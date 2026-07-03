import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import fs from "node:fs";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import router from "./routes";
import { seoRouter } from "./seo";

const app: Express = express();

// プロキシ越しの実 IP を取得するため Replit/CDN の X-Forwarded-For を信頼
app.set("trust proxy", 1);

// ── セキュリティヘッダ（Helmet）────────────────────────────────────────────────
// API サーバーなので CSP は不要（フロント側 Vite が制御）。HSTS / X-Content-Type-Options /
// Referrer-Policy / X-DNS-Prefetch-Control / X-Download-Options などのデフォルトを有効化。
// crossOriginResourcePolicy は same-site だと Capacitor から呼べないので緩めに cross-origin。
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
}));

// ── CORS allowlist (#2 セキュリティ) ───────────────────────────────────────────
// 全オリジン許可は CSRF / トークン漏洩リスクが高いため、 本番ドメイン + Capacitor
// (iOS / Android webview) のみ許可。 開発時は Replit プレビュー / localhost も許可。
// origin === undefined (curl, mobile native fetch, SSR) は CORS 対象外なので素通し。
// credentials: false — 現状 JWT は Authorization header で送るため cookie 不要。
const CORS_ALLOWED_ORIGINS = new Set<string>([
  "https://osusowakejapan.org",
  "https://www.osusowakejapan.org",
  "capacitor://localhost",
  "http://localhost",
  "ionic://localhost",
]);
const CORS_IS_DEV = process.env.NODE_ENV !== "production";
app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  if (!origin) return cb(null, { origin: true, credentials: false });
  if (CORS_ALLOWED_ORIGINS.has(origin)) return cb(null, { origin: true, credentials: false });
  if (CORS_IS_DEV) {
    try {
      const u = new URL(origin);
      const host = u.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host.endsWith(".replit.dev") ||
        host.endsWith(".replit.app")
      ) {
        return cb(null, { origin: true, credentials: false });
      }
    } catch { /* origin URL parse 失敗 → 拒否 */ }
  }
  console.warn(`[CORS] blocked origin: ${origin}`);
  cb(null, { origin: false });
}));

// Stripe webhook は署名検証のため raw body が必要 — JSON ミドルウェアより前に登録
// レート制限の対象外（Stripe からの正規再送をブロックしないため）
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── レート制限 ────────────────────────────────────────────────────────────────
// 一般 API: IP あたり 1分 600 リクエスト（NAT 配下の複数ユーザーを考慮して緩め）
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Stripe webhook と health は完全除外
  skip: (req) => req.path.startsWith("/stripe-webhook") || req.path === "/health",
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "rate_limited", message: "リクエストが多すぎます。少し時間をおいてから再度お試しください。" },
});

// 認証系: ブルートフォース対策で 1分 30 リクエスト/IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "rate_limited", message: "認証リクエストが多すぎます。1分後に再度お試しください。" },
});

// ── 公開読み取り (ゲスト含む) 用の厳格 limiter ──────────────────────────────
// /api/bags, /api/stores 系の GET は認証不要で誰でも叩けるため、
// スクレイピング・列挙攻撃への耐性を上げる。
// 一般的な利用 (React Query refetch 60秒間隔 × 数エンドポイント) には十分余裕。
// GET 以外 (POST/PUT/PATCH/DELETE) はそもそも requireAuth が掛かっているので
// generalLimiter (600/min/IP) のみで十分 → ここでは GET だけを対象にする。
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "rate_limited", message: "リクエストが多すぎます。少し時間をおいてから再度お試しください。" },
});
const publicReadGate: express.RequestHandler = (req, res, next) => {
  if (req.method !== "GET") return next();
  return publicReadLimiter(req, res, next);
};

app.use("/api/auth", authLimiter);
// ★ 公開読み取りエンドポイント — generalLimiter より先に厳格な limiter を適用
//   (express-rate-limit は per-middleware カウンタなので両方独立に効く)
app.use("/api/bags", publicReadGate);
app.use("/api/stores", publicReadGate);
app.use("/api", generalLimiter);

// ── 401/403 を返したエンドポイントをログ出力（運用監視・デバッグ用）──
// 攻撃の試行検知・フロント認証バグの早期発見に役立つ。本番でも有用なので残す。
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.warn(`[auth] ${res.statusCode} ${req.method} ${req.originalUrl}`);
    }
  });
  next();
});

app.use("/api", router);

// ── SEO: robots.txt + sitemap.xml (SPA フォールバックより前に必須) ─────────────
// 下の app.get(/^\/(?!api\/).*/) が非 /api GET を全部 index.html で返すため、これを
// 先にマウントしないと /robots.txt /sitemap.xml も HTML になりクローラが認識できない。
app.use(seoRouter);

// ── SPA 静的配信 (Fly.io 単一オリジン用) ──────────────────────────────────────
// Dockerfile が rescueat の dist/public を /app/public にコピーし STATIC_DIR を渡す。
// STATIC_DIR が無い場合 (Replit ローカル開発など) はスキップ。
const STATIC_DIR = process.env.STATIC_DIR;
if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  const indexPath = path.join(STATIC_DIR, "index.html");

  // ── SPA 応答からは helmet の COOP / X-Frame-Options / CORP を外す ──────────────
  // Replit の静的配信は SPA にこれらを付けていなかった (= 本番互換)。特に
  // Cross-Origin-Opener-Policy: same-origin は Stripe.js の controller iframe /
  // 3DS の window 連携を阻害しうるため、SPA 文書では付与しない。
  // ※ /api/* は上の app.use("/api", router) で既に応答済みなのでここには来ない
  //   (= API レスポンスの helmet ヘッダ、特に Capacitor 用 CORP cross-origin は温存)。
  app.use((_req, res, next) => {
    res.removeHeader("Cross-Origin-Opener-Policy");
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Cross-Origin-Resource-Policy");
    next();
  });

  // 1) /assets/*, /favicon.ico などのハッシュ付きアセットは長期キャッシュ
  app.use(
    express.static(STATIC_DIR, {
      index: false,
      maxAge: "1y",
      etag: true,
      setHeaders: (res, filePath) => {
        // index.html だけは常に最新を取らせる (SPA エントリ)
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        }
      },
    })
  );
  // 2) SPA フォールバック: /api/* 以外の GET は全部 index.html を返す
  app.get(/^\/(?!api\/).*/, (_req, res, next) => {
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
  });
  console.log(`[static] SPA serving enabled from ${STATIC_DIR}`);
} else if (STATIC_DIR) {
  console.warn(`[static] STATIC_DIR=${STATIC_DIR} but directory does not exist`);
}

export default app;
