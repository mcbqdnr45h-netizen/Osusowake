import React from 'react';
import { Download, ArrowRight, ExternalLink } from 'lucide-react';

// iOS と同じフルブリードのアプリアイコン (513KB PNG は読込が遅く一瞬崩れるため軽量 webp に)。
const ICON_URL = '/app-icon.webp';

// アプリ取得の振り分けページ (友だち共有リンクの飛び先)。
// 端末を判定して iPhone→App Store / Android→Play / それ以外→Web に誘導する。
const APP_STORE_URL = 'https://apps.apple.com/jp/app/id6763268307';
const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.yuhi.osusowake';
const WEB_URL = 'https://osusowakejapan.org';
// ネイティブスキーム: タップで App Store / Play アプリを直接開く。
const APP_STORE_APP = 'itms-apps://apps.apple.com/jp/app/id6763268307';
const PLAY_STORE_APP = 'market://details?id=com.yuhi.osusowake';
// LINE のアプリ内ブラウザは App Store スキームを弾く。openExternalBrowser=1 を付けると
// LINE が標準ブラウザ(Safari)で開き直す → そこでは App Store が正常に開く。
const EXTERNAL_GET = `${WEB_URL}/get?openExternalBrowser=1`;

// ★ Android 版は 2026-08-03 に Google Play で正式公開済み → Play へ誘導する。
const ANDROID_PUBLISHED = true;

export default function GetApp() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const inLine = /Line\//i.test(ua);
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const playReady = isAndroid && ANDROID_PUBLISHED;

  // 既に openExternalBrowser 付きで開かれているか (LINE 用・無限ループ防止)。
  const hasExtParam =
    typeof window !== 'undefined' &&
    /openExternalBrowser=1/.test(window.location.search);

  React.useEffect(() => {
    if (inLine) {
      // LINE 内なら openExternalBrowser 付き URL へ遷移して Safari で開かせる。
      // 既に付与済みなら再遷移しない (効かなかった場合は下のボタンで誘導)。
      if (!hasExtParam) window.location.href = EXTERNAL_GET;
      return;
    }
    if (isIos) window.location.href = APP_STORE_APP;
    else if (playReady) window.location.href = PLAY_STORE_APP;
  }, [inLine, isIos, playReady, hasExtParam]);

  const cta = inLine
    ? { href: EXTERNAL_GET, label: 'Safari で開いてインストール', icon: ExternalLink }
    : isIos
      ? { href: APP_STORE_APP, label: 'App Store でインストール', icon: Download }
      : playReady
        ? { href: PLAY_STORE_APP, label: 'Google Play でインストール', icon: Download }
        : { href: WEB_URL, label: 'ブラウザで今すぐ使う', icon: ArrowRight };
  const CtaIcon = cta.icon;

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-10 bg-gradient-to-br from-orange-50 via-background to-rose-50 text-center">
      <img
        src={ICON_URL}
        alt="おすそわけ"
        className="w-24 h-24 rounded-[22%] object-cover mb-5"
      />
      <h1 className="text-2xl font-black text-foreground mb-2">おすそわけ</h1>
      <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mb-8">
        ご近所のお店から、閉店前の余剰食品を
        <br />
        おトクにゲット🍞 フードロスを減らそう。
      </p>

      <a
        href={cta.href}
        className="w-full max-w-xs flex items-center justify-center gap-2 bg-primary text-primary-foreground font-bold text-base py-4 rounded-2xl shadow-md active:scale-[0.98] transition-transform"
      >
        <CtaIcon className="w-5 h-5" />
        {cta.label}
      </a>

      {inLine && (
        <p className="mt-3 text-xs text-muted-foreground max-w-xs">
          ※ LINE内ではApp Storeが開けないため、Safariで開き直します
        </p>
      )}

      {/* iOS(非LINE): スキームが開かない環境向けに https の保険リンク */}
      {isIos && !inLine && (
        <a
          href={APP_STORE_URL}
          className="mt-3 text-xs text-muted-foreground underline underline-offset-4"
        >
          開かない場合はこちら（App Store）
        </a>
      )}

      <a
        href={WEB_URL}
        className="mt-4 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
      >
        またはブラウザでそのまま使う →
      </a>

      {isAndroid && !ANDROID_PUBLISHED && (
        <p className="mt-8 text-xs text-muted-foreground/70">
          Android アプリは近日公開予定。今はブラウザでご利用いただけます
        </p>
      )}
      {isIos && !ANDROID_PUBLISHED && (
        <p className="mt-8 text-xs text-muted-foreground/70">Android 版は近日公開予定です</p>
      )}
    </div>
  );
}
