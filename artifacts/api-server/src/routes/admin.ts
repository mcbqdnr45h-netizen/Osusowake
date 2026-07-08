import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  storesTable, announcementsTable, webPushSubscriptionsTable, notificationsTable, salesLeadsTable,
  surpriseBagsTable, reservationsTable, reviewsTable, reportsTable, favoritesTable, cartReservationsTable,
} from "@workspace/db/schema";
import { eq, sql, desc, isNotNull, inArray } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase";
import { escapeHtml } from "../lib/escape.js";
import { isAdminMfaValid } from "../lib/admin-mfa";
import {
  isUserAdmin,
  getAllAdminUserIds,
  getAllAdminUsers,
  findUserIdByEmail,
  grantAdminRole,
  revokeAdminRole,
} from "../lib/admin.js";
import { Resend } from "resend";
import crypto from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { bagVisibleSql } from "../lib/bag-visibility.js";
import { sendPushToUsers } from "../lib/push.js";
import { buildGrowthData, buildDailyChecklistAI, buildSalesForecast, type AppStoreMetrics } from "../lib/growth.js";
import { getNotificationReach } from "../lib/daily-engagement.js";
import OpenAI from "openai";

const router: IRouter = Router();

// #6 フェーズ B: ハードコード ADMIN_EMAIL を完全廃止。 admin 判定は DB
// (users.role = 'admin') で一元化し、 lib/admin.ts のヘルパー経由で行う。
const APPROVAL_SECRET = process.env.ADMIN_APPROVAL_SECRET!;
if (!APPROVAL_SECRET) throw new Error("[SECURITY] ADMIN_APPROVAL_SECRET env var is not set");

// ── ブルートフォース防御（IP ベース、メモリ内） ──────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const BLOCK_DURATION_MS   = 15 * 60 * 1000; // 15 分

interface FailRecord { count: number; blockedUntil: number | null }
const failedAttempts = new Map<string, FailRecord>();

function getClientIp(req: Request): string {
  // Express の trust proxy=1 が Fly の付与する実クライアントIPを req.ip に解決する。
  //   X-Forwarded-For の左端を自前で読むと攻撃者が偽装してIPブロック/レート制限を回避できるため使わない。
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function isIpBlocked(ip: string): boolean {
  const rec = failedAttempts.get(ip);
  if (!rec) return false;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
  // ブロック解除
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) {
    failedAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordFailedAttempt(ip: string) {
  const rec = failedAttempts.get(ip) ?? { count: 0, blockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_FAILED_ATTEMPTS) {
    rec.blockedUntil = Date.now() + BLOCK_DURATION_MS;
    console.warn(`[SECURITY] 🔒 IP blocked for 15 min: ${ip} (${rec.count} failed admin auth attempts)`);
  }
  failedAttempts.set(ip, rec);
}

function clearFailedAttempts(ip: string) {
  failedAttempts.delete(ip);
}

// ── 管理者操作 監査ログ ──────────────────────────────────────────────────────
async function writeAuditLog(req: Request, action: string, targetId?: string | number, details?: Record<string, unknown>) {
  try {
    const ip        = getClientIp(req);
    const userAgent = req.headers["user-agent"]?.slice(0, 200) ?? "";
    const admin     = (req as any).adminUser?.email ?? "unknown";
    await supabaseAdmin.from("admin_audit_log").insert({
      admin_email: admin,
      action,
      target_id:  targetId != null ? String(targetId) : null,
      details:    details ?? null,
      ip_address: ip,
      user_agent: userAgent,
    });
  } catch (e) {
    console.warn("[admin/audit] write failed:", (e as Error).message);
  }
}

// ── レートリミッター（管理者 API 全体） ──────────────────────────────────────
//
// ⚠️ 重要: path 指定 ('/admin') を必ず付けること！
// `router.use(adminRateLimiter)` (path 無し) で適用すると、親 router で
// `router.use(adminRouter)` が path 無しマウントされている関係上、
// /api/* 全体に admin 用 60req/min の厳しい制限がかかってしまい、
// 一般ユーザーの API も 429 で遮断される潜在バグになる。
// path scoped にすることで、適用範囲を /admin/* に厳密に限定する。
const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 分
  max: 60,                 // 60 req / min
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    console.warn(`[SECURITY] ⚠️ Rate limit exceeded: ${getClientIp(req)} ${req.method} ${req.path}`);
    res.status(429).json({ error: "too_many_requests", message: "リクエストが多すぎます。しばらくお待ちください。" });
  },
});
router.use('/admin', adminRateLimiter);

// ── ヘルパー: Supabase token からユーザー情報を取得 ────────────────────────────
async function getAuthUser(req: Request) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── 管理者専用ミドルウェア（IP ブロック + 監査ログ付き） ───────────────────────
// ※ stores.ts 内に残る admin 系ルートからも使えるよう export している。
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req);

  // ① IP ブロックチェック
  if (isIpBlocked(ip)) {
    console.warn(`[SECURITY] 🚫 Blocked IP attempted admin access: ${ip}`);
    res.status(429).json({ error: "ip_blocked", message: "アクセスが一時的にブロックされています。しばらくお待ちください。" });
    return;
  }

  // ② JWT 検証
  const user = await getAuthUser(req);
  if (!user) {
    recordFailedAttempt(ip);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // ③ 管理者検証 — #6 フェーズ B: DB role=admin で一元判定。
  //   ハードコード email との OR 判定は廃止。 admin の追加/削除は
  //   POST/DELETE /admin/admins endpoint と AdminDashboard の管理者タブで行う。
  const isAdmin = await isUserAdmin({ id: user.id });
  if (!isAdmin) {
    recordFailedAttempt(ip);
    console.warn(`[SECURITY] ⚠️ Unauthorized admin access attempt: ${user.email} from ${ip}`);
    res.status(403).json({ error: "forbidden", message: "管理者権限が必要です" });
    return;
  }

  // ③.5 MFA(OTP) 検証 — DB role=admin だけでは不十分。 OTP を通したセッションのみ許可する。
  //   （これが無いと OTP はフロント表示だけの飾りで、 admin JWT 直叩きで素通りできた）
  //   未検証/期限切れは mfa_required を返し、 フロントが OTP を再要求する。
  if (!isAdminMfaValid(user.id)) {
    console.warn(`[SECURITY] 🔐 Admin without valid MFA: ${user.email} from ${ip}`);
    res.status(403).json({ error: "mfa_required", message: "2段階認証が必要です。確認コードを入力してください。" });
    return;
  }

  // ④ 成功 → 失敗カウントリセット
  clearFailedAttempts(ip);
  (req as any).adminUser = user;
  next();
}

// ── 管理者チェックのみ（監査ログなしの読み取り用） ──────────────────────────
const requireAdminLight = requireAdmin;

// ── GET /admin/metrics ─────────────────────────────────────────────────────────
// GMV、手数料、アクティブユーザー数、登録店舗数 + 拡張メトリクス
// query: ?excludeTest=1 で stripe_account_id IS NULL の店舗（テスト店）を集計から除外
router.get("/admin/metrics", requireAdmin, async (req, res) => {
  try {
    const excludeTest = req.query["excludeTest"] === "1" || req.query["excludeTest"] === "true";
    // 共通フィルタ: テスト店除外の場合は stripe_account_id を持つ店舗のみ
    const storeFilterSql = excludeTest
      ? sql`AND s.stripe_account_id IS NOT NULL`
      : sql``;

    // ── 1. GMV / アクティブユーザー / 詳細ステータス内訳 ──
    const gmvResult = await db.execute(sql`
      SELECT
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')), 0)::numeric AS gmv,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status='confirmed'), 0)::numeric AS gmv_confirmed,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status='picked_up'), 0)::numeric AS gmv_picked_up,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status='cancelled'), 0)::numeric AS gmv_cancelled,
        COUNT(*) FILTER (WHERE r.status='pending')::int    AS count_pending,
        COUNT(*) FILTER (WHERE r.status='confirmed')::int  AS count_confirmed,
        COUNT(*) FILTER (WHERE r.status='picked_up')::int  AS count_picked_up,
        COUNT(*) FILTER (WHERE r.status='cancelled')::int  AS count_cancelled,
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.status IN ('confirmed','picked_up'))::int AS active_users,
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.status='picked_up')::int AS pickup_users
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      WHERE 1=1 ${storeFilterSql}
    `);
    const m = gmvResult.rows[0] as any;
    const gmv = Number(m?.gmv ?? 0);
    const platformFee = Math.round(gmv * 0.20);

    // ── 2. 店舗統計 ──
    const storeStats = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_stores,
        COUNT(*) FILTER (WHERE status = 'approved' AND is_active = true)::int AS approved_stores,
        COUNT(*) FILTER (WHERE status IN ('pending_review','pending','applied'))::int AS pending_stores,
        COUNT(*) FILTER (WHERE status = 'approved' AND is_active = false)::int AS suspended_stores,
        COUNT(*) FILTER (WHERE stripe_account_id IS NULL)::int AS test_stores,
        COUNT(*) FILTER (WHERE stripe_account_id IS NOT NULL)::int AS real_stores
      FROM stores
    `);
    const sRow = storeStats.rows[0] as any;

    // ── 3. 直近30日 日別売上推移 ──
    const dailyResult = await db.execute(sql`
      SELECT
        TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')), 0)::numeric AS gmv,
        COUNT(r.id) FILTER (WHERE r.status IN ('confirmed','picked_up'))::int AS count
      FROM generate_series(
        (CURRENT_DATE - INTERVAL '29 days')::date,
        CURRENT_DATE::date,
        '1 day'::interval
      ) AS d(day)
      LEFT JOIN reservations r
        ON r.created_at::date = d.day
      LEFT JOIN stores s ON s.id = r.store_id
      WHERE r.id IS NULL OR (1=1 ${storeFilterSql})
      GROUP BY d.day
      ORDER BY d.day ASC
    `);
    const dailySeries = dailyResult.rows.map((r: any) => ({
      date: r.date,
      gmv: Number(r.gmv),
      count: Number(r.count),
    }));

    // ── 4. 店舗ランキング TOP 5 (GMV) ──
    const rankingResult = await db.execute(sql`
      SELECT
        s.id, s.name,
        s.stripe_account_id IS NULL AS is_test,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')), 0)::numeric AS gmv,
        COUNT(r.id) FILTER (WHERE r.status IN ('confirmed','picked_up'))::int AS reservations,
        COUNT(r.id) FILTER (WHERE r.status='picked_up')::int AS picked_up_count
      FROM stores s
      LEFT JOIN reservations r ON r.store_id = s.id
      WHERE 1=1 ${storeFilterSql}
      GROUP BY s.id, s.name, s.stripe_account_id
      HAVING COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')), 0) > 0
      ORDER BY gmv DESC
      LIMIT 5
    `);
    const storeRanking = rankingResult.rows.map((r: any) => ({
      id: Number(r.id),
      name: r.name,
      isTest: !!r.is_test,
      gmv: Number(r.gmv),
      reservations: Number(r.reservations),
      pickedUpCount: Number(r.picked_up_count),
      pickupRate: Number(r.reservations) > 0 ? Number(r.picked_up_count) / Number(r.reservations) : 0,
    }));

    // ── 5. 時間帯ヒートマップ（24h × 7曜日） ──
    const heatmapResult = await db.execute(sql`
      SELECT
        EXTRACT(DOW FROM r.created_at)::int  AS dow,
        EXTRACT(HOUR FROM r.created_at)::int AS hour,
        COUNT(*)::int AS count
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      WHERE r.status IN ('confirmed','picked_up')
        AND r.created_at >= CURRENT_DATE - INTERVAL '30 days'
        ${storeFilterSql}
      GROUP BY dow, hour
    `);
    const hourlyHeatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const row of heatmapResult.rows) {
      const r = row as any;
      hourlyHeatmap[Number(r.dow)][Number(r.hour)] = Number(r.count);
    }

    // ── 6. 異常検知 ──
    // (a) pending が 24h 以上滞留
    const stalePendingResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM reservations r
      WHERE r.status = 'pending'
        AND r.created_at < NOW() - INTERVAL '24 hours'
    `);
    // (b) cancellation 率が高い店舗（5件以上 & cancel率 30%超）
    const highCancelResult = await db.execute(sql`
      SELECT s.id, s.name,
        COUNT(r.id)::int AS total,
        COUNT(r.id) FILTER (WHERE r.status='cancelled')::int AS cancelled,
        (COUNT(r.id) FILTER (WHERE r.status='cancelled')::numeric / NULLIF(COUNT(r.id),0))::float AS rate
      FROM stores s
      LEFT JOIN reservations r ON r.store_id = s.id
      WHERE 1=1 ${storeFilterSql}
      GROUP BY s.id, s.name
      HAVING COUNT(r.id) >= 5
        AND (COUNT(r.id) FILTER (WHERE r.status='cancelled')::numeric / NULLIF(COUNT(r.id),0)) > 0.3
      ORDER BY rate DESC
      LIMIT 5
    `);
    // (c) 営業許可証 silent fail
    // stripe_payouts_enabled = true の店舗は Stripe KYC 完了済みのため除外
    const licenseIssuesResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM stores s
      WHERE s.status = 'approved'
        AND (s.license_image_url IS NULL OR s.license_upload_failed = true)
        AND s.stripe_account_id IS NOT NULL
        AND s.stripe_payouts_enabled IS NOT TRUE
    `);
    // (d) 通報未対応 (reports)
    const openReportsResult = await db.execute(sql`SELECT COUNT(*)::int AS n FROM reports`);
    // (e) approved だが Stripe 未連携 (販売不可状態)
    const noStripeApprovedResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM stores
      WHERE status = 'approved' AND (stripe_account_id IS NULL OR stripe_payouts_enabled IS NOT TRUE)
    `);
    // (f) 申請待ち合計 (applied + pending + pending_review) — トップで気付くべき件数
    const pendingApprovalsResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM stores
      WHERE status IN ('applied','pending','pending_review')
    `);
    // (g) sales_leads 新規 (お店通報)
    const newSalesLeadsResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM sales_leads WHERE status = 'new'
    `);

    // ── 7. ユーザー基本指標 ──
    const userBasicsResult = await db.execute(sql`
      SELECT
        ROUND(AVG(r.total_price))::int AS avg_price,
        MAX(r.total_price)::int AS max_price,
        MIN(r.total_price) FILTER (WHERE r.total_price > 0)::int AS min_price
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      WHERE r.status IN ('confirmed','picked_up')
        ${storeFilterSql}
    `);
    const u = userBasicsResult.rows[0] as any;

    res.json({
      // 既存フィールド（互換性維持）
      gmv,
      platformFee,
      activeUsers: Number(m?.active_users ?? 0),
      totalStores: sRow.total_stores,
      approvedStores: sRow.approved_stores,
      pendingStores: sRow.pending_stores,
      suspendedStores: sRow.suspended_stores,
      // 拡張フィールド
      excludeTest,
      breakdown: {
        gmvConfirmed: Number(m?.gmv_confirmed ?? 0),
        gmvPickedUp: Number(m?.gmv_picked_up ?? 0),
        gmvCancelled: Number(m?.gmv_cancelled ?? 0),
        countPending: Number(m?.count_pending ?? 0),
        countConfirmed: Number(m?.count_confirmed ?? 0),
        countPickedUp: Number(m?.count_picked_up ?? 0),
        countCancelled: Number(m?.count_cancelled ?? 0),
        pickupUsers: Number(m?.pickup_users ?? 0),
        avgPrice: Number(u?.avg_price ?? 0),
        maxPrice: Number(u?.max_price ?? 0),
        minPrice: Number(u?.min_price ?? 0),
      },
      storeBreakdown: {
        testStores: sRow.test_stores,
        realStores: sRow.real_stores,
      },
      dailySeries,
      storeRanking,
      hourlyHeatmap,
      anomalies: {
        stalePendingCount: Number((stalePendingResult.rows[0] as any)?.n ?? 0),
        highCancelStores: highCancelResult.rows.map((r: any) => ({
          id: Number(r.id), name: r.name, total: Number(r.total),
          cancelled: Number(r.cancelled), rate: Number(r.rate),
        })),
        licenseIssueCount: Number((licenseIssuesResult.rows[0] as any)?.n ?? 0),
        openReportsCount:    Number((openReportsResult.rows[0] as any)?.n ?? 0),
        noStripeApprovedCount: Number((noStripeApprovedResult.rows[0] as any)?.n ?? 0),
        pendingApprovalsCount: Number((pendingApprovalsResult.rows[0] as any)?.n ?? 0),
        newSalesLeadsCount:    Number((newSalesLeadsResult.rows[0] as any)?.n ?? 0),
      },
    });
  } catch (err: any) {
    console.error("[admin/metrics]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GROWTH GOD MODE — 成長の神モード
//  「集客はできてる。転換が壊れてる」を毎日ドライブするための経営コックピット。
//  単なる数字の羅列ではなく、今日打つべきアクション（死に店の掘り起こし /
//  ホットリードへの再エンゲージ / 供給の脈拍）を炙り出すことに全振りする。
// ═══════════════════════════════════════════════════════════════════════════

// 「購入した」の定義 = 支払い成立し受取確定/完了した予約（キャンセル除外）。
const BOUGHT_STATUSES = sql`('confirmed','picked_up')`;

// ── ホットリード再エンゲージの共有ヘルパー ──
// 指定セグメントのユーザーに in-app 通知 + 実Push(web/APNs) を撃つ。撃った人数を返す。
// admin 版 (/admin/growth/reengage) と board 版 (/board/reengage) の両方から使う。
async function runReengage(
  segment: string,
  title: string,
  body: string,
  url: string,
): Promise<number> {
  const idsRes = segment === "fav_no_purchase"
    ? await db.execute(sql`
        SELECT DISTINCT f.user_id AS user_id FROM favorites f
        WHERE NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.user_id = f.user_id AND r.status IN ${BOUGHT_STATUSES})`)
    : await db.execute(sql`
        SELECT u.id::text AS user_id FROM public.users u
        WHERE u.created_at > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.user_id = u.id::text AND r.status IN ${BOUGHT_STATUSES})`);

  const userIds = idsRes.rows.map((r: any) => r.user_id).filter(Boolean) as string[];
  if (userIds.length === 0) return 0;

  // in-app 通知を残す（Push が届かない端末でもアプリ内で見える）
  await db.insert(notificationsTable).values(
    userIds.map((userId) => ({
      userId,
      type: "reengage" as const,
      title: title.trim(),
      body: body?.trim() || null,
      read: false,
    })),
  );

  // 実 Push（web + APNs）を送信
  await sendPushToUsers(userIds, {
    title: title.trim(),
    body: body?.trim() || "",
    tag: `reengage-${segment}`,
    url: (typeof url === "string" && url.trim()) || "/",
  });

  return userIds.length;
}

const REENGAGE_SEGMENTS = ["fav_no_purchase", "registered_no_purchase_7d"];

// ── GET /admin/growth ──
// 成長コックピットのデータ一式（共有ライブラリ buildGrowthData で構築）。
router.get("/admin/growth", requireAdmin, async (_req, res) => {
  try {
    const data = await buildGrowthData();
    res.json({ ok: true, ...data });
  } catch (err: any) {
    console.error("[admin/growth]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/growth/reengage ──
// ホットリードのセグメントを狙って再エンゲージ Push を撃つ（+ in-app 通知も残す）。
router.post("/admin/growth/reengage", requireAdmin, async (req: any, res) => {
  const { segment, title, body, url } = req.body ?? {};
  if (!REENGAGE_SEGMENTS.includes(segment)) {
    res.status(400).json({ error: "bad_request", message: "unknown segment" }); return;
  }
  if (!title?.trim()) {
    res.status(400).json({ error: "bad_request", message: "title is required" }); return;
  }
  try {
    const targeted = await runReengage(segment, title, body, url);
    res.json({ ok: true, segment, targeted, note: targeted === 0 ? "対象ユーザーが0でした" : undefined });
  } catch (err: any) {
    console.error("[admin/growth/reengage]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED BOARD — 俺らだけの成長ボード（神モードとは別アクセス）
//  管理者権限(requireAdmin)ではなく「合言葉コード」で入れる。危険な管理操作は
//  一切できず、成長データ閲覧 + ホットリードPush + 今日のチェックリスト消化だけ。
//  コードは Fly secret BOARD_ACCESS_CODE。timingSafeEqual で比較。
// ═══════════════════════════════════════════════════════════════════════════

function checkBoardCode(req: Request): boolean {
  const expected = process.env.BOARD_ACCESS_CODE || "";
  if (!expected) return false;
  const given =
    (req.headers["x-board-code"] as string) ||
    (req.body && typeof req.body === "object" ? (req.body as any).code : "") ||
    "";
  if (typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireBoardCode(req: Request, res: Response, next: NextFunction) {
  if (!checkBoardCode(req)) {
    res.status(401).json({ error: "unauthorized", message: "invalid board code" }); return;
  }
  next();
}

// App Store Connect の数字は自動取得できないので app_settings に手動保存した値を読む。
async function getAppStoreMetrics(): Promise<AppStoreMetrics> {
  const r = await db.execute(sql`
    SELECT key, value FROM app_settings
    WHERE key IN ('growth_appstore_downloads','growth_appstore_impressions','growth_appstore_updated')`);
  const m: Record<string, string> = {};
  for (const row of r.rows as any[]) m[row.key] = row.value;
  return {
    downloads: Number(m["growth_appstore_downloads"] ?? 0) || 0,
    impressions: Number(m["growth_appstore_impressions"] ?? 0) || 0,
    updatedAt: m["growth_appstore_updated"] ?? null,
  };
}

// 今日消化したチェックリスト項目の状態を app_settings に保存する（board_checklist_YYYY-MM-DD）。
async function getBoardCheckState(isoDate: string): Promise<Record<string, boolean>> {
  const key = `board_checklist_${isoDate}`;
  const r = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${key}`);
  if (r.rows.length === 0) return {};
  try {
    return JSON.parse((r.rows[0] as any).value) || {};
  } catch {
    return {};
  }
}

// その日のAIチェックリストを app_settings に1日キャッシュする（board_checklist_items_YYYY-MM-DD）。
//   ★ 1日1回だけ生成する理由:
//     (1) 生成は数秒かかる → 毎回のboard表示で待たせない。
//     (2) AIは生成の度に item.id が変わる → 毎回作り直すと checkState(id管理のチェック) が全部外れる。
//   よって「その日 初回生成分」を凍結して同じ日は再利用する。 翌日(JST)は自動で新規生成。
async function getOrBuildDailyChecklist(
  isoDate: string,
  growth: Awaited<ReturnType<typeof buildGrowthData>>,
  appstore: AppStoreMetrics,
  sales: Awaited<ReturnType<typeof buildSalesForecast>>,
): Promise<{ items: any[]; source: "ai" | "template" }> {
  const key = `board_checklist_items_${isoDate}`;
  const r = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${key}`);
  if (r.rows.length > 0) {
    try {
      const cached = JSON.parse((r.rows[0] as any).value);
      if (cached && Array.isArray(cached.items) && cached.items.length > 0) return cached;
    } catch { /* 壊れてたら作り直す */ }
  }
  const built = await buildDailyChecklistAI(growth, appstore, sales);
  // AI成功時のみ凍結保存（テンプレ・フォールバックはキャッシュせず、次回AI生成を再挑戦させる）。
  if (built.source === "ai") {
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(built)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`).catch(() => {});
  }
  return built;
}

// ── POST /board/data ──
// 成長データ + App Store 数字 + 今日のチェックリスト + 消化状態を一括返却。
router.post("/board/data", requireBoardCode, async (_req, res) => {
  try {
    const [growth, appstore, reach, sales] = await Promise.all([buildGrowthData(), getAppStoreMetrics(), getNotificationReach(), buildSalesForecast()]);
    const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    // ★ その日のデータをAIが分析して組む動的チェックリスト(毎日中身が変わる)。 1日キャッシュ。 失敗時は固定テンプレにフォールバック。
    const { items: checklist, source: checklistSource } = await getOrBuildDailyChecklist(jst, growth, appstore, sales);
    const checkState = await getBoardCheckState(jst);
    res.json({ ok: true, growth, appstore, reach, sales, checklist, checklistSource, checkState, today: jst });
  } catch (err: any) {
    console.error("[board/data]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /board/chat ──
// board の「何でも聞けるAI」。 従業員も見るので危険な操作(Push配信/DB書込)は一切させない。
//   その日の成長データ・販売実績を丸ごとコンテキストに渡して、経営の相談相手にする。
//   ※ Push を撃つ等の"実行"は神モード(/admin)だけ。 ここは読み取り+助言のみ。
// 本番Flyには OPENAI_API_KEY が設定済み。 ローカル開発は AI_INTEGRATIONS_* を使う。
//   ★ 以前は AI_INTEGRATIONS_* しか見ておらず本番で "dummy" に落ちて 401 になっていた。
const boardOpenai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy",
});

// board データをAIが読める簡潔なテキストに要約する（トークン節約）。
function summarizeBoardContext(growth: any, appstore: AppStoreMetrics, reach: any, sales: any): string {
  const f = growth?.funnel ?? {};
  const sup = growth?.supply ?? {};
  const s = sales ?? {};
  const t = s.today ?? {};
  const fc = s.forecast ?? {};
  const lines: string[] = [];
  lines.push(`【全体ファネル(累計)】`);
  lines.push(`- 登録ユーザー:${f.registered ?? "?"} / お気に入り登録者:${f.favorited ?? "?"} / 購入者:${f.buyers ?? "?"} / リピーター:${f.repeatBuyers ?? "?"}`);
  lines.push(`- 直近7日新規:${f.newUsers7d ?? "?"} / 30日新規:${f.newUsers30d ?? "?"} / 登録→購入率:${f.rates?.registerToBuy ?? "?"}%`);
  lines.push(`- 累計GMV:¥${growth?.gmvTotal ?? "?"} / レビュー:${growth?.reviews?.count ?? 0}件(平均★${growth?.reviews?.avgRating ?? "?"})`);
  lines.push(`【供給】承認稼働店:${sup.approvedActiveStores ?? "?"} / 今ライブの店:${sup.storesWithLiveBags ?? "?"} / ライブ在庫:${sup.liveStockUnits ?? "?"}個`);
  lines.push(`【ホットリード】お気に入り済未購入:${growth?.hotLeads?.favNoPurchase ?? 0}人 / 登録7日以内未購入:${growth?.hotLeads?.registered7dNoPurchase ?? 0}人`);
  lines.push(`【App Store】DL:${appstore?.downloads ?? 0} / インプレ:${appstore?.impressions ?? 0}`);
  lines.push(`【次回デイリー通知の実リーチ】会員:${reach?.members ?? 0} + 匿名iOS:${reach?.anonIos ?? 0} + 匿名Web:${reach?.anonWeb ?? 0} = 計${reach?.total ?? 0}`);
  lines.push(`【今日の販売実績】出品${t.listedBags ?? 0}袋/在庫${t.listedUnits ?? 0}個/売れた${t.soldUnits ?? 0}個/完売${t.soldOutBags ?? 0}袋/売上¥${t.revenue ?? 0}/販売率${t.sellThrough ?? 0}%`);
  lines.push(`【販売予測(直近${fc.sampleDays ?? 0}日)】平均販売率${fc.avgSellThrough ?? 0}% / 好調カテゴリ:${fc.bestCategory ?? "—"} / 不調カテゴリ:${fc.worstCategory ?? "—"}`);
  if (fc.note) lines.push(`- 所見:${fc.note}`);
  if (Array.isArray(s.categoryPerformance) && s.categoryPerformance.length) {
    lines.push(`【カテゴリ別(売れた/出品)】` + s.categoryPerformance.map((c: any) => `${c.category}:${c.soldUnits}/${c.listedUnits}(${c.sellThrough}%)`).join(" / "));
  }
  if (Array.isArray(s.storePerformance) && s.storePerformance.length) {
    lines.push(`【店別 上位】` + s.storePerformance.slice(0, 8).map((st: any) => `${st.name}:${st.soldUnits}/${st.listedUnits}個`).join(" / "));
  }
  if (Array.isArray(growth?.deadStores) && growth.deadStores.length) {
    lines.push(`【叩き起こすべき店(承認済みやのに動いてない)】` + growth.deadStores.slice(0, 8).map((d: any) => d.name).join("、"));
  }
  return lines.join("\n");
}

const BOARD_AI_SYSTEM = `あなたは「おすそわけ」(=Too Good To Go の日本版フードロス削減アプリ)の経営参謀AIです。
飲食店が閉店前の余剰食品を「サプライズバッグ」として安価に販売し、ユーザーが予約・決済します(店舗手数料20%/ユーザー5%)。
このボードは創業者マロと従業員が見ます。以下の「今日の実データ」だけを根拠に、関西弁のカジュアルな口調で、具体的で実行可能な助言をしてください。
数字を聞かれたら実データから正確に答え、推測する時は「推測やけど」と明示すること。データに無いことは正直に「そのデータは今ここに無いわ」と言うこと。データを捏造しない。
回答は簡潔に(長くても400字程度)。`;

router.post("/board/chat", requireBoardCode, async (req: any, res) => {
  const { message, history, images } = req.body ?? {};
  const text = typeof message === "string" ? message.trim() : "";
  // 画像だけ(テキスト無し)でも投げられるようにする。 どちらも無い時だけ弾く。
  const imgList: string[] = Array.isArray(images)
    ? images.filter((s: any) => typeof s === "string" && s.startsWith("data:image/")).slice(0, 4)
    : [];
  if (!text && imgList.length === 0) {
    res.status(400).json({ error: "bad_request", message: "message or image is required" }); return;
  }
  try {
    const [growth, appstore, reach, sales] = await Promise.all([
      buildGrowthData(), getAppStoreMetrics(), getNotificationReach(), buildSalesForecast(),
    ]);
    const context = summarizeBoardContext(growth, appstore, reach, sales);

    // 直近数往復だけ渡す(暴走・トークン肥大防止)。 role/content(文字列)以外は捨てる。
    const priorTurns = (Array.isArray(history) ? history : [])
      .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      .slice(-6)
      .map((h: any) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 2000) }));

    // 画像がある時はマルチモーダル content 配列で組む(classify.ts と同じ image_url 方式)。
    const userContent: any = imgList.length > 0
      ? [
          ...imgList.map((url) => ({ type: "image_url", image_url: { url, detail: "auto" } })),
          { type: "text", text: (text || "この画像について、おすそわけの経営視点でコメントして。").slice(0, 2000) },
        ]
      : text.slice(0, 2000);

    const completion = await boardOpenai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 2000,
      messages: [
        { role: "system", content: BOARD_AI_SYSTEM },
        { role: "system", content: `＝＝＝ 今日の実データ ＝＝＝\n${context}` },
        ...priorTurns,
        { role: "user", content: userContent },
      ],
    });
    const reply = completion.choices[0]?.message?.content?.trim() || "うまく答えられへんかった。もう一回聞いて。";
    res.json({ ok: true, reply });
  } catch (err: any) {
    console.error("[board/chat]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /board/check ──
// チェックリスト項目の完了状態をトグルして今日分に永続化。
router.post("/board/check", requireBoardCode, async (req: any, res) => {
  const { itemId, done } = req.body ?? {};
  if (typeof itemId !== "string" || !itemId) {
    res.status(400).json({ error: "bad_request", message: "itemId required" }); return;
  }
  try {
    const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const key = `board_checklist_${jst}`;
    const state = await getBoardCheckState(jst);
    state[itemId] = !!done;
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(state)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`);
    res.json({ ok: true, checkState: state });
  } catch (err: any) {
    console.error("[board/check]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /board/appstore ──
// App Store Connect の DL / インプレッション数を手動更新。
router.post("/board/appstore", requireBoardCode, async (req: any, res) => {
  const { downloads, impressions } = req.body ?? {};
  try {
    const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const pairs: [string, string][] = [];
    if (downloads != null && !Number.isNaN(Number(downloads)))
      pairs.push(["growth_appstore_downloads", String(Math.round(Number(downloads)))]);
    if (impressions != null && !Number.isNaN(Number(impressions)))
      pairs.push(["growth_appstore_impressions", String(Math.round(Number(impressions)))]);
    pairs.push(["growth_appstore_updated", jst]);
    for (const [key, value] of pairs) {
      await db.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${key}, ${value}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`);
    }
    res.json({ ok: true, appstore: await getAppStoreMetrics() });
  } catch (err: any) {
    console.error("[board/appstore]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/license-issues ─────────────────────────────────────────────────
// 営業許可証 silent fail / 未提出だが approved な店舗の一覧
router.get("/admin/license-issues", requireAdmin, async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        s.id, s.name, s.status, s.is_active, s.category, s.city,
        s.image_url, s.icon_url, s.created_at, s.owner_id,
        s.stripe_account_id, s.stripe_charges_enabled,
        s.license_number,
        s.license_image_url IS NOT NULL AS has_license_url,
        s.stripe_license_file_id IS NOT NULL AS has_stripe_file_id,
        s.license_upload_failed,
        s.license_upload_error,
        s.license_upload_attempted_at,
        CASE
          WHEN s.license_upload_failed = TRUE THEN 'upload_failed'
          WHEN s.license_image_url IS NULL AND s.license_number IS NOT NULL THEN 'image_missing_but_number_set'
          WHEN s.license_image_url IS NULL AND s.license_number IS NULL THEN 'no_license_at_all'
          ELSE 'unknown'
        END AS issue_type,
        CASE
          WHEN s.license_upload_failed = TRUE THEN 'high'
          WHEN s.license_image_url IS NULL AND s.stripe_charges_enabled = TRUE THEN 'high'
          WHEN s.license_image_url IS NULL AND s.status = 'approved' THEN 'medium'
          ELSE 'low'
        END AS severity
      FROM stores s
      WHERE s.status = 'approved'
        AND s.stripe_account_id IS NOT NULL
        AND s.stripe_payouts_enabled IS NOT TRUE
        AND (
          s.license_image_url IS NULL
          OR s.license_upload_failed = TRUE
        )
      ORDER BY
        CASE
          WHEN s.license_upload_failed = TRUE THEN 0
          WHEN s.stripe_charges_enabled = TRUE THEN 1
          ELSE 2
        END,
        s.created_at DESC
    `);
    res.json({ items: result.rows, count: result.rows.length });
  } catch (err: any) {
    console.error("[admin/license-issues]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/request-license-reupload ──────────────────────
// 神モードから店主に営業許可証の再アップロードを要求（フラグ立て + console log）
router.post("/admin/stores/:storeId/request-license-reupload", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const [store] = await db
      .select({
        id: storesTable.id,
        name: storesTable.name,
        ownerId: storesTable.ownerId,
        stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
      })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (!store) { res.status(404).json({ error: "not_found" }); return; }

    // stripe_payouts_enabled = true の店舗は Stripe KYC 完了済みなので
    // 許可証再アップロード要求は無意味（Stripe 側で既に承認済み）
    if (store.stripePayoutsEnabled === true) {
      res.status(400).json({
        error: "already_stripe_verified",
        message: "この店舗はStripe KYCが完了しており、許可証は既に承認されています。再アップロード要求は不要です。",
      });
      return;
    }

    // フラグを再アップロード要求状態に
    await db.update(storesTable)
      .set({
        licenseUploadFailed: true,
        licenseUploadError: "admin_requested_reupload",
        licenseUploadAttemptedAt: new Date(),
      })
      .where(eq(storesTable.id, storeId));

    // 店主のメールアドレスを取得して将来のメール送信用にログ
    let ownerEmail: string | null = null;
    if (store.ownerId) {
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(store.ownerId);
        ownerEmail = data?.user?.email ?? null;
      } catch { /* ignore */ }
    }

    console.log(`📨 [admin] License reupload requested: storeId=${storeId} name="${store.name}" ownerEmail=${ownerEmail ?? "(none)"}`);

    res.json({
      ok: true,
      storeId,
      ownerEmail,
      message: "再アップロード要求を記録しました。 店主が次回ログイン時に通知されます。",
    });
  } catch (err: any) {
    console.error("[admin/request-license-reupload]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/stores ──────────────────────────────────────────────────────────
router.get("/admin/stores", requireAdmin, async (_req, res) => {
  try {
    // ⚠ 重要: bag と reservation を 1 クエリで JOIN すると Cartesian product が発生し
    // SUM(r.total_price) が bag 数倍に重複加算される (例: bag 6 個 × picked 1 件 ¥110 → ¥660)。
    // したがって bag 集計と reservation 集計は別サブクエリで先に GROUP BY してから JOIN する。
    const stores = await db.execute(sql`
      SELECT
        s.id, s.name, s.status, s.is_active, s.category, s.address, s.city,
        s.image_url, s.icon_url, s.owner_id, s.created_at, s.stripe_account_id,
        s.stripe_charges_enabled,
        s.stripe_payouts_enabled,
        s.show_on_map,
        COALESCE(b.bag_count, 0)::int AS bag_count,
        COALESCE(r.reservation_count, 0)::int AS reservation_count,
        COALESCE(r.revenue, 0)::numeric AS revenue,
        CASE WHEN s.owner_id IS NOT NULL THEN
          (SELECT COUNT(*)::int FROM stores s2 WHERE s2.owner_id = s.owner_id)
        ELSE 1 END AS owner_store_count,
        CASE WHEN s.owner_id IS NOT NULL THEN
          (SELECT COUNT(*)::int FROM stores s2 WHERE s2.owner_id = s.owner_id AND s2.id <= s.id)
        ELSE 1 END AS owner_store_rank
      FROM stores s
      LEFT JOIN (
        SELECT store_id, COUNT(*)::int AS bag_count
        FROM surprise_bags GROUP BY store_id
      ) b ON b.store_id = s.id
      LEFT JOIN (
        SELECT
          store_id,
          COUNT(*)::int AS reservation_count,
          COALESCE(SUM(total_price) FILTER (WHERE status IN ('confirmed','picked_up')), 0)::numeric AS revenue
        FROM reservations GROUP BY store_id
      ) r ON r.store_id = s.id
      ORDER BY s.created_at DESC
    `);
    res.json(stores.rows);
  } catch (err: any) {
    console.error("[admin/stores]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/recurring-monitor ──────────────────────────────────────────────
// 神モード: 全店の全定期出品テンプレを、今日の状態(公開予定/出品中/完売/取消/休み/未公開アラート)
// 付きで返す監視専用エンドポイント。 アクションボタンは無し(まず見るだけ)。
//   状態判定は recurring-publisher.ts / recurring.ts と同じ JST ロジックを踏襲。
//   - live(🟢出品中): is_active かつ 客に表示中のバッグがあり在庫あり
//   - soldout(🔴完売): 今日公開したが在庫0 / 持ち越しモードで完売して停止中
//   - pending(🔵公開予定): 今日が公開曜日・未公開・公開時刻前
//   - alert(⚠️未公開): 今日が公開曜日・公開時刻を過ぎたのに未公開(=公開漏れ疑い)
//   - withdrawn(⚫取消/停止): テンプレ自体が is_active=false(店が停止)。 updated_at で停止時刻が分かる
//   - off(🟡休み): 今日は公開曜日でない or skip_dates で休みに指定
//   - ended(🏁本日終了): 今日公開済みだが受取窓を過ぎて表示終了
router.get("/admin/recurring-monitor", requireAdmin, async (_req, res) => {
  try {
    // 各テンプレの集計(在庫/予約)を recurring_listing_id 単位で先に GROUP BY してから JOIN。
    //   ★ bagVisibleSql は surprise_bags を非エイリアスで参照するため、サブクエリの FROM も
    //     必ず非エイリアス `surprise_bags` にする(エイリアスを付けると列参照が壊れる)。
    const rows = (await db.execute(sql`
      SELECT
        r.id, r.store_id, r.title, r.publish_time, r.days_of_week, r.pickup_next_day,
        r.is_active, r.carry_over_stock, r.skip_dates, r.last_published_date,
        r.stock_count, r.discounted_price, r.original_price,
        r.pickup_start, r.pickup_end, r.pickup_start_2, r.pickup_end_2,
        to_char(r.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo','MM/DD HH24:MI') AS updated_jst,
        to_char(r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo','YYYY/MM/DD')    AS created_jst,
        s.name AS store_name, s.status AS store_status, s.owner_id,
        COALESCE(live.live_stock, 0)::int  AS live_stock,
        COALESCE(live.live_bags, 0)::int   AS live_bags,
        today.today_stock::int             AS today_stock,
        latest.latest_stock::int           AS latest_stock,
        COALESCE(resv.reserved_qty, 0)::int AS reserved_qty,
        COALESCE(resv.paid_qty, 0)::int     AS paid_qty
      FROM recurring_listings r
      JOIN stores s ON s.id = r.store_id
      LEFT JOIN (
        SELECT recurring_listing_id AS rid, SUM(stock_count)::int AS live_stock, COUNT(*)::int AS live_bags
        FROM surprise_bags
        WHERE recurring_listing_id IS NOT NULL AND is_active = true AND ${bagVisibleSql}
        GROUP BY recurring_listing_id
      ) live ON live.rid = r.id
      LEFT JOIN (
        SELECT recurring_listing_id AS rid, SUM(stock_count)::int AS today_stock
        FROM surprise_bags
        WHERE recurring_listing_id IS NOT NULL
          AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(now() AT TIME ZONE 'Asia/Tokyo')
        GROUP BY recurring_listing_id
      ) today ON today.rid = r.id
      LEFT JOIN (
        SELECT DISTINCT ON (recurring_listing_id) recurring_listing_id AS rid, stock_count AS latest_stock
        FROM surprise_bags
        WHERE recurring_listing_id IS NOT NULL
        ORDER BY recurring_listing_id, created_at DESC
      ) latest ON latest.rid = r.id
      LEFT JOIN (
        SELECT surprise_bags.recurring_listing_id AS rid,
          SUM(res.quantity)::int AS reserved_qty,
          COALESCE(SUM(res.quantity) FILTER (WHERE res.payment_status = 'paid'), 0)::int AS paid_qty
        FROM reservations res
        JOIN surprise_bags ON surprise_bags.id = res.bag_id
        WHERE surprise_bags.recurring_listing_id IS NOT NULL
          AND surprise_bags.is_active = true AND ${bagVisibleSql}
          AND res.status IN ('pending','confirmed')
        GROUP BY surprise_bags.recurring_listing_id
      ) resv ON resv.rid = r.id
      ORDER BY r.publish_time, r.id
    `)).rows as Array<Record<string, any>>;

    // ── JST 現在時刻 ──
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date());
    const gp = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    let hh = gp("hour"); if (hh === "24") hh = "00";
    const today = `${gp("year")}-${gp("month")}-${gp("day")}`;
    const nowTime = `${hh}:${gp("minute")}`;
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[gp("weekday")] ?? 0;
    const addDaysStr = (dateStr: string, n: number) => {
      const [y, m, d] = dateStr.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0"); const dd = String(dt.getUTCDate()).padStart(2, "0");
      return { date: `${dt.getUTCFullYear()}-${mm}-${dd}`, dow: dt.getUTCDay() };
    };

    const listings = rows.map((r) => {
      const daysOfWeek = Number(r.days_of_week);
      const pickupNextDay = !!r.pickup_next_day;
      const carryOver = !!r.carry_over_stock;
      const isActive = !!r.is_active;
      const skips = new Set(
        String(r.skip_dates ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      );
      // 今日この回が serve する受取日(前日出品なら翌日)。 曜日・休み判定はこの受取日ベース。
      const pickupDow = pickupNextDay ? (dow + 1) % 7 : dow;
      const scheduledToday = (daysOfWeek & (1 << pickupDow)) !== 0;
      const pickupDate = pickupNextDay ? addDaysStr(today, 1).date : today;
      const skippedToday = skips.has(pickupDate);
      const publishedToday = r.last_published_date === today;
      const pastPublishTime = nowTime >= String(r.publish_time);

      const liveStock = Number(r.live_stock ?? 0);
      const hasLive = Number(r.live_bags ?? 0) > 0 && liveStock > 0;
      const todayStock = r.today_stock == null ? null : Number(r.today_stock);
      const latestStock = r.latest_stock == null ? null : Number(r.latest_stock);

      // 次回自動公開 JST 日付(休み/曜日/公開済みを考慮、31日先まで探索)。
      const nextPublishDate = (() => {
        for (let i = 0; i < 31; i++) {
          const cur = i === 0 ? { date: today, dow } : addDaysStr(today, i);
          const pdow = pickupNextDay ? (cur.dow + 1) % 7 : cur.dow;
          if ((daysOfWeek & (1 << pdow)) === 0) continue;
          const pd = pickupNextDay ? addDaysStr(cur.date, 1).date : cur.date;
          if (skips.has(pd)) continue;
          if (i === 0) { if (!publishedToday && nowTime < String(r.publish_time)) return cur.date; continue; }
          return cur.date;
        }
        return null;
      })();

      // ── 状態判定(優先順) ──
      let status:
        | "withdrawn" | "live" | "soldout" | "alert" | "pending" | "off" | "ended";
      if (!isActive) status = "withdrawn";
      else if (hasLive) status = "live";
      else if (carryOver && latestStock != null && latestStock <= 0) status = "soldout";
      else if (publishedToday && todayStock != null && todayStock <= 0) status = "soldout";
      else if (!scheduledToday || skippedToday) status = "off";
      else if (!publishedToday) status = pastPublishTime ? "alert" : "pending";
      else status = "ended"; // 今日公開済みだが表示窓を過ぎた

      return {
        id: Number(r.id),
        storeId: Number(r.store_id),
        storeName: r.store_name as string,
        storeStatus: r.store_status as string,
        title: r.title as string,
        status,
        publishTime: r.publish_time as string,
        daysOfWeek,
        pickupNextDay,
        carryOverStock: carryOver,
        isActive,
        pickupStart: r.pickup_start as string | null,
        pickupEnd: r.pickup_end as string | null,
        pickupStart2: r.pickup_start_2 as string | null,
        pickupEnd2: r.pickup_end_2 as string | null,
        discountedPrice: Number(r.discounted_price),
        originalPrice: Number(r.original_price),
        stockCount: Number(r.stock_count),
        liveStock,
        liveBags: Number(r.live_bags ?? 0),
        todayStock,
        latestStock,
        reservedQty: Number(r.reserved_qty ?? 0),
        paidQty: Number(r.paid_qty ?? 0),
        lastPublishedDate: r.last_published_date as string | null,
        publishedToday,
        scheduledToday,
        skippedToday,
        nextPublishDate,
        updatedJst: r.updated_jst as string,
        createdJst: r.created_jst as string,
      };
    });

    const summary = {
      total: listings.length,
      live: listings.filter((l) => l.status === "live").length,
      pending: listings.filter((l) => l.status === "pending").length,
      soldout: listings.filter((l) => l.status === "soldout").length,
      alert: listings.filter((l) => l.status === "alert").length,
      withdrawn: listings.filter((l) => l.status === "withdrawn").length,
      off: listings.filter((l) => l.status === "off").length,
      ended: listings.filter((l) => l.status === "ended").length,
      liveStock: listings.reduce((a, l) => a + l.liveStock, 0),
      reservedQty: listings.reduce((a, l) => a + l.reservedQty, 0),
    };

    res.json({ today, nowTime, summary, listings });
  } catch (err: any) {
    console.error("[admin/recurring-monitor]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/stores/:storeId/detail ─────────────────────────────────────────
// 店舗詳細（全フィールド＋オーナーメール）
router.get("/admin/stores/:storeId/detail", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    // ⚠ /admin/stores と同じ理由で bag/reservation を別サブクエリ化 (Cartesian 防止)
    const result = await db.execute(sql`
      SELECT
        s.id, s.name, s.description, s.status, s.is_active, s.category,
        s.address, s.city, s.lat, s.lng, s.image_url, s.icon_url, s.phone,
        s.open_time, s.close_time, s.holiday, s.pickup_hours,
        s.owner_id, s.created_at, s.stripe_account_id,
        s.stripe_charges_enabled, s.stripe_payouts_enabled,
        s.license_number, s.license_image_url, s.stripe_license_file_id, s.id_image_url, s.pledge_signed,
        s.legal_name, s.legal_representative, s.legal_address,
        s.legal_phone, s.legal_email, s.legal_other,
        s.show_on_map,
        (SELECT COUNT(*)::int FROM surprise_bags WHERE store_id = s.id) AS bag_count,
        (SELECT COUNT(*)::int FROM reservations  WHERE store_id = s.id) AS reservation_count,
        (SELECT COALESCE(SUM(total_price) FILTER (WHERE status IN ('confirmed','picked_up')), 0)::numeric
           FROM reservations WHERE store_id = s.id) AS revenue,
        (SELECT COUNT(*)::int FROM favorites    WHERE store_id = s.id) AS favorite_count,
        (SELECT COUNT(*)::int FROM reviews      WHERE store_id = s.id) AS review_count,
        (SELECT COUNT(*)::int FROM reports      WHERE store_id = s.id) AS report_count,
        (SELECT COUNT(*)::int FROM notifications WHERE store_id = s.id) AS notification_count,
        (SELECT COUNT(*)::int FROM cart_reservations cr
           WHERE cr.bag_id IN (SELECT id FROM surprise_bags WHERE store_id = s.id)
              OR cr.reservation_id IN (SELECT id FROM reservations WHERE store_id = s.id)
        ) AS cart_reservation_count
      FROM stores s
      WHERE s.id = ${storeId}
    `);
    if (!result.rows[0]) { res.status(404).json({ error: "not_found" }); return; }
    const store = result.rows[0] as any;

    // オーナーのメールアドレスを Supabase から取得
    let ownerEmail: string | null = null;
    if (store.owner_id) {
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(store.owner_id);
        ownerEmail = data?.user?.email ?? null;
      } catch { /* ignore */ }
    }

    // ── Stripe ライブステータスを取得して DB も最新化 ────────────────────────
    let stripeRequirements: Record<string, any> | null = null;
    if (store.stripe_account_id) {
      const stripeKey = process.env["STRIPE_SECRET_KEY"];
      if (stripeKey) {
        try {
          const stripe = await import("stripe").then((m) => new m.default(stripeKey));
          const account = await stripe.accounts.retrieve(store.stripe_account_id as string);

          stripeRequirements = {
            currently_due:        account.requirements?.currently_due ?? [],
            eventually_due:       account.requirements?.eventually_due ?? [],
            errors:               account.requirements?.errors ?? [],
            disabled_reason:      account.requirements?.disabled_reason ?? null,
            pending_verification: account.requirements?.pending_verification ?? [],
          };

          // ── Stripe metadata から stripe_license_file_id を同期 ──────────
          // DB に値がなくてもメタデータに保存されていれば復元する
          const metaFileId = (account.metadata as any)?.license_file_id;
          const dbFileId   = (store as any).stripe_license_file_id;

          // メタデータに有効な file ID（"file_..." で始まる）があれば採用
          const resolvedFileId: string | null =
            dbFileId ?? (metaFileId?.startsWith('file_') ? metaFileId : null);

          // DB が空でメタデータに値があれば DB に書き戻す
          if (!dbFileId && resolvedFileId) {
            await db.update(storesTable)
              .set({ stripeLicenseFileId: resolvedFileId } as any)
              .where(eq(storesTable.id, storeId));
            console.log(`[admin/stores/detail] ✅ stripe_license_file_id を DB に復元: ${resolvedFileId}`);
          }

          // レスポンス用フィールドを上書き
          (store as any).stripe_license_file_id = resolvedFileId;

          // DB に最新値を書き込む（charges/payouts）
          // payouts_enabled = true なら Stripe KYC 完了とみなし、
          // 古い license_upload_failed フラグを自動クリアして
          // 「許可証問題あり」一覧から消えるようにする
          const dbPatch: any = {
            stripeChargesEnabled: account.charges_enabled,
            stripePayoutsEnabled: account.payouts_enabled,
          };
          if (account.payouts_enabled) {
            dbPatch.licenseUploadFailed = false;
            dbPatch.licenseUploadError = null;
          }
          await db.update(storesTable).set(dbPatch).where(eq(storesTable.id, storeId));

          // レスポンスのフィールドも最新値で上書き
          (store as any).stripe_charges_enabled = account.charges_enabled;
          (store as any).stripe_payouts_enabled = account.payouts_enabled;
          if (account.payouts_enabled) {
            (store as any).license_upload_failed = false;
            (store as any).license_upload_error = null;
          }

          console.log(`[admin/stores/detail] Stripe live fetch: storeId=${storeId} acct=${store.stripe_account_id} charges=${account.charges_enabled} payouts=${account.payouts_enabled} due=${stripeRequirements.currently_due.length}`);
        } catch (stripeErr: any) {
          console.warn(`[admin/stores/detail] Stripe fetch failed: ${stripeErr?.message}`);
          stripeRequirements = { error: stripeErr?.code ?? "stripe_error", message: stripeErr?.message };
        }
      }
    }

    res.json({ ...store, owner_email: ownerEmail, stripe_requirements: stripeRequirements });
  } catch (err: any) {
    console.error("[admin/stores/detail]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── refresh-stripe-status は廃止 ───────────────────────────────────────────────
// GET /admin/stores/:storeId/detail が同等処理 (Stripe live fetch + DB 更新) を含むため重複。
// detail GET 側に統合済み。

// ── POST /admin/stores/:storeId/stripe-sync ────────────────────────────────
// 管理者専用の完全 Stripe 再同期（requireStoreOwner を使わない）
// DB 更新 + licenseUploadFailed 自動クリア + AdminDashboard 互換レスポンス
router.post("/admin/stores/:storeId/stripe-sync", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const [store] = await db
      .select({ id: storesTable.id, stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (!store) { res.status(404).json({ error: "not_found" }); return; }
    if (!store.stripeAccountId) {
      res.status(400).json({ error: "no_stripe_account", message: "Stripeアカウントが未登録です" });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) { res.status(503).json({ error: "stripe_not_configured" }); return; }

    let chargesEnabled = false;
    let payoutsEnabled = false;
    let detailsSubmitted = false;
    let licenseFileId: string | null = null;
    let stripeError: string | null = null;
    let requirements: Record<string, any> | null = null;

    try {
      const stripe = await import("stripe").then((m) => new m.default(stripeKey));
      const account = await stripe.accounts.retrieve(store.stripeAccountId);
      chargesEnabled  = account.charges_enabled  ?? false;
      payoutsEnabled  = account.payouts_enabled   ?? false;
      detailsSubmitted = account.details_submitted ?? false;
      requirements = {
        currently_due:        account.requirements?.currently_due        ?? [],
        eventually_due:       account.requirements?.eventually_due       ?? [],
        errors:               account.requirements?.errors               ?? [],
        disabled_reason:      account.requirements?.disabled_reason      ?? null,
        pending_verification: account.requirements?.pending_verification ?? [],
      };
      // Stripe メタデータから license_file_id を取得
      const metaFileId = (account.metadata as any)?.license_file_id;
      if (metaFileId?.startsWith?.("file_")) licenseFileId = metaFileId;
      console.log(`[admin/stripe-sync] storeId=${storeId} charges=${chargesEnabled} payouts=${payoutsEnabled} licenseFileId=${licenseFileId}`);
    } catch (stripeErr: any) {
      stripeError = stripeErr?.code ?? stripeErr?.type ?? "stripe_error";
      console.warn(`[admin/stripe-sync] Stripe error storeId=${storeId}:`, stripeErr?.message);
    }

    // DB 更新
    const dbPatch: Record<string, any> = {
      stripeChargesEnabled: stripeError ? false : chargesEnabled,
      stripePayoutsEnabled: stripeError ? false : payoutsEnabled,
    };
    if (!stripeError && licenseFileId) dbPatch.stripeLicenseFileId = licenseFileId;
    // payouts_enabled = true なら KYC 完了済み → 許可証フラグを自動クリア
    if (!stripeError && payoutsEnabled) {
      dbPatch.licenseUploadFailed = false;
      dbPatch.licenseUploadError  = null;
    }
    await db.update(storesTable).set(dbPatch as any).where(eq(storesTable.id, storeId));

    res.json({
      synced: true,
      stripeAccountId:  store.stripeAccountId,
      chargesEnabled:   stripeError ? false : chargesEnabled,
      payoutsEnabled:   stripeError ? false : payoutsEnabled,
      detailsSubmitted: stripeError ? false : detailsSubmitted,
      licenseFileId:    stripeError ? null  : licenseFileId,
      requirements:     stripeError ? null  : requirements,
      stripeError,
    });
  } catch (err: any) {
    console.error("[admin/stripe-sync]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/stripe-disconnect ─────────────────────────────
// 管理者専用の Stripe 口座リセット（requireStoreOwner を使わない）
router.post("/admin/stores/:storeId/stripe-disconnect", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const [store] = await db
      .select({ id: storesTable.id, name: storesTable.name })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (!store) { res.status(404).json({ error: "not_found" }); return; }

    await db.update(storesTable)
      .set({
        stripeAccountId: null,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeLicenseFileId: null,
      } as any)
      .where(eq(storesTable.id, storeId));

    await writeAuditLog(req, "admin_stripe_disconnect", storeId, { storeName: store.name });
    res.json({ ok: true, message: "Stripe account disconnected." });
  } catch (err: any) {
    console.error("[admin/stripe-disconnect]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/batch-refresh-stripe ───────────────────────────────────
// stripeAccountId を持つ全店舗の charges_enabled をまとめて更新して返す。
// 1万店舗規模では同一 stripeAccountId が複数店舗で共有されるため、
// 「ユニークな accountId 単位」でAPIコールし、重複呼び出しを排除して rate limit 衝突を回避。
// 加えて並列上限（CONCURRENCY=8）で Stripe rate limit (~100 req/sec) に余裕を持たせる。
router.post("/admin/stores/batch-refresh-stripe", requireAdmin, async (req, res) => {
  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!stripeKey) { res.status(503).json({ error: "stripe_not_configured" }); return; }
  try {
    const rows = await db
      .select({ id: storesTable.id, stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(isNotNull(storesTable.stripeAccountId));

    // accountId → [storeId, ...] にグルーピング（同一オーナー多店舗を1コールにまとめる）
    const accountIdToStoreIds = new Map<string, number[]>();
    for (const row of rows) {
      const acct = row.stripeAccountId!;
      const list = accountIdToStoreIds.get(acct) ?? [];
      list.push(row.id);
      accountIdToStoreIds.set(acct, list);
    }
    const accountIds = Array.from(accountIdToStoreIds.keys());

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // 並列数制限ヘルパー（外部依存追加なし）
    const CONCURRENCY = 8;
    const updated: Record<number, boolean> = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, accountIds.length) }, async () => {
      while (cursor < accountIds.length) {
        const idx = cursor++;
        const acct = accountIds[idx];
        const storeIds = accountIdToStoreIds.get(acct) ?? [];
        try {
          const account = await stripe.accounts.retrieve(acct);
          const metaFileId = (account.metadata as any)?.license_file_id;
          const licenseFileId: string | null = metaFileId?.startsWith?.("file_") ? metaFileId : null;
          const patch: Record<string, any> = {
            stripeChargesEnabled: account.charges_enabled,
            stripePayoutsEnabled: account.payouts_enabled,
          };
          if (licenseFileId) patch.stripeLicenseFileId = licenseFileId;

          // 同一 accountId を持つ全店舗を 1 クエリで一括更新
          await db
            .update(storesTable)
            .set(patch as any)
            .where(eq(storesTable.stripeAccountId, acct));

          for (const sid of storeIds) updated[sid] = !!account.charges_enabled;
        } catch (innerErr: any) {
          console.warn(`[admin/batch-refresh-stripe] account ${acct} 失敗: ${innerErr?.message}`);
        }
      }
    });
    await Promise.all(workers);

    res.json({ updated, accounts: accountIds.length, stores: rows.length });
  } catch (err: any) {
    console.error("[admin/batch-refresh-stripe]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/approve ───────────────────────────────────────
router.post("/admin/stores/:storeId/approve", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    // Stripe口座があって charges_enabled === false なら承認をブロック
    const [storeCheck] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, stripeChargesEnabled: storesTable.stripeChargesEnabled })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (storeCheck?.stripeAccountId && storeCheck.stripeChargesEnabled === false) {
      res.status(400).json({
        error: "stripe_restricted",
        message: "このアカウントはStripeで制限中のため承認できません。Stripeダッシュボードで書類不備を解消してください。",
      });
      return;
    }

    const [updated] = await db
      .update(storesTable)
      .set({ status: "approved", isActive: true })
      .where(eq(storesTable.id, storeId))
      .returning();
    if (!updated) { res.status(404).json({ error: "not_found" }); return; }

    // オーナーに通知
    if (updated.ownerId) {
      await db.insert(notificationsTable).values({
        userId: updated.ownerId,
        type: "store_approved",
        title: "🎉 店舗が承認されました",
        body: `${updated.name} の審査が完了しました。今すぐおすそわけバッグを出品できます！`,
        read: false,
      }).catch(() => {});

      // オーナーへの承認メール（おすそわけ事務局から）
      const resendApiKey = process.env.RESEND_API_KEY;
      if (resendApiKey) {
        try {
          const resend = new Resend(resendApiKey);
          const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
          const { data: ownerAuth } = await supabaseAdmin.auth.admin.getUserById(updated.ownerId);
          const ownerEmail = ownerAuth?.user?.email;
          const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost'}`;
          if (ownerEmail) {
            await resend.emails.send({
              from: `おすそわけ事務局 <${fromDomain}>`,
              to: ownerEmail,
              subject: `【おすそわけ】${updated.name}の審査が完了しました 🎉`,
              html: `
<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fff8f0;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 4px 24px rgba(242,100,25,0.10);">
  <div style="background:linear-gradient(135deg,#F26419 0%,#F6AE2D 100%);padding:44px 32px 36px;text-align:center;">
    <div style="font-size:52px;margin-bottom:14px;">🎉</div>
    <h1 style="color:#fff;font-size:24px;font-weight:900;margin:0 0 8px;letter-spacing:-0.5px;">おめでとうございます！</h1>
    <p style="color:rgba(255,255,255,0.9);font-size:14px;margin:0;">審査が通過しました</p>
  </div>
  <div style="padding:36px 32px;">
    <p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 20px;">
      <strong>${escapeHtml(updated.name)}</strong> オーナー様<br><br>
      この度はおすそわけにご参加いただき、ありがとうございます。<br>
      審査が完了し、<strong style="color:#F26419;">本日よりおすそわけバッグの出品が可能</strong>になりました！<br><br>
      地域の食品ロス削減に、ぜひご一緒しましょう。応援しています 🧡
    </p>
    <div style="background:#fff8f0;border-radius:16px;padding:20px 24px;margin:0 0 28px;">
      <p style="font-size:13px;font-weight:900;color:#F26419;margin:0 0 10px;">🏪 次のステップ</p>
      <p style="font-size:13px;color:#555;line-height:1.7;margin:0;">
        ① ストアダッシュボードから銀行口座を登録する<br>
        ② 口座審査が完了したら（通常1〜3営業日）出品開始！<br>
        ③ 審査完了のご連絡はおすそわけ事務局よりお送りします
      </p>
    </div>
    <div style="text-align:center;">
      <a href="${appUrl}/store/dashboard" style="display:inline-block;background:linear-gradient(135deg,#F26419,#F6AE2D);color:#fff;font-size:16px;font-weight:900;padding:18px 52px;border-radius:16px;text-decoration:none;letter-spacing:0.5px;">
        ダッシュボードへ進む →
      </a>
    </div>
    <p style="font-size:12px;color:#aaa;margin:28px 0 0;text-align:center;">
      おすそわけ事務局 ｜ ご不明な点はアプリ内LINEサポートへ
    </p>
  </div>
</div>
</body></html>`.trim(),
            });
          }
        } catch (mailErr: any) {
          console.warn("[admin/approve] メール送信エラー:", mailErr?.message);
        }
      }
    }

    res.json({ ok: true, store: updated });
  } catch (err: any) {
    console.error("[admin/approve]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/show-on-map ───────────────────────────────────
// 口座設定未完了でもマップに表示させる管理者フラグのトグル
router.post("/admin/stores/:storeId/show-on-map", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  const { showOnMap } = req.body as { showOnMap: boolean };
  if (typeof showOnMap !== "boolean") { res.status(400).json({ error: "bad_request", message: "showOnMap must be boolean" }); return; }
  try {
    // showOnMap=true は管理者の強制表示フラグ → 同時に is_active=true にして
    // SQL の `isActive=true` 必須条件を満たす
    const [updated] = await db
      .update(storesTable)
      .set(showOnMap ? { showOnMap: true, isActive: true } : { showOnMap: false })
      .where(eq(storesTable.id, storeId))
      .returning();
    if (!updated) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ ok: true, store: updated });
  } catch (err: any) {
    console.error("[admin/show-on-map]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/migrate-data-urls ─────────────────────────────────────
// 過去のバグで image_url / icon_url が `data:image/...;base64,...` 形式で DB に
// 保存されてしまった店舗のデータを、 Supabase Storage にアップロードして正規 URL に
// 差し替える一発リカバリ。 オーナーに再アップを頼まずに既存データを修復できる。
router.post("/admin/stores/migrate-data-urls", requireAdmin, async (_req, res) => {
  // 画像実体の magic number 判定 (upload.ts と同等ロジックの最小実装)
  const detectMime = (buf: Buffer): { mime: string; ext: string } | null => {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: "image/gif", ext: "gif" };
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
     && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { mime: "image/webp", ext: "webp" };
    return null;
  };

  // 戻り値に storage path も含める → DB更新失敗時に補償削除可能にする
  const uploadDataUrl = async (dataUrl: string, ownerId: string): Promise<{ url: string; path: string }> => {
    const m = /^data:([^;,]+)?(?:;base64)?,(.+)$/.exec(dataUrl);
    if (!m) throw new Error("Invalid data URL format");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length < 12 || buf.length > 10 * 1024 * 1024) {
      throw new Error(`Invalid size: ${buf.length} bytes`);
    }
    const detected = detectMime(buf);
    if (!detected) throw new Error("Cannot detect image type from bytes");
    const safeOwner = (ownerId || "unknown").replace(/[^a-z0-9-]/gi, "");
    const fileName = `${safeOwner}/migrated-${Date.now()}-${Math.random().toString(36).slice(2)}.${detected.ext}`;
    const { error } = await supabaseAdmin.storage.from("bag-images").upload(fileName, buf, {
      contentType: detected.mime,
      upsert: false,
      cacheControl: "31536000, immutable",
    });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    const { data: { publicUrl } } = supabaseAdmin.storage.from("bag-images").getPublicUrl(fileName);
    return { url: publicUrl, path: fileName };
  };

  // 補償削除 (DB更新失敗時に Storage から孤児ファイルを除去)
  const removeUploaded = async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      await supabaseAdmin.storage.from("bag-images").remove(paths);
    } catch (e) {
      console.warn("[admin/migrate-data-urls] failed to remove orphaned objects:", paths, e);
    }
  };

  try {
    // 対象店舗を取得 (image_url または icon_url が data: で始まるもの)
    const targets = await db.execute(sql`
      SELECT id, name, owner_id, image_url, icon_url
      FROM stores
      WHERE image_url LIKE 'data:%' OR icon_url LIKE 'data:%'
    `);
    const rows = (targets as any).rows ?? targets;

    const results: Array<{ id: number; name: string; image: "ok" | "skip" | "fail"; icon: "ok" | "skip" | "fail"; error?: string }> = [];

    for (const row of rows as Array<{ id: number; name: string; owner_id: string; image_url: string | null; icon_url: string | null }>) {
      const result: { id: number; name: string; image: "ok" | "skip" | "fail"; icon: "ok" | "skip" | "fail"; error?: string } = {
        id: row.id, name: row.name, image: "skip", icon: "skip",
      };
      // 行単位で完全に隔離: アップロード/DB更新の失敗はこの店舗の result に閉じ、
      // バッチ全体の処理は継続させる。
      try {
        const patch: { imageUrl?: string; iconUrl?: string } = {};
        const uploadedPaths: string[] = []; // DB更新失敗時の補償削除用

        if (row.image_url && row.image_url.startsWith("data:")) {
          try {
            const { url, path } = await uploadDataUrl(row.image_url, row.owner_id);
            patch.imageUrl = url;
            uploadedPaths.push(path);
            result.image = "ok";
          } catch (e: any) {
            result.image = "fail";
            result.error = `image: ${e?.message ?? "unknown"}`;
          }
        }
        if (row.icon_url && row.icon_url.startsWith("data:")) {
          try {
            const { url, path } = await uploadDataUrl(row.icon_url, row.owner_id);
            patch.iconUrl = url;
            uploadedPaths.push(path);
            result.icon = "ok";
          } catch (e: any) {
            result.icon = "fail";
            result.error = (result.error ? result.error + " | " : "") + `icon: ${e?.message ?? "unknown"}`;
          }
        }

        if (Object.keys(patch).length > 0) {
          try {
            await db.update(storesTable).set(patch).where(eq(storesTable.id, row.id));
          } catch (dbErr: any) {
            // DB更新が落ちたら、直前にアップロードしたファイルは孤児になるので削除
            await removeUploaded(uploadedPaths);
            if (patch.imageUrl) result.image = "fail";
            if (patch.iconUrl)  result.icon  = "fail";
            result.error = (result.error ? result.error + " | " : "") + `db: ${dbErr?.message ?? "unknown"}`;
          }
        }
      } catch (rowErr: any) {
        // 想定外の例外も呑み込んでバッチ継続
        result.image = result.image === "ok" ? "ok" : "fail";
        result.icon  = result.icon  === "ok" ? "ok" : "fail";
        result.error = (result.error ? result.error + " | " : "") + `unexpected: ${rowErr?.message ?? "unknown"}`;
      }
      results.push(result);
    }

    const summary = {
      total: results.length,
      imageMigrated: results.filter(r => r.image === "ok").length,
      iconMigrated:  results.filter(r => r.icon === "ok").length,
      failed:        results.filter(r => r.image === "fail" || r.icon === "fail").length,
    };
    console.log("[admin/migrate-data-urls]", summary);
    res.json({ ok: true, summary, results });
  } catch (err: any) {
    console.error("[admin/migrate-data-urls]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/suspend ───────────────────────────────────────
router.post("/admin/stores/:storeId/suspend", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const [updated] = await db
      .update(storesTable)
      .set({ isActive: false })
      .where(eq(storesTable.id, storeId))
      .returning();
    if (!updated) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ ok: true, store: updated });
  } catch (err: any) {
    console.error("[admin/suspend]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/:storeId/reject ────────────────────────────────────────
router.post("/admin/stores/:storeId/reject", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  const { rejectionReason } = req.body as { rejectionReason?: string };
  try {
    const [updated] = await db
      .update(storesTable)
      .set({
        status: "rejected",
        isActive: false,
        ...(rejectionReason?.trim() ? { rejectionReason: rejectionReason.trim() } : {}),
      })
      .where(eq(storesTable.id, storeId))
      .returning();
    if (!updated) { res.status(404).json({ error: "not_found" }); return; }

    // オーナーへの却下通知（アプリ内 + メール）
    if (updated.ownerId) {
      await db.insert(notificationsTable).values({
        userId: updated.ownerId,
        type: "store_rejected",
        title: "📋 申請内容についてご連絡があります",
        body: `${updated.name} の申請について、おすそわけ事務局よりご連絡があります。アプリをご確認ください。`,
        read: false,
      }).catch(() => {});

      // 却下メール（おすそわけ事務局から）
      const resendApiKey = process.env.RESEND_API_KEY;
      if (resendApiKey) {
        try {
          const resend = new Resend(resendApiKey);
          const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
          const { data: ownerAuth } = await supabaseAdmin.auth.admin.getUserById(updated.ownerId);
          const ownerEmail = ownerAuth?.user?.email;
          const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost'}`;
          const reason = rejectionReason?.trim() ?? "申請内容に確認が必要な点がございました。";
          if (ownerEmail) {
            await resend.emails.send({
              from: `おすそわけ事務局 <${fromDomain}>`,
              to: ownerEmail,
              subject: `【おすそわけ】${updated.name}の申請についてご連絡`,
              html: `
<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#fff8f0;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#F26419 0%,#F6AE2D 100%);padding:44px 32px 36px;text-align:center;">
    <div style="font-size:52px;margin-bottom:14px;">📋</div>
    <h1 style="color:#fff;font-size:22px;font-weight:900;margin:0 0 8px;">申請内容についてご連絡</h1>
    <p style="color:rgba(255,255,255,0.9);font-size:14px;margin:0;">おすそわけ事務局</p>
  </div>
  <div style="padding:36px 32px;">
    <p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 20px;">
      <strong>${escapeHtml(updated.name)}</strong> オーナー様<br><br>
      この度はおすそわけへご申請いただき、誠にありがとうございます。<br>
      事務局にて内容を確認しましたところ、いくつかご確認いただきたい点がございました。
    </p>
    <div style="background:#fff3cd;border-left:4px solid #F6AE2D;border-radius:0 12px 12px 0;padding:16px 20px;margin:0 0 24px;">
      <p style="font-size:13px;font-weight:900;color:#856404;margin:0 0 8px;">📝 事務局からのメッセージ</p>
      <p style="font-size:14px;color:#333;line-height:1.7;margin:0;">${escapeHtml(reason)}</p>
    </div>
    <p style="font-size:14px;line-height:1.8;color:#555;margin:0 0 24px;">
      修正・再申請いただければ、改めて事務局にて確認いたします。<br>
      ご不明な点がございましたら、アプリ内のLINEサポートよりお気軽にご連絡ください。<br>
      引き続きよろしくお願いいたします 🧡
    </p>
    <div style="text-align:center;">
      <a href="${appUrl}/bank-setup" style="display:inline-block;background:linear-gradient(135deg,#F26419,#F6AE2D);color:#fff;font-size:15px;font-weight:900;padding:16px 48px;border-radius:16px;text-decoration:none;">
        再申請する →
      </a>
    </div>
    <p style="font-size:12px;color:#aaa;margin:28px 0 0;text-align:center;">
      おすそわけ事務局 ｜ ご不明な点はアプリ内LINEサポートへ
    </p>
  </div>
</div>
</body></html>`.trim(),
            });
          }
        } catch (mailErr: any) {
          console.warn("[admin/reject] メール送信エラー:", mailErr?.message);
        }
      }
    }

    res.json({ ok: true, store: updated });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── DELETE /admin/stores/:storeId (店舗削除) ──────────────────────────────────
// 店舗を完全削除する（関連レコードもトランザクションでカスケード削除）
// stores テーブルには FK が設定されていないため手動でクリーンアップする必要がある。
router.delete("/admin/stores/:storeId", requireAdmin, async (req, res) => {
  const storeId = Number(req.params.storeId);
  if (isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  console.log(`[admin/stores/delete] start storeId=${storeId}`);
  try {
    // 存在確認 (Drizzle / read は RLS の影響を受けない)
    const [target] = await db.select({ id: storesTable.id, name: storesTable.name, status: storesTable.status })
      .from(storesTable).where(eq(storesTable.id, storeId));
    if (!target) { res.status(404).json({ error: "not_found" }); return; }
    console.log(`[admin/stores/delete] target found: ${target.name}`);

    // bag_id / reservation_id を取得（cart_reservations 削除のため）
    const bagRows  = await db.select({ id: surpriseBagsTable.id }).from(surpriseBagsTable).where(eq(surpriseBagsTable.storeId, storeId));
    const resvRows = await db.select({ id: reservationsTable.id }).from(reservationsTable).where(eq(reservationsTable.storeId, storeId));
    const bagIds  = bagRows.map((b) => b.id);
    const resvIds = resvRows.map((r) => r.id);
    console.log(`[admin/stores/delete] bagIds=${JSON.stringify(bagIds)} resvIds=${JSON.stringify(resvIds)}`);

    // ── supabaseAdmin (service_role) で削除 — RLS を完全バイパス ─────────────
    // service_role は Supabase の RLS deny ポリシーを回避できる唯一の確実な方法。
    // トランザクションはないが FK 順に削除するため整合性は保たれる。

    // 1) cart_reservations (bag_id 経由)
    let cartDeleted = 0;
    if (bagIds.length > 0) {
      const { data: cd1, error: e1 } = await supabaseAdmin.from("cart_reservations").delete().in("bag_id", bagIds).select("id");
      if (e1) throw Object.assign(new Error(e1.message), { step: "cart_resv/bag", detail: e1.details });
      cartDeleted += (cd1?.length ?? 0);
      console.log(`[admin/stores/delete] step1a cart_reservations by bag_id: ${cd1?.length}`);
    }
    // 2) cart_reservations (reservation_id 経由)
    if (resvIds.length > 0) {
      const { data: cd2, error: e2 } = await supabaseAdmin.from("cart_reservations").delete().in("reservation_id", resvIds).select("id");
      if (e2) throw Object.assign(new Error(e2.message), { step: "cart_resv/resv", detail: e2.details });
      cartDeleted += (cd2?.length ?? 0);
      console.log(`[admin/stores/delete] step1b cart_reservations by resv_id: ${cd2?.length}`);
    }
    // 3) reviews
    console.log(`[admin/stores/delete] step2 deleting reviews...`);
    const { data: revDel, error: eRev } = await supabaseAdmin.from("reviews").delete().eq("store_id", storeId).select("id");
    if (eRev) throw Object.assign(new Error(eRev.message), { step: "reviews", detail: eRev.details });
    console.log(`[admin/stores/delete] step2 reviews: ${revDel?.length}`);

    // 4) reports
    console.log(`[admin/stores/delete] step3 deleting reports...`);
    const { data: repDel, error: eRep } = await supabaseAdmin.from("reports").delete().eq("store_id", storeId).select("id");
    if (eRep) throw Object.assign(new Error(eRep.message), { step: "reports", detail: eRep.details });
    console.log(`[admin/stores/delete] step3 reports: ${repDel?.length}`);

    // 5) favorites (ON DELETE CASCADE で自動削除される場合もあるが念のため)
    console.log(`[admin/stores/delete] step4 deleting favorites...`);
    const { data: favDel, error: eFav } = await supabaseAdmin.from("favorites").delete().eq("store_id", storeId).select("id");
    if (eFav) throw Object.assign(new Error(eFav.message), { step: "favorites", detail: eFav.details });
    console.log(`[admin/stores/delete] step4 favorites: ${favDel?.length}`);

    // 6) notifications
    console.log(`[admin/stores/delete] step5 deleting notifications...`);
    const { data: notifDel, error: eNotif } = await supabaseAdmin.from("notifications").delete().eq("store_id", storeId).select("id");
    if (eNotif) throw Object.assign(new Error(eNotif.message), { step: "notifications", detail: eNotif.details });
    console.log(`[admin/stores/delete] step5 notifications: ${notifDel?.length}`);

    // 7) reservations
    console.log(`[admin/stores/delete] step6 deleting reservations...`);
    const { data: resvDel, error: eResv } = await supabaseAdmin.from("reservations").delete().eq("store_id", storeId).select("id");
    if (eResv) throw Object.assign(new Error(eResv.message), { step: "reservations", detail: eResv.details });
    console.log(`[admin/stores/delete] step6 reservations: ${resvDel?.length}`);

    // 8) surprise_bags
    console.log(`[admin/stores/delete] step7 deleting surprise_bags...`);
    const { data: bagsDel, error: eBags } = await supabaseAdmin.from("surprise_bags").delete().eq("store_id", storeId).select("id");
    if (eBags) throw Object.assign(new Error(eBags.message), { step: "surprise_bags", detail: eBags.details });
    console.log(`[admin/stores/delete] step7 surprise_bags: ${bagsDel?.length}`);

    // 9) stores 本体
    console.log(`[admin/stores/delete] step8 deleting store...`);
    const { data: storeDel, error: eStore } = await supabaseAdmin.from("stores").delete().eq("id", storeId).select("id,name,status");
    if (eStore) throw Object.assign(new Error(eStore.message), { step: "store", detail: eStore.details });
    console.log(`[admin/stores/delete] step8 store deleted: ${storeDel?.[0]?.id}`);

    const cascade = {
      cart_reservations: cartDeleted,
      reviews:       revDel?.length  ?? 0,
      reports:       repDel?.length  ?? 0,
      favorites:     favDel?.length  ?? 0,
      notifications: notifDel?.length ?? 0,
      reservations:  resvDel?.length  ?? 0,
      surprise_bags: bagsDel?.length  ?? 0,
    };

    await writeAuditLog(req, "store_delete", storeId, {
      name:    target.name,
      status:  target.status,
      cascade,
    });

    console.log(`[admin/stores/delete] success storeId=${storeId}`);
    res.json({ ok: true, store: storeDel?.[0], cascade });
  } catch (err: any) {
    console.error("[admin/stores/delete] FAILED:", err?.message, err?.step, err?.detail);
    res.status(500).json({ error: "internal_error", message: err?.message, step: err?.step, detail: err?.detail });
  }
});

// ── GET /admin/approve-store (ワンタップ承認 — メールリンク用) ─────────────────
router.get("/admin/approve-store", async (req, res) => {
  const { storeId: storeIdStr, token } = req.query as { storeId?: string; token?: string };
  if (!storeIdStr || !token) {
    res.status(400).send("無効なリンクです");
    return;
  }
  const storeId = Number(storeIdStr);
  if (isNaN(storeId)) { res.status(400).send("無効な店舗IDです"); return; }

  const expected = crypto.createHmac("sha256", APPROVAL_SECRET).update(String(storeId)).digest("hex");
  if (token !== expected) {
    res.status(403).send("トークンが無効です");
    return;
  }

  try {
    const [updated] = await db
      .update(storesTable)
      .set({ status: "approved", isActive: true })
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) { res.status(404).send("店舗が見つかりません"); return; }

    // オーナー通知
    if (updated.ownerId) {
      await db.insert(notificationsTable).values({
        userId: updated.ownerId,
        type: "store_approved",
        title: "🎉 店舗が承認されました",
        body: `${updated.name} の審査が完了しました！`,
        read: false,
      }).catch(() => {});
    }

    const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost'}`;
    // XSS 対策: 店舗名 (オーナー入力値) と appUrl (env) を HTML エスケープ。
    // updated.name に <script> 等が含まれていても admin ブラウザでスクリプトが実行されないようにする。
    const escapeHtml = (s: string) => s
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const safeName = escapeHtml(String(updated.name ?? ""));
    const safeRedirect = escapeHtml(`${appUrl}/admin`);
    res.send(`
<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="3;url=${safeRedirect}">
<title>承認完了</title>
<style>body{font-family:'Helvetica Neue',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f0;margin:0;}
.card{background:#fff;border-radius:20px;padding:48px 40px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
.emoji{font-size:64px;margin-bottom:16px;}h1{color:#F26419;font-size:22px;margin:0 0 8px;}p{color:#666;font-size:14px;}</style>
</head><body>
<div class="card">
<div class="emoji">✅</div>
<h1>承認完了！</h1>
<p><strong>${safeName}</strong> を承認しました。<br>3秒後に管理者ダッシュボードへ移動します。</p>
</div>
</body></html>
    `);
  } catch (err: any) {
    console.error("[admin/approve-store]", err);
    res.status(500).send("エラーが発生しました: " + err?.message);
  }
});

// ── GET /admin/announcements ───────────────────────────────────────────────────
router.get("/admin/announcements", requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(announcementsTable)
      .orderBy(desc(announcementsTable.createdAt))
      .limit(50);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/announcements ──────────────────────────────────────────────────
// 全ユーザーへのお知らせを作成し、各ユーザーの notifications に挿入する
router.post("/admin/announcements", requireAdmin, async (req: any, res) => {
  const { title, body } = req.body as { title?: string; body?: string };
  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ error: "title と body は必須です" });
    return;
  }
  try {
    const [announcement] = await db
      .insert(announcementsTable)
      .values({ title: title.trim(), body: body.trim(), createdBy: req.adminUser.id })
      .returning();

    // 全ユーザーの ID 一覧を Supabase から取得してバルクインサート
    const { data: userList, error: userErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (userErr) throw userErr;

    if (userList.users.length > 0) {
      const notifRows = userList.users.map(u => ({
        userId: u.id,
        type: "announcement" as const,
        title: title.trim(),
        body: body.trim(),
        read: false,
      }));
      // バルクインサート（1000件単位）
      for (let i = 0; i < notifRows.length; i += 100) {
        await db.insert(notificationsTable).values(notifRows.slice(i, i + 100));
      }
    }

    res.json({ ok: true, announcement, userCount: userList.users.length });
  } catch (err: any) {
    console.error("[admin/announcements POST]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /announcements (public — ユーザーが閲覧) ──────────────────────────────
router.get("/announcements", async (req: any, res) => {
  try {
    const limit = Math.min(parseInt(req.query?.limit ?? '10', 10) || 10, 50);
    const rows = await db
      .select()
      .from(announcementsTable)
      .orderBy(desc(announcementsTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /web-push/subscribe ───────────────────────────────────────────────────
router.post("/web-push/subscribe", async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "endpoint, p256dh, auth は必須です" }); return;
  }
  try {
    await db.execute(sql`
      INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${user.id}, ${endpoint}, ${p256dh}, ${auth})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `);
    // ★ この endpoint が匿名テーブルに残っていたら削除(会員へ昇格・二重送信防止)
    await db.execute(sql`DELETE FROM anonymous_web_push_subscriptions WHERE endpoint = ${endpoint}`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /web-push/anon-subscribe (public) ──────────────────────────────────────
//   会員登録前(ログイン前)の Web Push 購読。 認証不要。
//   既に会員登録済みの endpoint はスキップして二重送信を防ぐ。
router.post("/web-push/anon-subscribe", async (req, res) => {
  const { endpoint, p256dh, auth } = req.body ?? {};
  if (!endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "endpoint, p256dh, auth は必須です" }); return;
  }
  try {
    const known = await db.execute(
      sql`SELECT 1 FROM web_push_subscriptions WHERE endpoint = ${endpoint} LIMIT 1`,
    );
    if ((known.rows?.length ?? 0) > 0) {
      res.json({ ok: true, skipped: "already_registered_to_user" }); return;
    }
    await db.execute(sql`
      INSERT INTO anonymous_web_push_subscriptions (endpoint, p256dh, auth, updated_at)
      VALUES (${endpoint}, ${p256dh}, ${auth}, NOW())
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = NOW()
    `);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/vapid-public-key ────────────────────────────────────────────────
// 注: 現状 admin UI からは未使用。 web-push 購読は GET /api/settings の publicVapidKey 経由。
//     将来 admin 専用 push 機能を追加する際の枠として残置。
router.get("/admin/vapid-public-key", requireAdmin, async (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
});

// ── GET /push/vapid-public-key (public) ─────────────────────────────────────────
// Webプッシュ購読(フロント)が applicationServerKey に使う公開鍵。 公開鍵なので認証不要。
router.get("/push/vapid-public-key", (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY ?? null });
});

// ── GET /settings (public) ─────────────────────────────────────────────────────
router.get("/settings", async (_req, res) => {
  try {
    const result = await db.execute(sql`SELECT key, value FROM app_settings ORDER BY key`);
    const settings: Record<string, string> = {};
    for (const row of result.rows as { key: string; value: string }[]) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/settings ────────────────────────────────────────────────────────
router.get("/admin/settings", requireAdmin, async (_req, res) => {
  try {
    const result = await db.execute(sql`SELECT key, value, updated_at FROM app_settings ORDER BY key`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── PATCH /admin/settings ──────────────────────────────────────────────────────
router.patch("/admin/settings", requireAdmin, async (req: any, res) => {
  const updates: Record<string, string> = req.body;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    res.status(400).json({ error: "body must be a key-value object" }); return;
  }
  try {
    for (const [key, value] of Object.entries(updates)) {
      await db.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${key}, ${String(value)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `);
    }
    // 最新値を返す
    const result = await db.execute(sql`SELECT key, value, updated_at FROM app_settings ORDER BY key`);
    res.json({ ok: true, settings: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/notifications/broadcast ────────────────────────────────────────
// 全ユーザーに通知ベルのお知らせを一斉送信
router.post("/admin/notifications/broadcast", requireAdmin, async (req: any, res) => {
  const { title, body } = req.body ?? {};
  if (!title?.trim()) {
    res.status(400).json({ error: "title is required" }); return;
  }
  try {
    const { data: userList, error: userErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (userErr || !userList) {
      res.status(500).json({ error: "failed_to_list_users", message: userErr?.message }); return;
    }
    if (userList.users.length === 0) {
      res.json({ ok: true, sentTo: 0 }); return;
    }
    const rows = userList.users.map(u => ({
      userId: u.id,
      type: "broadcast" as const,
      title: title.trim(),
      body: body?.trim() || null,
      read: false,
    }));
    await db.insert(notificationsTable).values(rows);
    res.json({ ok: true, sentTo: rows.length });
  } catch (err: any) {
    console.error("[admin] notification broadcast error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /sales-leads ── 誰でもOK（食品ロスのお店を通報）─────────────────────
router.post("/sales-leads", async (req, res) => {
  try {
    const user = await getAuthUser(req);
    const { storeName, location, memo } = req.body as {
      storeName?: string;
      location?: string;
      memo?: string;
    };
    if (!storeName?.trim() || !location?.trim()) {
      res.status(400).json({ error: "bad_request", message: "店舗名と場所は必須です" });
      return;
    }
    // 入力長制限（DB肥大 / abuse 防止）
    const trimmedStoreName = storeName.trim().slice(0, 200);
    const trimmedLocation  = location.trim().slice(0, 300);
    const trimmedMemo      = memo?.trim().slice(0, 1000) ?? null;
    if (trimmedStoreName.length < 1 || trimmedLocation.length < 1) {
      res.status(400).json({ error: "bad_request", message: "入力が短すぎます" });
      return;
    }
    const [lead] = await db.insert(salesLeadsTable).values({
      reportedBy: user?.id ?? null,
      storeName:  trimmedStoreName,
      location:   trimmedLocation,
      memo:       trimmedMemo,
      status:     "new",
    }).returning();

    // 管理者全員に in-app 通知 (#6 フェーズ B: 単一 admin email 依存を廃止)
    const adminIds = await getAllAdminUserIds();
    if (adminIds.length > 0) {
      await db.insert(notificationsTable).values(
        adminIds.map((adminId) => ({
          userId: adminId,
          type:   "sales_lead",
          title:  "🏪 新しい営業リードが届きました！",
          body:   `${storeName.trim()}（${location.trim()}）`,
          read:   false,
        })),
      );
    }
    res.json({ ok: true, id: lead.id });
  } catch (err: any) {
    console.error("[sales-leads] POST error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /admin/sales-leads ── 管理者のみ ───────────────────────────────────
router.get("/admin/sales-leads", requireAdmin, async (_req, res) => {
  try {
    const leads = await db
      .select()
      .from(salesLeadsTable)
      .orderBy(desc(salesLeadsTable.createdAt));
    res.json(leads);
  } catch (err: any) {
    console.error("[admin] sales-leads GET error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── PATCH /admin/sales-leads/:id ── ステータス更新 ────────────────────────
router.patch("/admin/sales-leads/:id", requireAdmin, async (req: any, res) => {
  try {
    const id     = Number(req.params.id);
    const status = (req.body as { status?: string }).status;
    if (!status) {
      res.status(400).json({ error: "bad_request", message: "status is required" });
      return;
    }
    await db
      .update(salesLeadsTable)
      .set({ status })
      .where(eq(salesLeadsTable.id, id));
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[admin] sales-leads PATCH error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /admin/stores/batch-patch-stripe-license ──────────────────────────────
// license_image_url が存在するのに stripe_license_file_id が NULL の店舗を一括修正
// ⚠️ RESCUE 専用エンドポイント: 通常 admin UI からは到達しない。
//    レガシー店舗の license file id 一括 backfill が必要な場合のみ
//    管理者が curl 等で手動実行する想定。
router.post("/admin/stores/batch-patch-stripe-license", requireAdmin, async (_req, res) => {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: "stripe_key_missing" });
    }
    const Stripe = (await import("stripe")).default;
    const { Readable } = await import("stream");

    // license_image_url あり・stripe_license_file_id なし・stripe_account_id あり
    const targets = await db
      .select({
        id: storesTable.id,
        name: storesTable.name,
        licenseImageUrl: storesTable.licenseImageUrl,
        stripeAccountId: storesTable.stripeAccountId,
      })
      .from(storesTable)
      .where(
        sql`license_image_url IS NOT NULL AND stripe_license_file_id IS NULL AND stripe_account_id IS NOT NULL`
      );

    const results: { storeId: number; name: string; result: string; fileId?: string }[] = [];

    for (const store of targets) {
      try {
        const stripe = new Stripe(stripeKey);
        const imgResp = await fetch(store.licenseImageUrl!);
        if (!imgResp.ok) {
          results.push({ storeId: store.id, name: store.name, result: `fetch失敗: HTTP ${imgResp.status}` });
          continue;
        }
        const ct = imgResp.headers.get("content-type") ?? "image/jpeg";
        const mime = ct.split(";")[0].trim();
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const ext = mime.split("/")[1] ?? "jpg";
        const stripeFile = await stripe.files.create(
          {
            file: { data: buf, name: `license-${store.id}-backfill.${ext}`, type: mime },
            purpose: "additional_verification",
          },
          { stripeAccount: store.stripeAccountId! }
        );
        await db
          .update(storesTable)
          .set({ stripeLicenseFileId: stripeFile.id } as any)
          .where(eq(storesTable.id, store.id));
        results.push({ storeId: store.id, name: store.name, result: "✅ アップロード完了", fileId: stripeFile.id });
        console.log(`[admin/batch-patch] ✅ store ${store.id} "${store.name}" → Stripe fileId=${stripeFile.id}`);
      } catch (err: any) {
        results.push({ storeId: store.id, name: store.name, result: `❌ エラー: ${err?.message}` });
        console.error(`[admin/batch-patch] store ${store.id} エラー:`, err?.message);
      }
    }

    res.json({ patched: results.filter(r => r.fileId).length, total: targets.length, results });
  } catch (err: any) {
    console.error("[admin/batch-patch-stripe-license]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ─── Stripe アカウント手動リンク（孤立アカウント修復用） ────────────────────
// PATCH /api/admin/stores/:storeId/link-stripe-account
// 既存の Stripe Connect アカウントを店舗 DB レコードに紐付ける。
// bank-setup 途中でエラーが起きてアカウントが孤立した際の修復用。
router.patch("/admin/stores/:storeId/link-stripe-account", requireAdmin, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) return res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
    const { stripeAccountId } = req.body as { stripeAccountId?: string };
    if (!stripeAccountId?.startsWith("acct_")) {
      return res.status(400).json({ error: "bad_request", message: "stripeAccountId は acct_ で始まる必要があります" });
    }
    const [store] = await db.select({ id: storesTable.id }).from(storesTable).where(eq(storesTable.id, storeId));
    if (!store) return res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });

    await db.update(storesTable).set({ stripeAccountId }).where(eq(storesTable.id, storeId));
    console.log(`[admin/link-stripe-account] ✅ storeId=${storeId} → stripeAccountId=${stripeAccountId}`);
    res.json({ ok: true, storeId, stripeAccountId });
  } catch (err: any) {
    console.error("[admin/link-stripe-account]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ⚠️ RESCUE 専用エンドポイント: 通常 admin UI からは到達しない。
//    Stripe Connect の business_profile.name が誤登録されているケースで
//    管理者が curl 等で手動修正する想定。
router.post("/admin/stores/:storeId/fix-stripe-business-name", requireAdmin, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    const { businessName } = req.body as { businessName?: string };
    if (!businessName?.trim()) {
      return res.status(400).json({ error: "bad_request", message: "businessName は必須です" });
    }
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "stripe_key_missing" });

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, name: storesTable.name })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (!store?.stripeAccountId) {
      return res.status(404).json({ error: "not_found", message: "StripeアカウントIDが見つかりません" });
    }
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey);
    const updated = await stripe.accounts.update(store.stripeAccountId, {
      business_profile: { name: businessName.trim() },
    });
    console.log(`[admin/fix-business-name] ✅ storeId=${storeId} acct=${store.stripeAccountId} 新しいbusiness_profile.name="${updated.business_profile?.name}"`);
    res.json({ ok: true, stripeAccountId: store.stripeAccountId, businessProfileName: updated.business_profile?.name });
  } catch (err: any) {
    console.error("[admin/fix-stripe-business-name]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #6 フェーズ B: 管理者管理 endpoint
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/admins — 現在の admin 一覧
router.get("/admin/admins", requireAdmin, async (req: Request, res: Response) => {
  try {
    const admins = await getAllAdminUsers();
    await writeAuditLog(req, "admins.list", undefined, { count: admins.length });
    res.json({ admins });
  } catch (err: any) {
    console.error("[admin/admins GET]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// POST /admin/admins — email 指定で admin 昇格
router.post("/admin/admins", requireAdmin, async (req: Request, res: Response) => {
  try {
    const email = String((req.body as { email?: string }).email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "bad_request", message: "email が必要です" });
      return;
    }
    const userId = await findUserIdByEmail(email);
    if (!userId) {
      res.status(404).json({ error: "user_not_found", message: "該当する登録ユーザーが見つかりません (先にサインアップが必要)" });
      return;
    }
    const ok = await grantAdminRole(userId);
    if (!ok) {
      res.status(500).json({ error: "grant_failed", message: "admin 昇格に失敗しました" });
      return;
    }
    await writeAuditLog(req, "admins.grant", userId, { email });
    console.warn(`[ADMIN] ✅ Granted admin role to ${email} (id=${userId}) by ${(req as any).adminUser?.email}`);
    res.json({ ok: true, userId, email });
  } catch (err: any) {
    console.error("[admin/admins POST]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// DELETE /admin/admins/:userId — admin 剥奪 (atomic、 last-admin / self-revoke 防御)
//   architect C1 対応: フロント/サーバ二重ガードに加え、 lib/admin.ts::revokeAdminRole が
//   1 ステートメント条件付き UPDATE で last-admin / self / not-admin を全部 atomic に判定する。
router.delete("/admin/admins/:userId", requireAdmin, async (req: Request, res: Response) => {
  try {
    const targetId = String(req.params['userId'] ?? "").trim();
    if (!targetId) {
      res.status(400).json({ error: "bad_request", message: "userId が必要です" });
      return;
    }
    const requesterId = (req as any).adminUser?.id as string | undefined;
    if (!requesterId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await revokeAdminRole(targetId, requesterId);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        self_revoke_forbidden: 400,
        last_admin: 400,
        not_admin: 404,
        error: 500,
      };
      const messageMap: Record<string, string> = {
        self_revoke_forbidden: "自分自身の admin 権限は剥奪できません",
        last_admin: "最後の管理者は削除できません",
        not_admin: "対象ユーザーは admin ではありません",
        error: "admin 剥奪に失敗しました",
      };
      res.status(statusMap[result.reason] ?? 500).json({
        error:   result.reason,
        message: messageMap[result.reason] ?? "admin 剥奪に失敗しました",
      });
      return;
    }
    await writeAuditLog(req, "admins.revoke", targetId);
    console.warn(`[ADMIN] ⚠️ Revoked admin role from id=${targetId} by ${(req as any).adminUser?.email}`);
    res.json({ ok: true, userId: targetId });
  } catch (err: any) {
    console.error("[admin/admins DELETE]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── CSV エクスポート ──────────────────────────────────────────────────────────
// 神モード会計用。 UTF-8 BOM 付きで Excel が文字化けしないようにする。
function toCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Excel/Sheets CSV インジェクション対策: 先頭が = + - @ TAB CR で始まる場合は ' を前置して
  // 式評価を防ぐ (店舗名・住所などユーザ入力由来の値が CSV を開いた瞬間に式実行されるのを阻止)
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function rowsToCsv(headers: string[], rows: any[][]): string {
  const lines = [headers.join(","), ...rows.map(r => r.map(toCsvCell).join(","))];
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(csv);
}

// GET /admin/export/stores.csv — 店舗一覧 (売上・予約・通報を含む)
router.get("/admin/export/stores.csv", requireAdmin, async (_req, res) => {
  try {
    const r = await db.execute(sql`
      SELECT
        s.id, s.name, s.status, s.is_active, s.category, s.city, s.address, s.phone,
        s.stripe_account_id, s.stripe_charges_enabled, s.stripe_payouts_enabled,
        s.license_number, s.created_at,
        (SELECT COUNT(*) FROM surprise_bags WHERE store_id = s.id)::int AS bag_count,
        (SELECT COUNT(*) FROM reservations  WHERE store_id = s.id)::int AS reservation_count,
        (SELECT COUNT(*) FROM reservations  WHERE store_id = s.id AND status='picked_up')::int AS picked_up_count,
        (SELECT COALESCE(SUM(total_price) FILTER (WHERE status IN ('confirmed','picked_up')),0)
           FROM reservations WHERE store_id = s.id)::numeric AS revenue,
        (SELECT COUNT(*) FROM reports WHERE store_id = s.id)::int AS report_count
      FROM stores s ORDER BY s.id
    `);
    const headers = ["店舗ID","店舗名","ステータス","公開","カテゴリ","市区町村","住所","電話",
      "Stripe アカウントID","売上可","入金可","営業許可番号","登録日","バッグ数","予約数","受取数","累計売上(円)","通報数"];
    const rows = r.rows.map((x: any) => [
      x.id, x.name, x.status, x.is_active ? "ON" : "OFF", x.category, x.city, x.address, x.phone,
      x.stripe_account_id, x.stripe_charges_enabled ? "✓" : "", x.stripe_payouts_enabled ? "✓" : "",
      x.license_number, x.created_at, x.bag_count, x.reservation_count, x.picked_up_count,
      Number(x.revenue ?? 0), x.report_count,
    ]);
    const date = new Date().toISOString().slice(0, 10);
    sendCsv(res, `osusowake_stores_${date}.csv`, rowsToCsv(headers, rows));
  } catch (err: any) {
    console.error("[admin/export/stores.csv]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// GET /admin/export/reservations.csv — 予約全件 (期間絞り可: ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get("/admin/export/reservations.csv", requireAdmin, async (req, res) => {
  try {
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to   = typeof req.query.to   === "string" ? req.query.to   : null;
    const isYmd = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const fromSql = isYmd(from) ? sql`AND r.created_at >= ${from}::date` : sql``;
    const toSql   = isYmd(to)   ? sql`AND r.created_at <  (${to}::date + INTERVAL '1 day')` : sql``;
    const result = await db.execute(sql`
      SELECT r.id, r.created_at, r.status, r.pickup_code,
             r.total_price, r.merchandise_amount,
             s.id AS store_id, s.name AS store_name, s.category,
             b.id AS bag_id, b.title AS bag_title, b.discounted_price,
             r.user_id
      FROM reservations r
      JOIN stores s ON s.id = r.store_id
      LEFT JOIN surprise_bags b ON b.id = r.bag_id
      WHERE 1=1 ${fromSql} ${toSql}
      ORDER BY r.created_at DESC
    `);
    const headers = ["予約ID","作成日時","ステータス","受取コード","合計(円)","商品代(円)",
      "店舗ID","店舗名","カテゴリ","バッグID","バッグ名","バッグ販売価格(円)","ユーザID"];
    const rows = result.rows.map((x: any) => [
      x.id, x.created_at, x.status, x.pickup_code,
      Number(x.total_price ?? 0), Number(x.merchandise_amount ?? 0),
      x.store_id, x.store_name, x.category,
      x.bag_id ?? "", x.bag_title ?? "", x.discounted_price ? Number(x.discounted_price) : "",
      x.user_id,
    ]);
    const date = new Date().toISOString().slice(0, 10);
    const range = from || to ? `_${from ?? ""}_${to ?? ""}` : "";
    sendCsv(res, `osusowake_reservations${range}_${date}.csv`, rowsToCsv(headers, rows));
  } catch (err: any) {
    console.error("[admin/export/reservations.csv]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// GET /admin/export/sales-summary.csv — 月次×店舗の売上集計
router.get("/admin/export/sales-summary.csv", requireAdmin, async (_req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        TO_CHAR(date_trunc('month', r.created_at), 'YYYY-MM') AS month,
        s.id AS store_id, s.name AS store_name,
        COUNT(*)::int AS reservation_count,
        COUNT(*) FILTER (WHERE r.status = 'picked_up')::int AS picked_up_count,
        COUNT(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')),0)::numeric AS gmv,
        ROUND(COALESCE(SUM(r.total_price) FILTER (WHERE r.status IN ('confirmed','picked_up')),0) * 0.20)::numeric AS platform_fee
      FROM reservations r JOIN stores s ON s.id = r.store_id
      GROUP BY 1, s.id, s.name
      ORDER BY 1 DESC, gmv DESC
    `);
    const headers = ["月","店舗ID","店舗名","予約数","受取数","キャンセル数","GMV(円)","手数料収益20%(円)"];
    const rows = result.rows.map((x: any) => [
      x.month, x.store_id, x.store_name,
      x.reservation_count, x.picked_up_count, x.cancelled_count,
      Number(x.gmv ?? 0), Number(x.platform_fee ?? 0),
    ]);
    const date = new Date().toISOString().slice(0, 10);
    sendCsv(res, `osusowake_sales_summary_${date}.csv`, rowsToCsv(headers, rows));
  } catch (err: any) {
    console.error("[admin/export/sales-summary.csv]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

export default router;
