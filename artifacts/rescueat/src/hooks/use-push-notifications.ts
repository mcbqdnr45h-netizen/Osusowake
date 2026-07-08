import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { useAuth } from '@/contexts/AuthContext';
import { authedFetch } from '@/lib/authed-fetch';
import { registerPushRequester } from '@/lib/push-permission';

// ★ iOS Capacitor では VITE_API_BASE (https://osusowakejapan.org) が必須。
//   BASE_URL だけだとリモートホスト由来の URL になり OK のはずだが、
//   将来 server.url が変わったり一時的にローカル assets に切り替わった際に
//   /api/... が WKWebView 内部スキーム capacitor:// に解決され失敗する。
//   StoreDashboard などと同じ優先順で API ベースを決定する。
const BASE = (((import.meta as any).env?.VITE_API_BASE as string) || '') ||
             (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');

// listener + register() は端末で1回だけ実行する(グローバルフラグで二重防止)。
let registerStarted = false;

export function usePushNotifications() {
  const { session } = useAuth();
  // listener は起動時に1回だけ張るが、その中から常に「最新の session」を読みたいので ref に退避。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // 直近で受け取ったデバイストークン。 ログイン成立時に authed 側へ昇格 POST するため保持。
  const lastTokenRef = useRef<string | null>(null);
  const authedPostedRef = useRef(false);

  // ── トークンをサーバへ送る。 ログイン中なら会員紐付け、未ログインなら匿名登録。
  const postToken = async (token: string, platform: string) => {
    const loggedIn = !!sessionRef.current?.access_token;
    try {
      if (loggedIn) {
        const res = await authedFetch(`${BASE}/api/push/device-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceToken: token, platform }),
        });
        if (res.ok) {
          authedPostedRef.current = true;
          console.log('[push] device token registered OK (会員)');
        } else {
          const text = await res.text().catch(() => '');
          console.warn('[push] device token registration failed:', res.status, text);
        }
      } else {
        // 匿名端末登録 (requireAuth 無し) — 会員登録前でもデイリー通知を届けるため。
        const res = await fetch(`${BASE}/api/push/anon-device-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceToken: token, platform }),
        });
        console.log('[push] anon device token POST', res.ok ? 'OK (匿名)' : `失敗 ${res.status}`);
      }
    } catch (err) {
      console.warn('[push] device token POST failed:', err);
    }
  };

  // ── listener 設置 + register() (許可済みが前提・1回のみ)。
  const doRegister = async () => {
    if (registerStarted) return;
    registerStarted = true;
    try {
      // ★ race condition 修正: register() より先に listener を登録する。
      //   register() が即座に registration を発火するケースがあり、後付けだと取りこぼす。
      await PushNotifications.addListener('registration', async (token) => {
        const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'
        lastTokenRef.current = token.value;
        console.log(`[push] ${platform === 'android' ? 'FCM' : 'APNs'} device token received:`, token.value.slice(0, 10) + '...', 'loggedIn=', !!sessionRef.current?.access_token);
        await postToken(token.value, platform);
      });

      await PushNotifications.addListener('registrationError', (err) => {
        console.warn('[push] registration error:', err.error);
      });

      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[push] foreground notification:', notification.title);
      });

      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const url = (action.notification.data as Record<string, string>)?.url;
        if (url && url !== '/') {
          // wouter はパスベースのルーティング。 location.hash を変えても遷移しない。
          //   pushState + popstate で実際に画面遷移させる（iOS push タップのディープリンク復活）。
          window.history.pushState(null, '', url);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      });

      console.log('[push] PushNotifications.register() 呼び出し');
      await PushNotifications.register();
    } catch (err) {
      console.warn('[push] register setup failed:', err);
      registerStarted = false;
    }
  };

  // ── 許可を求めてから登録する。 プレパーミッションシートの「オンにする」から呼ばれる。
  //   返り値 = 最終的に granted かどうか。
  const requestAndRegister = async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      let perm = await PushNotifications.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
        console.log('[push] プレパーミッション経由で requestPermissions');
        perm = await PushNotifications.requestPermissions();
      }
      if (perm.receive !== 'granted') {
        console.warn('[push] permission not granted:', perm.receive);
        return false;
      }
      await doRegister();
      return true;
    } catch (err) {
      console.warn('[push] requestAndRegister failed:', err);
      return false;
    }
  };

  // ── Phase 1: マウント時。 起動時に許可を求めて登録する(=カスタムシート前の元挙動に復帰)。
  //   ★ 理由: iOSバイナリに焼き込まれた古いローカルJSが、 リモート読込前の一瞬に
  //     「起動時プロンプト」を出してしまうため、 リモート側だけカスタムシート方式にすると
  //     OSダイアログ→カスタムシートの二重表示になる(順番も逆に見える)。
  //     iOSは許可ダイアログを1度しか出さないので、 リモートも起動時プロンプト方式へ戻せば
  //     ローカルが出した1回で決着し、 二重表示が消える。 プレパーミッション(シート)は
  //     App Store 再申請でローカル焼き込みを最新化するまで一旦見送り。
  //   ※ requester 登録は残す(将来シート復活時に再利用)。 匿名端末登録(anon-device-token)は維持。
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const unregister = registerPushRequester(requestAndRegister);
    (async () => {
      try {
        const perm = await PushNotifications.checkPermissions();
        console.log('[push] 起動時 permission state:', perm.receive);
        if (perm.receive === 'granted') {
          await doRegister();
        } else {
          // prompt / prompt-with-rationale → 起動時に許可を求める(元の挙動)。
          await requestAndRegister();
        }
      } catch (err) {
        console.warn('[push] 起動時 permission check failed:', err);
      }
    })();
    return () => {
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Phase 2: 匿名で登録済みの端末が後からログインしたら、会員トークンへ昇格させる。
  //   token 自体は変わらないので、保持しておいた token を authed 側へ POST し直すだけ。
  //   バックエンドが匿名テーブルから同トークンを削除して二重送信を防ぐ。
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (!session?.access_token) return;
    if (authedPostedRef.current) return;
    if (!lastTokenRef.current) return;
    postToken(lastTokenRef.current, Capacitor.getPlatform());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);
}
