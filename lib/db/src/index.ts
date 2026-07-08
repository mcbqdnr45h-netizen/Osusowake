import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Supabase PostgreSQL を優先使用（統一 DB）
const rawUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

if (!rawUrl) {
  throw new Error(
    "SUPABASE_DATABASE_URL または DATABASE_URL を設定してください。"
  );
}

const isSupabase = !!process.env.SUPABASE_DATABASE_URL;

/**
 * コネクションプール設定 — 本番ローンチ同時アクセス対応
 *
 * max: 10
 *   経緯: 3 → 10 →(20 試行・却下)→ 10。
 *     - 旧値 3 はローンチ日の致命的ボトルネック（4 リクエスト目以降が行列化）。
 *     - Supabase compute を SMALL (2vCPU/2GB) に増強し DB CPU 飽和は解消済。
 *       SMALL + pool=10 は 50 並列でもエラーゼロ (median 1.4s) を実測確認。
 *     - pool=20 を本番投入したところ 50 並列で 500 が多発。原因は
 *       ★ session pooler (5432) の Pool Size が 15 のままで、app pool 20 が
 *         その枠を超え、超過接続が pooler で弾かれたため。
 *       → app pool > pooler Pool Size は厳禁。10 に戻して安定運用する。
 *   pool を 10 超に上げたい場合は、先に Supabase ダッシュボードで
 *   Pooler の Pool Size を (目標 pool + admin 余裕) 以上に上げること。
 *   SMALL の max_connections は ~90 なので pooler 50 程度まで拡張余地あり。
 *
 * idleTimeoutMillis: 30_000
 *   アイドル 30 秒でコネクション解放。 常時稼働サーバーでは 10 秒は短すぎて
 *   再接続 (SSL + pooler ハンドシェイク) の遅延スパイクを招くため延長。
 *
 * connectionTimeoutMillis: 5_000
 *   5 秒以内に取得できなければエラー（ハング防止）。
 *
 * keepAlive + keepAliveInitialDelayMillis
 *   TCP キープアライブで Supabase の idle 切断を防ぐ。
 */
export const pool = new Pool({
  connectionString: rawUrl,
  ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
  max: 10,
  // idle でも接続を切らない（0 = idle タイムアウト無効）。
  //   経緯: 2026-07-01 Supabase 障害中、新規コネクション確立が 60〜130 秒かかる／
  //   途中で切れる事象が発生。 旧設定 (idle 30s + allowExitOnIdle) は 30 秒無通信で
  //   接続を捨てるため、次のリクエストが毎回この cold 接続コストを踏み、ランキング/
  //   バッグ一覧が無限スケルトン化した。 接続を温存し使い回すことで cold 確立を回避する。
  //   ★ max:10 は据え置き（pooler Pool Size=15 を超えない厳守。 上げる時は先に pooler 側）。
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// プールエラーをキャッチしてプロセスをクラッシュさせない
pool.on("error", (err) => {
  console.error("[db] pool error (non-fatal):", err.message);
});

export const db = drizzle(pool, { schema });

/**
 * コネクション keep-warm。
 * 一定間隔で軽量な SELECT 1 を撃ち、プール内の接続を常に温めておく。
 * Supabase 障害時の cold 接続コスト (60〜130s) をユーザーリクエストに踏ませないための保険。
 * pool.query は自動で idle 接続を再利用するので、これ自体が接続を生かし続ける。
 * 障害で失敗しても飲み込む（次の tick で再試行）。
 */
const KEEP_WARM_MS = 20_000;
setInterval(() => {
  pool.query("SELECT 1").catch((err) => {
    console.warn("[db] keep-warm ping failed (non-fatal):", err?.message);
  });
}, KEEP_WARM_MS).unref();

/**
 * DB クエリのリトライ実行ヘルパー。
 * Supabase のアイドル切断 / TCP リセット等で発生する一時的な接続エラーを
 * 検知して、最大 retries 回まで指数バックオフで再試行する。
 *
 * - "Connection terminated" / ECONNRESET / 57P01 (admin shutdown) /
 *   08006 (connection_failure) / 08003 (connection_does_not_exist) を再試行対象とする
 * - 業務エラー（unique 違反など）は即時 throw（リトライしない）
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries     = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const label       = opts.label ?? "db";

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg  = String(err?.message ?? "");
      const code = String(err?.code ?? "");
      const transient =
        msg.includes("Connection terminated") ||
        msg.includes("Client has encountered a connection error") ||
        msg.includes("connection terminated") ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "EPIPE" ||
        code === "57P01" ||
        code === "08006" ||
        code === "08003";

      if (!transient || attempt === retries) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[${label}] transient DB error (attempt ${attempt + 1}/${retries + 1}) — retrying in ${delay}ms:`,
        msg || code,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export * from "./schema";
