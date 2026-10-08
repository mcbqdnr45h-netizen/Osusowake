import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { recurringListingsTable, storesTable, surpriseBagsTable, reservationsTable } from "@workspace/db/schema";
import { eq, and, desc, sql, isNotNull, inArray } from "drizzle-orm";
import { notifyFavoritesOfRecurring } from "../lib/recurring-fan-notify.js";

/** この定期出品テンプレ由来で現在公開中のバッグを出品停止する（既存予約は壊さない）。 */
async function deactivateBagsForListing(listingId: number): Promise<void> {
  await db
    .update(surpriseBagsTable)
    .set({ isActive: false })
    .where(and(eq(surpriseBagsTable.recurringListingId, listingId), eq(surpriseBagsTable.isActive, true)));
}
import { requireAuth, requireStoreOwner } from "../middlewares/auth.js";
import { bagVisibleSql } from "../lib/bag-visibility.js";

const router: IRouter = Router();

// ── パイロット店ホワイトリスト（env RECURRING_PILOT_STORE_IDS="135,..."）──
//   定期出品はまずこの店だけに見える/使える。 他店・他ユーザーには一切出ない。
function pilotStoreIds(): number[] {
  return (process.env.RECURRING_PILOT_STORE_IDS ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}
function isPilotStore(storeId: number): boolean {
  return pilotStoreIds().includes(storeId);
}

/**
 * この店舗で定期出品が使えるか判定。
 * - env RECURRING_PILOT_STORE_IDS="all" → 全「承認済み」店に開放（本番運用）。
 * - それ以外（店舗IDのカンマ区切り） → そのIDの店だけ（パイロット/キルスイッチ）。
 * 未承認店は自動公開できない（publisher が approved のみ公開）ため UI も出さない。
 */
async function isRecurringEnabled(storeId: number): Promise<boolean> {
  const raw = (process.env.RECURRING_PILOT_STORE_IDS ?? "").trim();
  if (raw.toLowerCase() === "all") {
    const [s] = await db
      .select({ status: storesTable.status })
      .from(storesTable)
      .where(eq(storesTable.id, storeId))
      .limit(1);
    return s?.status === "approved";
  }
  return isPilotStore(storeId);
}

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// ── JST 日付ユーティリティ（「今夜だけ停止」の対象日計算用）──
function jstNow(): { date: string; time: string; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}`, dow: dowMap[get("weekday")] ?? 0 };
}
function addDays(dateStr: string, n: number): { date: string; dow: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return { date: `${dt.getUTCFullYear()}-${mm}-${dd}`, dow: dt.getUTCDay() };
}
/** 次に自動公開される JST 日付。 「今夜だけ停止」はこの日をスキップする。 */
function nextPublishDate(listing: typeof recurringListingsTable.$inferSelect): string {
  const { date: today, time, dow } = jstNow();
  // ★ 休みカレンダー(skip_dates=受取日ベース)を考慮。 publisher と同じく「この公開回が serve する
  //   受取日(前日出品なら翌日/当日出品なら当日)」が休みなら、 その回はスキップして次を探す。
  //   これが無いと、 バッジが実際は出ない日を表示し、 skip-tonight が既に休みの日を足して no-op になる。
  const skips = new Set(
    (listing.skipDates ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
  );
  const pickupDateOf = (publishDate: string) => (listing.pickupNextDay ? addDays(publishDate, 1).date : publishDate);
  for (let i = 0; i < 31; i++) {
    const cur = i === 0 ? { date: today, dow } : addDays(today, i);
    const pickupDow = listing.pickupNextDay ? (cur.dow + 1) % 7 : cur.dow;
    if ((listing.daysOfWeek & (1 << pickupDow)) === 0) continue;
    if (skips.has(pickupDateOf(cur.date))) continue; // この回の受取日が休み → スキップ
    if (i === 0) {
      // 今日: まだ未公開かつ公開時刻前なら今日が対象。 公開済み or 時刻を過ぎていれば今日は対象外
      if (listing.lastPublishedDate !== today && time < listing.publishTime) return cur.date;
      continue;
    }
    return cur.date;
  }
  return today;
}

/** :id の定期出品を取得し、 リクエストユーザーが所有店オーナーか検証。 */
async function getOwnedListing(req: Request, res: Response) {
  const id = parseInt(String(req.params.id ?? ""), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "bad_request", message: "Invalid id" }); return null; }
  const [listing] = await db.select().from(recurringListingsTable).where(eq(recurringListingsTable.id, id)).limit(1);
  if (!listing) { res.status(404).json({ error: "not_found", message: "定期出品が見つかりません" }); return null; }
  const [store] = await db.select({ ownerId: storesTable.ownerId }).from(storesTable).where(eq(storesTable.id, listing.storeId)).limit(1);
  if (!store || !store.ownerId || store.ownerId !== req.authUser!.id) {
    res.status(403).json({ error: "forbidden", message: "この定期出品を操作する権限がありません" });
    return null;
  }
  return listing;
}

// 一覧（+ この店で定期出品が使えるか = enabled）
router.get("/stores/:storeId/recurring", requireAuth, requireStoreOwner, async (req, res) => {
  const storeId = req.authStore!.id;
  if (!(await isRecurringEnabled(storeId))) { res.json({ enabled: false, listings: [] }); return; }
  const listings = await db.select().from(recurringListingsTable)
    .where(eq(recurringListingsTable.storeId, storeId))
    .orderBy(desc(recurringListingsTable.createdAt));

  // 各テンプレが「今日公開したバッグ」の在庫合計を集計（売切判定用）。
  //   公開中(is_active)バッグのみ。 在庫0=本日完売。 今日未公開なら該当なし(null)。
  const todayRows = await db
    .select({ rid: surpriseBagsTable.recurringListingId, stock: surpriseBagsTable.stockCount })
    .from(surpriseBagsTable)
    .where(and(
      eq(surpriseBagsTable.storeId, storeId),
      isNotNull(surpriseBagsTable.recurringListingId),
      // is_active は条件にしない: 完売後に非アクティブ化されたバッグも在庫0として数え、
      // 「本日完売」を正しく検知する（在庫で判定）。
      sql`DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
    ));
  const stockByListing = new Map<number, number>();
  for (const r of todayRows) {
    if (r.rid != null) stockByListing.set(r.rid, (stockByListing.get(r.rid) ?? 0) + (r.stock ?? 0));
  }

  // 今 客に表示中(is_active かつ notExpired)のバッグがあるテンプレ = 「いま出品中」。
  //   ★ bagVisibleSql で「表示中」に限定。 受取窓を過ぎた古いバッグを除外し、 残在庫も正確に集計。
  const liveRows = await db
    .select({ rid: surpriseBagsTable.recurringListingId, stock: surpriseBagsTable.stockCount })
    .from(surpriseBagsTable)
    .where(and(
      eq(surpriseBagsTable.storeId, storeId),
      isNotNull(surpriseBagsTable.recurringListingId),
      eq(surpriseBagsTable.isActive, true),
      bagVisibleSql,
    ));
  const liveStockByListing = new Map<number, number>();
  for (const r of liveRows) if (r.rid != null) liveStockByListing.set(r.rid, (liveStockByListing.get(r.rid) ?? 0) + (r.stock ?? 0));
  const liveSet = new Set<number>(liveStockByListing.keys());

  // 公開中バッグに対する「有効な予約」(status=pending/confirmed = 未受取・未キャンセル)を
  // テンプレ単位で集計。 取り下げ時に「予約済みの客がいる」警告を出すため。
  //   reservedQty = 有効予約の合計個数 / paidQty = うち決済済み(paymentStatus='paid')の個数。
  const resvRows = await db
    .select({
      rid: surpriseBagsTable.recurringListingId,
      qty: reservationsTable.quantity,
      paymentStatus: reservationsTable.paymentStatus,
    })
    .from(reservationsTable)
    .innerJoin(surpriseBagsTable, eq(reservationsTable.bagId, surpriseBagsTable.id))
    .where(and(
      eq(surpriseBagsTable.storeId, storeId),
      isNotNull(surpriseBagsTable.recurringListingId),
      eq(surpriseBagsTable.isActive, true),
      bagVisibleSql,
      inArray(reservationsTable.status, ["pending", "confirmed"]),
    ));
  const reservedByListing = new Map<number, number>();
  const paidByListing = new Map<number, number>();
  for (const r of resvRows) {
    if (r.rid == null) continue;
    const q = r.qty ?? 1;
    reservedByListing.set(r.rid, (reservedByListing.get(r.rid) ?? 0) + q);
    if (r.paymentStatus === "paid") paidByListing.set(r.rid, (paidByListing.get(r.rid) ?? 0) + q);
  }

  // 持ち越しモードの「完売して止まっている」状態の検知用: 各テンプレの最新バッグの在庫。
  //   完売(<=0)で表示中バッグも無い → carryOverSoldOut=true → UIで「完売・在庫を入れ直すと再開」表示。
  const latestStockRes = await db.execute(sql`
    SELECT DISTINCT ON (recurring_listing_id) recurring_listing_id AS rid, stock_count AS stock
    FROM surprise_bags
    WHERE store_id = ${storeId} AND recurring_listing_id IS NOT NULL
    ORDER BY recurring_listing_id, created_at DESC
  `);
  const latestStockByListing = new Map<number, number>();
  for (const r of (latestStockRes.rows ?? []) as Array<{ rid: number | null; stock: number | null }>) {
    if (r.rid != null) latestStockByListing.set(Number(r.rid), Number(r.stock ?? 0));
  }

  const enriched = listings.map((l) => {
    // 次に自動公開される日(=「休む」対象の公開日) と、 その受取日(前日出品なら+1日)。
    const np = nextPublishDate(l);
    const nextPickupDate = l.pickupNextDay ? addDays(np, 1).date : np;
    const latestStock = latestStockByListing.get(l.id);
    return {
      ...l,
      todayStock: stockByListing.has(l.id) ? stockByListing.get(l.id)! : null,
      nextPublishDate: np,
      nextPickupDate,
      hasLiveBag: liveSet.has(l.id),
      liveStock: liveStockByListing.get(l.id) ?? 0,
      // 持ち越しモードで完売して止まっている（表示中バッグ無し＆最新在庫0）
      carryOverSoldOut: !!l.carryOverStock && !liveSet.has(l.id) && latestStock != null && latestStock <= 0,
      liveReservedQty: reservedByListing.get(l.id) ?? 0,
      livePaidQty: paidByListing.get(l.id) ?? 0,
    };
  });
  res.json({ enabled: true, listings: enriched });
});

// 作成
router.post("/stores/:storeId/recurring", requireAuth, requireStoreOwner, async (req, res) => {
  const storeId = req.authStore!.id;
  if (!(await isRecurringEnabled(storeId))) { res.status(403).json({ error: "not_enabled", message: "この店舗では定期出品をまだ利用できません" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!b.title || typeof b.title !== "string") { res.status(400).json({ error: "bad_request", message: "商品名は必須です" }); return; }
  if (!isValidHHMM(b.publishTime)) { res.status(400).json({ error: "bad_request", message: "公開時刻は HH:MM 形式で指定してください" }); return; }
  if (Number(b.discountedPrice) < 50) { res.status(400).json({ error: "price_too_low", message: "価格は50円以上に設定してください" }); return; }
  if (!(Number(b.stockCount) >= 1)) { res.status(400).json({ error: "stock_too_low", message: "在庫数は1以上に設定してください" }); return; }
  const dow = Number.isInteger(b.daysOfWeek) ? ((b.daysOfWeek as number) & 127) : 127;
  const [created] = await db.insert(recurringListingsTable).values({
    storeId,
    title: b.title,
    description: (b.description as string) ?? null,
    originalPrice: Number(b.originalPrice) || Number(b.discountedPrice) || 0, // 未指定(NaN)防止
    discountedPrice: Number(b.discountedPrice),
    stockCount: Number(b.stockCount) || 0,
    pickupStart: (b.pickupStart as string) ?? null,
    pickupEnd: (b.pickupEnd as string) ?? null,
    // 2部制(受取2枠): 両方が HH:MM の時だけ採用。
    pickupStart2: (isValidHHMM(b.pickupStart2) && isValidHHMM(b.pickupEnd2)) ? b.pickupStart2 : null,
    pickupEnd2: (isValidHHMM(b.pickupStart2) && isValidHHMM(b.pickupEnd2)) ? b.pickupEnd2 : null,
    imageUrl: (b.imageUrl as string) ?? null,
    category: (b.category as string) ?? null,
    allergyInfo: (b.allergyInfo as string) ?? null,
    pickupNote: (b.pickupNote as string) ?? null,
    itemType: (b.itemType as string) ?? "bag",
    publishTime: b.publishTime,
    daysOfWeek: dow,
    pickupNextDay: b.pickupNextDay === true,
    isActive: b.isActive === false ? false : true,
    carryOverStock: b.carryOverStock === true,
    skipDates: (() => {
      const raw = Array.isArray(b.skipDates) ? (b.skipDates as unknown[]) : (typeof b.skipDates === "string" ? b.skipDates.split(",") : []);
      const clean = raw.map((s) => String(s).trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
      return Array.from(new Set(clean)).sort().join(",") || null;
    })(),
  }).returning();
  res.status(201).json(created);
});

// 更新（時刻・曜日・在庫・有効/無効・商品情報）
router.patch("/recurring/:id", requireAuth, async (req, res) => {
  const listing = await getOwnedListing(req, res);
  if (!listing) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.title === "string") patch.title = b.title;
  if ("description" in b) patch.description = (b.description as string) ?? null;
  if (b.originalPrice != null) patch.originalPrice = Number(b.originalPrice);
  if (b.discountedPrice != null) {
    if (Number(b.discountedPrice) < 50) { res.status(400).json({ error: "price_too_low", message: "価格は50円以上に設定してください" }); return; }
    patch.discountedPrice = Number(b.discountedPrice);
  }
  if (b.stockCount != null) {
    if (!(Number(b.stockCount) >= 1)) { res.status(400).json({ error: "stock_too_low", message: "在庫数は1以上に設定してください" }); return; }
    patch.stockCount = Number(b.stockCount);
  }
  if ("pickupStart" in b) patch.pickupStart = (b.pickupStart as string) ?? null;
  if ("pickupEnd" in b) patch.pickupEnd = (b.pickupEnd as string) ?? null;
  // 2部制(受取2枠): どちらかが来たら両方更新。 両方HH:MMの時だけ採用、 それ以外はクリア(1枠化)。
  if ("pickupStart2" in b || "pickupEnd2" in b) {
    const has2 = isValidHHMM(b.pickupStart2) && isValidHHMM(b.pickupEnd2);
    patch.pickupStart2 = has2 ? b.pickupStart2 : null;
    patch.pickupEnd2 = has2 ? b.pickupEnd2 : null;
  }
  if ("imageUrl" in b) patch.imageUrl = (b.imageUrl as string) ?? null;
  if ("category" in b) patch.category = (b.category as string) ?? null;
  if ("allergyInfo" in b) patch.allergyInfo = (b.allergyInfo as string) ?? null;
  if ("pickupNote" in b) patch.pickupNote = (b.pickupNote as string) ?? null;
  if ("itemType" in b) patch.itemType = (b.itemType as string) ?? "bag";
  if (b.publishTime != null) {
    if (!isValidHHMM(b.publishTime)) { res.status(400).json({ error: "bad_request", message: "公開時刻は HH:MM 形式で指定してください" }); return; }
    patch.publishTime = b.publishTime;
  }
  if (b.daysOfWeek != null && Number.isInteger(b.daysOfWeek)) patch.daysOfWeek = (b.daysOfWeek as number) & 127;
  if (typeof b.pickupNextDay === "boolean") patch.pickupNextDay = b.pickupNextDay;
  if (typeof b.isActive === "boolean") patch.isActive = b.isActive;
  if (typeof b.carryOverStock === "boolean") patch.carryOverStock = b.carryOverStock;
  // 休みカレンダー: 配列 or カンマ区切り文字列を受け取り、 "YYYY-MM-DD" のみに正規化して保存。
  if ("skipDates" in b) {
    const raw = Array.isArray(b.skipDates)
      ? (b.skipDates as unknown[])
      : (typeof b.skipDates === "string" ? b.skipDates.split(",") : []);
    const clean = raw.map((s) => String(s).trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    patch.skipDates = Array.from(new Set(clean)).sort().join(",") || null;
  }
  const [updated] = await db.update(recurringListingsTable).set(patch).where(eq(recurringListingsTable.id, listing.id)).returning();
  // ★ 停止(非公開)にしたら、 このテンプレ由来で公開中のバッグも出品停止して「出品中」から外す。
  if (patch.isActive === false) await deactivateBagsForListing(listing.id);
  // ★ 持ち越しモードで在庫数を変更したら、 このテンプレ由来の【最新】バッグの在庫だけ即更新＝補充して再出品。
  //   （完売後に新しく出せる分ができたら、 在庫を入れ直すだけで再び並ぶ。
  //    最新1件に限定＝固定→持ち越しに切替えた店の古いバッグを誤って復活させない）
  else if (updated?.carryOverStock && b.stockCount != null && Number(b.stockCount) >= 1) {
    const [latest] = await db
      .select({ id: surpriseBagsTable.id })
      .from(surpriseBagsTable)
      .where(eq(surpriseBagsTable.recurringListingId, listing.id))
      .orderBy(desc(surpriseBagsTable.createdAt))
      .limit(1);
    if (latest) {
      await db.update(surpriseBagsTable)
        .set({ stockCount: Number(b.stockCount), isActive: true })
        .where(eq(surpriseBagsTable.id, latest.id));
    }
  }
  res.json(updated);
});

// 次回を1回休む（クイック）。 休みは全てカレンダー(skip_dates=受取日ベース)に集約。
//   次に公開される回が serve する受取日を skip_dates に追加する。
router.post("/recurring/:id/skip-tonight", requireAuth, async (req, res) => {
  const listing = await getOwnedListing(req, res);
  if (!listing) return;
  const publishDate = nextPublishDate(listing);
  const pickupDate = listing.pickupNextDay ? addDays(publishDate, 1).date : publishDate;
  const existing = (listing.skipDates ? listing.skipDates.split(",").map((s) => s.trim()) : [])
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  const merged = Array.from(new Set([...existing, pickupDate])).sort().join(",");
  const [updated] = await db.update(recurringListingsTable)
    .set({ skipDates: merged, updatedAt: new Date() })
    .where(eq(recurringListingsTable.id, listing.id)).returning();
  res.json(updated);
});

// 今 公開中の分だけ取り下げる（定期出品テンプレは継続）。
//   「今日は余らなかった」が"公開後"に分かった時用。 前日出品だと当日朝には既に公開済みなので、
//   skip-tonight（次回をスキップ）では今 出ている分を止められない。 これで今の分だけ引っ込める。
router.post("/recurring/:id/withdraw-now", requireAuth, async (req, res) => {
  const listing = await getOwnedListing(req, res);
  if (!listing) return;
  await deactivateBagsForListing(listing.id);
  res.json({ ok: true });
});

// ─── 今すぐ公開する ────────────────────────────────────────────────────────────
// POST /api/recurring/:id/publish-now
//
// ★ 背景 (2026-08-12 あんぱん店より)
//   「定期出品が売り切れた後、在庫を足したのに、すぐ客に出せず【次回の公開時刻まで待ち】になる」
//   原因は在庫の持ち方ではなく【客に見えるのは "今日つくられたバッグ" だけ】という仕様。
//   在庫を足すと最新バッグの在庫は増える(PATCH側)が、それが昨日つくられたバッグだと
//   客の一覧には出てこない。結果、店には在庫3と見えているのに誰も買えない状態になる。
//   → 押した瞬間に「今日の日付で」バッグを作り直す口をつくる。これで即座に並ぶ。
//
// 仕様
//   ・自動公開と同じ店ガード（承認済み + Stripeで課金可 + 入金可）を通す。抜くな。
//   ・すでに今日公開中の分があるなら、二重に並べず在庫だけ合わせる。
//   ・新しく出す時は、古い分を出品停止してから出す（二重表示・二重計上の防止）。
//   ・今日の自動公開マークも付ける＝この後の公開時刻に同じ物がもう1個増えない。
//   ・通知は出さない（定期出品は通知しない方針。マロ指示 2026-07-08）。
router.post("/recurring/:id/publish-now", requireAuth, async (req, res) => {
  const listing = await getOwnedListing(req, res);
  if (!listing) return;

  if (!listing.isActive) {
    res.status(400).json({ error: "inactive", message: "停止中の定期出品です。先に「再開する」を押してください" });
    return;
  }

  const [store] = await db
    .select({
      status: storesTable.status,
      stripeAccountId: storesTable.stripeAccountId,
      stripeChargesEnabled: storesTable.stripeChargesEnabled,
      stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
    })
    .from(storesTable)
    .where(eq(storesTable.id, listing.storeId))
    .limit(1);
  if (
    !store ||
    store.status !== "approved" ||
    !store.stripeAccountId ||
    !store.stripeChargesEnabled ||
    !store.stripePayoutsEnabled
  ) {
    res.status(400).json({
      error: "store_not_ready",
      message: "お店の審査またはお振込口座の設定が完了していないため公開できません",
    });
    return;
  }

  const stock = Number(listing.stockCount);
  if (!(stock >= 1)) {
    res.status(400).json({ error: "stock_too_low", message: "在庫が0です。先に在庫数を入れてください" });
    return;
  }

  // ★ 穴①: 受取時間が過ぎた後に押せてしまう。
  //   客に見える条件は「今日つくられ、かつ最終受取時刻をまだ過ぎていない」。
  //   夕方の受取が終わった後に押すと、バッグは作られるのに客の一覧には出ず、
  //   店には「公開しました」とだけ出る＝一番タチが悪い（出したつもりで出ていない）。
  //   出せない時は作らずにハッキリ理由を返す。
  //   ※ 前日受け取り / 受取時間なし / 深夜またぎ は当日中ずっと見えるので対象外。
  //   ※ 時刻は必ず jstNow() を使う。環境によっては深夜0時台が "24:05" と出る実装があり
  //     （このファイルの jstNow() が既にその対策を持っている）、自前で書くと
  //     深夜0時台だけ「まだ受取前なのに"過ぎている"と誤判定して公開できない」ことになる。
  const { date: jstToday, time: nowHHMM } = jstNow();
  const endTime = listing.pickupEnd2 ?? listing.pickupEnd;   // 2部制なら最後の枠の終わり
  const startTime = listing.pickupStart;
  const crossesMidnight = !!(endTime && startTime && endTime < startTime);
  if (!listing.pickupNextDay && endTime && startTime && !crossesMidnight && endTime < nowHHMM) {
    res.status(400).json({
      error: "pickup_window_passed",
      message: `本日の受取時間（〜${endTime}）が過ぎているため、今すぐの公開はできません。次回の自動公開をお待ちください`,
    });
    return;
  }

  // ★ 穴②: 「休み」に設定した日でも公開できてしまう。
  //   店が休みと宣言した受取日に客が注文すると、来店しても店が閉まっている事故になる。
  const targetPickupDate = listing.pickupNextDay ? addDays(jstToday, 1).date : jstToday;
  const skipList = (listing.skipDates ? listing.skipDates.split(",").map((s) => s.trim()) : [])
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (skipList.includes(targetPickupDate)) {
    res.status(400).json({
      error: "pickup_date_is_holiday",
      message: `${targetPickupDate} は「休み」に設定されています。休みを解除してから公開してください`,
    });
    return;
  }

  // すでに今日つくられた分が【客に見えている】なら、二重に並べず在庫だけ合わせる。
  //   可視条件は全画面共通の bagVisibleSql を使う（ここで独自判定を書くとドリフトする）。
  const [liveToday] = await db
    .select({ id: surpriseBagsTable.id })
    .from(surpriseBagsTable)
    .where(and(
      eq(surpriseBagsTable.recurringListingId, listing.id),
      eq(surpriseBagsTable.isActive, true),
      bagVisibleSql,
    ))
    .orderBy(desc(surpriseBagsTable.createdAt))
    .limit(1);

  if (liveToday) {
    await db.update(surpriseBagsTable)
      .set({ stockCount: stock })
      .where(eq(surpriseBagsTable.id, liveToday.id));
    console.log(`[recurring] publish-now(restock) bag=${liveToday.id} tpl=${listing.id} stock=${stock}`);
    res.json({ ok: true, bagId: liveToday.id, mode: "restock", stock });
    return;
  }

  // 古い分（昨日つくられて客には見えていない残骸など）を止めてから、今日の分を出す。
  await deactivateBagsForListing(listing.id);

  const [bag] = await db
    .insert(surpriseBagsTable)
    .values({
      storeId: listing.storeId,
      title: listing.title,
      description: listing.description,
      originalPrice: listing.originalPrice,
      discountedPrice: listing.discountedPrice,
      stockCount: stock,
      pickupStart: listing.pickupStart,
      pickupEnd: listing.pickupEnd,
      pickupStart2: listing.pickupStart2,
      pickupEnd2: listing.pickupEnd2,
      imageUrl: listing.imageUrl,
      category: listing.category,
      allergyInfo: listing.allergyInfo,
      pickupNote: listing.pickupNote,
      itemType: listing.itemType ?? "bag",
      pickupNextDay: listing.pickupNextDay,
      recurringListingId: listing.id,
      isActive: true,
    })
    .returning();

  if (!bag) {
    res.status(500).json({ error: "insert_failed", message: "公開に失敗しました。もう一度お試しください" });
    return;
  }

  // ★ 最後の砦: 作ったバッグが【本当にお客様の一覧に出ているか】を、客と同じ条件で確かめる。
  //   上のガードは「出せない状況」を先読みしているが、受取開始だけ未設定など想定外の
  //   設定の組み合わせが残ると、また「公開しましたと出るのに客には見えない」に戻る。
  //   予測ではなく結果を見る。見えていなければ作ったものを取り消して、正直に失敗を返す。
  //   （lastPublishedDate はここまで触らない＝失敗しても自動公開の権利を奪わない）
  const [visible] = await db
    .select({ id: surpriseBagsTable.id })
    .from(surpriseBagsTable)
    .where(and(eq(surpriseBagsTable.id, bag.id), bagVisibleSql))
    .limit(1);
  if (!visible) {
    await db.update(surpriseBagsTable)
      .set({ isActive: false })
      .where(eq(surpriseBagsTable.id, bag.id));
    console.warn(`[recurring] publish-now ROLLBACK bag=${bag?.id} tpl=${listing.id} — 作成したが客に表示されない設定のため取り消し`);
    res.status(400).json({
      error: "would_not_be_visible",
      message: "この設定では今すぐ公開してもお客様の画面に表示されません。受取時間の設定をご確認ください",
    });
    return;
  }

  // ここまで来て初めて「今日はもう出した」と印を付ける
  // （この後の自動公開で同じ物がもう1個並ぶのを防ぐ）。
  await db.update(recurringListingsTable)
    .set({
      lastPublishedDate: sql`TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD')`,
      updatedAt: new Date(),
    })
    .where(eq(recurringListingsTable.id, listing.id));

  console.log(`[recurring] publish-now(new) bag=${bag?.id} store=${listing.storeId} tpl=${listing.id} stock=${stock}`);

  try {
    const [store] = await db
      .select({ name: storesTable.name })
      .from(storesTable)
      .where(eq(storesTable.id, listing.storeId))
      .limit(1);
    if (store) {
      await notifyFavoritesOfRecurring({
        storeId: listing.storeId,
        storeName: store.name,
        bagId: bag.id,
        bagTitle: listing.title,
        discountedPrice: listing.discountedPrice,
        stockCount: stock,
      });
    }
  } catch (notifyErr) {
    console.error(`[recurring] publish-now fan notify error (non-fatal) tpl=${listing.id}:`, notifyErr);
  }

  res.json({ ok: true, bagId: bag?.id, mode: "new", stock });
});

// 削除
router.delete("/recurring/:id", requireAuth, async (req, res) => {
  const listing = await getOwnedListing(req, res);
  if (!listing) return;
  // ★ 削除時も、 このテンプレ由来で公開中のバッグを出品停止してから削除する。
  await deactivateBagsForListing(listing.id);
  await db.delete(recurringListingsTable).where(eq(recurringListingsTable.id, listing.id));
  res.json({ ok: true });
});

// ─── 公開: 次回の出品予定（お客様向け・認証不要）────────────────────────────
// GET /api/stores/:storeId/next-drop
//   定期出品はしているが今は出品が無い店を「もうやっていない店」に見せないための最小情報。
//   返すのは受取日と受取時間帯だけ（店主の個人情報・在庫・価格は一切返さない）。
//   定期出品が無い / 停止中 / 未承認の店は { next: null }。
router.get("/stores/:storeId/next-drop", async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId ?? ""), 10);
    if (Number.isNaN(storeId)) { res.json({ next: null }); return; }

    // 承認済み・営業中の店のみ（未承認店の予定を客に見せない）
    const [store] = await db
      .select({ status: storesTable.status, isActive: storesTable.isActive })
      .from(storesTable)
      .where(eq(storesTable.id, storeId))
      .limit(1);
    if (!store || store.status !== "approved" || store.isActive === false) {
      res.json({ next: null });
      return;
    }

    const listings = await db
      .select()
      .from(recurringListingsTable)
      .where(and(eq(recurringListingsTable.storeId, storeId), eq(recurringListingsTable.isActive, true)));
    if (listings.length === 0) { res.json({ next: null }); return; }

    // 各テンプレの「次の受取日」を出し、最も近いものを返す。
    let best: { pickupDate: string; pickupStart: string | null; pickupEnd: string | null } | null = null;
    for (const l of listings) {
      const np = nextPublishDate(l);
      const pickupDate = l.pickupNextDay ? addDays(np, 1).date : np;
      if (!best || pickupDate < best.pickupDate) {
        best = { pickupDate, pickupStart: l.pickupStart ?? null, pickupEnd: l.pickupEnd ?? null };
      }
    }
    res.json({ next: best });
  } catch (err) {
    console.error("[next-drop] error:", err);
    // 失敗しても客の画面を壊さない（単に非表示になるだけ）
    res.json({ next: null });
  }
});

export default router;
