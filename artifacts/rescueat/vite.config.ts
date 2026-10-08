import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { flattenCascadeLayers } from "./vite-flatten-layers";

// PORT/BASE_PATH は dev/preview サーバー起動時のみ必須。
// `vite build` 時には不要なので、欠落していても build が通るようデフォルトを与える。
const isServeMode =
  process.argv.includes("dev") ||
  process.argv.includes("serve") ||
  process.argv.includes("preview");

const rawPort = process.env.PORT;

if (isServeMode && !rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = rawPort ? Number(rawPort) : 5173;

if (isServeMode && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

if (isServeMode && !process.env.BASE_PATH) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

// Maps API key: Replit Secret 名は VITE_MAPS_API_KEY。 旧コードが Maps_API_KEY という
// 存在しない名前を見ていたため、 web 側でもキーが空 → 「For development purposes only」 が出ていた。
// Mac ローカルや env 不在環境のために fallback キーも保持 (Bundle ID / Referrer 制限で保護前提)。
const MAPS_API_KEY_FALLBACK = "AIzaSyAd7THuZ2Dutmu_w2sXe6IqeCA8XoNOf3U";
const RESOLVED_MAPS_API_KEY =
  process.env.VITE_MAPS_API_KEY ??
  process.env.Maps_API_KEY ??
  process.env.MAPS_API_KEY ??
  MAPS_API_KEY_FALLBACK;

export default defineConfig({
  base: basePath,
  define: {
    'import.meta.env.VITE_MAPS_API_KEY': JSON.stringify(RESOLVED_MAPS_API_KEY),
    'import.meta.env.VITE_GOOGLE_MAPS_API_KEY': JSON.stringify(RESOLVED_MAPS_API_KEY),
    'import.meta.env.VITE_STRIPE_PK': JSON.stringify(process.env.STRIPE_PUBLISHABLE_KEY ?? ''),
  },
  plugins: [
    react(),
    tailwindcss(),
    flattenCascadeLayers(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  // ★ Tailwind v4 は oklch() / color-mix() / @property を多用するが、 これらは
  //    Chrome 111+ / Safari 15.4+ でしかサポートされない。 古い Android Chrome や
  //    System WebView (Chromium 90 台) で開くと色が解釈できず CSS ルール全体が
  //    スキップ → レイアウト崩壊する事例が発生。
  //    Lightning CSS で oklch → hex / color-mix → rgb 等の fallback を事前展開する。
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      // Chrome 90+ / Safari 14+ / Firefox 88+ / Android 5 以降をターゲットに自動 transpile
      targets: {
        chrome:  90 << 16,
        safari:  14 << 16,
        firefox: 88 << 16,
        android: 5  << 16,
      },
    },
  },
  // ★ 本番ビルドでのみ console.log / console.debug を除去する。
  //    認証状態などの内部情報がユーザのコンソールに出続けるのを止める。
  //    console.error / console.warn は障害調査に必要なので残す。
  //    dev サーバー (isServeMode) では開発の邪魔になるため何も落とさない。
  //    ※ NODE_ENV は Docker のビルド段階では未設定のため isServeMode で判定する。
  esbuild: {
    pure: isServeMode ? [] : ["console.log", "console.debug"],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // ★ CSS のミニファイも Lightning CSS に任せる (上の transformer と同じターゲットで)
    cssMinify: 'lightningcss',
    // ⚠️ manualChunks は「真っ白事故」を避けるため使わない方針。
    //   過去に id.includes("/react/") で framer-motion 内部の react path を
    //   誤マッチさせ、 React copy が複数 chunk に分散して hooks エラー →
    //   本番アプリが完全に立ち上がらなくなる障害が発生した。
    //   サイズ最適化が必要になった時は、 framer-motion のような React 内部を
    //   持つ巨大 lib を node_modules **絶対パス前提の正規表現** で厳密に
    //   切り出す形で再導入すること。 文字列 includes は絶対 NG。
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
