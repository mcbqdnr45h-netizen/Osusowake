import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { surpriseBagsTable, storesTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { bagVisibleSql } from "../lib/bag-visibility.js";
import { cached } from "../lib/ttl-cache.js";
import { computeUserTotal } from "../lib/pricing.js";

const router: IRouter = Router();

/**
 * 外部パートナー(地域メディア等)向けの公開・読み取り専用 出品一覧 API。
 *
 * セキュリティ設計:
 *  - GET のみ (書き込み経路なし)。
 *  - APIキー認証 (env PARTNER_API_KEY, timing-safe 比較)。未設定 or 不一致は 401。
 *  - 返すのは「アプリ内で既に公開済み」の店舗・出品情報のみ。
 *    PII (法人情報/KYC/StripeアカウントID/ownerId/電話番号/ユーザー情報/売上) は
 *    そもそも SELECT に含めない (=カラム単位で物理除外)。
 *  - 価格は必ず computeUserTotal 経由 = お客様が実際に支払う額 (5%利用料込み・¥10切上)。
 *    生の discountedPrice を出すと決済画面より安く見え「話が違う」を誘発するため。
 */
function requirePartnerKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env["PARTNER_API_KEY"] ?? "";
  const headerKey = (req.headers["x-api-key"] as string | undefined) ?? "";
  const authz = req.headers.authorization ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  const given = headerKey || bearer;
  if (!expected || !given) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    if (!crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  } catch {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// ★ 公開して良い店舗フィールドのみ (bags.ts の publicStoreCols と同方針)。
//   除外: ownerId, phone(要望により今回は非公開), legal*, license*, id画像,
//         stripe*, rejectionReason 等の PII / 内部フラグ。
//   data: URL(base64) は肥大化するため NULL に潰し、icon を代替に返す。
const publicStore = {
  id: storesTable.id,
  name: storesTable.name,
  description: storesTable.description,
  category: storesTable.category,
  address: storesTable.address,
  city: storesTable.city,
  lat: storesTable.lat,
  lng: storesTable.lng,
  openTime: storesTable.openTime,
  closeTime: storesTable.closeTime,
  holiday: storesTable.holiday,
  pickupHours: storesTable.pickupHours,
  imageUrl: sql<string | null>`CASE
    WHEN ${storesTable.imageUrl} LIKE 'data:%' OR ${storesTable.imageUrl} IS NULL THEN
      CASE WHEN ${storesTable.iconUrl} LIKE 'data:%' THEN NULL ELSE ${storesTable.iconUrl} END
    ELSE ${storesTable.imageUrl}
  END`.as("store_image_url"),
  iconUrl: sql<string | null>`CASE WHEN ${storesTable.iconUrl} LIKE 'data:%' THEN NULL ELSE ${storesTable.iconUrl} END`.as("store_icon_url"),
} as const;

// GET /api/public/listings?area=takatsuki&status=active
router.get("/public/listings", requirePartnerKey, async (req, res) => {
  try {
    const area = String(req.query["area"] ?? "").trim().toLowerCase();
    const isTakatsuki = area === "takatsuki";
    const cacheKey = `public:listings:${isTakatsuki ? "takatsuki" : "all"}`;

    const rows = await cached(cacheKey, 15_000, async () => {
      return db
        .select({
          id: surpriseBagsTable.id,
          title: surpriseBagsTable.title,
          description: surpriseBagsTable.description,
          originalPrice: surpriseBagsTable.originalPrice,
          discountedPrice: surpriseBagsTable.discountedPrice,
          stockCount: surpriseBagsTable.stockCount,
          category: surpriseBagsTable.category,
          imageUrl: surpriseBagsTable.imageUrl,
          pickupStart: surpriseBagsTable.pickupStart,
          pickupEnd: surpriseBagsTable.pickupEnd,
          pickupStart2: surpriseBagsTable.pickupStart2,
          pickupEnd2: surpriseBagsTable.pickupEnd2,
          pickupNextDay: surpriseBagsTable.pickupNextDay,
          createdAt: surpriseBagsTable.createdAt,
          store: publicStore,
        })
        .from(surpriseBagsTable)
        .innerJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
        .where(
          and(
            eq(surpriseBagsTable.isActive, true),
            sql`${storesTable.status} = 'approved' AND ${storesTable.isActive} = true`,
            bagVisibleSql,
            isTakatsuki
              ? sql`(${storesTable.city} ILIKE '%高槻%' OR ${storesTable.city} ILIKE '%takatsuki%')`
              : sql`true`,
          ),
        )
        .orderBy(surpriseBagsTable.id);
    });

    const listings = rows.map((b) => {
      const img = b.imageUrl && !b.imageUrl.startsWith("data:") ? b.imageUrl : null;
      const open = b.store.openTime ?? null;
      const close = b.store.closeTime ?? null;
      return {
        id: b.id,
        status: "active",
        title: b.title,
        description: b.description,
        price: computeUserTotal(Number(b.discountedPrice)), // ★お客様が実際に払う額(5%込)
        // ★ 割引前も必ず computeUserTotal を通す。アプリ内 (price-display.ts getDisplayPrice)
        //   は割引前・割引後の両方に 5%込み・¥10切上を適用して整合させている。ここで生値を
        //   返すと「割引後は5%込み・割引前は生値」の非対称になり、アプリと数字が食い違い
        //   (例 originalPrice=602 → アプリ¥640 / ポータル¥602)、割引率まで狂う。
        original_price: b.originalPrice != null ? computeUserTotal(Number(b.originalPrice)) : null,
        currency: "JPY",
        image_url: img,
        category: b.category,
        quantity: null, // 総数は保持していない
        remaining: b.stockCount,
        pickup_start: b.pickupStart, // JST "HH:mm" (時刻・当日)
        pickup_end: b.pickupEnd,
        pickup_start2: b.pickupStart2 ?? null,
        pickup_end2: b.pickupEnd2 ?? null,
        pickup_next_day: !!b.pickupNextDay,
        web_url: "https://osusowakejapan.org/",
        created_at: b.createdAt,
        updated_at: null,
        store: {
          store_id: b.store.id,
          // ★ 店舗個別ページ (ディープリンク)。本番 SPA の公開ルート /stores/:id
          //   (StoreDetailPublic) にそのまま飛べる。パートナーの店舗ページからの送客用。
          store_url: `https://osusowakejapan.org/stores/${b.store.id}`,
          name: b.store.name,
          name_kana: null,
          pr_text: b.store.description,
          catchcopy: null,
          logo_url: b.store.iconUrl,
          image_url: b.store.imageUrl,
          category: b.store.category,
          address: b.store.address,
          city: b.store.city,
          lat: b.store.lat,
          lng: b.store.lng,
          phone: null, // 要望により非公開(送客はアプリ経由)
          website_url: null,
          sns: null,
          open_time: open,
          close_time: close,
          business_hours: open && close ? `${open}〜${close}` : null,
          holiday: b.store.holiday,
          pickup_hours: b.store.pickupHours ?? null,
        },
      };
    });

    res.setHeader("Cache-Control", "public, max-age=15");
    res.json({
      generated_at: new Date().toISOString(),
      count: listings.length,
      listings,
    });
  } catch (err) {
    console.error("[public/listings] error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
