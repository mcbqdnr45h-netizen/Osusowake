import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import { registerPushRequester } from '@/lib/push-permission';

// Web版(Android Chrome / PC / ホーム追加したiOS PWA)向けの Webプッシュ購読登録。
//   ネイティブアプリ(iOS/Android)は Capacitor の usePushNotifications が担当するので、
//   ここは !isNativePlatform() のときだけ動く。 受信SW(sw.js)と送信側(VAPID web-push)は既存。
const BASE = (((import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

// VAPID公開鍵(base64url) → Uint8Array (pushManager.subscribe 用)
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function webPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

export function useWebPush() {
  const { session } = useAuth();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // 'none' 未購読 / 'anon' 匿名購読済 / 'user' 会員購読済。
  //   匿名で購読後にログインしたら 'anon' → 'user' へ昇格させたいので単純 boolean にしない。
  const modeRef = useRef<'none' | 'anon' | 'user'>('none');

  // ── 購読処理。 promptIfNeeded=true なら未決定時にブラウザ許可ダイアログを出す。
  //   false なら「既に granted の人だけ」購読する(勝手にダイアログを出さない)。
  //   返り値 = 最終的に購読できたか。
  const subscribe = async (promptIfNeeded: boolean): Promise<boolean> => {
    if (Capacitor.isNativePlatform()) return false; // ネイティブは Capacitor push
    if (!webPushSupported()) return false;           // iOS Safari 通常タブ等は非対応

    const loggedIn = !!sessionRef.current?.user?.id;
    // 既に会員登録済み、または「匿名購読済みでまだ未ログイン」なら何もしない。
    if (modeRef.current === 'user') return true;
    if (modeRef.current === 'anon' && !loggedIn) return true;

    try {
      let perm = Notification.permission;
      if (perm === 'default') {
        if (!promptIfNeeded) return false; // プロンプトはシート経由のときだけ
        perm = await Notification.requestPermission();
      }
      if (perm !== 'granted') return false;

      // VAPID公開鍵を取得
      const r = await fetch(`${BASE}/api/push/vapid-public-key`);
      const { key } = (await r.json()) as { key: string | null };
      if (!key) return false;

      // SW がアクティブになるのを待ってから購読（既存購読があれば再利用）
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
        });
      }
      const json = sub.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) return false;

      const payload = {
        endpoint: sub.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      };

      if (loggedIn) {
        // 会員: userId 紐付けで登録（endpoint で upsert）
        await authedFetch(`${BASE}/api/web-push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        modeRef.current = 'user';
        console.log('[webpush] subscribed ✅ (会員)');
      } else {
        // 非会員: 匿名購読（requireAuth 無し）。 ログインしたら会員側へ昇格される。
        await fetch(`${BASE}/api/web-push/anon-subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        modeRef.current = 'anon';
        console.log('[webpush] subscribed ✅ (匿名)');
      }
      return true;
    } catch (err) {
      console.warn('[webpush] subscribe failed:', err);
      return false;
    }
  };

  // ── マウント時: requester を登録し、起動時に許可を求めて購読(=カスタムシート前の元挙動)。
  //   プレパーミッションシートを一旦見送るため、 許可導線を維持する目的で起動時に prompt する。
  //   (web はローカル焼き込み問題が無いので二重表示は起きない。 iOS と挙動を揃えるための復帰。)
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    const unregister = registerPushRequester(() => subscribe(true));
    subscribe(true); // 未決定ならブラウザ許可を求めて購読
    return () => {
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ログイン状態が変わったら会員へ昇格(匿名→会員 or 新規会員購読)。
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    // 既に granted なら prompt 無しで購読/昇格。default の人はシートに委ねる。
    subscribe(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);
}
