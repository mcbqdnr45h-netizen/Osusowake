import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { surpriseBagsTable, storesTable, reservationsTable, favoritesTable, notificationsTable, reviewsTable } from "@workspace/db/schema";
import { eq, and, ne, sql, like } from "drizzle-orm";
import { releaseExpiredCartReservations } from "./reservations";
import { sendPushToUsers, filterFavoriteUpdateOptIn } from "../lib/push.js";
import { broadcastNewListing } from "../lib/new-listing-broadcast.js";
import { computeUserTotal } from "../lib/pricing.js";
import { requireAuth, requireStoreOwner } from "../middlewares/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { getReviewDemoOwnerIds, isReviewDemoOwner } from "../lib/app-review.js";
import { bagVisibleSql } from "../lib/bag-visibility.js";
import { cached, invalidate } from "../lib/ttl-cache.js";
import {
  ListStoreBagsParams,
  CreateBagParams,
  CreateBagBody,
  GetBagParams,
  UpdateBagParams,
  UpdateBagBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * 出品の取り消し(非公開)・削除時に、その出品で送った「新着」通知(ベル)を消す。
 * 通知本文末尾の [bag:ID] トークンで対象を特定する(bags.ts / recurring-publisher.ts が付与)。
 * 既に配信済みのプッシュは取り消せないが、アプリ内の通知一覧からは消えるので
 * 「取り消された(存在しない)出品に飛ばされる」誤誘導を防ぐ。 fail-open(失敗しても本処理は続行)。
 */
async function deleteNewBagNotifications(bagId: number): Promise<void> {
  try {
    await db.delete(notificationsTable).where(and(
      eq(notificationsTable.type, "new_bag"),
      like(notificationsTable.body, `%[bag:${bagId}]%`),
    ));
  } catch (e) {
    console.error(`[bags] deleteNewBagNotifications failed bag=${bagId}:`, e);
  }
}

/**
 * バッグが期限切れかどうかを判定する（深夜またぎ対応）
 * - pickupEnd が null → 出品日が今日でなければ期限切れ（SQL リスト表示フィルタ・フロント getBagStatus と整合）
 * - 通常バッグ（pickupEnd >= pickupStart）: 今日作成 かつ 現在時刻 > pickupEnd なら期限切れ
 * - 深夜またぎバッグ（pickupEnd < pickupStart 例: 23:00〜01:00）:
 *     今日作成 → 翌日の pickupEnd まで有効（期限切れにならない）
 *     昨日作成 → 今日の pickupEnd を過ぎたら期限切れ
 */
export function isBagExpired(bag: {
  pickupEnd: string | null;
  pickupStart: string | null;
  pickupEnd2?: string | null;
  pickupNextDay?: boolean | null;
  createdAt: Date;
  store?: { ownerId?: string | null } | null;
  storeOwnerId?: string | null;
}): boolean {
  // App Store 審査用デモ店舗のバッグは常に有効（日付・時刻バイパス）
  const ownerId = bag.storeOwnerId ?? bag.store?.ownerId ?? null;
  if (isReviewDemoOwner(ownerId)) return false;

  const nowJST      = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const createdJST  = new Date(bag.createdAt.getTime() + 9 * 60 * 60 * 1000);
  const todayStr    = nowJST.toISOString().slice(0, 10);
  const yesterdayStr = new Date(nowJST.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createdStr  = createdJST.toISOString().slice(0, 10);
  const currentTime = nowJST.toISOString().slice(11, 16); // "HH:MM"

  // ★ pickupEnd=null: 出品日 (JST) が今日でなければ期限切れ。
  //   旧実装は常に false を返していたが、 SQL リスト表示フィルタ (CASE 1) と
  //   フロント getBagStatus は「今日出品でなければ非表示/expired」 扱いのため、
  //   ここも揃えて単一化する。 これにより GET /bags/:id の 410 判定や
  //   reservations の予約拒否ロジックがリスト表示と齟齬を起こさなくなる。
  if (!bag.pickupEnd) {
    return createdStr !== todayStr;
  }

  // ★ 2部制(受取2枠): 期限は「最後の枠の終わり」= pickupEnd2 があればそちら（一覧の bagVisibleSql と一致）。
  const effEnd = bag.pickupEnd2 || bag.pickupEnd;

  // ★ 翌日受取（前日出品 pickupNextDay）: 今日出品→受取は明日でまだ有効 / 昨日出品→今日が受取日 / それ以前→期限切れ。
  if (bag.pickupNextDay) {
    if (createdStr === todayStr)     return false;
    if (createdStr === yesterdayStr) return currentTime > effEnd;
    return true;
  }

  // ★ 深夜またぎ判定は「最後の枠の終わり」(effEnd) で行う。 2部制で2枠目が日跨ぎ
  //   (例: 11:00-14:00, 22:00-02:00) の場合、 slot1 の pickupEnd だけ見ると日跨ぎを
  //   見落とし、 同日の effEnd 超過で早期に期限切れ扱いして 2枠目が消えるバグになる。
  const isOvernightBag = bag.pickupStart != null && effEnd < bag.pickupStart;

  if (isOvernightBag) {
    if (createdStr === todayStr) {
      // 今日出品した深夜またぎバッグ → 翌日の effEnd まで有効
      return false;
    } else if (createdStr === yesterdayStr) {
      // 昨日出品した深夜またぎバッグ → 今日の pickupEnd を過ぎたら期限切れ
      return currentTime > effEnd;
    }
    return true; // 2日以上前は期限切れ
  }

  // 通常バッグ
  if (createdStr !== todayStr) return true;
  return currentTime > effEnd;
}

// 受取時間が過ぎていないか判定するSQL条件（JST基準）
//
// 方針：バッグは「当日（JST）に作成されたもの」だけを表示する。
//       過去日付の出品は絶対に表示しない。
//       ただし深夜またぎバッグ（pickupEnd < pickupStart, 例: 22:00〜02:00）は
//       前日に作成されたものも翌日の pickupEnd まで表示継続する。
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ CASE 1: pickupEnd IS NULL                                               │
// │   → 受取時間制限なし。今日作成 (JST) なら常に表示。                         │
// ├─────────────────────────────────────────────────────────────────────────┤
// │ CASE 2: 通常バッグ (pickupEnd >= pickupStart, 例: 09:00〜20:00)          │
// │   → 今日作成 (JST) かつ pickupEnd が現在時刻以降ならば表示。                │
// ├─────────────────────────────────────────────────────────────────────────┤
// │ CASE 3: 深夜またぎバッグ (pickupEnd < pickupStart, 例: 22:00〜02:00)     │
// │   a) 今日作成 (JST): 現在時刻に関わらず表示（pickupEnd になるまで）          │
// │   b) 昨日作成 (JST): pickupEnd がまだ来ていないなら表示（翌日02:00まで等）   │
// └─────────────────────────────────────────────────────────────────────────┘
const TODAY_JST  = sql`DATE(NOW() AT TIME ZONE 'Asia/Tokyo')`;
const NOW_TIME   = sql`TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI')`;
const CREATED_JST = sql`DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')`;

// App Store 審査用デモ店舗オーナーの allowlist（SQL 配列リテラルに変換）
// セキュリティ: 値は env 由来 (admin 制御下) だが、 二重防御として UUID v4 形式のみ
// 通過させ、 不正な値は完全に除外する。 これで sql.raw 経由の injection 余地をゼロに。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_OWNER_IDS_SQL = sql.raw(
  (() => {
    const ids = getReviewDemoOwnerIds().filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return `ARRAY[NULL]::text[]`;
    return `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::text[]`;
  })(),
);

// ★ 可視条件は共有 SQL に一本化 (lib/bag-visibility.ts)。 ここは「審査用デモ店バイパス(CASE 0)」を
//   OR で足すだけ。 2部制(受取2枠)の期限延長も共有側で対応済み。
const notExpiredCondition = sql`(
  (${storesTable.ownerId} = ANY(${REVIEW_OWNER_IDS_SQL}))
  OR ${bagVisibleSql}
)`;

// ★ 公開エンドポイント用 store 公開フィールド (bags 結合用 — PII 完全除外)
//   除外: ownerId, licenseNumber, licenseImageUrl, idImageUrl, pledgeSigned,
//         rejectionReason, stripeAccountId, stripeLicenseFileId,
//         stripeNeedsBankReregister, stripeChargesEnabled, stripePayoutsEnabled,
//         approvalEmailSent, stripeKycAdminEmailSent,
//         licenseUploadFailed/Error/AttemptedAt
const publicStoreCols = {
  id: storesTable.id,
  name: storesTable.name,
  description: storesTable.description,
  address: storesTable.address,
  city: storesTable.city,
  category: storesTable.category,
  lat: storesTable.lat,
  lng: storesTable.lng,
  // ★ data: URL (base64 埋め込み) は最大数百KB に膨らみ、 一覧 API のレスポンス
  //    サイズと初期表示速度を著しく悪化させるため、 SQL レベルで NULL に潰す。
  //    また imageUrl が空 (NULL or data:) の場合は iconUrl を代替に返し、
  //    店主が登録した実物写真がバナーに必ず表示されるようにする。
  imageUrl: sql<string | null>`CASE
    WHEN ${storesTable.imageUrl} LIKE 'data:%' OR ${storesTable.imageUrl} IS NULL THEN
      CASE WHEN ${storesTable.iconUrl} LIKE 'data:%' THEN NULL ELSE ${storesTable.iconUrl} END
    ELSE ${storesTable.imageUrl}
  END`.as('image_url'),
  iconUrl:  sql<string | null>`CASE WHEN ${storesTable.iconUrl}  LIKE 'data:%' THEN NULL ELSE ${storesTable.iconUrl}  END`.as('icon_url'),
  phone: storesTable.phone,
  openTime: storesTable.openTime,
  closeTime: storesTable.closeTime,
  rating: storesTable.rating,
  isActive: storesTable.isActive,
  status: storesTable.status,
  holiday: storesTable.holiday,
  pickupHours: storesTable.pickupHours,
  createdAt: storesTable.createdAt,
} as const;

router.get("/bags", async (_req, res) => {
  // 期限切れ仮押さえを非同期で清算（レスポンスはブロックしない）
  releaseExpiredCartReservations().catch(() => {});
  try {
    // ★ 公開一覧: 全ユーザー同一結果 & 秒間多数の refetch が来るため 10 秒メモリキャッシュ。
    //   在庫は予約確定時にサーバー側で再検証されるため、数秒の鮮度落ちは許容。
    const result = await cached("bags:list", 10_000, async () => {
    const bags = await db
      .select({
        id: surpriseBagsTable.id,
        storeId: surpriseBagsTable.storeId,
        title: surpriseBagsTable.title,
        description: surpriseBagsTable.description,
        allergyInfo: surpriseBagsTable.allergyInfo,
        pickupNote: surpriseBagsTable.pickupNote,
        originalPrice: surpriseBagsTable.originalPrice,
        discountedPrice: surpriseBagsTable.discountedPrice,
        stockCount: surpriseBagsTable.stockCount,
        pickupStart: surpriseBagsTable.pickupStart,
        pickupEnd: surpriseBagsTable.pickupEnd,
        pickupStart2: surpriseBagsTable.pickupStart2,
        pickupEnd2: surpriseBagsTable.pickupEnd2,
        imageUrl: surpriseBagsTable.imageUrl,
        category: surpriseBagsTable.category,
        itemType: surpriseBagsTable.itemType,
        isActive: surpriseBagsTable.isActive,
        createdAt: surpriseBagsTable.createdAt,
        pickupNextDay: surpriseBagsTable.pickupNextDay,
        // ★ PII 除外: storesTable 全カラムではなく公開フィールドのみ取得
        store: publicStoreCols,
        storeAvgRating: sql<number | null>`(SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.store_id = ${storesTable.id})`,
        storeReviewCount: sql<number>`(SELECT COUNT(*)::integer FROM reviews r WHERE r.store_id = ${storesTable.id})`,
      })
      .from(surpriseBagsTable)
      .innerJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
      .where(and(
        eq(surpriseBagsTable.isActive, true),
        sql`${storesTable.status} = 'approved' AND ${storesTable.isActive} = true`,
        notExpiredCondition,
      ))
      .orderBy(surpriseBagsTable.id);

      return bags.map(({ storeAvgRating, storeReviewCount, ...b }) => ({
        ...b,
        store: { ...b.store, totalBagsAvailable: b.stockCount, avgRating: storeAvgRating, reviewCount: storeReviewCount },
      }));
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bags" });
  }
});

/**
 * 発見ページ「本日分は完売しました」用: 今日出品されたが、 もう買えないバッグを返す。
 *   = 完売(stock<=0) または 受取時間切れ(今 visible でない)。
 *   ★ /api/bags は notExpired で時間切れを弾くため、 時間切れバッグ(松村製麺所など)は
 *     ここでしか取れない。 これで「完売・終了した本日分」を発見に残せる。
 *   ★ stockCount は一律 0 に上書きして返す → フロント BagCard が「完売御礼・薄暗・タップ無効」
 *     で描画する(在庫残りの時間切れバッグも購入不可として正しく表示)。
 *   ★ /api/bags/:bagId より前に登録必須(:bagId が "ended-today" を捕まえるのを防ぐ)。
 */
router.get("/bags/ended-today", async (_req, res) => {
  try {
    const result = await cached("bags:ended-today", 30_000, async () => {
      const bags = await db
        .select({
          id: surpriseBagsTable.id,
          storeId: surpriseBagsTable.storeId,
          title: surpriseBagsTable.title,
          description: surpriseBagsTable.description,
          allergyInfo: surpriseBagsTable.allergyInfo,
          pickupNote: surpriseBagsTable.pickupNote,
          originalPrice: surpriseBagsTable.originalPrice,
          discountedPrice: surpriseBagsTable.discountedPrice,
          stockCount: surpriseBagsTable.stockCount,
          pickupStart: surpriseBagsTable.pickupStart,
          pickupEnd: surpriseBagsTable.pickupEnd,
          pickupStart2: surpriseBagsTable.pickupStart2,
          pickupEnd2: surpriseBagsTable.pickupEnd2,
          imageUrl: surpriseBagsTable.imageUrl,
          category: surpriseBagsTable.category,
          itemType: surpriseBagsTable.itemType,
          isActive: surpriseBagsTable.isActive,
          createdAt: surpriseBagsTable.createdAt,
          pickupNextDay: surpriseBagsTable.pickupNextDay,
          store: publicStoreCols,
          storeAvgRating: sql<number | null>`(SELECT ROUND(AVG(r.rating)::numeric, 1) FROM reviews r WHERE r.store_id = ${storesTable.id})`,
          storeReviewCount: sql<number>`(SELECT COUNT(*)::integer FROM reviews r WHERE r.store_id = ${storesTable.id})`,
          // ★ このバッグの「支払済み予約」件数。 stock=0 でも実際に売れたか判定に使う
          //   (在庫0で出品/手動0編集の“売れてないバッグ”を完売と偽らないため)。
          soldPaidCount: sql<number>`(SELECT COUNT(*)::integer FROM reservations r WHERE r.bag_id = ${surpriseBagsTable.id} AND r.payment_status = 'paid')`,
        })
        .from(surpriseBagsTable)
        .innerJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
        .where(and(
          // ★ bag.is_active=true は要求しない。 購入で完売(stock=0)すると payment.ts /
          //   stripe-webhook.ts が自動で is_active=false にするため、 ここで true を要求すると
          //   「ちゃんと売れて完売したバッグ」ほど弾かれる本末転倒になる。 停止店は下の store 条件で除外。
          sql`${storesTable.status} = 'approved' AND ${storesTable.isActive} = true`,
          // 受取日 = 今日(JST)。 pickup_next_day(前夜出品→翌日受取)は created が前日なので別扱い。
          sql`(
            (${surpriseBagsTable.pickupNextDay} IS NOT TRUE
              AND DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
            OR
            (${surpriseBagsTable.pickupNextDay} IS TRUE
              AND DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day')
          )`,
          // もう買えない、の内訳:
          //   (A) 本当に完売 = 在庫0 かつ 支払済み予約が1件以上(=ちゃんと売れて0になった)。
          //       ★ 在庫0でも予約0(店が在庫0で出品/手動0編集の未販売バッグ)は完売ではない → 除外。
          //   (B) 時間切れ = まだ有効(is_active=true)なのに受取時間外。
          //   ★ 店が意図的に下げた未完売(is_active=false かつ stock>0)は どちらにも該当せず除外。
          sql`(
            (${surpriseBagsTable.stockCount} <= 0
              AND EXISTS (SELECT 1 FROM reservations r WHERE r.bag_id = ${surpriseBagsTable.id} AND r.payment_status = 'paid'))
            OR (${surpriseBagsTable.isActive} = true AND NOT (${bagVisibleSql}))
          )`,
        ))
        .orderBy(sql`${surpriseBagsTable.id} DESC`)
        .limit(40);

      return bags.map(({ storeAvgRating, storeReviewCount, soldPaidCount, ...b }) => ({
        // ★ 嘘をつかないためのラベル種別。 stockCount:0 で上書きする前の“元の在庫”で判定する。
        //   完売(sold_out) = 在庫0 かつ 支払済み予約あり(=本当に売り切れて0になった)。
        //   それ以外(ended) = 受取時間切れ。 在庫が1でも残ってるなら時間切れであって完売ではない。
        //   ※ WHERE(B)条件で「まだ有効なのに受取時間外」の在庫残りバッグも入るので、
        //     ここで在庫0を必須にしないと在庫残りが完売と誤表示される(実際に起きたバグ)。
        //   フロント(BagCard)がこれで「完売御礼🌸」と「本日終了🌙」を出し分ける。
        endReason: (Number(b.stockCount) <= 0 && Number(soldPaidCount) > 0 ? "sold_out" : "ended") as "sold_out" | "ended",
        ...b,
        stockCount: 0, // ★ 一律「もう買えない」扱い(BagCard が薄暗・タップ無効で描画)
        store: { ...b.store, totalBagsAvailable: 0, avgRating: storeAvgRating, reviewCount: storeReviewCount },
      }));
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch ended-today bags" });
  }
});

router.get("/bags/:bagId", async (req, res) => {
  releaseExpiredCartReservations().catch(() => {});
  try {
    const { bagId } = GetBagParams.parse(req.params);
    const [bag] = await db
      .select({
        id: surpriseBagsTable.id,
        storeId: surpriseBagsTable.storeId,
        title: surpriseBagsTable.title,
        description: surpriseBagsTable.description,
        allergyInfo: surpriseBagsTable.allergyInfo,
        pickupNote: surpriseBagsTable.pickupNote,
        originalPrice: surpriseBagsTable.originalPrice,
        discountedPrice: surpriseBagsTable.discountedPrice,
        stockCount: surpriseBagsTable.stockCount,
        pickupStart: surpriseBagsTable.pickupStart,
        pickupEnd: surpriseBagsTable.pickupEnd,
        pickupStart2: surpriseBagsTable.pickupStart2,
        pickupEnd2: surpriseBagsTable.pickupEnd2,
        imageUrl: surpriseBagsTable.imageUrl,
        category: surpriseBagsTable.category,
        isActive: surpriseBagsTable.isActive,
        createdAt: surpriseBagsTable.createdAt,
        pickupNextDay: surpriseBagsTable.pickupNextDay,
        // ★ PII 除外: storesTable 全カラムではなく公開フィールドのみ
        store: publicStoreCols,
        // ★ オーナーID は内部の isBagExpired (デモ店舗判定) でのみ使用 ―
        //   レスポンスには含めない (下で分割代入で除外)
        storeOwnerId: storesTable.ownerId,
      })
      .from(surpriseBagsTable)
      .innerJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
      .where(eq(surpriseBagsTable.id, bagId));

    if (!bag) {
      res.status(404).json({ error: "not_found", message: "Bag not found" });
      return;
    }

    // 受取時間チェック：期限切れなら 410 Gone（深夜またぎ対応）
    if (isBagExpired({
      pickupEnd: bag.pickupEnd,
      pickupStart: bag.pickupStart,
      pickupEnd2: bag.pickupEnd2,
      pickupNextDay: bag.pickupNextDay,
      createdAt: bag.createdAt,
      storeOwnerId: bag.storeOwnerId,
    })) {
      res.status(410).json({ error: "expired", message: "この商品の受取時間が過ぎています" });
      return;
    }

    // ★ storeOwnerId は内部判定専用 — レスポンスから除外して PII リーク防止
    const { storeOwnerId: _omit, ...publicBag } = bag;
    void _omit;
    res.json({ ...publicBag, store: { ...publicBag.store, totalBagsAvailable: publicBag.stockCount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bag" });
  }
});

router.get("/stores/:storeId/bags", async (req, res) => {
  try {
    const { storeId } = ListStoreBagsParams.parse(req.params);
    const bags = await db
      .select()
      .from(surpriseBagsTable)
      .where(eq(surpriseBagsTable.storeId, storeId));

    // ★ best-effort なオーナー判定。
    //   `hidden_from_quick_publish` はオーナー本人の UI 設定（クイック出品リストの非表示フラグ）であり、
    //   一般ユーザに漏らす意味がないので、 オーナー以外には常に false で返す。
    //   (フロントの dedup 判定が `!== true` なのでオーナーには本当の値が必須、 一般には false 固定で OK)
    let isOwner = false;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) {
          const [store] = await db
            .select({ ownerId: storesTable.ownerId })
            .from(storesTable)
            .where(eq(storesTable.id, storeId))
            .limit(1);
          if (store?.ownerId && store.ownerId === user.id) isOwner = true;
        }
      } catch {
        // 失敗時は単に非オーナー扱い (best-effort)
      }
    }

    const sanitized = isOwner
      ? bags
      : bags.map((b) => ({ ...b, hiddenFromQuickPublish: false }));
    res.json(sanitized);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch store bags" });
  }
});

router.post("/stores/:storeId/bags", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const { storeId } = CreateBagParams.parse(req.params);

    // 店舗が approved かつ Stripe 連携・KYC完了済みでないとバッグ作成をブロック
    const [storeCheck] = await db
      .select({
        status: storesTable.status,
        stripeAccountId: storesTable.stripeAccountId,
        stripeChargesEnabled: storesTable.stripeChargesEnabled,
        stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
      })
      .from(storesTable)
      .where(eq(storesTable.id, storeId))
      .limit(1);
    if (!storeCheck) {
      return res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });
    }
    if (storeCheck.status !== "approved") {
      return res.status(403).json({ error: "store_not_approved", message: "店舗が承認されていないためバッグを出品できません" });
    }
    if (!storeCheck.stripeAccountId) {
      return res.status(403).json({ error: "stripe_not_connected", message: "銀行口座の登録が完了していないため出品できません。口座情報を登録してください。" });
    }
    if (!storeCheck.stripeChargesEnabled) {
      return res.status(403).json({ error: "kyc_pending", message: "決済の本人確認が完了していないため出品できません。審査通過後（通常3〜5営業日）に出品が開始できます。" });
    }
    if (!storeCheck.stripePayoutsEnabled) {
      return res.status(403).json({ error: "payouts_disabled", message: "入金が一時停止中のため出品できません。本人確認書類を提出して審査を完了してください。" });
    }

    const body = CreateBagBody.parse(req.body);
    if (!body.pickupEnd || body.pickupEnd.trim() === '') {
      return res.status(400).json({ error: "bad_request", message: "受取終了時間（pickupEnd）は必須です" });
    }

    // 2部制(受取2枠): CreateBagBody(生成zod)に無い任意フィールドなので req.body から直接読む。
    //   両方が HH:MM の時だけ採用（片方だけは無効＝1枠扱い）。
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const hhmm = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    const has2ndWindow = hhmm(rawBody.pickupStart2) && hhmm(rawBody.pickupEnd2);

    // Stripe 最低決済額チェック（50円未満は決済エラーになる）
    if (Number(body.discountedPrice) < 50) {
      return res.status(400).json({
        error: "price_too_low",
        message: "Stripeの決済制限により、価格は50円以上に設定してください",
      });
    }

    const [bag] = await db.insert(surpriseBagsTable).values({
      storeId,
      title: body.title,
      description: body.description ?? null,
      originalPrice: Number(body.originalPrice),
      discountedPrice: Number(body.discountedPrice),
      stockCount: Number(body.stockCount),
      pickupStart: body.pickupStart ?? null,
      pickupEnd: body.pickupEnd ?? null,
      pickupStart2: has2ndWindow ? String(rawBody.pickupStart2) : null,
      pickupEnd2: has2ndWindow ? String(rawBody.pickupEnd2) : null,
      imageUrl: body.imageUrl ?? null,
      category: body.category ?? null,
      allergyInfo: body.allergyInfo ?? null,
      pickupNote: body.pickupNote ?? null,
      // ★ クライアント (StoreDashboard) は 'bag' = サプライズバッグ / 'item' = 単品商品 を送る。
      //   従来 INSERT で itemType を渡しておらず、 DB default('bag') にフォールバックしていたため、
      //   店舗側が「単品商品」を選んでも常に「バッグ」 として保存されていた (本番バグ修正)。
      itemType: body.itemType ?? 'bag',
      // ★ 翌日受取（前日の夜に出品）。 手動出品でも「明日の朝 受取」のバッグを夜に出せるように。
      //   CreateBagBody(生成zod)に無い任意フィールドなので rawBody から直接読む。
      pickupNextDay: rawBody.pickupNextDay === true,
      isActive: true,
    }).returning();

    // お気に入りユーザーへの通知（★ res.json より先に await。autoscale 環境で worker が
    //   応答後にリサイクルされて push が消えるのを防ぐため。）
    try {
      const [store] = await db
        .select({ name: storesTable.name, ownerId: storesTable.ownerId })
        .from(storesTable)
        .where(eq(storesTable.id, storeId))
        .limit(1);

      const fanRows = await db
        .select({ userId: favoritesTable.userId })
        .from(favoritesTable)
        .where(eq(favoritesTable.storeId, storeId));

      // ★ 通知の価格は「お客様が実際に支払う額」= 商品代金 + 5%利用料(10円切上) にする。
      //   生の discountedPrice(店舗設定の商品代金)を出すと決済画面の金額とズレるため computeUserTotal を使う。
      const priceLabel = `¥${computeUserTotal(Number(body.discountedPrice)).toLocaleString()}`;

      if (fanRows.length > 0 && store) {
        const notifTitle = `🛍️ ${store.name} が新しいおすそわけを出品`;
        const notifBodyClean = `「${body.title}」${priceLabel}〜 在庫: ${body.stockCount}個`;
        const notifBodyDb    = bag?.id ? `${notifBodyClean} [bag:${bag.id}]` : notifBodyClean;
        await db.insert(notificationsTable).values(
          fanRows.map(f => ({
            userId: f.userId,
            type:   "new_bag",
            title:  notifTitle,
            body:   notifBodyDb,
            storeId,
          }))
        );
        // ★ DB通知(ベル)は全お気に入りユーザーに残す。プッシュ配信だけ
        //   「お気に入り店舗の更新」通知OFFのユーザーを除外する(設定を本当に効かせる)。
        const pushRecipients = await filterFavoriteUpdateOptIn(fanRows.map(f => f.userId));
        console.log(`[bags] 新出品通知ブロック開始 bag=${bag?.id} fans=${fanRows.length} push対象=${pushRecipients.length}`);
        if (pushRecipients.length > 0) {
          await sendPushToUsers(pushRecipients, {
            title: notifTitle,
            body:  notifBodyClean,
            tag:   bag?.id ? `new-bag-${bag.id}` : `new-bag-${storeId}-${Date.now()}`,
            url:   bag?.id ? `/bags/${bag.id}` : `/stores/${storeId}`,
          });
        }
        console.log(`[bags] notified ${pushRecipients.length}/${fanRows.length} favorite users for store ${storeId}`);
      }

      // ★ 全体配信: お気に入り未登録の全ユーザーにも新出品を通知(出品少ない今だけの初期ブースト)。
      //   env kill スイッチ・夜間スキップ・1日上限つき。定期出品からは呼ばない(手動出品のみ)。
      if (store) {
        try {
          await broadcastNewListing({
            storeId,
            storeName: store.name,
            ownerUserId: store.ownerId,
            bagId: bag?.id,
            bagTitle: body.title,
            priceLabel,
            stockCount: body.stockCount,
            excludeUserIds: fanRows.map(f => f.userId), // お気に入り勢は上で通知済み → 二重送信しない
          });
        } catch (broadcastErr) {
          console.error("[bags] broadcast error (non-fatal):", broadcastErr);
        }
      }
    } catch (notifErr) {
      console.error("[bags] notification error (non-fatal):", notifErr);
    }

    invalidate("bags:list"); invalidate("stores:list");
    res.status(201).json(bag);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Invalid bag data" });
  }
});

router.put("/bags/:bagId", requireAuth, async (req, res) => {
  try {
    const { bagId } = UpdateBagParams.parse(req.params);
    const body = UpdateBagBody.parse(req.body);

    // Stripe 最低決済額チェック
    if (body.discountedPrice !== undefined && Number(body.discountedPrice) < 50) {
      return res.status(400).json({
        error: "price_too_low",
        message: "Stripeの決済制限により、価格は50円以上に設定してください",
      });
    }

    // 認可: bag → store → ownerId が認証ユーザと一致するか確認
    // 同時に Stripe 状態も取得（公開ON操作のチェック用）
    const [bagOwner] = await db
      .select({
        ownerId: storesTable.ownerId,
        storeId: surpriseBagsTable.storeId,
        status: storesTable.status,
        stripeAccountId: storesTable.stripeAccountId,
        stripeChargesEnabled: storesTable.stripeChargesEnabled,
        stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
      })
      .from(surpriseBagsTable)
      .leftJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
      .where(eq(surpriseBagsTable.id, bagId))
      .limit(1);
    if (!bagOwner) {
      res.status(404).json({ error: "not_found", message: "Bag not found" });
      return;
    }
    if (bagOwner.ownerId !== req.authUser!.id) {
      console.warn(`[SECURITY] PUT /bags/${bagId}: store owner=${bagOwner.ownerId} requester=${req.authUser!.id}`);
      res.status(403).json({ error: "forbidden", message: "このバッグを編集する権限がありません" });
      return;
    }

    // ★ 公開ON操作の場合: PATCH /stores/:storeId/bags/:bagId と同じ Stripe ガードを適用
    //    （PUT 経由で isActive=true にして公開バイパスする攻撃 / 旧クライアントを防ぐ）
    if (body.isActive === true) {
      if (bagOwner.status !== "approved") {
        res.status(403).json({ error: "store_not_approved", message: "店舗が承認されていないためバッグを公開できません" });
        return;
      }
      if (!bagOwner.stripeAccountId) {
        res.status(403).json({ error: "stripe_not_connected", message: "Stripe決済が未連携のため公開できません。銀行口座の登録を完了してください。" });
        return;
      }
      if (!bagOwner.stripeChargesEnabled) {
        res.status(403).json({ error: "kyc_pending", message: "決済の本人確認が完了していないため公開できません。Stripe審査通過後に出品が開始できます。" });
        return;
      }
      if (!bagOwner.stripePayoutsEnabled) {
        res.status(403).json({ error: "payouts_disabled", message: "入金が一時停止中のため公開できません。本人確認書類を提出して審査を完了してください。" });
        return;
      }
    }

    const [updated] = await db
      .update(surpriseBagsTable)
      .set(body)
      .where(eq(surpriseBagsTable.id, bagId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Bag not found" });
      return;
    }
    // ★ 出品取り消し(非公開化)時は、その出品で送った新着通知(ベル)も消す。
    if (body.isActive === false) await deleteNewBagNotifications(bagId);
    invalidate("bags:list"); invalidate("stores:list");
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Invalid update data" });
  }
});

// 非公開バッグの削除（isActive=false のものだけ削除可能）
router.delete("/stores/:storeId/bags/:bagId", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId ?? ""), 10);
    const bagId = parseInt(String(req.params.bagId ?? ""), 10);
    if (isNaN(storeId) || isNaN(bagId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId or bagId" });
      return;
    }

    // 対象バッグを取得して所有権・公開状態を確認
    const [bag] = await db
      .select()
      .from(surpriseBagsTable)
      .where(and(
        eq(surpriseBagsTable.id, bagId),
        eq(surpriseBagsTable.storeId, storeId),
      ));

    if (!bag) {
      res.status(404).json({ error: "not_found", message: "Bag not found or not owned by this store" });
      return;
    }
    if (bag.isActive) {
      res.status(409).json({ error: "conflict", message: "公開中の商品は削除できません。先に非公開にしてください。" });
      return;
    }

    // ★ 重要: 予約が1件でも残っている (キャンセル以外) バッグは物理削除を拒否する。
    //   従来は関連予約を tx 内で一括 delete してから バッグを削除していたが、
    //   これにより以下が消失していた:
    //     - picked_up (受取済み = 決済成立済み売上)
    //     - confirmed (決済済み未受取)
    //     - pending   (仮押さえ中)
    //   結果: お客様のマイバック / 購入履歴 / 領収書 / 店舗売上集計から
    //   レコードが消える致命的バグ。 売上が消えると会計・税務・返金対応が壊れる。
    //
    //   保護対象外 = cancelled のみ。 これは在庫復元済みで、 残しても集計に影響しない。
    //   削除したい場合は店舗側で履歴を「非表示」(論理削除) する UI を使用すること。
    const blockingReservations = await db
      .select({ id: reservationsTable.id, status: reservationsTable.status })
      .from(reservationsTable)
      .where(and(
        eq(reservationsTable.bagId, bagId),
        ne(reservationsTable.status, "cancelled"),
      ));

    if (blockingReservations.length > 0) {
      res.status(409).json({
        error: "has_reservations",
        message: "この商品にはお客様の予約・購入履歴があるため削除できません。代わりに非表示にしてください。",
      });
      return;
    }

    // トランザクション内でキャンセル済み予約を先に削除 → バッグを削除
    await db.transaction(async (tx) => {
      await tx
        .delete(reservationsTable)
        .where(eq(reservationsTable.bagId, bagId));

      await tx
        .delete(surpriseBagsTable)
        .where(eq(surpriseBagsTable.id, bagId));
    });

    // ★ 出品削除時は、その出品で送った新着通知(ベル)も消す(存在しない出品への誘導防止)。
    await deleteNewBagNotifications(bagId);
    invalidate("bags:list"); invalidate("stores:list");
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to delete bag" });
  }
});

// 店舗オーナーによる個別バッグ更新（公開/非公開トグルなど）
// storeId を含めることで所有権チェックを行う
router.patch("/stores/:storeId/bags/:bagId", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId ?? ""), 10);
    const bagId = parseInt(String(req.params.bagId ?? ""), 10);
    if (isNaN(storeId) || isNaN(bagId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId or bagId" });
      return;
    }

    const body = UpdateBagBody.parse(req.body);

    // Stripe 最低決済額チェック
    if (body.discountedPrice !== undefined && Number(body.discountedPrice) < 50) {
      res.status(400).json({
        error: "price_too_low",
        message: "Stripeの決済制限により、価格は50円以上に設定してください",
      });
      return;
    }

    // 公開ON操作の場合：承認済み かつ Stripe 連携・charges/payoutsどちらも有効でないとブロック
    if (body.isActive === true) {
      const [storeCheck] = await db
        .select({
          status: storesTable.status,
          stripeAccountId: storesTable.stripeAccountId,
          stripeChargesEnabled: storesTable.stripeChargesEnabled,
          stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
        })
        .from(storesTable)
        .where(eq(storesTable.id, storeId))
        .limit(1);
      if (!storeCheck || storeCheck.status !== "approved") {
        res.status(403).json({ error: "store_not_approved", message: "店舗が承認されていないためバッグを公開できません" });
        return;
      }
      if (!storeCheck.stripeAccountId) {
        res.status(403).json({ error: "stripe_not_connected", message: "Stripe決済が未連携のため公開できません。銀行口座の登録を完了してください。" });
        return;
      }
      if (!storeCheck.stripeChargesEnabled) {
        res.status(403).json({ error: "kyc_pending", message: "決済の本人確認が完了していないため公開できません。Stripe審査通過後に出品が開始できます。" });
        return;
      }
      if (!storeCheck.stripePayoutsEnabled) {
        res.status(403).json({ error: "payouts_disabled", message: "入金が一時停止中のため公開できません。本人確認書類を提出して審査を完了してください。" });
        return;
      }

      // ★ 受取時間が既に過ぎているバッグの公開を拒否 (UI で「編集して公開」 に
      //   切替えているが、 旧クライアントや直接 API を叩かれた場合の二重防御)。
      //   isActive=true にしても getBagStatus が即 'expired' を返すため、
      //   ユーザは「公開できていない」 と感じる致命的な体験バグになる。
      const [bagCheck] = await db
        .select({
          createdAt: surpriseBagsTable.createdAt,
          pickupStart: surpriseBagsTable.pickupStart,
          pickupEnd: surpriseBagsTable.pickupEnd,
          pickupEnd2: surpriseBagsTable.pickupEnd2,
          pickupNextDay: surpriseBagsTable.pickupNextDay,
        })
        .from(surpriseBagsTable)
        .where(and(
          eq(surpriseBagsTable.id, bagId),
          eq(surpriseBagsTable.storeId, storeId),
        ))
        .limit(1);
      if (bagCheck) {
        // JST 基準 (フロント getBagStatus と完全に同じロジック; pickupEnd=null 含む)
        const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const todayStr     = nowJst.toISOString().slice(0, 10);
        const yesterdayStr = new Date(nowJst.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const createdRaw   = bagCheck.createdAt instanceof Date
          ? bagCheck.createdAt.toISOString()
          : String(bagCheck.createdAt ?? '');
        const createdIso = createdRaw && (createdRaw.endsWith('Z') || createdRaw.includes('+'))
          ? createdRaw : createdRaw + 'Z';
        const createdJstMs = new Date(createdIso).getTime() + 9 * 60 * 60 * 1000;
        const createdStr   = new Date(createdJstMs).toISOString().slice(0, 10);
        const currentTime  = nowJst.toISOString().slice(11, 16);

        let isExpired = false;
        if (bagCheck.pickupEnd) {
          // 2部制(受取2枠): 期限は「最後の枠の終わり」= pickupEnd2 があればそちら。
          const effEnd = bagCheck.pickupEnd2 || bagCheck.pickupEnd;
          // 深夜またぎ判定は最後の枠(effEnd)基準（2部制で2枠目が日跨ぎのケースを取りこぼさない）。
          const isOvernight = bagCheck.pickupStart != null && effEnd < bagCheck.pickupStart;
          if (bagCheck.pickupNextDay) {
            // 翌日受取(前日出品): 今日出品→受取は明日でまだ有効 / 昨日出品→今日が受取日 / それ以前→期限切れ
            if (createdStr === todayStr) isExpired = false;
            else if (createdStr === yesterdayStr) isExpired = currentTime > effEnd;
            else isExpired = true;
          } else if (isOvernight) {
            if (createdStr === todayStr) {
              isExpired = false;
            } else if (createdStr === yesterdayStr) {
              isExpired = currentTime > effEnd;
            } else {
              isExpired = true;
            }
          } else {
            isExpired = (createdStr !== todayStr) || (currentTime > effEnd);
          }
        } else {
          // pickupEnd 未設定: 出品日が今日でなければ期限切れ (フロント getBagStatus と同等)
          isExpired = createdStr !== todayStr;
        }
        if (isExpired) {
          res.status(409).json({
            error: "pickup_time_passed",
            message: "受取時間が過ぎているため公開できません。 受取時間を編集してから再度公開してください。",
          });
          return;
        }
      }
    }

    const [updated] = await db
      .update(surpriseBagsTable)
      .set(body)
      .where(and(
        eq(surpriseBagsTable.id, bagId),
        eq(surpriseBagsTable.storeId, storeId),
      ))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Bag not found or not owned by this store" });
      return;
    }
    // ★ 出品取り消し(非公開化)時は、その出品で送った新着通知(ベル)も消す。
    if (body.isActive === false) await deleteNewBagNotifications(bagId);
    invalidate("bags:list"); invalidate("stores:list");
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Invalid update data" });
  }
});

export default router;
