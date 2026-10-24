import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { storesTable, surpriseBagsTable, reportsTable, reviewsTable, reservationsTable, notificationsTable } from "@workspace/db/schema";
import { eq, sql, and, ne, gte, lt, inArray, count, desc } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase";
import { documentViewUrl } from "../lib/store-documents.js";
import { escapeHtml } from "../lib/escape.js";
import { requireAuth, requireStoreOwner } from "../middlewares/auth.js";
import { requireAdmin } from "./admin.js";
import { bagVisibleSql } from "../lib/bag-visibility.js";
import { cached, invalidate } from "../lib/ttl-cache.js";
import {
  ListStoresQueryParams,
  CreateStoreBody,
  UpdateStoreBody,
  GetStoreParams,
  UpdateStoreParams,
} from "@workspace/api-zod";
import { Resend } from "resend";
import { sendStoreApprovalEmail } from "../utils/emails";
import { normalizeForCompare, storeIdentityKey, normalizeLicenseNumber } from "../lib/normalize-store.js";
import { calcFees } from "../lib/pricing.js";

const REPORT_TYPES = ["closed", "temp_closed", "wrong_hours", "wrong_info", "inappropriate_review", "other"] as const;

/**
 * 営業許可証番号の重複検出 (共通ヘルパー)。
 * /stores/apply / reapply / bank-setup の 3 経路で再利用する。
 * 食品衛生法上「営業許可は施設ごと (1施設 = 1番号)」 が原則のため、
 * 同じ番号での 2店舗目登録 / 他店舗から番号盗用は無効入力扱いで全部ブロックする。
 *
 * @param opts.ownerId - 申請ユーザの ID (isSelf 判定用)
 * @param opts.rawLicenseNumber - 入力された営業許可証番号 (生の文字列)
 * @param opts.excludeStoreId - 自分自身の店舗を除外するため (bank-setup / reapply で必須)
 * @returns 重複ヒットがあれば情報、 なければ null
 */
async function findLicenseDuplicate(opts: {
  ownerId: string;
  rawLicenseNumber: string | null | undefined;
  excludeStoreId?: number;
}): Promise<{ id: number; ownerId: string | null; status: string; isSelf: boolean } | null> {
  const key = normalizeLicenseNumber(opts.rawLicenseNumber);
  if (!key) return null;
  const rows = await db
    .select({
      id: storesTable.id,
      ownerId: storesTable.ownerId,
      licenseNumber: storesTable.licenseNumber,
      status: storesTable.status,
    })
    .from(storesTable)
    .where(sql`${storesTable.status} IN ('pending', 'applied', 'approved', 'pending_review')`);
  const hit = rows.find(
    (r) =>
      (opts.excludeStoreId == null || r.id !== opts.excludeStoreId) &&
      normalizeLicenseNumber(r.licenseNumber) === key,
  );
  if (!hit) return null;
  return {
    id: hit.id,
    ownerId: hit.ownerId,
    status: hit.status,
    isSelf: hit.ownerId === opts.ownerId,
  };
}

/** 営業許可証番号 重複時の 409 レスポンスを統一 */
function sendLicenseDuplicate(
  res: any,
  hit: { id: number; ownerId: string | null; status: string; isSelf: boolean },
) {
  return res.status(409).json({
    error: "license_duplicate",
    scope: hit.isSelf ? "self" : "other",
    message: hit.isSelf
      ? "この営業許可証番号は、 すでにあなたの別の店舗で使用されています。 営業許可は施設ごとに発行されるため、 別の番号をご入力ください。"
      : "この営業許可証番号は、 すでに別のお店で登録されています。 番号にお間違いがないかご確認ください。 (お問い合わせが必要な場合はサポートまで)",
    existingStoreId: hit.isSelf ? hit.id : undefined,
  });
}

// ⚠️ Stripe Connect business_profile.url 用の公開ドメイン
// Replit の dev/preview ドメイン（*.replit.dev / *.replit.app）を Stripe に送信すると、
// JCB / ダイナース / ディスカバー等のカードブランド審査で「不審な URL」と判定され
// 当該ブランドのカード支払いが一時停止される事例が確認されている。
// したがって本番ドメイン（osusowakejapan.org）にハードコードし、
// 環境変数 OSUSOWAKE_PUBLIC_URL で上書き可能にする。
const PUBLIC_BUSINESS_URL = process.env.OSUSOWAKE_PUBLIC_URL?.trim() || "https://osusowakejapan.org/";

/**
 * Stripe business_profile.url 用の URL 正規化。
 * 以下のいずれかに該当する入力は強制的に本番ドメイン（PUBLIC_BUSINESS_URL）に差し替える:
 *   - 空 / null / undefined
 *   - URL として parse 不能
 *   - http/https 以外のスキーム
 *   - Replit dev/preview ドメイン（*.replit.dev / *.replit.app）
 * これによりフロントの再申請ドラフト経由で過去に保存された Replit URL が
 * Stripe に再送されるのを防ぐ（JCB 等カードブランド審査の停止対策）。
 */
function normalizeBusinessUrl(input: string | undefined | null): string {
  const u = (input ?? "").trim();
  if (!u) return PUBLIC_BUSINESS_URL;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return PUBLIC_BUSINESS_URL;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "replit.app" ||
      host === "replit.dev" ||
      host.endsWith(".replit.app") ||
      host.endsWith(".replit.dev")
    ) {
      return PUBLIC_BUSINESS_URL;
    }
    return u;
  } catch {
    return PUBLIC_BUSINESS_URL;
  }
}
type ReportType = typeof REPORT_TYPES[number];

/** 日本の電話番号を Stripe が要求する E.164 形式（+81...）に変換するサーバーサイド安全変換 */
function toE164Japan(phone: string): string {
  const digits = phone.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return '+81' + digits.slice(1);
  return '+81' + digits;
}

/**
 * 半角カナ → 全角カナに変換 + 全角数字/英字 → 半角に変換。
 * Stripe JP の address_kana は全角カタカナのみ受け付けるため正規化が必須。
 * 例: "ｶﾐﾊﾑﾛ" → "カミハムロ", "１-２-３" → "1-2-3"
 */
function toFullWidthKana(input: string): string {
  if (!input) return input;
  // 1. 半角カナ → 全角カナ（濁点・半濁点も合成）
  const kanaMap: Record<string, string> = {
    'ｶﾞ':'ガ','ｷﾞ':'ギ','ｸﾞ':'グ','ｹﾞ':'ゲ','ｺﾞ':'ゴ','ｻﾞ':'ザ','ｼﾞ':'ジ','ｽﾞ':'ズ','ｾﾞ':'ゼ','ｿﾞ':'ゾ',
    'ﾀﾞ':'ダ','ﾁﾞ':'ヂ','ﾂﾞ':'ヅ','ﾃﾞ':'デ','ﾄﾞ':'ド','ﾊﾞ':'バ','ﾋﾞ':'ビ','ﾌﾞ':'ブ','ﾍﾞ':'ベ','ﾎﾞ':'ボ',
    'ﾊﾟ':'パ','ﾋﾟ':'ピ','ﾌﾟ':'プ','ﾍﾟ':'ペ','ﾎﾟ':'ポ','ｳﾞ':'ヴ',
    'ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
    'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
    'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
    'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
    'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ｦ':'ヲ','ﾝ':'ン',
    'ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
    'ｰ':'ー','｡':'。','｢':'「','｣':'」','､':'、','･':'・',
  };
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const two = input.slice(i, i + 2);
    if (kanaMap[two]) { out += kanaMap[two]; i++; continue; }
    const one = input[i];
    if (kanaMap[one]) { out += kanaMap[one]; continue; }
    out += one;
  }
  // 2. ひらがな → カタカナ（IMEで誤入力したケース対応）
  out = out.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  // 3. 全角数字/英字 → 半角（番地等）
  out = out.replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return out;
}

/**
 * 町名（town）と番地（line1）を再分離する。
 * 「ｶﾐﾊﾑﾛ1-2-22」「神内1-2-22」のように町名欄に番地まで入ってる場合、
 * 最初の半角/全角数字以降を line1 に移動する。
 * Stripe JP の住所バリデータは郵便番号と町名の照合をするため、town に番地が混入すると弾かれる。
 */
function splitTownLine1(town: string, line1: string): { town: string; line1: string } {
  const t = (town ?? '').trim();
  const l = (line1 ?? '').trim();
  if (!t) return { town: t, line1: l };
  // 最初の数字（半角/全角）の位置を探す
  const m = t.match(/[0-9０-９]/);
  if (!m || m.index === undefined) return { town: t, line1: l };
  const cleanTown = t.slice(0, m.index).trim();
  const moved     = t.slice(m.index).trim();
  if (!cleanTown) return { town: t, line1: l }; // 全部数字なら触らない
  // 既存 line1 がある場合は前に町名残りを足す
  const newLine1 = l ? `${moved} ${l}` : moved;
  return { town: cleanTown, line1: newLine1 };
}

/**
 * カナ住所を Stripe が受け付ける文字集合（カタカナ・英数字・半角スペース・ハイフン・ドット）へ強制正規化。
 * ★ ConteCafe (2026-09-29): カナ番地に全角数字・漢字（丁目等）が入り
 *   "Invalid katakana address" で会社住所+代表者住所がまとめて拒否され法人登録が全滅していた。
 *   店主に直させるのではなくサーバーで吸収する。
 */
function sanitizeKanaAddressField(s: string): string {
  let out = (s ?? '').trim();
  // ひらがな → カタカナ
  out = out.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  // 住所に頻出する漢字をカタカナへ
  out = out
    .replace(/丁目/g, 'チョウメ').replace(/番地/g, 'バンチ').replace(/番町/g, 'バンチョウ')
    .replace(/号室/g, 'ゴウシツ').replace(/号/g, 'ゴウ').replace(/番/g, 'バン').replace(/条/g, 'ジョウ');
  // 半角カナ→全角カナ・全角英数→半角
  out = toFullWidthKana(out);
  // ハイフン類・全角スペースを許容文字へ
  out = out.replace(/[－‐−–—〜~]/g, '-').replace(/　/g, ' ');
  // 許容外の文字（残った漢字・記号など）を除去
  out = out.replace(/[^ァ-ヶーA-Za-z0-9 .\-]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Stripe JP に送る address_kanji / address_kana をまとめて正規化。
 * - kana側: 半角カナ→全角カナ + 数字を半角化 + Stripe許容文字への強制正規化
 * - 両方: townに数字混入してたら line1 に分離
 */
function buildJpAddress(k: {
  postalCode: string;
  stateKanji: string; cityKanji: string; townKanji: string; line1Kanji: string;
  stateKana:  string; cityKana:  string; townKana:  string; line1Kana:  string;
}) {
  // ★ 全角数字(５６９...)を半角に直してから数字以外を落とす (2026-08-05)。
  //   旧実装は全角数字をそのまま捨てていたため postal_code が空文字になり、
  //   Stripe に「登録済みの住所を消そうとした」と判定されて
  //   "you cannot unset any of it" で再提出が丸ごと失敗していた。
  const postal = (k.postalCode ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '');
  const kanjiSplit = splitTownLine1(k.townKanji ?? '', k.line1Kanji ?? '');
  const kanaRaw    = splitTownLine1(k.townKana  ?? '', k.line1Kana  ?? '');
  const kanaSplit = {
    town:  sanitizeKanaAddressField(kanaRaw.town),
    line1: sanitizeKanaAddressField(kanaRaw.line1),
  };
  return {
    address_kanji: {
      postal_code: postal,
      state:       (k.stateKanji ?? '').trim(),
      city:        (k.cityKanji  ?? '').trim(),
      town:        kanjiSplit.town,
      line1:       kanjiSplit.line1,
    },
    address_kana: {
      postal_code: postal,
      state:       sanitizeKanaAddressField(k.stateKana ?? ''),
      city:        sanitizeKanaAddressField(k.cityKana  ?? ''),
      town:        kanaSplit.town,
      line1:       kanaSplit.line1,
    },
  };
}

const router: IRouter = Router();

// ─── GET /api/stripe/public-config ───────────────────────────────────────────
// フロントエンドが Stripe.js をロードするために必要な公開鍵を返す。
// STRIPE_PUBLISHABLE_KEY 環境変数を設定することで
// バックエンドの STRIPE_SECRET_KEY と必ず同じモード（test/live）になる。
router.get("/stripe/public-config", (_req, res) => {
  const pk = process.env["STRIPE_PUBLISHABLE_KEY"] ?? "";
  const secretKey = process.env["STRIPE_SECRET_KEY"] ?? "";
  const mode: "test" | "live" = secretKey.startsWith("sk_live_") ? "live" : "test";
  if (!pk) {
    // 未設定の場合でも mode だけは返す（フロントエンドで警告表示に使う）
    res.status(503).json({ error: "stripe_not_configured", mode, publishableKey: "" });
    return;
  }
  res.json({ publishableKey: pk, mode });
});

const storeSelectFields = {
  id: storesTable.id,
  name: storesTable.name,
  description: storesTable.description,
  address: storesTable.address,
  city: storesTable.city,
  category: storesTable.category,
  lat: storesTable.lat,
  lng: storesTable.lng,
  imageUrl: storesTable.imageUrl,
  iconUrl: storesTable.iconUrl,
  phone: storesTable.phone,
  openTime: storesTable.openTime,
  closeTime: storesTable.closeTime,
  rating: storesTable.rating,
  isActive: storesTable.isActive,
  status: storesTable.status,
  ownerId: storesTable.ownerId,
  licenseNumber: storesTable.licenseNumber,
  licenseImageUrl: storesTable.licenseImageUrl,
  idImageUrl: storesTable.idImageUrl,
  pledgeSigned: storesTable.pledgeSigned,
  createdAt: storesTable.createdAt,
  stripeAccountId: storesTable.stripeAccountId,
  stripeChargesEnabled: storesTable.stripeChargesEnabled,
  stripePayoutsEnabled: storesTable.stripePayoutsEnabled,
  stripeNeedsBankReregister: storesTable.stripeNeedsBankReregister,
  holiday: storesTable.holiday,
  pickupHours: storesTable.pickupHours,
  rejectionReason: storesTable.rejectionReason,
  // ★ 可視条件は共有SQL(lib/bag-visibility.ts)に一本化。 2部制(受取2枠)の期限延長もそこで対応。
  totalBagsAvailable: sql<number>`COALESCE(SUM(CASE
    WHEN ${surpriseBagsTable.isActive} = true AND ${bagVisibleSql}
    THEN ${surpriseBagsTable.stockCount} ELSE 0 END), 0)`.as("totalBagsAvailable"),
};

// 公開 API (認証不要) で返す最小集合 — PII / 内部運用情報を一切含まない (#3)
// 除外対象: ownerId, licenseNumber, licenseImageUrl, idImageUrl, pledgeSigned,
//          rejectionReason, stripeAccountId, stripeNeedsBankReregister
// (これらは admin / 自店舗オーナー専用エンドポイント /stores/by-owner 等で別途返す)
const publicStoreSelectFields = {
  id: storesTable.id,
  name: storesTable.name,
  description: storesTable.description,
  address: storesTable.address,
  city: storesTable.city,
  category: storesTable.category,
  lat: storesTable.lat,
  lng: storesTable.lng,
  // ★ Egress 削減: data: URL (base64 埋め込み) は SQL レベルで NULL に潰す。
  //   imageUrl と iconUrl は別物として扱うが、imageUrl が空 (NULL or data:) の場合は
  //   iconUrl を代替に返す。これにより「写真を1枚しか登録してない店」のバナーが
  //   生成画像にならず、店主が登録した実物写真が必ずマップに表示される。
  //   （結果ピンとバナーが同じ写真になるが、デフォルト画像より店主の意図に沿う）
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
  stripeChargesEnabled: storesTable.stripeChargesEnabled,
  showOnMap: storesTable.showOnMap,
  holiday: storesTable.holiday,
  pickupHours: storesTable.pickupHours,
  createdAt: storesTable.createdAt,
  // 本日完売 (social proof): 「受取日が今日」のバッグが売り切れたら true。
  //   ★ 決済で在庫0になると isActive=false になる (totalBagsAvailable からは消える) ため、
  //     ここは isActive を見ない (= 完売済み非アクティブも拾う)。
  //   ★ 2026-09-13 日付判定を /bags/ended-today と同一定義に統一:
  //     通常バッグ = 今日作成 / 翌日受取(pickupNextDay) = 昨日作成(受取が今日)。
  //     旧実装の「今日 or 昨日作成」だと、昨日売り切れた通常バッグが翌日も
  //     「🔥本日完売」と誤表示され続けていた(マロ報告)。
  //   ★ 支払済み予約が1件以上あるバッグのみ完売扱い
  //     (在庫0で出品/手動0編集した“売れてないバッグ”を完売と偽らない — ended-today と同じ)。
  soldOutToday: sql<boolean>`COALESCE(BOOL_OR(
    ${surpriseBagsTable.stockCount} <= 0
    AND (
      (${surpriseBagsTable.pickupNextDay} IS NOT TRUE
        AND DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')
            = DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
      OR
      (${surpriseBagsTable.pickupNextDay} IS TRUE
        AND DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')
            = DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day')
    )
    AND EXISTS (SELECT 1 FROM reservations pr
                WHERE pr.bag_id = ${surpriseBagsTable.id} AND pr.payment_status = 'paid')
  ), false)`.as("soldOutToday"),
  // ★ 可視条件は共有SQL(lib/bag-visibility.ts)に一本化。 2部制(受取2枠)の期限延長もそこで対応。
  totalBagsAvailable: sql<number>`COALESCE(SUM(CASE
    WHEN ${surpriseBagsTable.isActive} = true AND ${bagVisibleSql}
    THEN ${surpriseBagsTable.stockCount} ELSE 0 END), 0)`.as("totalBagsAvailable"),
};

// Public: list only approved + active stores
router.get("/stores", async (req, res) => {
  try {
    ListStoresQueryParams.parse(req.query);

    // ★ 公開一覧: 全ユーザー同一結果 & 秒間多数の refetch → 10 秒メモリキャッシュ。
    //   店舗の承認/出品/在庫変化時は該当ミューテーションで invalidate("stores:list") 済み。
    const stores = await cached("stores:list", 10_000, async () =>
    // ★ 公開エンドポイント: PII を含まない publicStoreSelectFields を使用 (#3)
    // show_on_map = true は管理者が手動で立てる強制表示フラグ。
    //   → 承認・口座設定・出品の有無に関わらず、is_active のみを条件にマップに表示する
    // それ以外は通常の「承認済み + 口座OK」ルール
    // 注: Stripe が無効化された場合は webhook で stripe_charges_enabled=false かつ
    //     show_on_map=false を同時に設定するため、自動的にマップから消える。
      db
      .select(publicStoreSelectFields)
      // ★ 性能: マーカーの個数集計(totalBagsAvailable / soldOutToday)は「今日/昨日作成」のバッグしか
      //   対象にならない(bagVisibleSql の全CASE が created today/yesterday 前提)。 なので結合自体を
      //   直近2日のバッグに絞る → 過去の全履歴バッグを結合しなくなり集計が激速化(結果は同一)。
      //   これが無いと店ごとに数百件の古いバッグを結合してJST変換集計し、 /api/stores が1秒超になっていた。
      .from(storesTable)
      .leftJoin(surpriseBagsTable, and(
        eq(storesTable.id, surpriseBagsTable.storeId),
        sql`${surpriseBagsTable.createdAt} >= NOW() - INTERVAL '2 days'`,
      ))
      .where(sql`${storesTable.isActive} = true AND (
        coalesce(${storesTable.showOnMap}, false) = true
        OR (${storesTable.status} = 'approved' AND coalesce(${storesTable.stripeChargesEnabled}, false) = true)
      )`)
      .groupBy(storesTable.id)
      // ★ 2026-08-12: ORDER BY が無く、DBが返す順のまま＝更新のたびに並びが変わっていた。
      //   お気に入り画面はこの並びをそのまま表示するため、開くたびに店の順番が入れ替わって見える。
      //   （地図/検索は自前で並べ替えているので影響なし）。新しい店が上＝毎回同じ並びに固定する。
      .orderBy(desc(storesTable.id))
    );

    res.json(stores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch stores" });
  }
});

// Public: create a new store — immediately active (no manual approval needed)
// 直接登録は admin のみ。一般ユーザは /stores/apply 経由で申請する。
router.post("/stores", requireAdmin, async (req, res) => {
  try {
    const body = CreateStoreBody.parse(req.body);
    const [store] = await db.insert(storesTable).values({
      name: body.name,
      description: body.description ?? null,
      address: body.address,
      city: body.city,
      category: body.category,
      lat: Number(body.lat),
      lng: Number(body.lng),
      imageUrl: body.imageUrl ?? null,
      phone: body.phone ?? null,
      openTime: body.openTime ?? null,
      closeTime: body.closeTime ?? null,
      isActive: true,
      status: "approved",
    }).returning();
    res.status(201).json({ ...store, totalBagsAvailable: 0 });
  } catch (err) {
    console.error("Store creation error:", err);
    res.status(400).json({ error: "bad_request", message: "Invalid store data" });
  }
});

// Public: apply for store registration — sets status to "pending" for admin review
// ── POST /stores/:storeId/request-listing ─────────────────────────────────────
// お気に入り店への「出品リクエスト」。
//   ★ 2026-08-29 マロ発案。供給（店の出品）が最大のボトルネックのため、
//     「待っているお客様がいる」ことを店に届けて出品の動機にする。
//   ・1ユーザー×1店×1日(JST)で1回まで（DBのUNIQUEで保証。連打しても店に迷惑なし）
//   ・店主にはベル通知のみ（プッシュは送らない＝通知疲れさせない）
router.post("/stores/:storeId/request-listing", requireAuth, async (req: any, res) => {
  const storeId = parseInt(String(req.params.storeId ?? ""), 10);
  if (Number.isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const [store] = await db
      .select({ id: storesTable.id, name: storesTable.name, status: storesTable.status, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId))
      .limit(1);
    if (!store || store.status !== "approved") {
      res.status(404).json({ error: "not_found", message: "店舗が見つかりません" }); return;
    }
    const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const inserted = await db.execute(sql`
      INSERT INTO listing_requests (store_id, user_id, jst_date)
      VALUES (${storeId}, ${req.authUser.id}, ${jstDate})
      ON CONFLICT (store_id, user_id, jst_date) DO NOTHING
      RETURNING id
    `);
    const already = (inserted.rows?.length ?? 0) === 0;
    let todayCount = 0;
    const cnt = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM listing_requests WHERE store_id = ${storeId} AND jst_date = ${jstDate}
    `);
    todayCount = Number((cnt.rows?.[0] as any)?.n ?? 0);

    // 過去の出品からの「また食べたい」: 商品名つきリクエスト (2026-09-13)。
    //   店主に「どの商品が求められているか」まで届けて再出品の動機を強くする。
    const rawTitle = (req.body as { bagTitle?: unknown })?.bagTitle;
    const bagTitle = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 60) : "";

    // 新規リクエストのときだけ店主へベル通知（同一人物の連打では通知しない）
    if (!already && store.ownerId) {
      const wantLine = bagTitle ? `リクエストされた商品:「${bagTitle}」。` : "";
      await db.insert(notificationsTable).values({
        userId: store.ownerId,
        type: "announcement",
        title: "🙏 出品リクエストが届きました",
        body: `お客様が「${store.name}」の出品を待っています（本日${todayCount}人目）。${wantLine}出品すると、お気に入り登録のお客様に通知が届きます。`,
        read: false,
      }).catch(() => {});
    }
    res.json({ ok: true, already, todayCount });
  } catch (err: any) {
    console.error("[stores/request-listing]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /stores/:storeId/past-bags ────────────────────────────────────────────
// 店舗情報ページの「過去の出品」(公開・認証不要)。
//   ★ 2026-09-13 マロ発案。出品が無い時間帯に店ページを開いた客に
//     「この店はこういうバッグが出る」を見せて、お気に入り登録・出品リクエストへ繋ぐ。
//   ・過去60日のバッグを商品名でまとめ、最新の1件＋出品回数を返す（最大8種・新しい順）
//   ・「今日の分」(受取日が今日) は現在出品側と重複するため除外
//   ・価格/写真/回数のみ。PII なし。60秒キャッシュ。
router.get("/stores/:storeId/past-bags", async (req, res) => {
  const storeId = parseInt(String(req.params.storeId ?? ""), 10);
  if (Number.isNaN(storeId)) { res.status(400).json({ error: "bad_request" }); return; }
  try {
    const items = await cached(`store:${storeId}:past-bags`, 60_000, async () => {
      const result = await db.execute(sql`
        SELECT title, image_url, original_price, discounted_price, item_type, category, created_at, times_listed
        FROM (
          SELECT DISTINCT ON (b.title)
            b.title,
            CASE WHEN b.image_url LIKE 'data:%' THEN NULL ELSE b.image_url END AS image_url,
            b.original_price, b.discounted_price, b.item_type, b.category, b.created_at,
            COUNT(*) OVER (PARTITION BY b.title)::int AS times_listed
          FROM surprise_bags b
          JOIN stores s ON s.id = b.store_id
          WHERE b.store_id = ${storeId}
            -- タイトル未入力時のデフォルト名「おすそわけ袋」は商品情報が無いため過去の出品に出さない
            -- (2026-09-13 マロ指示: Taps の「おすそわけ袋」表示が不要だった件。全店共通ルールで対応)
            AND b.title <> 'おすそわけ袋'
            AND s.is_active = true
            AND (COALESCE(s.show_on_map, false) = true OR s.status = 'approved')
            AND b.created_at >= NOW() - INTERVAL '60 days'
            AND (
              -- 「受取日が今日」の分は除外 (現在出品/本日完売の側で見せる)
              (b.pickup_next_day IS NOT TRUE
                AND DATE(b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') < DATE(NOW() AT TIME ZONE 'Asia/Tokyo'))
              OR
              (b.pickup_next_day IS TRUE
                AND DATE(b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo') < DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day')
            )
          ORDER BY b.title, b.created_at DESC
        ) t
        ORDER BY t.created_at DESC
        LIMIT 8
      `);
      return (result.rows ?? []).map((r: any) => ({
        title: r.title,
        imageUrl: r.image_url ?? null,
        originalPrice: r.original_price != null ? Number(r.original_price) : null,
        discountedPrice: r.discounted_price != null ? Number(r.discounted_price) : null,
        itemType: r.item_type ?? null,
        category: r.category ?? null,
        timesListed: Number(r.times_listed ?? 1),
        lastListedAt: r.created_at,
      }));
    });
    res.json({ items });
  } catch (err: any) {
    console.error("[stores/past-bags]", err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch past bags" });
  }
});

router.post("/stores/apply", requireAuth, async (req, res) => {
  try {
    const body = req.body;
    // ★ ownerId は認証トークンから取得（リクエストボディの ownerId は無視 = なりすまし防止）
    const ownerId = req.authUser!.id;
    console.log("[/stores/apply] 申請受付 ownerId=", ownerId, "name=", body.name);

    if (!body.name || !body.address || !body.city) {
      return res.status(400).json({ error: "bad_request", message: "必須項目（店舗名・住所・市区町村）が不足しています" });
    }

    // ★ 2026-08-04: 審査が終わっていない店舗を持つオーナーは新しい店舗を追加できない。
    //   (審査中に2号店・3号店を積み増せるとテスト登録や不正のスパム経路になるため。
    //    承認済みの店だけを持つオーナーは従来どおり複数店舗を追加できる)
    const [inflight] = await db
      .select({ id: storesTable.id, name: storesTable.name, status: storesTable.status })
      .from(storesTable)
      .where(and(
        eq(storesTable.ownerId, ownerId),
        sql`${storesTable.status} IN ('pending', 'applied', 'pending_review')`,
      ))
      .limit(1);
    if (inflight) {
      console.warn(`[/stores/apply] 🚫 審査中店舗あり ownerId=${ownerId} blockedBy=${inflight.id}:${inflight.name}(${inflight.status})`);
      return res.status(403).json({
        error: "pending_store_exists",
        message: `「${inflight.name}」の審査が完了するまで、新しい店舗は追加できません。審査完了後にもう一度お試しください。`,
      });
    }

    // ── 住所構造バリデーション (改ざん/旧クライアント/手入力テスト対策) ───
    //   「大阪府大阪市旭区」 のような市レベルのみの入力をブロックする。
    //   食品衛生法上 = 営業許可は施設単位なので、 番地まで特定できない住所は無効扱い。
    const addrRaw = String(body.address).trim();
    const HAS_NUM_OR_KANJI_NUM = /[0-9０-９一二三四五六七八九十]/;
    const HAS_STREET_STRUCTURE = /(丁目|番地|番|号|号室|階|F|f|[0-9０-９]\s*[\-－‐ー][0-9０-９])/;
    if (
      addrRaw.length < 10 ||
      !HAS_NUM_OR_KANJI_NUM.test(addrRaw) ||
      !HAS_STREET_STRUCTURE.test(addrRaw)
    ) {
      console.warn(`[/stores/apply] 🚫 住所形式不正 ownerId=${ownerId} address="${addrRaw}"`);
      return res.status(400).json({
        error: "address_invalid",
        message:
          "住所が不正です。 番地・建物名まで含めて正確に入力してください。 例: 大阪府大阪市旭区○○町1-2-3 ○○ビル1階",
      });
    }
    // ── 緯度経度の必須化 (Google Places 等で正規化済みの座標が無いと申請不可) ──
    //   フロント側で pinPos を必須にしているが、 改ざん/旧クライアント対策で server 側でも検証。
    const latNum = body.lat != null ? Number(body.lat) : NaN;
    const lngNum = body.lng != null ? Number(body.lng) : NaN;
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum) || (latNum === 0 && lngNum === 0)) {
      console.warn(`[/stores/apply] 🚫 緯度経度不正 ownerId=${ownerId} lat=${body.lat} lng=${body.lng}`);
      return res.status(400).json({
        error: "location_required",
        message: "位置情報が取得できませんでした。 検索ボックスからお店を選択し直してください。",
      });
    }

    // 既存店舗のStripeアカウントIDを取得（2店舗目以降で流用するため）
    const existingStores = await db
      .select({ id: storesTable.id, stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.ownerId, ownerId))
      .orderBy(desc(storesTable.id));

    // 既存店舗のStripeアカウントIDを流用（最初にStripeが設定されている店舗を使用）
    const existingStripeAccountId = existingStores.find(s => s.stripeAccountId)?.stripeAccountId ?? null;

    // ★ サーバ側必須バリデーション (改ざん/旧クライアント対策)
    //   2店舗目以降 (existingStripeAccountId != null) の場合、 営業許可証 (画像 + 番号) は必須。
    //   1店舗目では bank-setup で別途送るので onboarding 側では不要。
    //   data URL は image/jpeg, image/png, image/webp, image/heic, image/heif, application/pdf を許可。
    const LICENSE_DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp|heic|heif)|application\/pdf);base64,(.+)$/s;
    if (existingStripeAccountId) {
      const rawLicense = typeof body.licenseImageBase64 === "string" ? body.licenseImageBase64 : "";
      const rawNumber = typeof body.licenseNumber === "string" ? body.licenseNumber.trim() : "";
      if (!rawLicense || !LICENSE_DATA_URL_RE.test(rawLicense)) {
        console.warn(`[/stores/apply] 🚫 2店舗目登録: 営業許可証画像が不足 ownerId=${ownerId} hasImage=${!!rawLicense}`);
        return res.status(400).json({
          error: "license_image_required",
          message: "2店舗目以降の登録には営業許可証の画像 (JPG/PNG/HEIC/PDF) が必須です。",
        });
      }
      if (!rawNumber) {
        console.warn(`[/stores/apply] 🚫 2店舗目登録: 営業許可証番号が不足 ownerId=${ownerId}`);
        return res.status(400).json({
          error: "license_number_required",
          message: "2店舗目以降の登録には営業許可証番号が必須です。",
        });
      }
      // ★ 営業許可証番号フォーマット検証: 「第120号」 のような短すぎる適当入力をブロック。
      //   実物は通常 10 桁前後 (自治体コード + 連番) なので、 全角→半角正規化後 5 文字以上 + 数字 3 文字以上を要求。
      const normalizedNumber = rawNumber.normalize("NFKC");
      const digitsOnly = normalizedNumber.replace(/[^0-9]/g, "");
      if (normalizedNumber.length < 5 || digitsOnly.length < 4) {
        console.warn(`[/stores/apply] 🚫 2店舗目登録: 営業許可証番号フォーマット不正 ownerId=${ownerId} number="${rawNumber}" digits=${digitsOnly.length}`);
        return res.status(400).json({
          error: "license_number_invalid",
          message:
            "営業許可証番号の形式が正しくありません。 通常は10桁前後の番号です。 保健所発行の許可証に記載された番号を正確に入力してください。",
        });
      }
    }

    // ── 重複店舗の検出 ─────────────────────────────────────────────────
    //   ★ 同オーナ自己重複 (店名+住所+市区町村): 409 self_duplicate
    //   ★ 営業許可証番号の重複 (自/他オーナ問わず): 409 license_duplicate
    //      食品衛生法上「1施設 1番号」 が原則 = 同じ番号の使い回しは無効入力 or なりすましの強い指標。
    //   ★ 別オーナの店名+住所重複: 警告ログのみ (フードコート等の正規ケース)。
    try {
      const licHit = await findLicenseDuplicate({ ownerId, rawLicenseNumber: body.licenseNumber });
      if (licHit) {
        console.warn(
          `[/stores/apply] 🚫 営業許可証番号 重複ブロック: ownerId=${ownerId} → 既存storeId=${licHit.id} ownerId=${licHit.ownerId} status=${licHit.status} isSelf=${licHit.isSelf}`,
        );
        return sendLicenseDuplicate(res, licHit);
      }
    } catch (licEx: any) {
      console.warn(`[/stores/apply] 営業許可証重複チェック失敗 (申請は継続): ${licEx?.message}`);
    }

    const incomingKey = storeIdentityKey(body.name, body.address, body.city);
    if (incomingKey) {
      try {
        const sameNameCandidates = await db
          .select({
            id: storesTable.id,
            name: storesTable.name,
            address: storesTable.address,
            city: storesTable.city,
            ownerId: storesTable.ownerId,
            status: storesTable.status,
          })
          .from(storesTable)
          .where(
            sql`${storesTable.status} IN ('pending', 'approved', 'pending_review', 'applied')`,
          );

        // (1) 自己重複チェック (同オーナ) → 即 409
        const selfCollision = sameNameCandidates.find(
          (s) => s.ownerId === ownerId &&
                 storeIdentityKey(s.name, s.address, s.city ?? "") === incomingKey,
        );
        if (selfCollision) {
          console.warn(
            `[/stores/apply] 🚫 自己重複ブロック: ownerId=${ownerId} name="${body.name}" addr="${body.address}" → 既存storeId=${selfCollision.id} status=${selfCollision.status}`,
          );
          return res.status(409).json({
            error: "self_duplicate",
            message:
              "同じ店名・住所のお店が既に登録されています。 マイページの「所有店舗」 から既存のお店を確認してください。",
            existingStoreId: selfCollision.id,
            existingStatus: selfCollision.status,
          });
        }

        // (2) 別オーナ重複は警告のみ (admin 精査運用)
        const otherCollision = sameNameCandidates.find(
          (s) => s.ownerId !== ownerId &&
                 storeIdentityKey(s.name, s.address, s.city ?? "") === incomingKey,
        );
        if (otherCollision) {
          console.warn(
            `[/stores/apply] ⚠️ 別オーナ重複候補 (申請は通します): 申請ownerId=${ownerId} name="${body.name}" addr="${body.address}" → 既存storeId=${otherCollision.id} ownerId=${otherCollision.ownerId} (admin で要精査)`,
          );
        }
      } catch (collEx: any) {
        // 重複検出は best-effort だが、 自己重複ブロックは安全側に倒し失敗時のみログ
        console.warn(`[/stores/apply] 重複検出失敗 (申請は継続): ${collEx?.message}`);
      }
    }

    // 営業許可証写真を Supabase Storage にアップロード（base64 が届いた場合）
    let licenseImageUrl: string | null = null;
    let resolvedLicenseNumber: string | null = body.licenseNumber?.trim() || null;

    if (body.licenseImageBase64) {
      // 直接アップロード (image/jpeg|png|webp|heic|heif + application/pdf 対応)
      try {
        const match = (body.licenseImageBase64 as string).match(LICENSE_DATA_URL_RE);
        if (match) {
          const contentType = match[1];
          const ext =
            contentType === "image/png" ? "png" :
            contentType === "image/webp" ? "webp" :
            contentType === "image/heic" ? "heic" :
            contentType === "image/heif" ? "heif" :
            contentType === "application/pdf" ? "pdf" :
            "jpg";
          const buffer = Buffer.from(match[2], "base64");
          const filePath = `${ownerId}/${Date.now()}-license.${ext}`;
          const { error: uploadError } = await supabaseAdmin.storage
            .from("store-documents")
            .upload(filePath, buffer, { contentType, upsert: false, cacheControl: "31536000, immutable" });
          if (!uploadError) {
            // DB には保管場所だけ入れる（表示用リンクはレスポンス時に1時間だけ有効で作る）
            licenseImageUrl = filePath;
            console.log("[/stores/apply] ✅ 営業許可証アップロード完了:", filePath);
          } else {
            console.warn("[/stores/apply] 営業許可証アップロード失敗:", uploadError.message);
          }
        } else {
          console.warn("[/stores/apply] 営業許可証 dataURL パース失敗 (許可外 MIME)");
        }
      } catch (uploadEx: any) {
        console.warn("[/stores/apply] 営業許可証アップロード例外:", uploadEx?.message);
      }
    }

    // ── Stripe Files API: 営業許可証をStripeサーバーにアップロード ──────────────
    // 既存のStripeアカウントがある場合（2店舗目以降）のみ実行。
    // 同時に既存アカウントの charges_enabled を取得して 2店舗目側の DB / レスポンスに反映する。
    // ★ charges_enabled=false の場合 = 1店舗目で銀行口座無効化や KYC 期限切れが発生している。
    //   この場合は 2店舗目も売上を受け取れないので、 フロント側で再有効化フローへ誘導する。
    let stripeLicenseFileId: string | null = null;
    let existingStripeChargesEnabled: boolean | null = null;
    let existingStripePayoutsEnabled: boolean | null = null;
    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (existingStripeAccountId && stripeKey) {
      try {
        const stripe = await import("stripe").then((m) => new m.default(stripeKey));

        // 既存アカウントの状態取得 (再有効化が必要かフロントで判断するため)
        try {
          const existingAccount = await stripe.accounts.retrieve(existingStripeAccountId);
          existingStripeChargesEnabled = existingAccount.charges_enabled === true;
          existingStripePayoutsEnabled = existingAccount.payouts_enabled === true;
          console.log(`[/stores/apply] ℹ️ 既存Stripeアカウント状態: accountId=${existingStripeAccountId} charges=${existingStripeChargesEnabled} payouts=${existingStripePayoutsEnabled}`);
        } catch (retrieveEx: any) {
          console.warn(`[/stores/apply] 既存アカウント状態取得失敗 (継続): ${retrieveEx?.message}`);
        }

        // 営業許可証バッファを確保（base64 から復元 / image + PDF 対応）
        let licenseBuffer: Buffer | null = null;
        let licenseMime = "image/jpeg";
        if (body.licenseImageBase64) {
          const match = (body.licenseImageBase64 as string).match(LICENSE_DATA_URL_RE);
          if (match) {
            licenseMime = match[1];
            licenseBuffer = Buffer.from(match[2], "base64");
          } else {
            console.warn("[/stores/apply] Stripe Files: 営業許可証 dataURL パース失敗 (許可外 MIME)");
          }
        }

        if (licenseBuffer) {
          // Stripe Files API にアップロード（purpose: additional_verification — 追加書類）
          const fileExt =
            licenseMime === "application/pdf" ? "pdf" :
            licenseMime.startsWith("image/") ? licenseMime.split("/")[1] : "jpg";
          const stripeFile = await stripe.files.create(
            {
              file: { data: licenseBuffer, name: `license-${Date.now()}.${fileExt}`, type: licenseMime },
              purpose: "additional_verification",
            },
            { stripeAccount: existingStripeAccountId }
          );
          stripeLicenseFileId = stripeFile.id;
          console.log(`[/stores/apply] ✅ Stripe Files API アップロード完了: fileId=${stripeFile.id} accountId=${existingStripeAccountId} size=${stripeFile.size}bytes purpose=${stripeFile.purpose} mime=${licenseMime}`);
        }

        // ── Stripe Account Metadata のみ更新（business_profile は一切変更しない）─────
        // ⚠️ business_profile.name を上書きすると既存アカウント名が破壊されるため変更禁止
        // 「どの店舗の売上か」はチャージ時のメタデータ（store_id / store_name）で管理する
        const storePhone    = body.phone ? toE164Japan(String(body.phone)) : "";
        const storeAddress  = `${body.address}, ${body.city}`.trim();
        const newStoreCount = existingStores.length + 1;

        // ── 送信データの分類ログ（JSON形式）──────────────────────────────────
        const stripeUpdatePayload = {
          // ===== 店舗ごとに「新しく送る」情報（アカウントのメタデータに追記）=====
          NEW_PER_STORE_METADATA: {
            "metadata.store_count":          String(newStoreCount),
            "metadata.latest_store_name":    body.name,
            "metadata.latest_store_address": storeAddress,
            "metadata.latest_store_phone":   storePhone || "(なし)",
            "metadata.license_file_id":      stripeLicenseFileId ?? "(未アップロード)",
            "metadata.updated_at":           new Date().toISOString(),
          },
          // ===== 変更しない情報（Stripe側で保持済み）=====
          NOT_TOUCHED: {
            "business_profile.name":   "（オーナー名／法人名 → 上書き禁止・Stripe保持済み）",
            "individual.id_number":    "（免許証・マイナンバー → Stripe保持済み）",
            "external_account (bank)": "（振込先口座 → Stripe保持済み）",
            "company.tax_id":          "（法人番号 → Stripe保持済み）",
            "tos_acceptance":          "（利用規約同意 → Stripe保持済み）",
          },
          // ===== 課金時のチャージに付与するメタデータ（店舗識別用）=====
          CHARGE_METADATA_ON_PAYMENT: {
            "store_id":   "(課金ごとに動的付与)",
            "store_name": body.name,
            "store_phone": storePhone || "(なし)",
          },
          stripe_account_id: existingStripeAccountId,
          timestamp:         new Date().toISOString(),
        };
        console.log(`[/stores/apply] 📦 Stripe送信データ分類:\n${JSON.stringify(stripeUpdatePayload, null, 2)}`);

        // business_profile は一切触れず、メタデータのみ安全に更新
        const updatedAccount = await stripe.accounts.update(existingStripeAccountId, {
          metadata: {
            store_count:          String(newStoreCount),
            latest_store_name:    body.name,
            latest_store_address: storeAddress,
            latest_store_phone:   storePhone,
            license_file_id:      stripeLicenseFileId ?? "",
            updated_at:           new Date().toISOString(),
          },
        });
        console.log(`[/stores/apply] ✅ Stripe Account Metadata 更新完了（business_profile 不変）: accountId=${existingStripeAccountId} bp_name="${updatedAccount.business_profile?.name}" charges=${updatedAccount.charges_enabled} metadata=${JSON.stringify(updatedAccount.metadata)}`);

      } catch (stripeEx: any) {
        // Stripe の失敗はスキップ（店舗登録自体を止めない）
        console.warn(`[/stores/apply] ⚠️ Stripe連携処理エラー: ${stripeEx?.message} code=${stripeEx?.code}`);
      }
    }

    // 基本情報のみ保存
    // ★ 重要: 「approved」になるのは admin (神モード) が手動で承認した時のみ。
    //   - 1店舗目（Stripe未登録）: status="pending" → bank-setup → admin 承認で approved 化
    //   - 2店舗目以降（既存Stripe流用）: status="pending_review" → admin 承認で approved 化
    //     ↑ 旧仕様では即時 approved にしていたが、 営業許可証 / 住所の真正性を admin が
    //       目視確認できないため、 適当な住所・許可証番号で公開される穴が発生していた。
    //       2店舗目も必ず admin レビューを通すことで、 不正店舗の即時公開を防ぐ。
    const initialStatus = existingStripeAccountId ? "pending_review" : "pending";
    const inserted = await db.insert(storesTable).values({
      name: body.name,
      description: body.description ?? null,
      address: body.address,
      city: body.city,
      category: body.category ?? "other",
      lat: body.lat != null ? Number(body.lat) : 35.6895,
      lng: body.lng != null ? Number(body.lng) : 139.6917,
      imageUrl: body.imageUrl ?? null,
      iconUrl: body.iconUrl ?? null,
      phone: body.phone ?? null,
      isActive: false,
      status: initialStatus,
      ownerId: ownerId,
      // 2店舗目以降は既存のStripeアカウントIDを流用（bank-setup不要）
      stripeAccountId: existingStripeAccountId,
      // 既存アカウントの charges/payouts 状態を反映 (引き継ぎ時のみ)
      stripeChargesEnabled: existingStripeChargesEnabled,
      stripePayoutsEnabled: existingStripePayoutsEnabled,
      licenseNumber: resolvedLicenseNumber,
      licenseImageUrl,
      idImageUrl: null,
      pledgeSigned: body.pledgeSigned === true,
      stripeLicenseFileId,
    }).returning();

    const store = inserted[0];

    // サイレントエラー防止: .returning() が行を返さなかった場合は明示的にエラー
    if (!store?.id) {
      console.error("[/stores/apply] ❌ INSERT は実行されたが返却行なし — ownerId=", ownerId);
      return res.status(500).json({ error: "insert_no_result", message: "店舗情報の保存が確認できませんでした。再度お試しください。" });
    }

    console.log("[/stores/apply] ✅ 店舗登録・自動承認 id=", store.id, "ownerId=", store.ownerId);


    // ── オーナーの role を store_owner に更新（customer から登録した場合も対応）──
    try {
      const { error: roleErr } = await supabaseAdmin
        .from("users")
        .update({ role: "store_owner" })
        .eq("id", ownerId);
      if (roleErr) console.warn("[/stores/apply] users.role 更新失敗:", roleErr.message);
      else console.log("[/stores/apply] ✅ users.role → store_owner (ownerId=", ownerId, ")");
    } catch (roleEx: any) {
      console.warn("[/stores/apply] users.role 更新例外:", roleEx?.message);
    }

    // ★ レスポンスに既存 Stripe アカウントの charges_enabled を含める。
    //   フロントは existingStripeChargesEnabled === false の時のみ
    //   bank-setup 画面 (再有効化フロー) へ誘導する。
    res.status(201).json({
      ...store,
      totalBagsAvailable: 0,
      // 引き継ぎ時のみ意味を持つフラグ (1店舗目登録時は null)
      inheritedFromStripeAccount: existingStripeAccountId,
      existingStripeChargesEnabled,
      existingStripePayoutsEnabled,
      requiresStripeReauth:
        existingStripeAccountId != null && existingStripeChargesEnabled === false,
    });
  } catch (err) {
    console.error("[/stores/apply] DB INSERT エラー:", err);
    res.status(500).json({ error: "internal_error", message: "店舗情報の保存に失敗しました" });
  }
});

// POST /api/stores/fix-owner-role
// ストアを所有するユーザーの role を store_owner に修正（既存ユーザー向け救済エンドポイント）
// 認可: 認証済みユーザ本人が、自分のストア所有を根拠に role を直す。他人の ownerId 指定は拒否。
router.post("/stores/fix-owner-role", requireAuth, async (req, res) => {
  try {
    const authUserId = req.authUser!.id;
    const { ownerId } = req.body;
    if (!ownerId) {
      return res.status(400).json({ error: "bad_request", message: "ownerId は必須です" });
    }

    // 本人以外を直すのは禁止（権限昇格防止）
    if (ownerId !== authUserId) {
      return res.status(403).json({ error: "forbidden", message: "他人の権限は修正できません" });
    }

    // 本当にストアを所有しているか確認
    const [store] = await db
      .select({ id: storesTable.id })
      .from(storesTable)
      .where(eq(storesTable.ownerId, ownerId))
      .limit(1);

    if (!store) {
      return res.status(403).json({ error: "forbidden", message: "このユーザーはストアを所有していません" });
    }

    // Supabase の users テーブルの role を store_owner に更新
    const { error: roleErr } = await supabaseAdmin
      .from("users")
      .update({ role: "store_owner" })
      .eq("id", ownerId);

    if (roleErr) {
      console.warn("[fix-owner-role] 更新失敗:", roleErr.message);
      return res.status(500).json({ error: "update_failed", message: roleErr.message });
    }

    console.log("[fix-owner-role] ✅ users.role → store_owner (ownerId=", ownerId, ")");
    res.json({ success: true });
  } catch (err: any) {
    console.error("[fix-owner-role] エラー:", err?.message);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// Authenticated: upload a store document image to Supabase Storage
// 認可: userId はクライアント送信を信頼せず、必ず認証済みユーザの ID を使う
router.post("/stores/upload-document", requireAuth, async (req, res) => {
  try {
    const { imageBase64, fileType } = req.body;
    const userId = req.authUser!.id;

    if (!imageBase64 || !fileType) {
      return res.status(400).json({ error: "bad_request", message: "imageBase64, fileType は必須です" });
    }

    // Extract MIME type and raw base64 data
    // ★ セキュリティ修正 (2026-07-08): 旧正規表現 image/[\w+]+ は image/svg+xml も
    //   許可していた。SVG は <script> を埋め込めるため、審査で管理者がプレビュー
    //   した瞬間にストアド XSS になりうる。ラスター画像のみの厳格 allowlist にする。
    const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
    const match = imageBase64.match(/^data:([\w./+-]+);base64,(.+)$/s);
    if (!match || !ALLOWED_IMAGE_TYPES.has(match[1])) {
      return res.status(400).json({ error: "bad_request", message: "対応していない画像形式です（JPEG / PNG / WebP のみ）" });
    }

    const contentType = match[1];
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const buffer = Buffer.from(match[2], "base64");

    // ★ マジックナンバー検証: 宣言 MIME と実バイトが一致するか確認し、
    //   拡張子/Content-Type を偽装した実行可能ファイルのアップロードを防ぐ。
    const sigOk =
      (contentType === "image/jpeg" && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
      (contentType === "image/png"  && buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) ||
      (contentType === "image/webp" && buffer.length > 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50);
    if (!sigOk) {
      return res.status(400).json({ error: "bad_request", message: "画像データが破損しているか、形式が一致しません" });
    }

    // fileType はクライアント入力。 そのままパスに使うと "../" 等でバケット内の
    //   他ユーザ領域へ書き込めてしまうため、 英数とハイフン/アンダースコアのみ許可。
    const safeFileType = String(fileType).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "doc";
    const filePath = `${userId}/${Date.now()}-${safeFileType}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("store-documents")
      .upload(filePath, buffer, { contentType, upsert: false, cacheControl: "31536000, immutable" });

    if (uploadError) {
      console.error("[upload-document] Storage upload error:", uploadError);
      return res.status(500).json({ error: "upload_failed", message: uploadError.message });
    }

    // 返すリンクは1時間だけ有効。 保存に使うのは path の方。
    const viewUrl = await documentViewUrl(filePath);

    console.log("[upload-document] ✅ Uploaded:", filePath);
    res.json({ path: filePath, url: viewUrl ?? `storage://${filePath}` });
  } catch (err) {
    console.error("[upload-document] Error:", err);
    res.status(500).json({ error: "internal_error", message: "アップロードに失敗しました" });
  }
});

// Public: review readiness check — validates required fields but does NOT auto-approve
// Approval is manual, performed by an admin in the admin dashboard
router.post("/stores/:storeId/auto-review", requireAdmin, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    const [store] = await db
      .select()
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      return res.status(404).json({ error: "not_found", message: "Store not found" });
    }

    // 審査チェック項目
    const checks = [
      { key: "basic_info",   label: "基本情報",       passed: !!(store.name && store.address && store.city && store.lat && store.lng) },
      { key: "license",      label: "営業許可証番号",   passed: !!store.licenseNumber },
      { key: "license_img",  label: "営業許可証（写真）", passed: !!store.licenseImageUrl },
      { key: "id_img",       label: "本人確認書類",     passed: !!store.idImageUrl },
      { key: "pledge",       label: "誓約書への同意",   passed: store.pledgeSigned === true },
    ];

    const allPassed = checks.every(c => c.passed);

    // ステータスは変更しない — 承認は管理者が手動で行う
    console.log(`[auto-review] store ${storeId} allPassed=${allPassed} (no auto-approval)`);
    const failed = checks.filter(c => !c.passed).map(c => c.label);
    return res.json({
      approved: false,
      ready: allPassed,
      checks,
      reason: allPassed ? null : `未記入の項目があります: ${failed.join(', ')}`,
      store,
    });
  } catch (err) {
    console.error("Auto-review error:", err);
    res.status(500).json({ error: "internal_error", message: "Review failed" });
  }
});

// Public: get the store owned by a specific user
router.get("/stores/by-owner", requireAuth, async (req, res) => {
  try {
    // 認可: 自分の店舗しか見れない。query.userId が指定されていても、
    // 認証ユーザの ID と一致しなければ 403。
    const userId = req.authUser!.id;
    const queriedUserId = (req.query.userId as string | undefined) ?? userId;
    if (queriedUserId !== userId) {
      return res.status(403).json({ error: "forbidden", message: "他のオーナーの店舗は閲覧できません" });
    }
    const [store] = await db
      .select(storeSelectFields)
      .from(storesTable)
      .leftJoin(surpriseBagsTable, eq(storesTable.id, surpriseBagsTable.storeId))
      .where(eq(storesTable.ownerId, userId))
      .groupBy(storesTable.id)
      .orderBy(desc(storesTable.id))
      .limit(1);

    if (!store) {
      return res.status(404).json({ error: "not_found", message: "No store found for this user" });
    }
    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch store by owner" });
  }
});

// GET /api/stores/all-by-owner — オーナーの全店舗一覧（多店舗対応）
router.get("/stores/all-by-owner", requireAuth, async (req, res) => {
  try {
    // ★ iOS WKWebView などのキャッシュを完全に無効化
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    // 認可: 自分の店舗一覧しか見れない。
    const userId = req.authUser!.id;
    const queriedUserId = (req.query.userId as string | undefined) ?? userId;
    if (queriedUserId !== userId) {
      return res.status(403).json({ error: "forbidden", message: "他のオーナーの店舗一覧は閲覧できません" });
    }
    const stores = await db
      .select(storeSelectFields)
      .from(storesTable)
      .leftJoin(surpriseBagsTable, eq(storesTable.id, surpriseBagsTable.storeId))
      .where(eq(storesTable.ownerId, userId))
      .groupBy(storesTable.id)
      .orderBy(desc(storesTable.id));

    res.json(stores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch stores by owner" });
  }
});

// Admin: list all pending stores awaiting approval
router.get("/admin/stores/pending", requireAdmin, async (_req, res) => {
  try {
    const stores = await db
      .select(storeSelectFields)
      .from(storesTable)
      .leftJoin(surpriseBagsTable, eq(storesTable.id, surpriseBagsTable.storeId))
      .where(eq(storesTable.status, "pending"))
      .groupBy(storesTable.id)
      .orderBy(storesTable.createdAt);

    res.json(stores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch pending stores" });
  }
});

// Admin: list all stores (all statuses)
router.get("/admin/stores", requireAdmin, async (_req, res) => {
  try {
    const stores = await db
      .select(storeSelectFields)
      .from(storesTable)
      .leftJoin(surpriseBagsTable, eq(storesTable.id, surpriseBagsTable.storeId))
      .groupBy(storesTable.id)
      .orderBy(storesTable.createdAt);

    res.json(stores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch stores" });
  }
});

// Admin: approve a store
router.post("/admin/stores/:storeId/approve", requireAdmin, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }

    // 承認前に既存 stripeAccountId を取得
    const [storeRow] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    const [updated] = await db
      .update(storesTable)
      .set({ status: "approved" })
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }

    // ★ 承認で公開対象が変わる → 一覧キャッシュを破棄（承認店が即マップに出るように）。
    //   これが無いと最大10秒 approved 済みの店がマップに出ず「承認したのに見えない」事故。
    invalidate("stores:list"); invalidate("bags:list");

    // ── Stripe 連携状態をチェック（承認とは独立して確認）──
    let stripeStatus: {
      ok: boolean;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      hasAccount: boolean;
      currentlyDue: string[];
      errors: { code: string; reason: string; requirement: string }[];
    } = {
      ok: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      hasAccount: !!storeRow?.stripeAccountId,
      currentlyDue: [],
      errors: [],
    };

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (stripeKey && storeRow?.stripeAccountId) {
      try {
        const stripe = await import("stripe").then((m) => new m.default(stripeKey));
        const account = await stripe.accounts.retrieve(storeRow.stripeAccountId);
        const due    = account.requirements?.currently_due ?? [];
        const errors = (account.requirements?.errors ?? []).map((e: any) => ({
          code:        e.code        ?? "",
          reason:      e.reason      ?? "",
          requirement: e.requirement ?? "",
        }));
        stripeStatus = {
          ok:             account.charges_enabled === true,
          chargesEnabled: account.charges_enabled === true,
          payoutsEnabled: account.payouts_enabled === true,
          hasAccount:     true,
          currentlyDue:   due,
          errors,
        };
        console.log(`[approve] Stripe check for ${storeRow.stripeAccountId}: charges=${account.charges_enabled} payouts=${account.payouts_enabled} due=${due.length}`);
      } catch (stripeErr: any) {
        console.warn(`[approve] Stripe status check failed: ${stripeErr?.message}`);
        stripeStatus.hasAccount = true;
      }
    }

    // ── 店舗オーナーへの承認通知 & メール ──────────────────────────────
    try {
      if (updated.ownerId) {
        // アプリ内通知（重複防止: 既存の store_approved 通知がなければ追加）
        const existing = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(and(
            eq(notificationsTable.userId, updated.ownerId),
            eq(notificationsTable.type, "store_approved"),
          ))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(notificationsTable).values({
            userId: updated.ownerId,
            type:   "store_approved",
            title:  "🎉 店舗審査が承認されました！",
            body:   `${updated.name} の審査が通過しました。口座・本人確認登録を完了して出品を始めましょう。`,
            read:   false,
          });
          console.log(`[approve] ✅ アプリ内通知送信 → userId=${updated.ownerId}`);
        }

        // 承認メール（未送信の場合のみ）
        if (!updated.approvalEmailSent) {
          const resendApiKey = process.env.RESEND_API_KEY;
          if (resendApiKey) {
            try {
              const { data: userData } = await supabaseAdmin.auth.admin.getUserById(updated.ownerId);
              const ownerEmail = userData?.user?.email;
              if (ownerEmail) {
                const sent = await sendStoreApprovalEmail({ ownerEmail, storeName: updated.name });
                if (sent) {
                  await db.update(storesTable).set({ approvalEmailSent: true }).where(eq(storesTable.id, storeId));
                  console.log(`[approve] ✅ 承認メール送信 → ${ownerEmail}`);
                }
              }
            } catch (emailErr: any) {
              console.warn(`[approve] 承認メール送信エラー:`, emailErr?.message);
            }
          }
        }
      }
    } catch (notifyErr: any) {
      console.warn("[approve] 通知送信エラー:", notifyErr?.message);
    }

    res.json({ ...updated, totalBagsAvailable: 0, stripeStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to approve store" });
  }
});

// Admin: reject a store (with optional rejection reason)
router.post("/admin/stores/:storeId/reject", requireAdmin, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }
    const rejectionReason: string | null = req.body?.rejectionReason?.trim() || null;

    const [updated] = await db
      .update(storesTable)
      .set({ status: "rejected", rejectionReason })
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }

    // ★ 却下で公開対象から外れる → 一覧キャッシュを破棄（停止店が即マップから消えるように）。
    invalidate("stores:list"); invalidate("bags:list");

    // ── 店舗オーナーへの通知 & メール ──────────────────────────────
    try {
      if (updated.ownerId) {
        // in-app 通知
        await db.insert(notificationsTable).values({
          userId: updated.ownerId,
          type: "store_rejected",
          title: "店舗審査の結果をお知らせします",
          body: rejectionReason
            ? `申請が却下されました。理由：${rejectionReason}`
            : "申請が却下されました。再申請フォームより修正のうえ再度お申し込みください。",
        });

        // メール送信
        const resendApiKey = process.env.RESEND_API_KEY;
        if (resendApiKey) {
          const resend = new Resend(resendApiKey);
          const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
          const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost'}`;
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(updated.ownerId);
          const ownerEmail = userData?.user?.email;
          if (ownerEmail) {
            await resend.emails.send({
              from: `おすそわけ <${fromDomain}>`,
              to: ownerEmail,
              subject: `【おすそわけ】店舗審査の結果について：${escapeHtml(updated.name)}`,
              html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);padding:40px 32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">😔</div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:900;margin:0;">審査結果のご連絡</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:15px;color:#333;line-height:1.7;margin-bottom:20px;">
        この度は おすそわけ にご申請いただきありがとうございます。<br>
        誠に申し訳ございませんが、<strong>${escapeHtml(updated.name)}</strong> の店舗申請について、今回は審査を通過できませんでした。
      </p>
      ${rejectionReason ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <p style="font-size:12px;font-weight:900;color:#dc2626;margin:0 0 8px;">却下理由</p>
        <p style="font-size:14px;color:#333;margin:0;line-height:1.6;">${escapeHtml(rejectionReason)}</p>
      </div>` : ''}
      <p style="font-size:14px;color:#555;line-height:1.7;margin-bottom:24px;">
        情報を修正のうえ、アプリより再申請していただくことが可能です。
      </p>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${appUrl}/store/reapply" style="display:inline-block;background:linear-gradient(135deg,#F26419,#d44a00);color:#ffffff;font-size:16px;font-weight:900;padding:16px 48px;border-radius:14px;text-decoration:none;">
          再申請する
        </a>
      </div>
      <p style="color:#999;font-size:12px;text-align:center;margin:0;">ご不明な点は <a href="mailto:hello@osusowakejapan.org" style="color:#F26419;">hello@osusowakejapan.org</a> までご連絡ください。</p>
    </div>
  </div>
</body>
</html>`.trim(),
            });
            console.log("[reject] ✅ 却下メール送信 →", ownerEmail);
          }
        }
      }
    } catch (notifyErr: any) {
      console.warn("[reject] 通知送信エラー:", notifyErr?.message);
    }

    res.json({ ...updated, totalBagsAvailable: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to reject store" });
  }
});

// Store owner: reapply after rejection
router.post("/stores/:storeId/reapply", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }

    const body = req.body ?? {};

    // 既存店舗を取得してオーナー確認
    const [store] = await db.select().from(storesTable).where(eq(storesTable.id, storeId)).limit(1);
    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    if (store.status !== "rejected") {
      res.status(400).json({ error: "invalid_status", message: "Only rejected stores can reapply" });
      return;
    }

    // 更新可能なフィールドのみ受け取る
    //   ★ status は 1店舗目 (Stripe未登録) なら "pending" (再度 bank-setup へ誘導)、
    //     それ以外は "pending_review" (admin 再審査)。 旧コードの "applied" は誤りで、
    //     本来 admin 承認を経るべき店舗が即時 公開される穴があった。
    const reapplyStatus: "pending" | "pending_review" =
      store.stripeAccountId ? "pending_review" : "pending";
    const updateData: Record<string, unknown> = {
      status: reapplyStatus,
      rejectionReason: null,
    };
    const editableFields = ["name", "description", "address", "city", "category", "phone",
      "openTime", "closeTime", "holiday", "pickupHours", "imageUrl",
      "licenseNumber", "pledgeSigned",
      "legalName", "legalRepresentative", "legalAddress", "legalPhone", "legalEmail", "legalOther"];
    for (const f of editableFields) {
      if (body[f] !== undefined) updateData[f] = body[f];
    }

    // ★ 営業許可証番号の重複チェック (自分自身の店舗は除外)
    //    却下→再申請の経路で、 他店舗の番号を盗用 / 自分の別店舗の番号に書き換える攻撃を防ぐ
    if (typeof body.licenseNumber === "string") {
      try {
        const licHit = await findLicenseDuplicate({
          ownerId: store.ownerId!,
          rawLicenseNumber: body.licenseNumber,
          excludeStoreId: storeId,
        });
        if (licHit) {
          console.warn(
            `[/reapply] 🚫 営業許可証番号 重複ブロック: storeId=${storeId} ownerId=${store.ownerId} → 既存storeId=${licHit.id} isSelf=${licHit.isSelf}`,
          );
          sendLicenseDuplicate(res, licHit);
          return;
        }
      } catch (licEx: any) {
        console.warn(`[/reapply] 営業許可証重複チェック失敗 (申請は継続): ${licEx?.message}`);
      }
    }

    // ── 営業許可証 画像差し替え (任意) ───────────────────────────────────
    //   apply 経路と同じく Supabase Storage にアップロードして signedUrl を保存。
    //   既存 stripeAccountId があれば Stripe Files API にも再アップロードして
    //   metadata.license_file_id を更新する (admin 再審査時に最新書類が見えるよう)。
    const LICENSE_DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp|heic|heif)|application\/pdf);base64,(.+)$/s;
    if (typeof body.licenseImageBase64 === "string" && body.licenseImageBase64) {
      const match = body.licenseImageBase64.match(LICENSE_DATA_URL_RE);
      if (!match) {
        res.status(400).json({
          error: "license_image_invalid",
          message: "営業許可証の画像形式が不正です。 JPG/PNG/HEIC/PDF を選んでください。",
        });
        return;
      }
      try {
        const contentType = match[1];
        const ext =
          contentType === "image/png" ? "png" :
          contentType === "image/webp" ? "webp" :
          contentType === "image/heic" ? "heic" :
          contentType === "image/heif" ? "heif" :
          contentType === "application/pdf" ? "pdf" :
          "jpg";
        const buffer = Buffer.from(match[2], "base64");
        const filePath = `${store.ownerId}/${Date.now()}-license.${ext}`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from("store-documents")
          .upload(filePath, buffer, { contentType, upsert: false, cacheControl: "31536000, immutable" });
        if (!uploadError) {
          updateData.licenseImageUrl = filePath;
          console.log(`[/reapply] ✅ 営業許可証 再アップロード完了: storeId=${storeId} path=${filePath}`);
        } else {
          console.warn(`[/reapply] 営業許可証 Supabase アップロード失敗: ${uploadError.message}`);
        }

        // Stripe Files API: 既存アカウントがあれば再アップロード + metadata 更新
        const stripeKey = process.env["STRIPE_SECRET_KEY"];
        if (store.stripeAccountId && stripeKey) {
          try {
            const stripe = await import("stripe").then((m) => new m.default(stripeKey));
            const fileExt = ext === "jpg" ? "jpg" : ext;
            const stripeFile = await stripe.files.create(
              {
                file: { data: buffer, name: `license-${Date.now()}.${fileExt}`, type: contentType },
                purpose: "additional_verification",
              },
              { stripeAccount: store.stripeAccountId }
            );
            updateData.stripeLicenseFileId = stripeFile.id;
            try {
              await stripe.accounts.update(store.stripeAccountId, {
                metadata: {
                  license_file_id: stripeFile.id,
                  license_updated_at: new Date().toISOString(),
                  reapply_store_id: String(storeId),
                },
              });
            } catch (mdEx: any) {
              console.warn(`[/reapply] Stripe metadata 更新失敗 (継続): ${mdEx?.message}`);
            }
            console.log(`[/reapply] ✅ Stripe Files 再アップロード完了: storeId=${storeId} fileId=${stripeFile.id}`);
          } catch (stripeEx: any) {
            console.warn(`[/reapply] Stripe Files 再アップロード失敗 (継続): ${stripeEx?.message}`);
          }
        }
      } catch (uploadEx: any) {
        console.warn(`[/reapply] 営業許可証アップロード例外: ${uploadEx?.message}`);
      }
    }

    const [updated] = await db
      .update(storesTable)
      .set(updateData as any)
      .where(eq(storesTable.id, storeId))
      .returning();

    // 管理者全員に in-app 通知 (再申請を見落とさないため)
    //   pending_review (= 2店舗目以降の再審査待ち) の場合のみ通知。
    //   pending (= 1店舗目で bank-setup 未完了) は ユーザ側の作業中なので通知不要。
    if (reapplyStatus === "pending_review") {
      try {
        const { getAllAdminUserIds } = await import("../lib/admin.js");
        const adminIds = await getAllAdminUserIds();
        if (adminIds.length > 0) {
          await db.insert(notificationsTable).values(
            adminIds.map((adminId) => ({
              userId: adminId,
              type:   "store_reapply",
              title:  "🔄 却下店舗が再申請しました",
              body:   `${updated.name}（再審査待ち）`,
              read:   false,
            })),
          );
        }
      } catch (notifyEx: any) {
        console.warn(`[/reapply] admin 通知失敗 (申請は成功): ${notifyEx?.message}`);
      }
    }

    res.json({ ...updated, totalBagsAvailable: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to reapply" });
  }
});

router.get("/stores/:storeId", async (req, res) => {
  try {
    const { storeId } = GetStoreParams.parse(req.params);
    // ★ 公開エンドポイント: PII を含まない publicStoreSelectFields を使用 (#3)
    //   オーナー自身がフルデータを取得する場合は /stores/by-owner を使う。
    const [store] = await db
      .select(publicStoreSelectFields)
      .from(storesTable)
      .leftJoin(surpriseBagsTable, eq(storesTable.id, surpriseBagsTable.storeId))
      .where(eq(storesTable.id, storeId))
      .groupBy(storesTable.id);

    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json(store);
  } catch (err) {
    // 不正な storeId (数値でない等) は 400 (bags/:bagId と同じ扱い。zod直接依存なしのためname判定)
    if ((err as any)?.name === "ZodError" || (err as any)?.name === "$ZodError") {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch store" });
  }
});

// User: report a store
router.post("/stores/:storeId/report", requireAuth, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }

    // 認証済みユーザーIDを使う（body.userId は信頼しない＝なりすまし防止）
    const userId = req.authUser!.id;
    const { reportType, comment } = req.body as {
      reportType?: string;
      comment?: string;
    };

    if (!reportType || !REPORT_TYPES.includes(reportType as ReportType)) {
      res.status(400).json({ error: "bad_request", message: "Invalid reportType" });
      return;
    }

    // Rate limit: reject if same user already reported this store within 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [existing] = await db
      .select({ id: reportsTable.id })
      .from(reportsTable)
      .where(
        and(
          eq(reportsTable.storeId, storeId),
          eq(reportsTable.userId, userId),
          gte(reportsTable.createdAt, since)
        )
      )
      .limit(1);

    if (existing) {
      res.status(429).json({ error: "rate_limited", message: "You already reported this store recently" });
      return;
    }

    // Save the report
    const [report] = await db.insert(reportsTable).values({
      storeId,
      userId,
      reportType: reportType as ReportType,
      comment: comment?.trim() || null,
    }).returning();

    // Auto-flag: count total reports for this store
    const [{ total }] = await db
      .select({ total: count() })
      .from(reportsTable)
      .where(eq(reportsTable.storeId, storeId));

    if (Number(total) >= 3) {
      // Set store status to pending_review so admin gets notified
      await db
        .update(storesTable)
        .set({ status: "pending_review" })
        .where(
          and(
            eq(storesTable.id, storeId),
            eq(storesTable.status, "approved")
          )
        );
    }

    res.status(201).json({ success: true, report });
  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ error: "internal_error", message: "Failed to save report" });
  }
});

// Admin: list all reports with store names
router.get("/admin/reports", requireAdmin, async (_req, res) => {
  try {
    const reports = await db
      .select({
        id: reportsTable.id,
        storeId: reportsTable.storeId,
        storeName: storesTable.name,
        storeStatus: storesTable.status,
        userId: reportsTable.userId,
        reportType: reportsTable.reportType,
        comment: reportsTable.comment,
        createdAt: reportsTable.createdAt,
      })
      .from(reportsTable)
      .leftJoin(storesTable, eq(reportsTable.storeId, storesTable.id))
      .orderBy(reportsTable.createdAt);

    res.json(reports);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch reports" });
  }
});

// Admin: dismiss reports for a store (reset pending_review → approved)
router.post("/admin/stores/:storeId/dismiss-reports", requireAdmin, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }
    const [updated] = await db
      .update(storesTable)
      .set({ status: "approved" })
      .where(eq(storesTable.id, storeId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json({ success: true, store: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to dismiss reports" });
  }
});

// Public: get reviews for a store (with avg rating + count)
router.get("/stores/:storeId/reviews", async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }
    const reviews = await db
      .select({
        id: reviewsTable.id,
        reservationId: reviewsTable.reservationId,
        userId: reviewsTable.userId,
        rating: reviewsTable.rating,
        comment: reviewsTable.comment,
        createdAt: reviewsTable.createdAt,
        reply: reviewsTable.reply,
        repliedAt: reviewsTable.repliedAt,
      })
      .from(reviewsTable)
      .where(eq(reviewsTable.storeId, storeId))
      .orderBy(desc(reviewsTable.createdAt));

    const avgRating = reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;

    res.json({
      reviews,
      avgRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
      count: reviews.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch reviews" });
  }
});

// User: post a review (must have a picked_up reservation for this store)
router.post("/stores/:storeId/reviews", requireAuth, async (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid store ID" });
      return;
    }

    // 認証済みユーザーIDを使う（body.userId は信頼しない＝なりすまし防止）
    const userId = req.authUser!.id;
    const { reservationId, rating, comment } = req.body as {
      reservationId?: number;
      rating?: number;
      comment?: string;
    };

    if (!reservationId || typeof reservationId !== "number") {
      res.status(400).json({ error: "bad_request", message: "reservationId is required" });
      return;
    }
    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      res.status(400).json({ error: "bad_request", message: "rating must be 1-5" });
      return;
    }

    // Verify reservation is picked_up and belongs to this user + store
    const [reservation] = await db
      .select({ id: reservationsTable.id, status: reservationsTable.status })
      .from(reservationsTable)
      .where(
        and(
          eq(reservationsTable.id, reservationId),
          eq(reservationsTable.userId, userId),
          eq(reservationsTable.storeId, storeId),
          eq(reservationsTable.status, "picked_up")
        )
      )
      .limit(1);

    if (!reservation) {
      res.status(403).json({ error: "forbidden", message: "No valid picked_up reservation found" });
      return;
    }

    // Prevent duplicate reviews for the same reservation
    const [existingReview] = await db
      .select({ id: reviewsTable.id })
      .from(reviewsTable)
      .where(eq(reviewsTable.reservationId, reservationId))
      .limit(1);

    if (existingReview) {
      res.status(409).json({ error: "conflict", message: "Review already submitted for this reservation" });
      return;
    }

    const [review] = await db.insert(reviewsTable).values({
      storeId,
      reservationId,
      userId,
      rating,
      comment: comment?.trim() || null,
    }).returning();

    res.status(201).json({ success: true, review });

    // 店舗オーナーへ「新しい口コミ」をアプリ内ベル通知（push は使わない＝マロ指示）。
    //   - ベルは無条件で insert（レビューを取りこぼさない）。
    //   - 重複レビューは上流で 409 済み＝このブロックは 1 レビューにつき 1 回だけ走る。
    //   - 応答後に非同期・失敗は握り潰す（保存本体には影響させない）。
    try {
      const [store] = await db
        .select({ ownerId: storesTable.ownerId })
        .from(storesTable)
        .where(eq(storesTable.id, storeId))
        .limit(1);
      if (store?.ownerId) {
        const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
        const trimmed = comment?.trim();
        const body = trimmed
          ? `${stars}「${trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed}」`
          : `${stars} の評価をいただきました`;
        await db.insert(notificationsTable).values({
          userId: store.ownerId,
          type: "new_review",
          title: "新しい口コミが投稿されました",
          body,
          storeId,
        });
      }
    } catch (notifyErr) {
      console.error("[stores] review notify error (non-fatal):", notifyErr);
    }
    return;
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ error: "internal_error", message: "Failed to save review" });
  }
});

router.put("/stores/:storeId", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const { storeId } = UpdateStoreParams.parse(req.params);
    const body = UpdateStoreBody.parse(req.body);

    const [updated] = await db
      .update(storesTable)
      .set(body)
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json({ ...updated, totalBagsAvailable: 0 });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Invalid update data" });
  }
});

// GET /api/stores/:storeId/today-sales
// 今日の売上（手数料20%控除後の店舗受取額）を Stripe Transfers から取得
router.get("/stores/:storeId/today-sales", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, name: storesTable.name })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }

    if (!store.stripeAccountId) {
      res.json({ gross: 0, platformFee: 0, net: 0, count: 0, connected: false });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.json({ gross: 0, platformFee: 0, net: 0, count: 0, connected: true, noKey: true });
      return;
    }

    const stripeLib = await import("stripe");
    const stripe = new stripeLib.default(stripeKey);

    // 今日の0時（JST）のUNIXタイムスタンプを計算
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStrJST = nowJST.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const startOfDayUTC = new Date(todayStrJST + "T00:00:00+09:00");
    const startUnix = Math.floor(startOfDayUTC.getTime() / 1000);

    // 連携アカウントへの今日のTransfer一覧を取得
    const transfers = await stripe.transfers.list({
      destination: store.stripeAccountId,
      created: { gte: startUnix },
      limit: 100,
    });

    // JPY: amountは円単位
    const net = transfers.data.reduce((sum, t) => sum + t.amount, 0);
    // 正確な逆算（新収益モデル）:
    //   店舗受取 = floor(merch × 0.80) - round(userTotal × 0.036)
    //   userTotal ≈ merch × 1.05 のため
    //   店舗受取 ≈ merch × 0.80 - merch × 1.05 × 0.036 = merch × 0.7622
    //   → 商品代金 (merch) ≈ 店舗受取 / 0.7622
    // ※ ここで返す `gross` は「商品代金合計」（20% 課金ベース）の概算値。
    //   ユーザー支払合計は別 (商品代金 + 5%システム利用料) なので店舗には開示しない。
    const STORE_RATE = 1 - 0.20 - 1.05 * 0.036; // ≒ 0.7622
    const gross       = net > 0 ? Math.round(net / STORE_RATE) : 0;
    const platformFee = gross - net; // = プラットフォーム手数料(20%) + Stripe手数料(3.6%)

    res.json({
      gross,
      platformFee,
      net,
      count: transfers.data.length,
      connected: true,
    });
  } catch (err: any) {
    console.error("Today sales error:", err);
    res.status(500).json({ error: "stripe_error", message: "Failed to fetch today's sales" });
  }
});

// GET /api/stores/:storeId/statement
//   - パラメータ無し   → 振込一覧 { payouts: [...] }（セレクタ用）
//   - ?payout=po_xxx  → その振込の明細 { payout, items, totals, ... }
//
// 振込(payout)単位の明細。 Stripe の payout に含まれる balance transaction から
// 送金(transfer)を辿り、 metadata.reservationId でうちのDBの注文に紐付けて明細化する。
// → 銀行に着金した額と、その内訳(注文)が 1 対 1 で照合できる。
// 金額は payment.ts と同一の calcFees で算出するため実送金額と一致する。
// ※ これは「売上明細書」であり適格請求書(インボイス)ではない。
router.get("/stores/:storeId/statement", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const [store] = await db
      .select({ id: storesTable.id, name: storesTable.name, stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    if (!store.stripeAccountId) {
      res.json({ connected: false, storeName: store.name, payouts: [] });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.json({ connected: true, noKey: true, storeName: store.name, payouts: [] });
      return;
    }
    const stripe = await import("stripe").then((m) => new m.default(stripeKey));
    const acct = store.stripeAccountId;

    const toJst = (unixSec: number) =>
      new Date(unixSec * 1000 + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const STATUS_JA: Record<string, string> = {
      paid: "着金済", in_transit: "送金中", pending: "振込予定", failed: "失敗", canceled: "取消",
    };

    const payoutId = String(req.query.payout ?? "").trim();

    // ── モード1: 振込一覧（セレクタ用）─────────────────────────────
    // 60秒キャッシュ: 画面を開くたびの Stripe 往復を削減
    if (!payoutId) {
      const payouts = await cached(`stmt-list:${acct}`, 60_000, async () => {
        const list = await stripe.payouts.list({ limit: 24 }, { stripeAccount: acct });
        return list.data.map((p) => ({
          id:          p.id,
          arrivalDate: toJst(p.arrival_date),
          amount:      p.amount,
          status:      p.status,
          statusLabel: STATUS_JA[p.status] ?? p.status,
        }));
      });
      res.json({ connected: true, storeName: store.name, payouts });
      return;
    }

    // ── モード2: 指定振込の明細 ───────────────────────────────────
    // ★ 確定した振込の内訳は変わらないため 10 分キャッシュ。 2回目以降は即返し。
    //   キャッシュキーに storeId を含める（同一 Stripe アカウント共有の複数店で
    //   他店の明細が混ざらないように。 DB 照会側too storeId で絞る）。
    const payload = await cached(`stmt:${storeId}:${payoutId}`, 600_000, async () => {
      // 振込の実在確認。 「存在しない」だけ null(=404)。 一時エラー(レート制限等)は
      // throw する — cached() は例外を保存しないため、 誤った 404 が10分固定される事故を防ぐ。
      let payout: any;
      try {
        payout = await stripe.payouts.retrieve(payoutId, { stripeAccount: acct });
      } catch (e: any) {
        if (e?.code === "resource_missing" || e?.statusCode === 404) return null;
        throw e;
      }

      // この振込に含まれる balance transaction（★has_more ページングで全件取得。
      // limit:100 固定だと101件以上の振込で明細が欠落し、合計が着金額と合わなくなる）
      const btAll: any[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < 20; page++) { // 安全上限 2000 件
        const chunk: any = await stripe.balanceTransactions.list(
          {
            payout: payoutId, limit: 100, expand: ["data.source"],
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          { stripeAccount: acct },
        );
        btAll.push(...chunk.data);
        if (!chunk.has_more) break;
        startingAfter = chunk.data[chunk.data.length - 1]?.id;
      }
      const btxns = { data: btAll };

      const asId = (v: any): string | null =>
        typeof v === "string" ? v : (v && typeof v === "object" && typeof v.id === "string" ? v.id : null);
      const parseRid = (v: unknown): number | undefined => {
        const n = v != null ? parseInt(String(v), 10) : NaN;
        return isNaN(n) ? undefined : n;
      };
      // 送金から reservationId / PaymentIntent ID を解決する。
      // ★ デスティネーションチャージでは送金は Stripe 自動生成で metadata が空。
      //   reservationId は PaymentIntent の metadata (payment.ts の feeMetadata) にあるため、
      //   送金 → source_transaction(プラットフォームcharge) → payment_intent と expand で辿る。
      //   metadata に無い古い注文のために PI の ID も返し、 後で DB の
      //   reservations.payment_intent_id から逆引きする（最終フォールバック）。
      // 失敗時は 1 回リトライ後 throw する — 握り潰すと未解決分が「その他（返金・調整等）」に
      // 化けて誤った巨額調整が表示され、 さらに10分キャッシュされてしまうため。
      // throw なら cached() は保存せず、 フロントに「取得に失敗」が出て再試行できる。
      const resolveTransfer = async (trId: string, attempt = 0): Promise<{ rid?: number; piId?: string }> => {
        try {
          const tr = await stripe.transfers.retrieve(trId, {
            expand: ["source_transaction.payment_intent"],
          });
          const ch: any = tr.source_transaction;
          const rid = parseRid(tr.metadata?.["reservationId"])            // separate CT 経路
            ?? parseRid(ch?.metadata?.reservationId)                      // charge に載る場合
            ?? parseRid(ch?.payment_intent?.metadata?.reservationId);     // destination charge の本命
          const piId = typeof ch?.payment_intent === "string"
            ? ch.payment_intent
            : ch?.payment_intent?.id;
          return { rid, piId };
        } catch (e) {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 500));
            return resolveTransfer(trId, 1);
          }
          throw e;
        }
      };

      // ★ 金額の権威は「実際に振り込まれた bt.amount」。 calcFees での再計算は
      //   過去の手数料条件・丸めと数円ズレ得るため、 受取額には使わない。
      //   payout 以外の bt を全部拾う: プラス=注文の入金 / マイナス=返金・調整。
      //   Stripe の構造上 Σ(payout以外のbt) = payout.amount が保証される
      //   → 明細合計 + 調整額 = 振込額が必ず一致する。
      const parts = btxns.data.filter((bt: any) => bt.type !== "payout");
      // ★ Stripe レート制限対策: 全件一斉でなく 4 件ずつ解決する
      const resolved: Array<{ rid?: number; piId?: string; amount: number }> = [];
      for (let i = 0; i < parts.length; i += 4) {
        const batch = await Promise.all(parts.slice(i, i + 4).map(async (bt: any) => {
          const src = bt.source as any;
          const stId = asId(src?.source_transfer) ?? asId(src?.transfer) ?? asId(src);
          let rid: number | undefined;
          let piId: string | undefined;
          if (bt.amount > 0) {
            if (stId && stId.startsWith("tr_")) {
              const r = await resolveTransfer(stId);
              rid = r.rid; piId = r.piId;
            }
            if (rid === undefined) rid = parseRid(src?.metadata?.reservationId);
            if (piId === undefined) {
              const p = src?.payment_intent;
              piId = typeof p === "string" ? p : p?.id;
            }
          }
          return { rid, piId, amount: bt.amount };
        }));
        resolved.push(...batch);
      }

      // metadata で特定できなかった分を PaymentIntent ID → DB 逆引きで救済
      const orphanPiIds = [...new Set(
        resolved.filter((r) => r.rid === undefined && r.piId).map((r) => r.piId!),
      )];
      if (orphanPiIds.length > 0) {
        const piRows = await db
          .select({ id: reservationsTable.id, piId: reservationsTable.paymentIntentId })
          .from(reservationsTable)
          .where(and(
            eq(reservationsTable.storeId, storeId),
            inArray(reservationsTable.paymentIntentId, orphanPiIds),
          ));
        const ridByPi = new Map(piRows.filter((p) => p.piId).map((p) => [p.piId!, p.id]));
        for (const r of resolved) {
          if (r.rid === undefined && r.piId) r.rid = ridByPi.get(r.piId);
        }
      }

      // 注文ID → 実送金額（同一注文が複数btに分かれても合算）
      const amountByRid = new Map<number, number>();
      let unmatchedAmount = 0; // 注文に紐付かない調整分（返金・手数料調整等。正負あり）
      for (const r of resolved) {
        if (r.rid === undefined) { unmatchedAmount += r.amount; continue; }
        amountByRid.set(r.rid, (amountByRid.get(r.rid) ?? 0) + r.amount);
      }
      const reservationIds = [...amountByRid.keys()];

      const rows = reservationIds.length > 0
        ? await db
            .select({
              id:                reservationsTable.id,
              createdAt:         reservationsTable.createdAt,
              quantity:          reservationsTable.quantity,
              totalPrice:        reservationsTable.totalPrice,
              merchandiseAmount: reservationsTable.merchandiseAmount,
              status:            reservationsTable.status,
              title:             surpriseBagsTable.title,
            })
            .from(reservationsTable)
            .leftJoin(surpriseBagsTable, eq(reservationsTable.bagId, surpriseBagsTable.id))
            // ★ storeId でも絞る: 同一 Stripe アカウント共有の複数店で
            //   他店の注文明細（商品名・金額）が混ざるのを防ぐ。
            //   他店分の金額は「その他」(unmatchedAmount) 側に集計される。
            .where(and(
              inArray(reservationsTable.id, reservationIds),
              eq(reservationsTable.storeId, storeId),
            ))
            .orderBy(reservationsTable.createdAt)
        : [];

      // DB に見つからなかった注文（削除等）の実額も調整分へ回し、 合計の整合を守る
      const foundIds = new Set(rows.map((r) => r.id));
      for (const [rid, amt] of amountByRid) {
        if (!foundIds.has(rid)) unmatchedAmount += amt;
      }

      const items = rows.map((r) => {
        const merch = r.merchandiseAmount ?? r.totalPrice;
        const { shopGross } = calcFees(r.totalPrice, merch);
        const actualNet = amountByRid.get(r.id) ?? 0;  // ★ 実際に振り込まれた額（権威）
        const commission = merch - shopGross;          // おすそわけ手数料(20%)
        // 決済手数料は実額から逆算 = 当時の実際の控除額。
        // 行内で 商品代金 - 手数料20% - 決済手数料 = 受取額 が恒等的に成立する。
        const stripeFee = shopGross - actualNet;
        const dateJst = new Date(r.createdAt.getTime() + 9 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        return {
          date:         dateJst,
          orderId:      r.id,
          title:        r.title ?? "(商品名なし)",
          quantity:     r.quantity,
          customerPaid: r.totalPrice,
          merchandise:  merch,
          commission,
          stripeFee,
          storeNet:     actualNet,
          status:       r.status,
        };
      });

      const totals = items.reduce(
        (a, it) => ({
          count:        a.count + 1,
          customerPaid: a.customerPaid + it.customerPaid,
          merchandise:  a.merchandise + it.merchandise,
          commission:   a.commission + it.commission,
          stripeFee:    a.stripeFee + it.stripeFee,
          storeNet:     a.storeNet + it.storeNet,
        }),
        { count: 0, customerPaid: 0, merchandise: 0, commission: 0, stripeFee: 0, storeNet: 0 },
      );

      return {
        connected: true,
        issuer: "おすそわけ",
        isQualifiedInvoice: false,
        taxNote: "商品代金は軽減税率8%対象、各種手数料は10%対象です。本書は売上明細書であり適格請求書ではありません。",
        payout: {
          id:          payout.id,
          arrivalDate: toJst(payout.arrival_date),
          amount:      payout.amount,
          status:      payout.status,
          statusLabel: STATUS_JA[payout.status] ?? payout.status,
        },
        unmatchedAmount,
        items,
        totals,
      };
    });

    if (!payload) {
      res.status(404).json({ error: "not_found", message: "Payout not found" });
      return;
    }
    // 店名はキャッシュ外で付与（同一Stripeアカウント共有の複数店で他店名が出ないように）
    res.json({ ...payload, storeName: store.name });
  } catch (err: any) {
    console.error("[statement] error:", err?.message);
    res.status(500).json({ error: "internal_error", message: "Failed to build statement" });
  }
});

// GET /api/stores/:storeId/connect/status
// Stripe アカウントのオンボーディング完了状況を返す
router.get("/stores/:storeId/connect/status", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    // ★ iOS WKWebView などのキャッシュを完全に無効化
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const storeId = parseInt(String(req.params.storeId));

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }

    if (!store.stripeAccountId) {
      res.json({ connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      // Stripe未設定でもアカウントIDがあれば connected=true として返す
      res.json({ connected: true, accountId: store.stripeAccountId, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false });
      return;
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));
    const account = await stripe.accounts.retrieve(store.stripeAccountId);

    // ★ write-through キャッシュ: ライブ Stripe の値を DB の stripeChargesEnabled / stripePayoutsEnabled
    //   に書き戻す。これで StoreLayout / StoreSelector / MyPage の DB ベース・バッジが最新化され、
    //   StoreDashboard のライブ判定（出品ボタンブロック）と矛盾しなくなる。
    //   （以前は webhook 任せだったため、Stripe が後から有効化したケースで DB が古いまま停止中表示が残っていた）
    try {
      await db
        .update(storesTable)
        .set({
          stripeChargesEnabled: account.charges_enabled === true,
          stripePayoutsEnabled: account.payouts_enabled === true,
        })
        .where(eq(storesTable.id, storeId));
    } catch (syncErr) {
      console.error("[connect/status] DB write-through failed (non-fatal):", syncErr);
    }

    // ★ 2026-08-04 自己修復: Stripe が完全に通っている(決済◯かつ入金◯)のに
    //   こちらのステータスが審査中のまま残っている店を、この参照のタイミングで承認する。
    //   自動承認は webhook(account.updated) 依存だったため、Stripe からの通知を
    //   取りこぼす／通知後に条件が揃うケースで「Stripe は完了しているのにアプリは
    //   ずっと審査中」という詰みが発生していた。店主がダッシュボードを開くたびに
    //   ここで救済されるので、通知の取りこぼしが恒久的な詰みにならない。
    try {
      const stripeFullyVerified = account.charges_enabled === true && account.payouts_enabled === true;
      const [cur] = await db
        .select({ status: storesTable.status, name: storesTable.name, ownerId: storesTable.ownerId })
        .from(storesTable)
        .where(eq(storesTable.id, storeId))
        .limit(1);
      let autoApprove = true; // 既定ON（このファイル内の他経路と同じ方針）
      try {
        const settingRows = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified'`);
        autoApprove = ((settingRows.rows[0] as any)?.value ?? "true") !== "false";
      } catch (_) { /* 読めない場合は既定ONのまま */ }
      if (
        autoApprove &&
        stripeFullyVerified &&
        cur &&
        (cur.status === "applied" || cur.status === "pending_review" || cur.status === "pending")
      ) {
        await db
          .update(storesTable)
          .set({ status: "approved" as any, isActive: true })
          .where(eq(storesTable.id, storeId));
        console.log(`[connect/status] ✅ 自己修復で承認: store ${storeId} (${cur.name})`);
        if (cur.ownerId) {
          try {
            await db.insert(notificationsTable).values({
              userId: cur.ownerId,
              type: "store_approved",
              title: "🎉 店舗が承認されました！",
              body: `${cur.name} がおすそわけに公開されました。おすそわけバッグを出品しましょう！`,
              read: false,
            });
          } catch (_) { /* 通知失敗は握り潰す */ }
        }
      }
      // ★ 2026-08-05 自己修復(逆方向): Stripe が再提出を求めている(書類却下 / past_due)のに
      //   こちらが 'applied'(審査中) のまま残っている店を 'pending' に差し戻す。
      //   これは stripe-webhook.ts が account.updated 受信時に元々やっている処理と同一。
      //   webhook を取りこぼすと「Stripeは却下しているのにアプリは"審査中"一点張りで
      //   再入力フォームが出ない」という詰みになる(高槻駅 2026-08-05)。
      //   'pending' に戻れば従来どおり bank-setup の再入力フォーム(不足項目つき)が出る。
      else if (cur && cur.status === "applied") {
        const reqs: any = (account as any).requirements ?? {};
        const pastDue: string[] = reqs.past_due ?? [];
        const errs: any[] = reqs.errors ?? [];
        if (pastDue.length > 0 || errs.length > 0) {
          const needsBankReregister = pastDue.some(
            (f: string) => f === "external_account" || f.startsWith("external_account"),
          );
          await db
            .update(storesTable)
            .set({ status: "pending" as any, stripeNeedsBankReregister: needsBankReregister || false })
            .where(eq(storesTable.id, storeId));
          console.log(
            `[connect/status] ⚠️ 自己修復で再入力へ差し戻し: store ${storeId} (${cur.name}) past_due=[${pastDue.join(", ")}] errors=${errs.length}`,
          );
        }
      }
    } catch (healErr) {
      console.error("[connect/status] 自己修復スキップ (non-fatal):", healErr);
    }

    res.json({
      connected: true,
      accountId: store.stripeAccountId,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      requirements: {
        currentlyDue: account.requirements?.currently_due ?? [],
        eventuallyDue: account.requirements?.eventually_due ?? [],
        errors: account.requirements?.errors ?? [],
        pendingVerification: account.requirements?.pending_verification ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
      },
    });
  } catch (err: any) {
    // アカウントが削除されている場合など
    if (err?.code === "account_invalid" || err?.statusCode === 404) {
      res.json({ connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false });
      return;
    }
    console.error("Stripe Connect status error:", err);
    res.status(500).json({ error: "stripe_error", message: "Failed to fetch connect status" });
  }
});

// ─── Stripe 保存済みデータ取得（フォーム事前入力用） ────────────────────────────
// GET /api/stores/:storeId/connect/account-data
// Stripe に保存済みの個人情報・口座情報を返す（再申請時のフォーム事前入力用）
router.get("/stores/:storeId/connect/account-data", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) return res.status(400).json({ error: "bad_request" });

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) return res.status(404).json({ error: "not_found" });
    if (!store.stripeAccountId) return res.json({ hasAccount: false });

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) return res.json({ hasAccount: true, data: null });

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));
    const account = await stripe.accounts.retrieve(store.stripeAccountId);

    const ind = (account as any).individual ?? null;
    const biz = account.business_profile ?? null;

    const bankAccount = (() => {
      const ext = (account as any).external_accounts?.data?.[0];
      if (!ext) return null;
      return {
        bankName: ext.bank_name ?? '',
        last4: ext.last4 ?? '',
        routingNumber: ext.routing_number ?? '',
      };
    })();

    res.json({
      hasAccount: true,
      businessType: account.business_type ?? 'individual',
      individual: ind ? {
        lastNameKanji:  ind.last_name_kanji  ?? '',
        firstNameKanji: ind.first_name_kanji ?? '',
        lastNameKana:   ind.last_name_kana   ?? '',
        firstNameKana:  ind.first_name_kana  ?? '',
        email: ind.email ?? '',
        dobYear:  ind.dob?.year  ? String(ind.dob.year)  : '',
        dobMonth: ind.dob?.month ? String(ind.dob.month).padStart(2, '0') : '',
        dobDay:   ind.dob?.day   ? String(ind.dob.day).padStart(2, '0')   : '',
        postalCode: ind.address_kanji?.postal_code ?? '',
        stateKanji: ind.address_kanji?.state ?? '',
        cityKanji:  ind.address_kanji?.city  ?? '',
        townKanji:  ind.address_kanji?.town  ?? '',
        line1Kanji: (() => {
          // Stripe の line1 = "市区町村 町名・番地 [建物名]" で送信しているため
          // 読み戻す際は city + town の繰り返しプレフィックスをすべて除去して建物名のみ返す
          let v = ind.address_kanji?.line1 ?? '';
          const city = ind.address_kanji?.city ?? '';
          const town = ind.address_kanji?.town ?? '';
          // 繰り返し含む "高槻市 上土室 高槻市 上土室..." を全て除去するためwhileループ使用
          let prev = '';
          while (v !== prev) {
            prev = v;
            if (city && v.startsWith(city)) v = v.slice(city.length).trimStart();
            if (town && v.startsWith(town)) v = v.slice(town.length).trimStart();
          }
          return v;
        })(),
        stateKana:  ind.address_kana?.state  ?? '',
        cityKana:   ind.address_kana?.city   ?? '',
        townKana:   ind.address_kana?.town   ?? '',
        line1Kana: (() => {
          let v = ind.address_kana?.line1 ?? '';
          const city = ind.address_kana?.city ?? '';
          const town = ind.address_kana?.town ?? '';
          let prev = '';
          while (v !== prev) {
            prev = v;
            if (city && v.startsWith(city)) v = v.slice(city.length).trimStart();
            if (town && v.startsWith(town)) v = v.slice(town.length).trimStart();
          }
          return v;
        })(),
        phone: (() => {
          // Stripe は +81XXXXXXXXX 形式で保存。日本のフォーム用に 0XX 形式に変換
          const raw = ind.phone ?? '';
          return raw.startsWith('+81') ? '0' + raw.slice(3) : raw;
        })(),
      } : null,
      company: account.business_type === 'company' ? {
        nameKanji: (account as any).company?.name_kanji ?? '',
        nameKana:  (account as any).company?.name_kana  ?? '',
        taxId:     '',
        structure: (account as any).company?.structure  ?? '',
      } : null,
      business: {
        productDescription: biz?.product_description ?? biz?.name ?? '',
        url: biz?.url ?? '',
      },
      bankAccount,
      // ★ 2026-08-05 診断ログ: 「生年月日だけ再入力フォームに引き継がれない」調査用。
      //   値そのものは出さず、Stripeが返してきたか(有無)と除外条件だけを記録する。
      _dobDiag: (() => {
        console.log(
          `[account-data] storeId=${storeId} dob present y/m/d=` +
          `${ind?.dob?.year != null}/${ind?.dob?.month != null}/${ind?.dob?.day != null} ` +
          `currently_due=[${(account.requirements?.currently_due ?? []).join(",")}] ` +
          `err_reqs=[${(account.requirements?.errors ?? []).map((e: any) => e.requirement).join(",")}]`,
        );
        return undefined;
      })(),
      // 不備フィールド（フロント側でこれらは空欄にする）
      rejectedFields: [
        ...(account.requirements?.currently_due  ?? []),
        ...(account.requirements?.errors?.map((e: any) => e.requirement) ?? []),
      ],
    });
  } catch (err: any) {
    if (err?.code === "account_invalid" || err?.statusCode === 404) {
      return res.json({ hasAccount: false });
    }
    console.error("[account-data] error:", err?.message);
    res.status(500).json({ error: "stripe_error" });
  }
});

// ─── Stripe アカウント切断（再連携用） ────────────────────────────────────────
// POST /api/stores/:storeId/stripe-disconnect
// stripeAccountId を NULL にリセットして、オーナーが新しい口座で再連携できるようにする
router.post("/stores/:storeId/stripe-disconnect", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) return res.status(400).json({ error: "bad_request" });

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) return res.status(404).json({ error: "not_found" });

    // DB のみリセット（既存の Stripe アカウントはそのまま残す）
    await db.update(storesTable)
      .set({ stripeAccountId: null } as any)
      .where(eq(storesTable.id, storeId));

    res.json({ ok: true, message: "Stripe account disconnected. Please reconnect." });
  } catch (err: any) {
    console.error("[stripe-disconnect] error:", err?.message);
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── Stripe 強制再同期 ────────────────────────────────────────────────────────
// POST /api/stores/:storeId/stripe-sync
// Stripe API から最新ステータスを取得して DB を上書きする（管理者・オーナー両用）
router.post("/stores/:storeId/stripe-sync", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      return res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
    }

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      return res.status(404).json({ error: "not_found", message: "Store not found" });
    }

    if (!store.stripeAccountId) {
      return res.json({
        synced: false,
        reason: "no_stripe_account",
        stripeAccountId: null,
        chargesEnabled: null,
        payoutsEnabled: null,
      });
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      return res.status(500).json({ error: "config_error", message: "Stripe not configured" });
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    let chargesEnabled = false;
    let payoutsEnabled = false;
    let detailsSubmitted = false;
    let licenseFileId: string | null = null;
    let stripeError: string | null = null;
    let requirements: any = null;

    try {
      const account = await stripe.accounts.retrieve(store.stripeAccountId);
      chargesEnabled    = account.charges_enabled ?? false;
      payoutsEnabled    = account.payouts_enabled ?? false;
      detailsSubmitted  = account.details_submitted ?? false;
      requirements      = {
        currentlyDue:        account.requirements?.currently_due ?? [],
        eventuallyDue:       account.requirements?.eventually_due ?? [],
        errors:              account.requirements?.errors ?? [],
        disabledReason:      account.requirements?.disabled_reason ?? null,
        pendingVerification: account.requirements?.pending_verification ?? [],
      };

      // Stripe メタデータから license_file_id を取得
      const metaFileId = (account.metadata as any)?.license_file_id;
      if (metaFileId?.startsWith?.("file_")) {
        licenseFileId = metaFileId;
      }

      console.log(`[stripe-sync] storeId=${storeId} accountId=${store.stripeAccountId} charges=${chargesEnabled} payouts=${payoutsEnabled} details=${detailsSubmitted} licenseFileId=${licenseFileId}`);
    } catch (stripeErr: any) {
      // account_invalid = アカウントが存在しない or このキーからアクセス不可
      stripeError = stripeErr?.code ?? stripeErr?.type ?? "stripe_error";
      console.warn(`[stripe-sync] Stripe error for storeId=${storeId} accountId=${store.stripeAccountId}:`, stripeErr?.message);
    }

    // DB に最新値を書き込む（エラー時はフラグのみリセット）
    const dbPatch: Record<string, any> = {
      stripeChargesEnabled: stripeError ? false : chargesEnabled,
      stripePayoutsEnabled: stripeError ? false : payoutsEnabled,
    };
    if (!stripeError && licenseFileId) {
      (dbPatch as any).stripeLicenseFileId = licenseFileId;
    }
    // payouts_enabled = true なら Stripe が KYC 完了済みなので
    // 許可証アップロード失敗フラグを自動クリアする
    if (!stripeError && payoutsEnabled) {
      (dbPatch as any).licenseUploadFailed = false;
      (dbPatch as any).licenseUploadError = null;
    }
    await db
      .update(storesTable)
      .set(dbPatch as any)
      .where(eq(storesTable.id, storeId));

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
    console.error("[stripe-sync] error:", err?.message);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ─── Stripe Account Link（インクリメンタル認証）──────────────────────────────
// POST /api/stores/:storeId/connect/account-link
// requirements.currently_due を確認し、不足情報だけを補完するためのStripe管理ページURLを生成する
router.post("/stores/:storeId/connect/account-link", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const { returnUrl, refreshUrl, full } = req.body as { returnUrl?: string; refreshUrl?: string; full?: boolean };

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }

    if (!store.stripeAccountId) {
      res.status(400).json({ error: "no_stripe_account", message: "Stripe account not connected" });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.status(503).json({ error: "stripe_not_configured", message: "Stripe is not configured" });
      return;
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // アカウント情報と不足要件を取得
    const account = await stripe.accounts.retrieve(store.stripeAccountId);
    const currentlyDue = account.requirements?.currently_due ?? [];

    // currently_due があれば account_update（差分更新）、なければ account_onboarding
    // ★ リンク種別の選択 (2026-08-04 実挙動にもとづき確定):
    //   account_update     = 全項目フォーム。**前回入力した値が埋まった状態**で開き、
    //                        不足・不備の欄だけ空 or 要修正になる。最後に一括送信。
    //   account_onboarding = 不足項目だけを順に聞く差分ウィザード。
    //
    //   一度でも登録を終えた店 (details_submitted) には **必ず account_update** を使う。
    //   理由: 生年月日や氏名を打ち間違えている店では Stripe の要求が
    //   「本人確認書類を出せ」だけになることがあり、差分ウィザードには
    //   生年月日の欄が無いため、正しい書類を出しても登録値と一致せず
    //   却下 → 再提出 → 却下 … と抜け出せなくなる。全項目フォームなら
    //   店主が自分で登録値の誤りを見つけて直せる。
    //   (full:true が来た場合も同じく全項目フォームを開く)
    //
    //   まだ登録を終えていない店だけ account_onboarding (初回の案内フロー)。
    const linkType: "account_onboarding" | "account_update" =
      account.details_submitted || full === true
        ? "account_update"
        : "account_onboarding";

    // URLのデフォルト値（フロントエンドから渡せる）
    const baseUrl = returnUrl?.replace(/\/(stripe-kyc.*|store\/.*)$/, '') ?? "https://osusowakejapan.org";
    const safeReturnUrl  = returnUrl  ?? `${baseUrl}/store/dashboard`;
    const safeRefreshUrl = refreshUrl ?? `${baseUrl}/store/dashboard`;

    const accountLink = await stripe.accountLinks.create({
      account: store.stripeAccountId,
      return_url:  safeReturnUrl,
      refresh_url: safeRefreshUrl,
      type: linkType,
    });

    console.log(
      `[AccountLink] storeId=${storeId} type=${linkType} ` +
      `currently_due=${JSON.stringify(currentlyDue)} url=${accountLink.url}`
    );

    res.json({
      url:          accountLink.url,
      type:         linkType,
      currentlyDue,
      requirements: {
        currentlyDue,
        eventuallyDue:      account.requirements?.eventually_due ?? [],
        errors:             account.requirements?.errors ?? [],
        pendingVerification:account.requirements?.pending_verification ?? [],
        disabledReason:     account.requirements?.disabled_reason ?? null,
      },
    });
  } catch (err: any) {
    console.error("Stripe Account Link error:", err);
    // ★ 恒久却下(rejected.*)のアカウントは Stripe が account link の発行を拒否する。
    //   英語の生エラーを店主に見せても詰むため、日本語でサポート導線を返す。
    const raw = String(err?.message ?? "");
    if (/rejected/i.test(raw)) {
      return res.status(409).json({
        error: "account_rejected",
        message:
          "このアカウントはStripeの審査で受付できない状態になっており、アプリ内での再提出ができません。" +
          "LINEサポートへご連絡ください（別アカウントでの再登録をご案内します）。",
      });
    }
    res.status(500).json({
      error: "stripe_error",
      message: "修正ページを開けませんでした。時間をおいて再度お試しください。解決しない場合はLINEサポートへご連絡ください。",
    });
  }
});

// ─── Stripe 残高・ペイアウト情報 ─────────────────────────────────────────────
// GET /api/stores/:storeId/connect/balance
router.get("/stores/:storeId/connect/balance", requireAuth, requireStoreOwner, async (req, res) => {
  const storeId = parseInt(String(req.params.storeId));
  if (isNaN(storeId)) return res.status(400).json({ error: "bad_request" });

  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!stripeKey) return res.status(503).json({ error: "stripe_not_configured" });

  const [store] = await db
    .select({ stripeAccountId: storesTable.stripeAccountId })
    .from(storesTable)
    .where(eq(storesTable.id, storeId));

  if (!store?.stripeAccountId) {
    return res.json({ connected: false, pending: 0, available: 0, payoutSchedule: null, nextPayoutDate: null });
  }

  try {
    const stripe = await import("stripe").then((m) => new m.default(stripeKey));
    // ※ クロージャ内で型ナローイングが効かないので、ローカル const に抽出する
    const stripeAccountId: string = store.stripeAccountId;

    // ── 並列ブロック1: balance / account / transfers / payouts を全部同時に投げる ──
    // 元々は順次 + N+1 だったので体感5〜10倍速くなる（Stripe は同時接続を許容する）
    const [balance, account, txfListResult, payoutListResult] = await Promise.all([
      stripe.balance.retrieve({ stripeAccount: stripeAccountId }),
      stripe.accounts.retrieve(stripeAccountId),
      stripe.transfers.list({ destination: stripeAccountId, limit: 5 }).catch(() => null),
      stripe.payouts.list(
        { limit: 5 },
        { stripeAccount: stripeAccountId }
      ).catch(() => null),
    ]);

    const rawPending   = balance.pending.reduce((s, b) => s + b.amount, 0);
    const rawAvailable = balance.available.reduce((s, b) => s + b.amount, 0);
    // ★ 送金中ペイアウト等で Stripe は pending をマイナス計上することがある（available と相殺され
    //   net = available + pending が実際の手元残高）。 そのまま出すと店主に「保留中 ¥-1,391」と
    //   負の数が見えて誤解を招く。 負の pending を available に反映し、 表示は 0 未満にしない。
    //   （例: pending=-1391, available=1391 → 保留中¥0 / 振込可能¥0、 送金中¥1,391は履歴で表示）
    const pending   = Math.max(0, rawPending);
    const available = Math.max(0, rawAvailable + Math.min(0, rawPending));

    // 次回ペイアウト日を計算
    const schedule = (account.settings as any)?.payouts?.schedule as {
      interval: string; weekly_anchor?: string; monthly_anchor?: number; delay_days?: number;
    } | null;

    // Stripe JP は決済から7日間の保留期間がある（schedule.delay_days は payout 設定値で別物）
    // balance transactions の available_on から実際の保留日数・振込可能日を取得する
    let actualDelayDays = 7; // JP Stripe default = 7 calendar days
    let pendingAvailableOn: Date | null = null;

    // ── 並列ブロック2: balanceTransactions.list + 各 transfer の balanceTransactions.retrieve ──
    // pending balance の available_on と、各 transfer の available_on を同時に取得する
    const balanceTxPromise = pending > 0
      ? stripe.balanceTransactions.list(
          { limit: 20 },
          { stripeAccount: stripeAccountId }
        ).catch(() => null)
      : Promise.resolve(null);

    const transferBtPromises = (txfListResult?.data ?? []).map(async (t) => {
      let availOn: string | null = null;
      try {
        if (t.balance_transaction) {
          const btId: string = typeof t.balance_transaction === "string" ? t.balance_transaction : (t.balance_transaction as any).id;
          const bt = await stripe.balanceTransactions.retrieve(btId, { stripeAccount: stripeAccountId });
          availOn = bt.available_on ? new Date(bt.available_on * 1000).toISOString().slice(0, 10) : null;
        }
      } catch { /* 取得失敗は無視 */ }
      return {
        id:          t.id,
        amount:      t.amount,
        createdDate: new Date(t.created * 1000).toISOString().slice(0, 10),
        available_on: availOn,
      };
    });

    const [txList, platformTransfers] = await Promise.all([
      balanceTxPromise,
      Promise.all(transferBtPromises),
    ]);

    if (txList) {
      for (const tx of txList.data) {
        if (!tx.available_on) continue;
        // payment / transfer いずれも対象
        if (tx.type !== "payment" && tx.type !== "transfer" && tx.type !== "payout") continue;
        const d = new Date(tx.available_on * 1000);
        if (!pendingAvailableOn || d > pendingAvailableOn) pendingAvailableOn = d;
        if (tx.created) {
          const days = Math.round((tx.available_on - tx.created) / 86400);
          if (days > 0) actualDelayDays = days;
        }
      }
    }

    // 基準日：pending のみなら available_on（Stripe実測値）、それ以外は今日
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
    const baseDate = (pending > 0 && available === 0 && pendingAvailableOn)
      ? new Date(pendingAvailableOn.getTime() + 9 * 60 * 60 * 1000) // available_on → JST
      : (pending > 0 && available === 0)
        ? new Date(now.getTime() + actualDelayDays * 24 * 60 * 60 * 1000) // fallback
        : now;

    let nextPayoutDate: string | null = null;
    if (schedule?.interval === "weekly" && schedule.weekly_anchor) {
      const dayMap: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
      const anchor    = dayMap[schedule.weekly_anchor] ?? 1;
      const baseDay   = baseDate.getDay();
      let diff        = anchor - baseDay;
      if (diff <= 0) diff += 7;
      const next = new Date(baseDate.getTime() + diff * 24 * 60 * 60 * 1000);
      nextPayoutDate = next.toISOString().slice(0, 10);
    } else if (schedule?.interval === "monthly" && schedule.monthly_anchor) {
      const year   = baseDate.getFullYear();
      const month  = baseDate.getMonth();
      const day    = baseDate.getDate();
      const anchor = schedule.monthly_anchor;
      // ★ ここは日付ベース比較にする (旧: epoch 比較) 。
      //   baseDate は JST +9h シフト epoch。 一方 new Date(y,m,d) はサーバ TZ (UTC) の
      //   Y-M-D 00:00 epoch。 epoch 直接比較すると JST anchor日 00:00 の瞬間から
      //   `next < baseDate` になり anchor 日当日ずっと翌月にドリフトする。
      //   例: JST 7/25 00:00 → baseDate epoch=UTC 7/24 15:00、 next epoch=UTC 7/25 00:00
      //       → next < baseDate ではないが、 実測では baseDate は +9h されて
      //       UTC 上は7/25 15:00 相当になり next(UTC 7/25 00:00) < baseDate → 翌月へ。
      //   → anchor 日 (JST) 当日は当月 anchor をキープしたい。
      const advance = day > anchor;
      const next = advance
        ? new Date(year, month + 1, anchor)
        : new Date(year, month, anchor);
      // toISOString ではなく手動フォーマット (サーバ TZ が UTC で
      //   new Date(y,m,d) は UTC 0:00 → toISOString でそのまま同日なので実害はないが、
      //   将来 TZ 変わった時に off-by-one を避けるため明示化)。
      const y2 = next.getFullYear();
      const m2 = String(next.getMonth() + 1).padStart(2, "0");
      const d2 = String(next.getDate()).padStart(2, "0");
      nextPayoutDate = `${y2}-${m2}-${d2}`;
    }

    // 最近の振込履歴（最大5件）— 並列ブロック1で取得済みの結果を流用
    const recentPayouts: Array<{ id: string; amount: number; arrivalDate: string; status: string }> =
      (payoutListResult?.data ?? []).map((p) => ({
        id:          p.id,
        amount:      p.amount,
        arrivalDate: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
        status:      p.status, // paid / pending / in_transit / canceled / failed
      }));

    res.json({
      connected:     true,
      accountId:     store.stripeAccountId,
      pending,
      available,
      currency:      "jpy",
      payoutsEnabled: account.payouts_enabled,
      chargesEnabled: account.charges_enabled,
      payoutSchedule: schedule,
      nextPayoutDate,
      delayDays:     actualDelayDays,
      recentPayouts,
      platformTransfers,
    });
  } catch (err: any) {
    console.error("[balance] error:", err?.message);
    res.status(500).json({ error: "stripe_error", message: err?.message });
  }
});

// ─── Stripe KYC 情報送信 ────────────────────────────────────────────────────
// PUT /api/stores/:storeId/connect/kyc
// 代表者情報・事業形態・事業内容を Stripe Account Update API に送信する
router.put("/stores/:storeId/connect/kyc", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    const { businessType, companyNameKanji, companyNameKana, companyStructure, representative, businessProfile } = req.body as {
      businessType: "individual" | "company";
      companyNameKanji?: string;
      companyNameKana?: string;
      companyStructure?: string;
      representative: {
        firstNameKanji: string;
        lastNameKanji: string;
        firstNameKana: string;
        lastNameKana: string;
        dobYear: number;
        dobMonth: number;
        dobDay: number;
        postalCode: string;
        stateKanji: string;
        cityKanji: string;
        townKanji: string;
        line1Kanji?: string;
        stateKana: string;
        cityKana: string;
        townKana: string;
        line1Kana?: string;
        phone?: string;
        email?: string;
      };
      businessProfile: {
        productDescription?: string;
        url?: string;
      };
    };

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.status(503).json({ error: "stripe_not_configured", message: "Stripe が設定されていません" });
      return;
    }

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });
      return;
    }

    if (!store.stripeAccountId) {
      res.status(400).json({ error: "no_stripe_account", message: "先に振込先口座を登録してください" });
      return;
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // ── Stripe アカウントの実際の business_type を取得して整合性チェック ──
    // フォームの businessType と Stripe 側が食い違う場合は Stripe 側を優先する
    // （フォームが company でも Stripe が individual なら individual パスで送る）
    let resolvedBusinessType: "individual" | "company" = businessType;
    try {
      const existingAcc = await stripe.accounts.retrieve(store.stripeAccountId);
      const stripeActualType = existingAcc.business_type as "individual" | "company" | undefined;
      if (stripeActualType && stripeActualType !== businessType) {
        console.warn(
          `[KYC] business_type mismatch — form: ${businessType}, Stripe: ${stripeActualType} → using Stripe value`
        );
        resolvedBusinessType = stripeActualType;
      }
    } catch (_) {
      // 取得失敗時はフォームの値をそのまま使用
    }

    // ── 住所を Stripe JP 仕様に正規化（半角カナ→全角カナ、町名から番地を分離）──
    const jpAddrKyc = buildJpAddress({
      postalCode: representative.postalCode,
      stateKanji: representative.stateKanji, cityKanji: representative.cityKanji,
      townKanji:  representative.townKanji,  line1Kanji: representative.line1Kanji ?? '',
      stateKana:  representative.stateKana,  cityKana:  representative.cityKana,
      townKana:   representative.townKana,   line1Kana:  representative.line1Kana  ?? '',
    });
    const addressKanji = jpAddrKyc.address_kanji;
    const addressKana  = jpAddrKyc.address_kana;

    // ── 標準住所（kanji/kana と並列で送信） ──
    const addressStandard: Record<string, string> = {
      postal_code: addressKanji.postal_code,
      country:     "JP",
      state:       addressKanji.state,
      city:        addressKanji.city,
      line1:       addressKanji.line1,
    };

    // ── 事業内容 ──
    const businessProfileUpdate: Record<string, string> = { mcc: "5812" };
    if (businessProfile.productDescription) {
      businessProfileUpdate["product_description"] = businessProfile.productDescription;
    }
    if (businessProfile.url) {
      businessProfileUpdate["url"] = businessProfile.url;
    }
    // 法人の場合は business_profile.name（ビジネス名）を設定する
    if (resolvedBusinessType === "company" && companyNameKanji?.trim()) {
      businessProfileUpdate["name"] = companyNameKanji.trim();
    }

    // ── Stripe Account Update パラメータを構築（部分更新 — 空フィールドは完全に除外）──
    const updateParams: Record<string, any> = {
      business_type:    resolvedBusinessType,
      business_profile: businessProfileUpdate,
    };

    // 法人代表者用: スコープを if-else の外に宣言して後続の Persons API で使えるようにする
    let repPersonPayload: Record<string, any> | null = null;

    if (resolvedBusinessType === "individual") {
      const indiv: Record<string, any> = {};
      // JP では first_name/last_name（Latin）は不要。kana/kanji のみ送る
      if (representative.firstNameKana?.trim())  indiv.first_name_kana  = toFullWidthKana(representative.firstNameKana);
      if (representative.lastNameKana?.trim())   indiv.last_name_kana   = toFullWidthKana(representative.lastNameKana);
      if (representative.firstNameKanji?.trim()) indiv.first_name_kanji = representative.firstNameKanji;
      if (representative.lastNameKanji?.trim())  indiv.last_name_kanji  = representative.lastNameKanji;
      // 生年月日（全フィールド揃っている場合のみ）
      if (representative.dobDay && representative.dobMonth && representative.dobYear) {
        indiv.dob = {
          day:   Number(representative.dobDay),
          month: Number(representative.dobMonth),
          year:  Number(representative.dobYear),
        };
      }
      // 住所: JP では address（標準）は送らず address_kana / address_kanji のみ
      if (representative.postalCode?.trim()) {
        indiv.address_kanji = addressKanji;
        indiv.address_kana  = addressKana;
      }
      if (representative.phone?.trim()) indiv.phone = toE164Japan(representative.phone);
      if (representative.email?.trim()) indiv.email = representative.email;
      // JP 個人事業主: 政治的関与は常に送信。id_number はテストモード専用の偽値のみ
      const isTestKeyKyc = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      if (isTestKeyKyc) indiv.id_number = "000000000000";
      indiv.political_exposure = "none";

      if (Object.keys(indiv).length > 0) updateParams["individual"] = indiv;
    } else {
      // company: 会社情報 + 代表者情報
      const companyObj: Record<string, any> = {};
      // 法人名マッピング（JP Stripe）:
      //   name_kanji = 漢字法人名（必須）  /  name_kana = カナ（必須）  /  name = ローマ字（任意）
      if (companyNameKanji?.trim()) companyObj.name_kanji = companyNameKanji.trim();
      if (companyNameKana?.trim())  companyObj.name_kana  = toFullWidthKana(companyNameKana.trim());
      // ⚠️ JP では company.structure を送ると全値エラーになるため送らない
      // JP では address（標準）は送らず address_kana / address_kanji のみ
      if (representative.postalCode?.trim()) {
        companyObj.address_kanji = addressKanji;
        companyObj.address_kana  = addressKana;
      }
      if (representative.phone?.trim()) companyObj.phone = toE164Japan(representative.phone);
      if (Object.keys(companyObj).length > 0) updateParams["company"] = companyObj;

      // 代表者データを repPersonPayload に構築（スコープを外に出す）
      const repData: Record<string, any> = {};
      // JP では rep.first_name/last_name（Latin）は不要。kana/kanji のみ
      if (representative.firstNameKana?.trim())  repData.first_name_kana  = toFullWidthKana(representative.firstNameKana);
      if (representative.lastNameKana?.trim())   repData.last_name_kana   = toFullWidthKana(representative.lastNameKana);
      if (representative.firstNameKanji?.trim()) repData.first_name_kanji = representative.firstNameKanji;
      if (representative.lastNameKanji?.trim())  repData.last_name_kanji  = representative.lastNameKanji;
      if (representative.dobDay && representative.dobMonth && representative.dobYear) {
        repData.dob = {
          day:   Number(representative.dobDay),
          month: Number(representative.dobMonth),
          year:  Number(representative.dobYear),
        };
      }
      // JP では address（標準）は送らず address_kana / address_kanji のみ
      if (representative.postalCode?.trim()) {
        repData.address_kanji = addressKanji;
        repData.address_kana  = addressKana;
      }
      if (representative.phone?.trim()) repData.phone = toE164Japan(representative.phone);
      if (representative.email?.trim()) repData.email = representative.email;
      // ⚠️ title は relationship の中に入れる（Stripe JP 仕様）
      repData.relationship = {
        representative: true,
        director: true,      // JP 法人では director: true が必須
        executive: true,
        owner: true,
        percent_ownership: 100,
        title: (representative as any).title?.trim() || "代表取締役",
      };
      // ⚠️ accounts.update は "representative" パラメータを受け付けない（Stripe JP）
      // → accounts.update の後に Persons API で登録する
      repPersonPayload = repData;
    }

    // ── Stripe 送信直前のペイロードをフルログ（null/空がないか確認）──
    // ★ 個人情報(氏名/生年月日/住所/電話)はログに出さない。送る項目名だけ (2026-10-03 方針)
    const kycKeys = Object.entries(updateParams).map(([k, v]) =>
      (v && typeof v === 'object' && !Array.isArray(v)) ? `${k}{${Object.keys(v).join(',')}}` : k).join(' ');
    console.log(`📤 [KYC] Stripe accounts.update fields for account ${store.stripeAccountId}: ${kycKeys}`);

    const account = await stripe.accounts.update(store.stripeAccountId, updateParams as any);

    // ── 法人代表者を Persons API で登録/更新（accounts.update では設定不可）──
    if (resolvedBusinessType === 'company' && repPersonPayload !== null) {
      try {
        const kyc_existingPersons = await stripe.accounts.listPersons(store.stripeAccountId, { limit: 20 });
        const kyc_existing = kyc_existingPersons.data.find(p => p.relationship?.representative);
        // 口座登録で「担当者は取締役ではない」として取締役を別に登録したお店は、
        //   再提出で担当者を取締役・オーナーに戻さない（役職だけ更新する）。
        const hasSeparateDirector = kyc_existingPersons.data.some(p => p.relationship?.director && !p.relationship?.representative);
        //   この画面(/store/kyc)は役職を送らないので、 役職は口座登録で入れたもの(店長など)をそのまま残す。
        if (hasSeparateDirector && repPersonPayload.relationship) {
          repPersonPayload.relationship = {
            representative: true,
            title: (representative as any).title?.trim() || kyc_existing?.relationship?.title || "担当者",
          };
        }
        if (kyc_existing) {
          await stripe.accounts.updatePerson(store.stripeAccountId, kyc_existing.id, repPersonPayload as any);
          console.log(`[KYC] Persons.update done — ${kyc_existing.id}`);
        } else {
          const np = await stripe.accounts.createPerson(store.stripeAccountId, repPersonPayload as any);
          console.log(`[KYC] Persons.create done — ${np.id}`);
        }
      } catch (perr: any) {
        console.error("[KYC] Persons API error (non-fatal):", perr?.message ?? perr);
      }
    }

    // ── Stripe レスポンスをフルログ ──
    console.log(`✅ [KYC] Stripe accounts.update succeeded for store ${storeId}`);
    console.log(`   charges_enabled:  ${account.charges_enabled}`);
    console.log(`   payouts_enabled:  ${account.payouts_enabled}`);
    console.log(`   details_submitted: ${account.details_submitted}`);
    console.log(`   requirements.currently_due:  ${JSON.stringify(account.requirements?.currently_due)}`);
    console.log(`   requirements.eventually_due: ${JSON.stringify(account.requirements?.eventually_due)}`);
    console.log(`   requirements.errors:         ${JSON.stringify(account.requirements?.errors)}`);
    console.log(`   requirements.disabled_reason: ${account.requirements?.disabled_reason}`);

    // currently_due が空 = Stripe への必須送信フィールドがすべて揃った
    // KYC フォーム送信が成功した時点（Stripe がエラーを返さなかった時点）で
    // DB ステータスを 'applied' に進める。
    // pending のまま放置すると「本人確認が必要」が申請直後も出続けるため、
    // currently_due の残有無に関わらず常に applied へ移行する。
    const eventuallyDue = account.requirements?.eventually_due ?? [];
    const currentlyDue  = account.requirements?.currently_due ?? [];
    const kycComplete   = currentlyDue.length === 0;   // currently_due 空 = 送信完了

    // charges_enabled を DB に保存（有効/制限中の区別を管理画面に反映）
    await db
      .update(storesTable)
      .set({ stripeChargesEnabled: account.charges_enabled })
      .where(eq(storesTable.id, storeId));

    // ★ 自動承認は「Stripeが完全にOK = 決済◯かつ入金◯」の時だけ（2026-08-04厳格化）。
    //   charges_enabled 単独では承認しない（入金停止のままマップ公開される事故の防止）。
    let kycAutoApproved = false;
    if (account.charges_enabled && account.payouts_enabled) {
      try {
        const settingRows = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified'`);
        const settingVal = (settingRows.rows[0] as any)?.value ?? 'true';
        if (settingVal !== 'false') kycAutoApproved = true;
      } catch (_) {
        kycAutoApproved = true; // 完全体確認済みならDB読み込みエラー時も承認してよい
      }
    }

    // KYC送信成功 → 常に pending → applied（or approved）へ進める
    // ただし既に approved/pending_review の場合はダウングレードしない
    const [currentStore] = await db
      .select({ status: storesTable.status })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));
    const shouldUpgrade = !["approved", "pending_review"].includes(currentStore?.status ?? "");
    if (shouldUpgrade) {
      const newStatus = kycAutoApproved ? "approved" : "applied";
      await db
        .update(storesTable)
        .set({ status: newStatus, isActive: kycAutoApproved ? true : undefined })
        .where(eq(storesTable.id, storeId));
      console.log(
        `✅ Store ${storeId} status → '${newStatus}' (KYC submitted, currently_due: ${currentlyDue.length} 件)` +
        (eventuallyDue.length > 0 ? ` (eventually_due ${eventuallyDue.length} 件残)` : "")
      );
    }

    res.json({
      success: true,
      kycComplete,
      storeStatus: kycComplete ? "applied" : "applied",
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: {
        currentlyDue:        currentlyDue,
        eventuallyDue:       eventuallyDue,
        errors:              account.requirements?.errors ?? [],
        pendingVerification: account.requirements?.pending_verification ?? [],
        disabledReason:      account.requirements?.disabled_reason ?? null,
      },
    });
  } catch (err: any) {
    console.error("❌ [KYC] Stripe accounts.update FAILED:");
    console.error("   type:      ", err?.type);
    console.error("   code:      ", err?.raw?.code ?? err?.code);
    console.error("   param:     ", err?.raw?.param ?? err?.param);
    console.error("   message:   ", err?.raw?.message ?? err?.message);
    console.error("   statusCode:", err?.statusCode);
    console.error("   raw error: ", JSON.stringify(err?.raw ?? {}, null, 2));
    res.status(500).json({
      error: "stripe_error",
      message: err?.raw?.message ?? err?.message ?? "KYC情報の送信に失敗しました",
      param: err?.raw?.param ?? null,
      stripeCode: err?.raw?.code ?? null,
      stripeType: err?.type ?? null,
    });
  }
});

// ─── Stripe 本人確認書類アップロード ─────────────────────────────────────────
// POST /api/stores/:storeId/connect/kyc-document
// 1. base64 画像を Stripe Files API (purpose=identity_document) にアップロード
// 2. 取得した fileId を individual.verification.document.front/back にセット
// 3. requirements が完全にゼロになれば DB を 'approved' に更新
router.post("/stores/:storeId/connect/kyc-document", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    const { imageBase64, mimeType, side } = req.body as {
      imageBase64: string;          // "data:image/jpeg;base64,..." or raw base64
      mimeType: string;             // "image/jpeg" | "image/png"
      side: "front" | "back";
    };

    if (!imageBase64 || !mimeType || !side) {
      res.status(400).json({ error: "bad_request", message: "imageBase64, mimeType, side は必須です" });
      return;
    }
    if (side !== "front" && side !== "back") {
      res.status(400).json({ error: "bad_request", message: "side は 'front' または 'back' のみ有効です" });
      return;
    }

    // ── 店舗取得 ──
    const [store] = await db.select().from(storesTable).where(eq(storesTable.id, storeId)).limit(1);
    if (!store) {
      res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });
      return;
    }
    if (!store.stripeAccountId) {
      res.status(400).json({ error: "no_stripe_account", message: "Stripeアカウントが未設定です。先に口座登録を行ってください。" });
      return;
    }

    // ── Stripe キー取得 ──
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      res.status(500).json({ error: "config_error", message: "Stripe設定が不足しています" });
      return;
    }
    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // ── base64 → Buffer 変換 ──
    const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const fileName = `identity_document_${side}.${ext}`;

    console.log(`📤 [KYC-DOC] Uploading ${side} document to Stripe Files for account ${store.stripeAccountId} (${(buffer.length / 1024).toFixed(1)} KB)`);

    // ── Stripe Files API にアップロード ──
    const file = await stripe.files.create({
      purpose: "identity_document",
      file: {
        data:    buffer,
        name:    fileName,
        type:    mimeType as "image/jpeg" | "image/png",
      },
    });
    console.log(`✅ [KYC-DOC] Stripe file created: ${file.id} (${file.filename})`);

    // ── business_type を確認して verification の送信先を決める ──
    // 個人事業主: individual.verification.document → accounts.update({ individual })
    // 法人:       代表者(Person).verification.document → accounts.updatePerson()
    //   ★ Stripe の accounts.update に `representative` というパラメータは存在しない
    //     (=旧実装は "Received unknown parameter: representative" で会社アカウントは常に失敗していた)。
    //     法人の代表者は Person オブジェクトなので、listPersons で代表者を引いて
    //     updatePerson で書類をセットしなければならない。
    const existingAccount = await stripe.accounts.retrieve(store.stripeAccountId);
    const isCompany = existingAccount.business_type === "company";

    let account: any;
    if (isCompany) {
      // 代表者 Person を特定（representative → owner → 先頭 の順でフォールバック）
      const persons = await stripe.accounts.listPersons(store.stripeAccountId, { limit: 100 });
      const rep =
        persons.data.find((p) => (p.relationship as any)?.representative) ??
        persons.data.find((p) => (p.relationship as any)?.owner) ??
        persons.data[0];
      if (!rep) {
        res.status(400).json({
          error: "no_representative",
          message: "代表者情報が未登録です。先に代表者情報を登録してから書類を再提出してください。",
        });
        return;
      }
      console.log(`📤 [KYC-DOC] Sending verification to Person ${rep.id} (representative).verification.document`);
      await stripe.accounts.updatePerson(store.stripeAccountId, rep.id, {
        verification: { document: { [side]: file.id } },
      } as any);
      // 更新後のアカウント requirements を取り直す
      account = await stripe.accounts.retrieve(store.stripeAccountId);
    } else {
      console.log(`📤 [KYC-DOC] Sending verification to individual.verification.document`);
      account = await stripe.accounts.update(store.stripeAccountId, {
        individual: { verification: { document: { [side]: file.id } } },
      } as any);
    }

    console.log(`✅ [KYC-DOC] verification.document set succeeded for store ${storeId}`);
    console.log(`   requirements.currently_due:  ${JSON.stringify(account.requirements?.currently_due)}`);
    console.log(`   requirements.eventually_due: ${JSON.stringify(account.requirements?.eventually_due)}`);
    console.log(`   requirements.pending_verification: ${JSON.stringify(account.requirements?.pending_verification)}`);

    // ── currently_due が空になっても 'applied' のまま。承認は管理者が手動で行う ──
    const currentlyDue  = account.requirements?.currently_due  ?? [];
    const eventuallyDue = account.requirements?.eventually_due ?? [];
    const pendingVer    = account.requirements?.pending_verification ?? [];
    const kycComplete   = currentlyDue.length === 0;

    if (kycComplete) {
      await db
        .update(storesTable)
        .set({ status: "applied", stripeNeedsBankReregister: false })
        .where(eq(storesTable.id, storeId));
      console.log(`✅ Store ${storeId} status → 'applied' (doc upload cleared currently_due — awaiting admin approval)`);
    }

    res.json({
      success:    true,
      fileId:     file.id,
      side,
      kycComplete,
      storeStatus: "applied",
      requirements: {
        currentlyDue,
        eventuallyDue,
        pendingVerification: pendingVer,
      },
    });
  } catch (err: any) {
    console.error("❌ [KYC-DOC] Failed:");
    console.error("   type:    ", err?.type);
    console.error("   code:    ", err?.raw?.code ?? err?.code);
    console.error("   message: ", err?.raw?.message ?? err?.message);
    console.error("   raw:     ", JSON.stringify(err?.raw ?? {}, null, 2));
    res.status(500).json({
      error:       "stripe_error",
      message:     err?.raw?.message ?? err?.message ?? "書類のアップロードに失敗しました",
      stripeCode:  err?.raw?.code ?? null,
      stripeType:  err?.type ?? null,
    });
  }
});

// ─── Stripe Custom Account 銀行口座セットアップ ───────────────────────────────
// ── 住所「町名に一致する候補が複数」エラーの自動補正ヘルパー ──────────────────
//   mokopan (2026-09-02, 個人) → 2026-09-28 法人(company)・代表者(person) にも適用拡張。
//   番地欄の先頭に書かれた「◯丁目/◯番町/◯条」を町名側へ移す（例: 日吉台 + 5番町11-1 → 日吉台5番町 + 11-1）。
function moveChomeToTown(town?: string, line1?: string): [string, string] | null {
  if (!town || !line1) return null;
  const m = line1.match(/^\s*([0-9０-９一二三四五六七八九十]+)\s*(丁目|番町|条|チョウメ|バンチョウ|ジョウ)\s*/);
  if (!m) return null;
  const rest = line1.slice(m[0].length).replace(/^[-ー‐−–ｰ\s]+/, '');
  if (!rest) return null;
  return [town + m[1] + m[2], rest];
}
// individual / company / person のペイロードを受け取り、address_kanji/kana の町名を補正した複製を返す。
// 補正できる形でなければ null（リトライしない）。
function retryEntityWithFixedTown<T extends Record<string, any>>(entity: T): T | null {
  const kj = moveChomeToTown(entity?.address_kanji?.town, entity?.address_kanji?.line1);
  if (!kj) return null;
  const copy: any = JSON.parse(JSON.stringify(entity));
  copy.address_kanji.town  = kj[0];
  copy.address_kanji.line1 = kj[1];
  const kn = moveChomeToTown(copy.address_kana?.town, copy.address_kana?.line1);
  if (kn) { copy.address_kana.town = kn[0]; copy.address_kana.line1 = kn[1]; }
  return copy;
}

// ── 法人番号の検査用数字 (国税庁告示の計算式) ─────────────────────────────────
//   登記簿の会社法人等番号(12桁)の先頭に付ける1桁。12桁しか手元にない店主が
//   0埋めして無効な13桁を作る事故(ConteCafe 2026-09-28)を自動変換で根絶する。
//   検証済み: トヨタ/ソフトバンク/楽天の公開法人番号で計算値が一致。
function corporateCheckDigit12(base12: string): number {
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += Number(base12[12 - n]) * (n % 2 === 1 ? 1 : 2);
  return 9 - (sum % 9);
}

// POST /api/stores/:storeId/connect/bank-setup
// STEP1-2（アカウント作成＋口座登録）を同期で実行してクライアントにレスポンスを返し、
// STEP3-5（書類アップロード＋KYC更新＋DB更新）をバックグラウンドで継続する。
// ※ 全ての変数を try 外に宣言してバックグラウンドクロージャのスコープ問題を回避する。
router.post("/stores/:storeId/connect/bank-setup", requireAuth, requireStoreOwner, async (req, res) => {
  // ── 変数を try の外側に宣言（BGクロージャがスコープを共有できるようにする）──
  const storeId = parseInt(String(req.params.storeId));
  if (isNaN(storeId)) {
    res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
    return;
  }

  const body = req.body as {
    bankToken: string | null;
    tosTimestamp: number;
    businessType?: "individual" | "company";
    kycData: {
      firstNameKanji: string; lastNameKanji: string;
      firstNameKana: string;  lastNameKana: string;
      phone: string; email?: string;
      dobYear: number; dobMonth: number; dobDay: number;
      postalCode: string;
      stateKanji: string; cityKanji: string; townKanji: string; line1Kanji?: string;
      stateKana: string;  cityKana: string;  townKana: string;  line1Kana?: string;
      productDescription?: string; businessUrl?: string;
      companyNameKanji?: string; companyNameKana?: string;
      companyNameLatin?: string; companyTaxId?: string;
      companyStructure?: string;
      representativeTitle?: string;
      // 法人で、手続きをする担当者が取締役ではない場合 false（未指定=従来どおり担当者=取締役）
      representativeIsDirector?: boolean;
      director?: {
        firstNameKanji?: string; lastNameKanji?: string;
        firstNameKana?: string;  lastNameKana?: string;
        dobYear?: number | string; dobMonth?: number | string; dobDay?: number | string;
      };
    };
    docFrontBase64: string; docFrontMime: string;
    docBackBase64?: string; docBackMime?: string;
    bizLicenseBase64?: string; bizLicenseMime?: string; bizLicenseNumber?: string;
  };

  const { bankToken, tosTimestamp, businessType = "individual", kycData, docFrontBase64, docFrontMime, docBackBase64, docBackMime, bizLicenseBase64, bizLicenseMime, bizLicenseNumber } = body;

  if (!tosTimestamp || !kycData || !docFrontBase64 || !docFrontMime) {
    res.status(400).json({ error: "bad_request", message: "tosTimestamp, kycData, docFrontBase64, docFrontMime は必須です" });
    return;
  }
  // 法人で担当者が取締役ではない場合、 本物の取締役の氏名と生年月日が要る（Stripe JP: directors は氏名＋生年月日）
  if (businessType === "company" && kycData.representativeIsDirector === false) {
    const d = kycData.director ?? {};
    const ok = [d.lastNameKanji, d.firstNameKanji, d.lastNameKana, d.firstNameKana].every((v) => typeof v === "string" && v.trim())
      && [d.dobYear, d.dobMonth, d.dobDay].every((v) => Number(v) > 0);
    if (!ok) {
      res.status(400).json({ error: "bad_request", message: "取締役（社長など）の氏名（漢字・カナ）と生年月日を入力してください" });
      return;
    }
  }

  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!stripeKey) {
    res.status(503).json({ error: "stripe_not_configured", message: "Stripe が設定されていません" });
    return;
  }

  const [store] = await db
    .select({ id: storesTable.id, stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId, status: storesTable.status, name: storesTable.name })
    .from(storesTable)
    .where(eq(storesTable.id, storeId));

  if (!store) {
    res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });
    return;
  }

  const wasRejected = store.status === "rejected";

  // ★ 営業許可証番号の重複チェック (自分自身の店舗は除外)
  //    bank-setup 経路で他店舗の番号を盗用 / 自分の別店舗の番号に書き換える攻撃を防ぐ。
  //    bizLicenseNumber が空の場合は既存値を変更しないので、 入力があった時のみ検証する。
  if (typeof bizLicenseNumber === "string" && bizLicenseNumber.trim().length > 0) {
    try {
      const licHit = await findLicenseDuplicate({
        ownerId: store.ownerId!,
        rawLicenseNumber: bizLicenseNumber,
        excludeStoreId: storeId,
      });
      if (licHit) {
        console.warn(
          `[bank-setup] 🚫 営業許可証番号 重複ブロック: storeId=${storeId} ownerId=${store.ownerId} → 既存storeId=${licHit.id} isSelf=${licHit.isSelf}`,
        );
        sendLicenseDuplicate(res, licHit);
        return;
      }
    } catch (licEx: any) {
      console.warn(`[bank-setup] 営業許可証重複チェック失敗 (申請は継続): ${licEx?.message}`);
    }
  }

  // オーナーメール取得
  let ownerEmail: string | undefined;
  if (store.ownerId) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(store.ownerId);
    ownerEmail = userData?.user?.email ?? kycData.email;
  }

  const stripe = await import("stripe").then((m) => new m.default(stripeKey));

  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.ip ?? "127.0.0.1";

  // ⚠️ Stripe business_profile.url は本番ドメインを使う（Replit dev ドメインは
  //   JCB 等カードブランド審査で「不審な URL」と判定され支払い停止になるため）
  //   normalizeBusinessUrl() がフロントの再申請ドラフト経由で送られた Replit URL も強制置換する
  const businessUrl = normalizeBusinessUrl(kycData.businessUrl);

  // タイムアウト付き Stripe ヘルパー（外側で定義して BG からも使える）
  function stripeCall<T>(promise: Promise<T>, label: string, ms = 25000): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`stripe_timeout:${label}`)), ms)
      ),
    ]);
  }

  // accountId を外側で宣言（STEP1 で値を代入、BG で参照）
  let accountId: string | null = store.stripeAccountId;

  // ── STEP 1-2: Stripe アカウント作成＋口座登録（同期） ──
  try {
    // ── 即座にステータスを書いてループを防止 ──
    // 管理者審査不要：却下済み再申請も含め常に applied へ
    const newStatus = "applied";
    await db.update(storesTable).set({
      status: newStatus,
      ...(wasRejected ? { rejectionReason: null } : {}),
      ...(bizLicenseNumber?.trim() ? { licenseNumber: bizLicenseNumber.trim() } : {}),
    }).where(eq(storesTable.id, storeId));
    console.log(`[bank-setup] ✅ Store ${storeId} status → '${newStatus}' (wasRejected=${wasRejected})`);


    // STEP 1: アカウント作成 or 更新
    if (!accountId) {
      console.log(`[bank-setup] STEP1 Creating Stripe Custom Account for store ${storeId}… businessType=${businessType}`);
      // ⚠️ business_type は accounts.create 時に設定しないと後から変更できない
      // 法人の場合は company 基本情報（name_kanji/kana）も一緒に渡す
      // ⚠️ JP では company.structure を送ると全値エラーになるため省略
      const isTestKeyStep1 = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const step1CompanyPayload: Record<string, any> = businessType === "company" ? {
        // テストモードのみ偽値フォールバックを使用。本番では必ずフォーム入力値を使う
        name_kanji: kycData.companyNameKanji?.trim() || store.name || (isTestKeyStep1 ? "株式会社テスト" : undefined),
        name_kana:  kycData.companyNameKana?.trim()  || (isTestKeyStep1 ? "テスト" : undefined),
        // company.name（ラテン文字）は Stripe JP で必須
        name: kycData.companyNameLatin?.trim() || (isTestKeyStep1 ? "Kabushiki Gaisha Test" : undefined),
      } : {};
      try {
        const account = await stripeCall(
          stripe.accounts.create(
            {
              type: "custom", country: "JP",
              business_type: businessType,
              ...(ownerEmail ? { email: ownerEmail } : {}),
              capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
              business_profile: {
                mcc: "5812",
                url: businessUrl,
                product_description: kycData.productDescription?.trim() || "食品ロス削減おすそわけサービス",
                ...(businessType === "company"
                  ? { name: kycData.companyNameKanji?.trim() || store.name || (isTestKeyStep1 ? "株式会社テスト" : undefined) }
                  : {}),
              },
              // JP では service_agreement: 'full' が必須
              tos_acceptance: { date: Math.floor(tosTimestamp / 1000), ip, service_agreement: "full" },
              // 送金スケジュール: 毎月25日 (Payout Fee 削減のため週次→月次に変更)
              settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 25 } } },
              ...(businessType === "company" ? { company: step1CompanyPayload } : {}),
            },
            { idempotencyKey: `store-${storeId}-account-create-${businessType}-${crypto.randomUUID()}` }
          ),
          "accounts.create"
        );
        accountId = account.id;
        // 同一オーナーの全店舗に stripe_account_id を伝播
        await db.update(storesTable)
          .set({ stripeAccountId: accountId })
          .where(
            store.ownerId
              ? eq(storesTable.ownerId, store.ownerId)
              : eq(storesTable.id, storeId)
          );
        console.log(`✅ [bank-setup] Stripe Account created: ${accountId} — propagated to all stores of owner ${store.ownerId} (business_type=${businessType})`);
      } catch (createErr: any) {
        const [latest] = await db.select({ stripeAccountId: storesTable.stripeAccountId }).from(storesTable).where(eq(storesTable.id, storeId));
        if (latest?.stripeAccountId) {
          accountId = latest.stripeAccountId;
          console.warn(`⚠️  [bank-setup] accounts.create failed, using existing accountId=${accountId}`);
        } else {
          throw createErr;
        }
      }
    } else {
      console.log(`[bank-setup] STEP1 Updating existing Stripe Account ${accountId}… businessType=${businessType}`);
      const isTestKeyStep1Upd = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const step1UpdPayload: Record<string, any> = {
        business_type:    businessType,
        business_profile: {
          mcc: "5812",
          url: businessUrl,
          product_description: kycData.productDescription?.trim() || "食品ロス削減おすそわけサービス",
          ...(businessType === "company"
            ? { name: kycData.companyNameKanji?.trim() || store.name || (isTestKeyStep1Upd ? "株式会社テスト" : undefined) }
            : {}),
        },
        tos_acceptance: { date: Math.floor(tosTimestamp / 1000), ip, service_agreement: "full" },
        settings:       { payouts: { schedule: { interval: "monthly", monthly_anchor: 25 } } },
      };
      if (businessType === "company") {
        // ⚠️ JP では company.structure を送ると全値エラーになるため省略
        // テストモードのみ偽値フォールバックを使用
        step1UpdPayload.company = {
          name_kanji: kycData.companyNameKanji?.trim() || store.name || (isTestKeyStep1Upd ? "株式会社テスト" : undefined),
          name_kana:  kycData.companyNameKana?.trim()  || (isTestKeyStep1Upd ? "テスト" : undefined),
        };
      }
      try {
        await stripeCall(
          stripe.accounts.update(accountId, step1UpdPayload as any),
          "accounts.update(tos+businessType)"
        );
        console.log(`✅ [bank-setup] STEP1 accounts.update(tos+businessType) succeeded`);
      } catch (updErr: any) {
        console.warn(`⚠️  [bank-setup] accounts.update(tos+businessType) failed: ${updErr.message} — continuing`);
      }
    }

    // STEP 2: 銀行口座を紐付け（口座登録済みの場合はスキップ）
    if (!bankToken) {
      console.log(`[bank-setup] STEP2 Skipped — bank account already registered for ${accountId}`);
    } else {
    console.log(`[bank-setup] STEP2 Attaching bank account to ${accountId}…`);
    try {
      await stripeCall(
        stripe.accounts.createExternalAccount(accountId!, {
          external_account: bankToken,
          default_for_currency: true,
        }),
        "createExternalAccount"
      );
      console.log(`✅ [bank-setup] Bank account attached to ${accountId}`);
    } catch (bankErr: any) {
      if (bankErr.code === "external_account_already_exists" || bankErr.message?.includes("already")) {
        console.warn(`⚠️  [bank-setup] External account already attached — skipping`);
      } else if (bankErr.message?.startsWith("stripe_timeout:")) {
        console.warn(`⚠️  [bank-setup] Bank attach timed out — continuing`);
      } else {
        throw bankErr;
      }
    }
    } // end if (bankToken)

    // ── STEP 4: KYC 更新（同期 — 代表者データを確実に Stripe に届けるため BG から移動）──
    const k = kycData;
    // 住所を Stripe JP 仕様に正規化（半角カナ→全角カナ、町名から番地を分離）
    const jpAddr = buildJpAddress({
      postalCode: k.postalCode ?? '',
      stateKanji: k.stateKanji ?? '', cityKanji: k.cityKanji ?? '', townKanji: k.townKanji ?? '', line1Kanji: k.line1Kanji ?? '',
      stateKana:  k.stateKana  ?? '', cityKana:  k.cityKana  ?? '', townKana:  k.townKana  ?? '', line1Kana:  k.line1Kana  ?? '',
    });
    // ★ 番地(line1)は自宅住所PIIのため数字をマスクしてログ出力 (2026-10-03)。
    //   町名+文字種はmokopan/ConteCafe級の住所デバッグに必須なので残す。
    const maskNum = (s: string) => (s ?? '').replace(/[0-9０-９]/g, '#');
    console.log(`[bank-setup] 住所正規化結果 — kanji.town="${jpAddr.address_kanji.town}" line1="${maskNum(jpAddr.address_kanji.line1)}" / kana.town="${jpAddr.address_kana.town}" line1="${maskNum(jpAddr.address_kana.line1)}"`);

    const indiv: Record<string, any> = {};
    if (k.firstNameKana?.trim())  indiv.first_name_kana  = toFullWidthKana(k.firstNameKana.trim());
    if (k.lastNameKana?.trim())   indiv.last_name_kana   = toFullWidthKana(k.lastNameKana.trim());
    if (k.firstNameKanji?.trim()) indiv.first_name_kanji = k.firstNameKanji.trim();
    if (k.lastNameKanji?.trim())  indiv.last_name_kanji  = k.lastNameKanji.trim();
    if (k.dobDay && k.dobMonth && k.dobYear && !isNaN(Number(k.dobDay))) {
      indiv.dob = { day: Number(k.dobDay), month: Number(k.dobMonth), year: Number(k.dobYear) };
    }
    if (k.postalCode?.trim()) {
      indiv.address_kanji = jpAddr.address_kanji;
      indiv.address_kana  = jpAddr.address_kana;
    }
    if (k.phone?.trim()) indiv.phone = toE164Japan(k.phone);
    if (ownerEmail)      indiv.email = ownerEmail;

    const bizProfile: Record<string, string> = {
      mcc: "5812",
      url: businessUrl,
      product_description: k.productDescription?.trim() || "食品ロス削減おすそわけサービス",
    };
    if (businessType === "company") {
      const isTestKeyBizProfile = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const bpName = k.companyNameKanji?.trim() || store.name || (isTestKeyBizProfile ? "株式会社テスト" : undefined);
      if (bpName) bizProfile.name = bpName;
    }

    const step4Payload: Record<string, any> = {
      business_type:  businessType,
      business_profile: bizProfile,
      tos_acceptance: { date: Math.floor(tosTimestamp / 1000), ip, service_agreement: "full" },
      settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 25 } } },
    };

    if (businessType === "company") {
      const isTestKeyStep4 = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const companyObj: Record<string, any> = {
        // 本番では必ずフォーム入力値を使う。テストモードのみ偽値フォールバックを許可
        name_kanji: k.companyNameKanji?.trim() || store.name || (isTestKeyStep4 ? "株式会社テスト" : undefined),
        name_kana:  toFullWidthKana(k.companyNameKana?.trim() || '') || (isTestKeyStep4 ? "カブシキガイシャテスト" : undefined),
      };
      // company.name（ラテン文字社名）は Stripe JP で必須。未入力時はテストモードのみフォールバック
      companyObj.name = k.companyNameLatin?.trim() || (isTestKeyStep4 ? "Kabushiki Gaisha Test" : undefined);
      if (k.postalCode?.trim()) {
        companyObj.address_kanji = jpAddr.address_kanji;
        companyObj.address_kana  = jpAddr.address_kana;
      }
      if (k.phone?.trim()) companyObj.phone = toE164Japan(k.phone);
      step4Payload.company = companyObj;
    } else {
      const isTestKeyStep4 = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      // id_number はテストモード専用の偽値。本番では書類審査に委ねるため送信しない
      if (isTestKeyStep4) indiv.id_number = "000000000000";
      indiv.political_exposure = "none";
      if (Object.keys(indiv).length > 0) step4Payload.individual = indiv;
    }

    // ★★ 安全装置 (2026-08-05): 空文字の項目を送信直前に全部取り除く。
    //   Stripe は空文字を「その項目を削除しろ」という意味に取る。すでに本人確認が
    //   済んでいる口座に対して1つでも空文字を送ると
    //   "Once a full set of basic legal entity information has been provided ...
    //    you cannot unset any of it" で【更新まるごと失敗】する。
    //   実際に郵便番号が空文字になった店で再提出が丸ごと弾かれた(高槻駅 2026-08-05)。
    //   「送らない」= Stripe側の既存値がそのまま残る、が常に正しい挙動。
    const pruneEmpty = (o: any): any => {
      if (Array.isArray(o)) return o;
      if (o === null || typeof o !== "object") return o;
      const out: Record<string, any> = {};
      for (const [key, val] of Object.entries(o)) {
        if (val === "" || val === null || val === undefined) continue;
        if (typeof val === "object" && !Array.isArray(val)) {
          const child = pruneEmpty(val);
          if (Object.keys(child).length > 0) out[key] = child;
          continue;
        }
        out[key] = val;
      }
      return out;
    };
    const droppedEmptyKeys: string[] = [];
    (function findEmpty(o: any, path = "") {
      if (o === null || typeof o !== "object" || Array.isArray(o)) return;
      for (const [key, val] of Object.entries(o)) {
        const p = path ? `${path}.${key}` : key;
        if (val === "" || val === null || val === undefined) droppedEmptyKeys.push(p);
        else findEmpty(val, p);
      }
    })(step4Payload);
    if (droppedEmptyKeys.length > 0) {
      console.warn(`⚠️  [bank-setup] STEP4 空欄のため送信対象から除外: ${droppedEmptyKeys.join(", ")}`);
    }
    const step4Clean = pruneEmpty(step4Payload);

    // ★ セキュリティ (2026-10-03): KYC PII(氏名/生年月日/住所/電話)はログに出さない。
    //   デバッグには「どのフィールドを送ったか」のキー一覧で十分 (7/08監査ポリシー準拠)。
    const step4Keys = Object.entries(step4Clean as Record<string, any>).map(([k, v]) =>
      (v && typeof v === 'object' && !Array.isArray(v)) ? `${k}{${Object.keys(v).join(',')}}` : k).join(' ');
    console.log(`📤 [bank-setup] STEP4 accounts.update (sync) fields: ${step4Keys}`);
    let kycWarning = false;
    // ★ 2026-08-05 警告の中身をクライアントに返す。旧実装は kycWarning(真偽値)だけを返し、
    //   画面には「個人情報の一部が正しく送信されませんでした」という同じ文言しか出せなかった。
    //   実際には書類のアップロードは別途成功しているケースが多く(高槻駅)、店主が
    //   「全部失敗した」と誤解して何度も送り直す原因になっていた。
    let kycMissingFields: string[] = [];
    let kycErrorMessage: string | null = null;
    try {
      const kycAcc = await stripeCall(
        stripe.accounts.update(accountId!, step4Clean as any),
        "accounts.update(kyc-sync)", 30000
      ) as any;
      console.log(`✅ [bank-setup] STEP4 accounts.update OK (charges_enabled=${kycAcc?.charges_enabled})`);
      console.log(`   currently_due: ${JSON.stringify(kycAcc?.requirements?.currently_due)}`);
      if ((kycAcc?.requirements?.errors ?? []).length > 0) {
        console.warn(`⚠️  [bank-setup] STEP4 errors: ${JSON.stringify(kycAcc.requirements.errors)}`);
      }
      // STEP4成功後の currently_due をチェック
      // individual.verification.document / individual.verification.additional_document は
      // バックグラウンドでアップロード済み or アップロード予定のため「エラー」扱いしない
      const stillDue: string[] = kycAcc?.requirements?.currently_due ?? [];
      const missingIndividual = stillDue.filter((f: string) =>
        f.startsWith('individual.') &&
        !f.includes('verification') &&
        !f.includes('document')
      );
      if (missingIndividual.length > 0) {
        console.warn(`⚠️  [bank-setup] Individual fields still missing after STEP4 — reverting to pending: ${missingIndividual.join(', ')}`);
        await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
        kycMissingFields = missingIndividual;
        kycWarning = true;
      } else {
        console.log(`✅ [bank-setup] STEP4 OK — remaining currently_due (verification docs expected): ${JSON.stringify(stillDue)}`);
      }
    } catch (kycErr: any) {
      const errMsg = kycErr?.raw?.message ?? kycErr?.message ?? '';
      // ★ 自動リカバリ (2026-09-02 mokopan): Stripe の「町名に一致する候補が複数あります」は、
      //   番地欄の先頭に書かれた「◯丁目/◯番町/◯条」を町名側へ移すと通る
      //   (高槻の日吉台は正式町名が「日吉台一〜七番町」のため「日吉台」だけでは特定不能)。
      //   1回だけ補正して再試行し、それでもダメなら従来どおり pending に戻す。
      let recovered = false;
      if (/matching the provided town/i.test(errMsg)) {
        // individual / company どちらのペイロードでも補正 (2026-09-28 法人拡張)
        const entKey = (step4Clean as any).individual ? 'individual' : (step4Clean as any).company ? 'company' : null;
        const fixedEnt = entKey ? retryEntityWithFixedTown((step4Clean as any)[entKey]) : null;
        if (entKey && fixedEnt) {
          const retryPayload: any = JSON.parse(JSON.stringify(step4Clean));
          retryPayload[entKey] = fixedEnt;
          console.log(`♻️  [bank-setup] STEP4 自動リカバリ(${entKey}): 町名を "${fixedEnt.address_kanji.town}" に補正して再試行`);
          try {
            const kycAcc2 = await stripeCall(
              stripe.accounts.update(accountId!, retryPayload),
              "accounts.update(kyc-retry-town)", 30000
            ) as any;
            console.log(`✅ [bank-setup] STEP4 リトライ成功 (charges_enabled=${kycAcc2?.charges_enabled})`);
            recovered = true;
            const stillDue2: string[] = kycAcc2?.requirements?.currently_due ?? [];
            const missing2 = stillDue2.filter((f: string) =>
              (f.startsWith('individual.') || f.startsWith('company.')) && !f.includes('verification') && !f.includes('document'));
            if (missing2.length > 0) {
              console.warn(`⚠️  [bank-setup] リトライ成功だが不足項目あり — reverting to pending: ${missing2.join(', ')}`);
              await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
              kycMissingFields = missing2;
              kycWarning = true;
            }
          } catch (retryErr: any) {
            console.warn(`⚠️  [bank-setup] STEP4 リトライも失敗: ${retryErr?.raw?.message ?? retryErr?.message}`);
          }
        }
      }
      if (!recovered) {
        console.warn(`⚠️  [bank-setup] STEP4 accounts.update FAILED — reverting to pending: ${errMsg}`);
        // 個人情報が届かなかったのでステータスを pending に戻して再入力を促す
        try {
          await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
        } catch (_) {}
        kycErrorMessage = errMsg || null;
        kycWarning = true;
      }
    }

    // ── STEP 4b: 法人代表者を Persons API で同期登録/更新 ──
    // BG ではなく同期で実行することでエラーを即座に検知できる
    let syncPersonId: string | null = null;
    if (businessType === "company") {
      // ★ セキュリティ修正 (2026-07-08): 代表者の氏名/電話/生年月日/郵便番号 (KYC PII) を
      //   平文で Fly ログに残さない。ログ閲覧権限が漏れた場合の個人情報流出を防ぐため、
      //   デバッグに必要な「各項目が存在するか」の boolean だけを出力する。
      console.log(`[bank-setup] STEP4b (sync) — kycData present: nameKanji=${!!(k.firstNameKanji && k.lastNameKanji)} phone=${!!k.phone} dob=${!!(k.dobYear && k.dobMonth && k.dobDay)} postal=${!!k.postalCode}`);

      const repPayload: Record<string, any> = {};
      if (k.firstNameKana?.trim())  repPayload.first_name_kana  = toFullWidthKana(k.firstNameKana.trim());
      if (k.lastNameKana?.trim())   repPayload.last_name_kana   = toFullWidthKana(k.lastNameKana.trim());
      if (k.firstNameKanji?.trim()) repPayload.first_name_kanji = k.firstNameKanji.trim();
      if (k.lastNameKanji?.trim())  repPayload.last_name_kanji  = k.lastNameKanji.trim();
      if (k.dobDay && k.dobMonth && k.dobYear && !isNaN(Number(k.dobDay))) {
        repPayload.dob = { day: Number(k.dobDay), month: Number(k.dobMonth), year: Number(k.dobYear) };
      }
      if (k.postalCode?.trim()) {
        repPayload.address_kanji = jpAddr.address_kanji;
        repPayload.address_kana  = jpAddr.address_kana;
      }
      if (k.phone?.trim())  repPayload.phone = toE164Japan(k.phone);
      if (ownerEmail)       repPayload.email = ownerEmail;
      // 担当者が取締役（社長・役員）なら従来どおり。 取締役ではない担当者（店長など）は
      //   取締役・オーナーとして送らない（事実と違う申告になり、登記との照合で止まるため）。
      //   その場合の取締役は下の STEP4b-1 で別の Person として送る。
      const repIsDirector = k.representativeIsDirector !== false;
      repPayload.relationship = repIsDirector
        ? {
            representative:    true,
            director:          true,
            executive:         true,
            owner:             true,
            percent_ownership: 100,
            title:             k.representativeTitle?.trim() || "代表取締役",
          }
        : {
            representative:    true,
            director:          false,
            executive:         false,
            owner:             false,
            // 以前「はい」で送った店が「いいえ」に直したとき、 持ち株100%が残らないよう消す（"" = 未設定に戻す）
            percent_ownership: "",
            title:             k.representativeTitle?.trim() || "担当者",
          };
      // Stripe JP: 代表者の政治的関与を明示（未設定だと KYC pending になる場合がある）
      repPayload.political_exposure = "none";

      // ★ セキュリティ (2026-10-03): 代表者PIIはログに出さない。キー一覧のみ (7/08監査ポリシー準拠)。
      console.log(`📤 [bank-setup] STEP4b person payload fields: ${Object.keys(repPayload).join(',')}`);
      try {
        const existingPersons = await stripeCall(
          stripe.accounts.listPersons(accountId!, { limit: 10 }),
          "persons.list-sync", 10000
        ) as any;
        const existingRep = (existingPersons?.data ?? []).find((p: any) => p.relationship?.representative === true);
        if (existingRep) {
          await stripeCall(
            stripe.accounts.updatePerson(accountId!, existingRep.id, repPayload as any),
            "persons.update-sync", 30000
          );
          syncPersonId = existingRep.id;
          console.log(`✅ [bank-setup] STEP4b Persons.update OK id=${existingRep.id}`);
        } else {
          const created = await stripeCall(
            stripe.accounts.createPerson(accountId!, repPayload as any),
            "persons.create-sync", 30000
          ) as any;
          syncPersonId = created?.id ?? null;
          console.log(`✅ [bank-setup] STEP4b Persons.create OK id=${created?.id}`);
        }
      } catch (personErr: any) {
        const pMsg = personErr?.raw?.message ?? personErr?.message ?? '';
        console.warn(`⚠️  [bank-setup] STEP4b Persons API FAILED: ${pMsg}`);
        console.warn(`   type=${personErr?.type} code=${personErr?.raw?.code ?? personErr?.code} param=${personErr?.raw?.param ?? personErr?.param}`);
        console.warn(`   raw: ${JSON.stringify(personErr?.raw ?? { message: personErr?.message })}`);

        // ★ 代表者住所の町名エラーも自動リカバリ (2026-09-28: STEP4 と同じ補正を person にも適用)
        let personRecovered = false;
        if (/matching the provided town/i.test(pMsg)) {
          const fixedRep = retryEntityWithFixedTown(repPayload);
          if (fixedRep) {
            console.log(`♻️  [bank-setup] STEP4b 自動リカバリ: 代表者住所の町名を "${fixedRep.address_kanji.town}" に補正して再試行`);
            try {
              const ppl = await stripeCall(stripe.accounts.listPersons(accountId!, { limit: 10 }), "persons.list-retry", 10000) as any;
              const rep2 = (ppl?.data ?? []).find((p: any) => p.relationship?.representative === true);
              if (rep2) {
                await stripeCall(stripe.accounts.updatePerson(accountId!, rep2.id, fixedRep as any), "persons.update-retry", 30000);
                syncPersonId = rep2.id;
              } else {
                const created2 = await stripeCall(stripe.accounts.createPerson(accountId!, fixedRep as any), "persons.create-retry", 30000) as any;
                syncPersonId = created2?.id ?? null;
              }
              personRecovered = !!syncPersonId;
              console.log(`✅ [bank-setup] STEP4b リトライ成功 id=${syncPersonId}`);
            } catch (r2: any) {
              console.warn(`⚠️  [bank-setup] STEP4b リトライも失敗: ${r2?.raw?.message ?? r2?.message}`);
            }
          }
        }

        // ★ 2026-09-28 ConteCafe: 代表者未登録のまま「登録完了」と表示され、店主は成功したと
        //   思い込み、後日 Stripe から「代表者を指定してください」等5件の制限が届いていた。
        //   法人にとって代表者登録の失敗は確実に入金停止になるため、店主の画面に必ず出す。
        if (!personRecovered) {
          kycWarning = true;
          if (!kycErrorMessage) kycErrorMessage = pMsg || null;
          try {
            await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
          } catch (_) {}
        }
      }
    }

    // ── STEP 4b-1: 担当者が取締役ではない場合、 本物の取締役を別の Person として登録/更新 ──
    //   Stripe JP の directors は氏名(漢字・カナ)＋生年月日だけ。 本人確認書類は不要。
    let directorOk = true;
    if (businessType === "company" && syncPersonId && k.representativeIsDirector === false) {
      directorOk = false;
      const d = k.director ?? {};
      const dirPayload: Record<string, any> = {
        first_name_kanji: String(d.firstNameKanji ?? "").trim(),
        last_name_kanji:  String(d.lastNameKanji ?? "").trim(),
        first_name_kana:  toFullWidthKana(String(d.firstNameKana ?? "").trim()),
        last_name_kana:   toFullWidthKana(String(d.lastNameKana ?? "").trim()),
        dob: { day: Number(d.dobDay), month: Number(d.dobMonth), year: Number(d.dobYear) },
        relationship: { director: true, representative: false, title: "取締役" },
      };
      try {
        const ppl = await stripeCall(stripe.accounts.listPersons(accountId!, { limit: 20 }), "persons.list-director", 10000) as any;
        const existingDir = (ppl?.data ?? []).find((p: any) => p.relationship?.director === true && p.relationship?.representative !== true);
        if (existingDir) {
          await stripeCall(stripe.accounts.updatePerson(accountId!, existingDir.id, dirPayload as any), "persons.update-director", 30000);
          console.log(`✅ [bank-setup] STEP4b-1 取締役 Persons.update OK id=${existingDir.id}`);
        } else {
          const createdDir = await stripeCall(stripe.accounts.createPerson(accountId!, dirPayload as any), "persons.create-director", 30000) as any;
          console.log(`✅ [bank-setup] STEP4b-1 取締役 Persons.create OK id=${createdDir?.id}`);
        }
        directorOk = true;
      } catch (dErr: any) {
        // 取締役が登録できないと後日「取締役を指定してください」で止まる。 店主の画面に必ず出す。
        const dMsg = dErr?.raw?.message ?? dErr?.message ?? "";
        console.warn(`⚠️  [bank-setup] STEP4b-1 取締役の登録に失敗: ${dMsg}`);
        kycWarning = true;
        if (!kycErrorMessage) kycErrorMessage = `取締役情報の登録に失敗しました: ${dMsg}`;
        try {
          await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
        } catch (_) {}
      }
    }

    // ── STEP 4b-2: directors_provided: true を送信（全取締役の情報が揃ったことを Stripe に通知）──
    // persons.create の後に設定しないと Stripe が受け付けない
    if (businessType === "company" && syncPersonId && directorOk) {
      try {
        await stripeCall(
          stripe.accounts.update(accountId!, { company: { directors_provided: true } } as any),
          "accounts.update(directors_provided)", 10000
        );
        console.log(`✅ [bank-setup] STEP4b-2 directors_provided=true submitted`);
      } catch (dirErr: any) {
        // ★ 2026-09-28: 失敗すると後日「取締役を指定してください」の制限になる。黙らせない。
        console.warn(`⚠️  [bank-setup] STEP4b-2 directors_provided FAILED: ${dirErr?.raw?.message ?? dirErr?.message}`);
        kycWarning = true;
        if (!kycErrorMessage) kycErrorMessage = `役員情報の確定に失敗しました: ${dirErr?.raw?.message ?? dirErr?.message ?? ''}`;
      }
    }

    // ── STEP 4c: 法人番号（tax_id）同期送信 ──
    if (businessType === "company") {
      const isTestKey = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const rawTaxId  = (kycData.companyTaxId ?? "").replace(/[^0-9]/g, '').trim();
      // ⚠️ "0000000000000" は Stripe JP テスト環境で invalid。テスト時は "9999999999999" を使用する
      // ★ 2026-09-28: 12桁(登記の会社法人等番号)は検査用数字を頭に付けて正式な13桁に自動変換。
      //   13桁は検査用数字を照合し、不正(0埋め等)なら送らずに店主へ差し戻す。
      let taxId: string | null = null;
      if (rawTaxId.length === 12) {
        taxId = String(corporateCheckDigit12(rawTaxId)) + rawTaxId;
        console.log(`♻️  [bank-setup] STEP4c 12桁→13桁自動変換で送信`);
      } else if (rawTaxId.length === 13 && Number(rawTaxId[0]) === corporateCheckDigit12(rawTaxId.slice(1))) {
        taxId = rawTaxId;
      } else if (isTestKey) {
        taxId = "9999999999999";
      }
      if (taxId) {
        try {
          await stripeCall(
            stripe.accounts.update(accountId!, { company: { tax_id: taxId } } as any),
            "accounts.update(tax_id-sync)", 15000
          );
          console.log(`✅ [bank-setup] STEP4c company.tax_id submitted (test=${isTestKey})`);
        } catch (taxErr: any) {
          // ★ 2026-09-28: 法人番号未達は後日「法人番号を指定してください」の制限になる。黙らせない。
          console.warn(`⚠️  [bank-setup] STEP4c tax_id FAILED: ${taxErr?.raw?.message ?? taxErr?.message}`);
          kycWarning = true;
          if (!kycErrorMessage) kycErrorMessage = `法人番号の登録に失敗しました: ${taxErr?.raw?.message ?? taxErr?.message ?? ''}`;
          try { await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId)); } catch (_) {}
        }
      } else {
        // 桁数不正・検査用数字の不一致(0埋め等)は送らずに店主へ差し戻す
        console.warn(`⚠️  [bank-setup] STEP4c tax_id SKIPPED — 不正な法人番号: len=${rawTaxId.length}`);
        kycWarning = true;
        if (!kycErrorMessage) kycErrorMessage = '法人番号が正しくありません。登記簿の12桁（会社法人等番号）をお持ちの場合は、0を足さずに12桁のまま入力してください（自動で正式な13桁に変換されます）。';
        try { await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId)); } catch (_) {}
      }
    }

    // STEP1-4 完了 → クライアントにレスポンスを返す（BG は書類アップロードのみ）
    console.log(`✅ [bank-setup] STEP1-4 complete — responding to client (syncPersonId=${syncPersonId}, kycWarning=${kycWarning})`);
    res.json({
      success: true, accountId, partial: true, kycWarning,
      // 何が足りないのか / なぜ弾かれたのかを画面で出し分けるための情報
      kycMissingFields,
      kycErrorMessage,
      // 本人確認書類はこのリクエストで受け取り済み(この後バックグラウンドでStripeへ送る)。
      // 個人情報の更新が失敗しても書類提出は別経路で成立するため、画面で明示する。
      docsReceived: !!docFrontBase64,
    });

  } catch (err: any) {
    console.error("❌ [bank-setup] Fatal error (STEP1-4):", err?.raw?.message ?? err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({
        error:   "stripe_error",
        message: err?.raw?.message ?? err?.message ?? "登録処理に失敗しました",
        param:   err?.raw?.param ?? null,
      });
    }
    return;  // BG は起動しない
  }

  // syncPersonId を BG に渡すため let で宣言し直す（上の try-catch 内の変数は外から見えないため）
  // ※ accountId は上の try ブロック外で宣言済み（line 1806）
  // BG は書類アップロード + 代表者の本人確認書類更新 + DB 更新のみ担当
  let syncPersonId2: string | null = null;
  try {
    // 既存代表者 Person ID を取得（BG で書類を添付するため）
    if (businessType === "company" && accountId) {
      const personsList = await stripe.accounts.listPersons(accountId, { limit: 10 });
      const rep = personsList.data.find(p => p.relationship?.representative === true);
      if (rep) syncPersonId2 = rep.id;
    }
  } catch (_) {}

  // ── STEP 3-5: バックグラウンド処理 ──
  // ここは try の外なので accountId / kycData / stripe / businessUrl / ownerEmail / storeId すべてアクセス可能
  void (async () => {
    const toBuffer = (b64: string) => Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");

    try {
      // STEP 3: 書類アップロード（並列）
      console.log(`[bank-setup] BG STEP3 Uploading identity documents…`);
      const frontExt = docFrontMime === "image/png" ? "png" : "jpg";

      const [frontResult, backResult] = await Promise.allSettled([
        stripeCall(
          stripe.files.create({
            purpose: "identity_document",
            file: { data: toBuffer(docFrontBase64), name: `id_front.${frontExt}`, type: docFrontMime as "image/jpeg" | "image/png" },
          }),
          "files.create(front)", 30000
        ),
        ...(docBackBase64 && docBackMime ? [
          stripeCall(
            stripe.files.create({
              purpose: "identity_document",
              file: { data: toBuffer(docBackBase64), name: `id_back.${docBackMime === "image/png" ? "png" : "jpg"}`, type: docBackMime as "image/jpeg" | "image/png" },
            }),
            "files.create(back)", 30000
          ),
        ] : [Promise.resolve(null)]),
      ]);

      const frontFile   = frontResult.status === "fulfilled" ? frontResult.value : null;
      const backFileRaw = backResult.status  === "fulfilled" ? backResult.value  : null;
      const backFileId  = backFileRaw ? (backFileRaw as any).id : undefined;

      // ★ 2026-08-05 書類がStripeに渡らなかったことを「握り潰さない」ための判定用。
      //   旧実装は警告ログを出すだけで、店主の画面には「登録完了！」と表示されていた。
      let docAttachFailed = false;
      if (frontFile) console.log(`✅ [bank-setup] BG Front doc: ${(frontFile as any).id}`);
      else {
        docAttachFailed = true;
        console.warn(`⚠️  [bank-setup] BG Front doc upload failed`);
      }
      if (backFileId) console.log(`✅ [bank-setup] BG Back doc: ${backFileId}`);

      // 営業許可証を Supabase Storage に保存
      // ── silent fail を必ず DB に記録する（神モード検知用）──
      let licenseImageUrl: string | null = null;
      let licenseUploadFailed = false;
      let licenseUploadError: string | null = null;
      const licenseUploadAttemptedAt = new Date();

      if (bizLicenseBase64 && store.ownerId) {
        try {
          const licMatch = bizLicenseBase64.match(/^data:(image\/[\w+]+);base64,(.+)$/s);
          if (!licMatch) {
            licenseUploadFailed = true;
            licenseUploadError = "invalid_base64_format";
            console.error(`❌ [bank-setup] BG License: invalid base64 format (storeId=${storeId})`);
          } else {
            const licContentType = licMatch[1];
            const licExt = licContentType === "image/png" ? "png" : "jpg";
            const licBuffer = Buffer.from(licMatch[2], "base64");
            const licPath = `${store.ownerId}/${Date.now()}-license.${licExt}`;
            const { error: licUpErr } = await supabaseAdmin.storage
              .from("store-documents")
              .upload(licPath, licBuffer, { contentType: licContentType, upsert: false, cacheControl: "31536000, immutable" });
            if (licUpErr) {
              licenseUploadFailed = true;
              licenseUploadError = `storage_upload: ${licUpErr.message}`;
              console.error(`❌ [bank-setup] BG License doc upload FAILED (storeId=${storeId}): ${licUpErr.message}`);
            } else {
              licenseImageUrl = licPath;
              console.log(`✅ [bank-setup] BG License doc saved: ${licPath}`);
            }
          }
        } catch (licEx: any) {
          licenseUploadFailed = true;
          licenseUploadError = `exception: ${licEx?.message ?? String(licEx)}`;
          console.error(`❌ [bank-setup] BG License doc exception (storeId=${storeId}): ${licEx?.message}`);
        }
      } else if (!bizLicenseBase64) {
        // 画像が渡されてないケース → 神モード警告対象
        licenseUploadFailed = true;
        licenseUploadError = "no_image_provided";
        console.warn(`⚠️  [bank-setup] BG License: no image provided (storeId=${storeId})`);
      } else if (!store.ownerId) {
        licenseUploadFailed = true;
        licenseUploadError = "no_owner_id";
        console.warn(`⚠️  [bank-setup] BG License: store has no ownerId (storeId=${storeId})`);
      }

      // ── BG STEP4b-docs: 同期で作成済みの person に本人確認書類を添付 ──
      let kycChargesEnabled: boolean | null = null;
      if (businessType === "company" && syncPersonId2 && frontFile) {
        try {
          await stripeCall(
            stripe.accounts.updatePerson(accountId!, syncPersonId2, {
              verification: {
                document: {
                  front: (frontFile as any).id,
                  ...(backFileId ? { back: backFileId } : {}),
                },
              },
            } as any),
            "persons.update(docs)", 30000
          );
          console.log(`✅ [bank-setup] BG Person docs updated OK: person=${syncPersonId2}`);
        } catch (personDocErr: any) {
          docAttachFailed = true;
          console.warn(`⚠️  [bank-setup] BG person doc update FAILED: ${personDocErr?.raw?.message ?? personDocErr?.message}`);
        }
      } else if (businessType === "individual" && frontFile) {
        // 個人事業主: accounts.update の individual.verification で書類を添付
        try {
          await stripeCall(
            stripe.accounts.update(accountId!, {
              individual: {
                verification: {
                  document: {
                    front: (frontFile as any).id,
                    ...(backFileId ? { back: backFileId } : {}),
                  },
                },
              },
            } as any),
            "accounts.update(individual-docs)", 30000
          );
          console.log(`✅ [bank-setup] BG individual verification docs updated OK`);
        } catch (indDocErr: any) {
          docAttachFailed = true;
          console.warn(`⚠️  [bank-setup] BG individual doc update FAILED: ${indDocErr?.raw?.message ?? indDocErr?.message}`);
        }
      } else if (businessType === "company" && frontFile && !syncPersonId2) {
        // ★ 2026-09-28: 代表者 Person が存在しないと書類はどこにも添付されない。
        //   旧実装はこのケースを黙って素通りしていた(ConteCafe)。必ず失敗扱いにする。
        docAttachFailed = true;
        console.warn(`⚠️  [bank-setup] BG doc attach SKIPPED — 代表者Personが存在しません (storeId=${storeId})`);
      }

      // 書類添付後の charges_enabled / payouts_enabled を確認
      let kycPayoutsEnabled: boolean | null = null;
      let postDocsDue: string[] = [];
      try {
        const refreshed = await stripeCall(
          stripe.accounts.retrieve(accountId!),
          "accounts.retrieve(post-docs)", 10000
        ) as any;
        kycChargesEnabled = refreshed?.charges_enabled ?? false;
        kycPayoutsEnabled = refreshed?.payouts_enabled ?? false;
        console.log(`   post-docs charges_enabled=${refreshed?.charges_enabled} payouts_enabled=${refreshed?.payouts_enabled}`);
        postDocsDue = refreshed?.requirements?.currently_due ?? [];
        console.log(`   post-docs currently_due: ${JSON.stringify(refreshed?.requirements?.currently_due)}`);
        console.log(`   post-docs eventually_due: ${JSON.stringify(refreshed?.requirements?.eventually_due)}`);
      } catch (_) {}

      // ★★ 2026-08-05 サイレント失敗の封鎖:
      //   本人確認書類がStripeに届かなかった場合、旧実装は警告ログを出すだけで
      //   店主の画面には「登録完了！」と表示され、そのまま永久に待ち続ける詰みになっていた。
      //   届いていないと判定できたときは status を pending に戻して【再入力フォームを出し】、
      //   ベル通知でも本人に知らせる。判定は安全側(迷ったら知らせる)に倒す。
      let docDeliveryFailed = false;
      try {
        const docStillDue = postDocsDue.some(
          (f: string) => f.includes("verification") || f.includes("document"),
        );
        const fullyOk = kycChargesEnabled === true && kycPayoutsEnabled === true;
        docDeliveryFailed = (docAttachFailed || docStillDue) && !fullyOk;
        if (docDeliveryFailed) {
          console.warn(
            `❌ [bank-setup] BG 本人確認書類がStripeに届いていない — storeId=${storeId} ` +
            `attachFailed=${docAttachFailed} stillDue=[${postDocsDue.join(",")}] → pending に差し戻し`,
          );
          // ※ status はここでは書き換えない。直後の STEP5 が status を上書きするため、
          //   STEP5 側の newStatus 決定に docDeliveryFailed を渡して 'pending' にさせる。
          const [cur] = await db
            .select({ status: storesTable.status, ownerId: storesTable.ownerId, name: storesTable.name })
            .from(storesTable)
            .where(eq(storesTable.id, storeId))
            .limit(1);
          if (cur?.ownerId) {
            try {
              // ★ 「届かなかった」のか「Stripeがまだ求めている」のかで文言を分ける。
              //   一律に「送信できませんでした」と出すと、実際は届いているのに
              //   同じ書類を何度も送り直させることになる。
              await db.insert(notificationsTable).values({
                userId: cur.ownerId,
                type: "store_kyc_doc_failed",
                title: docAttachFailed
                  ? "⚠️ 本人確認書類が送信できませんでした"
                  : "⚠️ 本人確認書類の再提出が必要です",
                body: docAttachFailed
                  ? "通信の問題などで書類が届きませんでした。お手数ですが、もう一度撮影して再提出してください。"
                  : "決済会社が本人確認書類の提出を引き続き求めています。アプリの出品管理から再提出してください。",
                read: false,
              });
            } catch (_) { /* 通知失敗は握り潰す */ }
          }
        }
      } catch (docCheckErr: any) {
        console.error("[bank-setup] BG 書類到達チェック失敗 (non-fatal):", docCheckErr?.message);
      }

      // STEP 5: DB 更新 + オーナーの role を確実に store_owner に設定
      // charges_enabled なら自動承認（デフォルトON。app_settings で 'false' を明示すると無効）
      let autoApproved = false;
      // ★ 自動承認は決済◯かつ入金◯の完全体だけ（2026-08-04厳格化）
      if (kycChargesEnabled === true && kycPayoutsEnabled === true) {
        try {
          const settingRows = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified'`);
          const settingVal = (settingRows.rows[0] as any)?.value ?? 'true';
          if (settingVal !== 'false') autoApproved = true;
        } catch (_) {
          autoApproved = true; // 完全体確認済みならDB読み込みエラー時も承認してよい
        }
      }

      // ★ 書類がStripeに届いていない場合は「審査中(applied)」にせず
      //   'pending' に落として再入力フォームを出す (2026-08-05)。
      const newStatus = autoApproved ? "approved" : (docDeliveryFailed ? "pending" : "applied");
      // 現在の store を更新（許可証アップロード追跡フラグ含む）
      await db.update(storesTable).set({
        status: newStatus,
        isActive: autoApproved ? true : undefined,
        ...(licenseImageUrl ? { licenseImageUrl } : {}),
        ...(kycChargesEnabled !== null ? { stripeChargesEnabled: kycChargesEnabled } : {}),
        ...(kycPayoutsEnabled !== null ? { stripePayoutsEnabled: kycPayoutsEnabled } : {}),
        licenseUploadFailed,
        licenseUploadError,
        licenseUploadAttemptedAt,
      }).where(eq(storesTable.id, storeId));

      // 同一オーナーの他店舗にも stripe_account_id / charges / payouts を伝播
      if (store.ownerId && accountId) {
        try {
          await db.update(storesTable)
            .set({
              stripeAccountId: accountId,
              ...(kycChargesEnabled !== null ? { stripeChargesEnabled: kycChargesEnabled } : {}),
              ...(kycPayoutsEnabled !== null ? { stripePayoutsEnabled: kycPayoutsEnabled } : {}),
            })
            .where(
              and(
                eq(storesTable.ownerId, store.ownerId),
                ne(storesTable.id, storeId)
              )
            );
          console.log(`✅ [bank-setup] BG Propagated stripe_account_id=${accountId} (charges=${kycChargesEnabled}) to all other stores of owner ${store.ownerId}`);
        } catch (propErr: any) {
          console.warn(`⚠️ [bank-setup] BG propagation to other stores failed: ${propErr?.message}`);
        }
      }

      if (autoApproved) {
        console.log(`✅ [bank-setup] BG Store ${storeId} → auto-approved (charges_enabled=true, auto_approve=on)`);
      } else {
        console.log(`✅ [bank-setup] BG Store ${storeId} status → '${newStatus}' (awaiting admin approval)`);
      }

      if (store.ownerId) {
        try {
          await supabaseAdmin.from("users").update({ role: "store_owner" }).eq("id", store.ownerId);
          console.log(`✅ [bank-setup] BG users.role → store_owner (ownerId=${store.ownerId})`);
        } catch (roleEx: any) {
          console.warn(`⚠️  [bank-setup] BG role update failed:`, roleEx?.message);
        }
      }

    } catch (bgErr: any) {
      console.error(`❌ [bank-setup] BG error:`, bgErr?.message ?? bgErr);
      try {
        await db.update(storesTable).set({ status: "applied", stripeNeedsBankReregister: false }).where(eq(storesTable.id, storeId));
      } catch (_) {}
      // フォールバック: role 更新を試みる
      if (store.ownerId) {
        try {
          await supabaseAdmin.from("users").update({ role: "store_owner" }).eq("id", store.ownerId);
        } catch (_) {}
      }
    }
  })();
});

// ─── 既存 Stripe アカウントの requirements 充足（テストデータで一括完了）──────
// POST /api/stores/:storeId/connect/fill-requirements
// currently_due / eventually_due のフィールドをテスト値で埋め、アカウントを Active にする
router.post("/stores/:storeId/connect/fill-requirements", requireAuth, requireStoreOwner, async (req, res) => {
  const storeId = parseInt(String(req.params.storeId));
  if (isNaN(storeId)) return res.status(400).json({ error: "bad_request" });

  const stripeKey = process.env["STRIPE_SECRET_KEY"];
  if (!stripeKey) return res.status(503).json({ error: "stripe_not_configured" });

  // ⚠️ このルートはダミーデータを送信するためテストモード専用
  if (!stripeKey.startsWith("sk_test_")) {
    return res.status(403).json({ error: "forbidden", message: "fill-requirements はテストモードでのみ使用可能です" });
  }

  const [store] = await db
    .select({ id: storesTable.id, stripeAccountId: storesTable.stripeAccountId, ownerId: storesTable.ownerId, name: storesTable.name })
    .from(storesTable)
    .where(eq(storesTable.id, storeId));

  if (!store?.stripeAccountId) {
    return res.status(404).json({ error: "no_stripe_account", message: "Stripe アカウントが未登録です" });
  }

  const accountId = store.stripeAccountId;
  const stripe = await import("stripe").then((m) => new m.default(stripeKey));

  try {
    // 現在の requirements を取得
    const account = await stripe.accounts.retrieve(accountId);
    const due = [
      ...(account.requirements?.currently_due  ?? []),
      ...(account.requirements?.eventually_due ?? []),
    ];
    console.log(`[fill-req] ${accountId} requirements:`, JSON.stringify(due));

    // ── business_type を確認（個人/法人でフィールド送信先が異なる）──
    const isCompany = account.business_type === "company";
    console.log(`[fill-req] business_type=${account.business_type} isCompany=${isCompany}`);

    // ── テストデータペイロード（JP Custom Account 用）──
    const fillIp = req.ip ?? req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ?? "127.0.0.1";
    const payload: Record<string, any> = {
      // ToS（JP では date・ip・service_agreement の3点セット必須）
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: fillIp, service_agreement: "full" },
      // 送金スケジュール
      settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 25 } } },
    };

    const ownerEmail = store.ownerId
      ? await supabaseAdmin.auth.admin.getUserById(store.ownerId).then(r => r.data?.user?.email ?? null).catch(() => null)
      : null;

    // ⚠️ 法人の representative は accounts.update に含めると "parameter_unknown" エラーになる
    // → personRepPayload に分離し、accounts.update 後に Persons API で登録する
    let personRepPayload: Record<string, any> | null = null;

    if (isCompany) {
      // ─── 法人: representative は Persons API で別途設定 ───
      const hasRepDue = due.some(f => f.startsWith("representative.") || f.startsWith("person."));
      if (hasRepDue) {
        const rep: Record<string, any> = {};
        if (due.some(f => f.includes("representative.first_name"))) {
          rep.first_name_kana  = "テスト";
          rep.first_name_kanji = "テスト";
        }
        if (due.some(f => f.includes("representative.last_name"))) {
          rep.last_name_kana  = "テスト";
          rep.last_name_kanji = "テスト";
        }
        if (due.some(f => f.includes("representative.dob"))) {
          rep.dob = { day: 1, month: 1, year: 1990 };
        }
        if (due.some(f => f.includes("representative.address"))) {
          rep.address_kanji = { postal_code: "1000001", state: "東京都", city: "千代田区", town: "千代田", line1: "1-1" };
          rep.address_kana  = { postal_code: "1000001", state: "トウキョウト", city: "チヨダク", town: "チヨダ", line1: "1-1" };
        }
        if (due.some(f => f.includes("representative.phone"))) {
          rep.phone = "+810600000000";
        }
        if (due.some(f => f.includes("representative.email"))) {
          rep.email = ownerEmail ?? "test@example.com";
        }
        // ⚠️ title は relationship の中に入れる（Stripe JP 仕様）。director: true も JP 法人では必須
        rep.relationship = {
          representative: true,
          director: true,
          executive: true,
          owner: true,
          percent_ownership: 100,
          title: "代表取締役",
        };
        personRepPayload = rep;
      }

      // 法人情報（company オブジェクト）は accounts.update で送れる
      if (due.some(f => f.includes("company."))) {
        const storeNameForFallback = store.name ?? "株式会社テスト";
        // ⚠️ JP では company.structure を送ると全値エラーになるため省略
        const fillCompany: Record<string, any> = {
          name_kanji: storeNameForFallback,
          name_kana:  "テスト",
          // company.name はラテン文字社名（英語）。Stripe JP では currently_due に含まれる場合がある
          name: "Test Company Inc",
          address_kanji: { postal_code: "1000001", state: "東京都", city: "千代田区", town: "千代田", line1: "1-1" },
          address_kana:  { postal_code: "1000001", state: "トウキョウト", city: "チヨダク", town: "チヨダ", line1: "1-1" },
          phone: "+810600000000",
          // 法人の directors_provided: true → 全取締役の情報が揃っていることを Stripe に通知
          directors_provided: true,
        };
        // テストキーの場合: 法人番号を有効なテスト値で送る（本番は実際の13桁番号が必要）
        // ⚠️ "0000000000000" は Stripe JP で invalid。"9999999999999" を使用する
        if (stripeKey.startsWith("sk_test_")) {
          fillCompany.tax_id = "9999999999999";
        }
        payload.company = fillCompany;
      }
    } else {
      // ─── 個人事業主: individual キーに送る ───
      const indiv: Record<string, any> = {};
      if (due.some(f => f.includes("individual.id_number")) && stripeKey.startsWith("sk_test_")) {
        indiv.id_number = "000000000000";  // マイナンバー（テストモード専用）
      }
      if (due.some(f => f.includes("individual.political_exposure"))) {
        indiv.political_exposure = "none";
      }
      if (due.some(f => f.includes("individual.first_name"))) {
        indiv.first_name_kana  = "テスト";
        indiv.first_name_kanji = "テスト";
      }
      if (due.some(f => f.includes("individual.last_name"))) {
        indiv.last_name_kana  = "テスト";
        indiv.last_name_kanji = "テスト";
      }
      if (due.some(f => f.includes("individual.dob"))) {
        indiv.dob = { day: 1, month: 1, year: 1990 };
      }
      if (due.some(f => f.includes("individual.address"))) {
        // JP: address と address_kana/kanji は共存不可 → kanji/kana のみ（東京都千代田区テスト住所）
        indiv.address_kanji = { postal_code: "1000001", state: "東京都", city: "千代田区", town: "千代田", line1: "1-1" };
        indiv.address_kana  = { postal_code: "1000001", state: "トウキョウト", city: "チヨダク", town: "チヨダ", line1: "1-1" };
      }
      if (due.some(f => f.includes("individual.phone"))) {
        indiv.phone = "+810600000000";
      }
      if (due.some(f => f.includes("individual.email"))) {
        indiv.email = ownerEmail ?? "test@example.com";
      }
      if (Object.keys(indiv).length > 0) payload.individual = indiv;

      // political_exposure は常に送る。id_number はテストモードのみ（本番では書類審査）
      payload.individual = {
        ...(payload.individual ?? {}),
        ...(stripeKey.startsWith("sk_test_") ? { id_number: "000000000000" } : {}),
        political_exposure: "none",
      };
    }

    if (due.some(f => f.includes("business_profile.product_description"))) {
      payload.business_profile = { mcc: "5812", product_description: "食品ロス削減おすそわけサービス" };
    }
    if (due.some(f => f.includes("business_profile.url"))) {
      // ⚠️ Replit dev ドメインを送ると JCB 等カードブランドの審査で「不審な URL」と
      //   判定され当該ブランドが一時停止されるため、必ず本番ドメインを使う
      payload.business_profile = { ...payload.business_profile, mcc: "5812", url: PUBLIC_BUSINESS_URL };
    }
    if (due.some(f => f.includes("business_profile.name")) && isCompany) {
      payload.business_profile = { ...payload.business_profile, mcc: "5812", name: store.name ?? "株式会社テスト" };
    }

    console.log(`📤 [fill-req] accounts.update payload for ${accountId}:`, JSON.stringify(payload, null, 2));
    const updated = await stripe.accounts.update(accountId, payload as any);
    console.log(`✅ [fill-req] accounts.update done. charges_enabled=${updated.charges_enabled}`);

    // 法人の場合: representative を Persons API で登録/更新
    if (personRepPayload) {
      console.log(`📤 [fill-req] Persons API for representative:`, JSON.stringify(personRepPayload, null, 2));
      try {
        const existingPersons = await stripe.accounts.listPersons(accountId, { limit: 10 });
        const existingRep = (existingPersons.data ?? []).find((p: any) => p.relationship?.representative === true);
        if (existingRep) {
          await stripe.accounts.updatePerson(accountId, existingRep.id, personRepPayload as any);
          console.log(`✅ [fill-req] Persons.update representative id=${existingRep.id}`);
        } else {
          const created = await stripe.accounts.createPerson(accountId, personRepPayload as any) as any;
          console.log(`✅ [fill-req] Persons.create representative id=${created?.id}`);
        }
      } catch (personErr: any) {
        console.warn(`⚠️  [fill-req] Persons API FAILED: ${personErr?.raw?.message ?? personErr?.message}`);
        console.warn(`   param: ${personErr?.raw?.param ?? personErr?.param}`);
      }
    }

    // 最新の状態を取得（Persons API 後に requirements が変わる可能性がある）
    const finalAccount = await stripe.accounts.retrieve(accountId);
    const remaining = [
      ...(finalAccount.requirements?.currently_due  ?? []),
      ...(finalAccount.requirements?.eventually_due ?? []),
    ];
    console.log(`✅ [fill-req] Done. Remaining requirements:`, JSON.stringify(remaining));

    res.json({
      success:              true,
      accountId,
      charges_enabled:      finalAccount.charges_enabled,
      payouts_enabled:      finalAccount.payouts_enabled,
      remaining_due:        remaining,
      payout_schedule:      (finalAccount.settings as any)?.payouts?.schedule,
    });
  } catch (err: any) {
    console.error(`❌ [fill-req] Error:`, err?.raw?.message ?? err?.message);
    res.status(500).json({
      error:   "stripe_error",
      message: err?.raw?.message ?? err?.message,
      param:   err?.raw?.param ?? null,
    });
  }
});

// ── 審査承認通知（メール + アプリ内通知） ───────────────────────────────────
router.post("/stores/notify-approval", requireAdmin, async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const [store] = await db
      .select()
      .from(storesTable)
      .where(eq(storesTable.ownerId, user.id))
      .limit(1);

    if (!store) {
      res.status(404).json({ error: "store_not_found" });
      return;
    }

    if (store.status !== "approved") {
      res.status(400).json({ error: "not_approved", message: "店舗がまだ承認されていません" });
      return;
    }

    const results: { notification: boolean; email: boolean | string } = {
      notification: false,
      email: false,
    };

    // ── アプリ内通知を作成（未読がなければ追加）────────────────────────────
    const existing = await db
      .select()
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.userId, user.id),
        eq(notificationsTable.type, "store_approved"),
      ))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(notificationsTable).values({
        userId: user.id,
        type: "store_approved",
        title: "🎉 審査が承認されました！",
        body: `${store.name} の審査が通過しました。振込先口座を登録して出品を始めましょう。`,
        read: false,
      });
      results.notification = true;
    }

    // ── メール送信（approval_email_sent が false の場合のみ）──────────────
    if (!store.approvalEmailSent) {
      const sent = await sendStoreApprovalEmail({
        ownerEmail: user.email!,
        storeName:  store.name,
      });
      if (sent) {
        await db
          .update(storesTable)
          .set({ approvalEmailSent: true })
          .where(eq(storesTable.id, store.id));
        results.email = true;
      } else {
        results.email = "send_failed";
      }
    } else {
      results.email = "already_sent";
    }

    res.json({ ok: true, ...results });
  } catch (err: any) {
    console.error("[notify-approval] error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ─── 店舗オーナー向けレビュー一覧（バッグ名 join）─────────────────────────────
router.get("/stores/:storeId/owner-reviews", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const reviews = await db
      .select({
        id: reviewsTable.id,
        rating: reviewsTable.rating,
        comment: reviewsTable.comment,
        createdAt: reviewsTable.createdAt,
        reply: reviewsTable.reply,
        repliedAt: reviewsTable.repliedAt,
        bagTitle: surpriseBagsTable.title,
        reservationId: reviewsTable.reservationId,
      })
      .from(reviewsTable)
      .leftJoin(reservationsTable, eq(reviewsTable.reservationId, reservationsTable.id))
      .leftJoin(surpriseBagsTable, eq(reservationsTable.bagId, surpriseBagsTable.id))
      .where(eq(reviewsTable.storeId, storeId))
      .orderBy(desc(reviewsTable.createdAt));

    res.json({ reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch reviews" });
  }
});

// ─── レビューへの返信（店舗オーナー）─────────────────────────────────────────
router.patch("/stores/:storeId/reviews/:reviewId/reply", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId ?? ""));
    const reviewId = parseInt(String(req.params.reviewId ?? ""));
    const { reply } = req.body as { reply: string };

    if (isNaN(storeId) || isNaN(reviewId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid id" });
      return;
    }

    const [updated] = await db
      .update(reviewsTable)
      .set({ reply: reply || null, repliedAt: reply ? new Date() : null })
      .where(and(eq(reviewsTable.id, reviewId), eq(reviewsTable.storeId, storeId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Review not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to update reply" });
  }
});

// ─── 店舗プロフィール更新（カバー写真・紹介文・営業時間等）─────────────────
router.put("/stores/:storeId/profile", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const allowed = ["name", "description", "imageUrl", "iconUrl", "phone", "address", "city", "openTime", "closeTime", "holiday", "pickupHours", "category", "qualifiedInvoiceNumber"] as const;
    const body = req.body as Partial<Record<typeof allowed[number], string | null>> & { lat?: number | string | null; lng?: number | string | null };
    const patch: Record<string, string | number | null> = {};
    for (const key of allowed) {
      if (key in body) patch[key] = (body[key] as string | null) ?? null;
    }
    // ── 位置情報 (lat/lng) は店舗オーナーが地図ピンで微調整できる ──
    //    日本国内の妥当範囲チェックのみ実施 (lat 20-46, lng 122-154)。
    //    片方だけの更新は受け付けない (整合性のためペアで更新)。
    if ("lat" in body || "lng" in body) {
      const latNum = body.lat == null || body.lat === "" ? NaN : Number(body.lat);
      const lngNum = body.lng == null || body.lng === "" ? NaN : Number(body.lng);
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
        res.status(400).json({ error: "invalid_coordinates", message: "緯度・経度は数値で指定してください。" });
        return;
      }
      if (latNum < 20 || latNum > 46 || lngNum < 122 || lngNum > 154) {
        res.status(400).json({ error: "invalid_coordinates", message: "緯度・経度が日本国内の範囲外です。" });
        return;
      }
      patch.lat = latNum;
      patch.lng = lngNum;
    }
    // 適格請求書発行事業者登録番号は T + 13桁数字 のみ許可。 空文字は null 扱い。
    if ("qualifiedInvoiceNumber" in patch) {
      const raw = (patch.qualifiedInvoiceNumber ?? "").toString().trim().toUpperCase();
      if (raw === "") {
        patch.qualifiedInvoiceNumber = null;
      } else if (!/^T\d{13}$/.test(raw)) {
        res.status(400).json({
          error: "invalid_qualified_invoice_number",
          message: "適格請求書発行事業者登録番号は T で始まる 14 文字 (T + 数字 13 桁) で入力してください。",
        });
        return;
      } else {
        patch.qualifiedInvoiceNumber = raw;
      }
    }

    const [updated] = await db
      .update(storesTable)
      .set(patch)
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to update profile" });
  }
});

// ─── Stripe情報を特商法フォームの初期値として取得 ─────────────────────────────
// GET /api/stores/:storeId/connect/stripe-prefill
router.get("/stores/:storeId/connect/stripe-prefill", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store?.stripeAccountId) {
      res.json({ available: false });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.json({ available: false });
      return;
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));
    const account = await stripe.accounts.retrieve(store.stripeAccountId);

    // 代表者名の取得（individualまたはpersons API）
    let representative = '';
    if (account.individual?.first_name || account.individual?.last_name) {
      const parts = [account.individual.last_name, account.individual.first_name].filter(Boolean);
      representative = parts.join(' ').trim();
    } else {
      try {
        const persons = await stripe.accounts.listPersons(store.stripeAccountId, {
          relationship: { representative: true },
          limit: 1,
        });
        const rep = persons.data[0];
        if (rep) {
          const parts = [rep.last_name, rep.first_name].filter(Boolean);
          representative = parts.join(' ').trim();
        }
      } catch {
        // personsが取得できない場合は空のまま
      }
    }

    // 住所の組み立て（日本語順：都道府県→市区町村→番地）
    // city と town の重複除去: town が city を前置している場合は city を省く
    function buildJapaneseAddress(parts: (string | null | undefined)[]): string {
      const filled = parts.filter(Boolean) as string[];
      const deduped: string[] = [];
      for (const part of filled) {
        if (deduped.length === 0) {
          deduped.push(part);
        } else {
          const last = deduped[deduped.length - 1];
          if (part.startsWith(last)) {
            // 例: last="高槻市", part="高槻市○○町" → last を longer な part で置換
            deduped[deduped.length - 1] = part;
          } else if (!last.endsWith(part) && !last.includes(part)) {
            deduped.push(part);
          }
          // else: part が last に含まれている → スキップ（重複）
        }
      }
      return deduped.join('');
    }

    const addr = account.company?.address_kanji
      ?? account.individual?.address_kanji
      ?? account.company?.address
      ?? account.individual?.address;

    let legalAddress = '';
    if (addr && typeof addr === 'object') {
      const a = addr as { state?: string | null; city?: string | null; town?: string | null; line1?: string | null; line2?: string | null; postal_code?: string | null };
      const built = buildJapaneseAddress([a.state, a.city, a.town, a.line1, a.line2]);
      legalAddress = built || (a.postal_code ? `〒${a.postal_code}` : '');
    }

    // 電話番号: E.164 (+8180...) → 日本ローカル形式 (080-xxxx-xxxx)
    function formatJapanesePhone(raw: string | null | undefined): string {
      if (!raw) return '';
      let digits = raw.replace(/\D/g, '');
      // E.164: +81 → 先頭の 81 を 0 に置換
      if (raw.startsWith('+81') || digits.startsWith('81')) {
        digits = '0' + digits.replace(/^81/, '');
      }
      // 携帯・IP電話: 0[5789]0 始まり 11桁 → 0X0-XXXX-XXXX
      if (/^0[5789]0\d{8}$/.test(digits)) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
      }
      // 2桁市外局番 (03, 06 など) 10桁 → 0X-XXXX-XXXX
      if (/^0[36]\d{8}$/.test(digits)) {
        return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
      }
      // 3桁市外局番 10桁 → 0XX-XXX-XXXX
      if (/^0\d{2}\d{7}$/.test(digits) && digits.length === 10) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
      // その他 11桁 → 0XXX-XX-XXXX (4桁局番)
      if (digits.length === 11) {
        return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
      }
      return digits;
    }

    const rawPhone = account.company?.phone ?? account.individual?.phone ?? '';
    const legalPhone = formatJapanesePhone(rawPhone);

    // メール
    const legalEmail = account.email ?? '';

    // 事業者名（法人名 > 屋号 > ビジネスプロフィール名）
    const legalName = account.company?.name
      ?? account.business_profile?.name
      ?? '';

    res.json({
      available: true,
      legalName,
      representative,
      legalAddress,
      legalPhone,
      legalEmail,
    });
  } catch (err: any) {
    console.error("Stripe prefill error:", err);
    res.json({ available: false });
  }
});

router.get("/stores/:storeId/legal", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const [store] = await db
      .select({
        name: storesTable.name,
        legalName: storesTable.legalName,
        legalRepresentative: storesTable.legalRepresentative,
        legalAddress: storesTable.legalAddress,
        legalPhone: storesTable.legalPhone,
        legalEmail: storesTable.legalEmail,
        legalOther: storesTable.legalOther,
      })
      .from(storesTable)
      .where(eq(storesTable.id, storeId));

    if (!store) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to fetch legal info" });
  }
});

// ─── 特定商取引法表記 更新（店舗オーナー）──────────────────────────────────────
router.put("/stores/:storeId/legal", requireAuth, requireStoreOwner, async (req, res) => {
  try {
    const storeId = parseInt(String(req.params.storeId));
    if (isNaN(storeId)) {
      res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
      return;
    }

    const { legalName, legalRepresentative, legalAddress, legalPhone, legalEmail, legalOther } =
      req.body as {
        legalName?: string;
        legalRepresentative?: string;
        legalAddress?: string;
        legalPhone?: string;
        legalEmail?: string;
        legalOther?: string;
      };

    const [updated] = await db
      .update(storesTable)
      .set({ legalName, legalRepresentative, legalAddress, legalPhone, legalEmail, legalOther })
      .where(eq(storesTable.id, storeId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not_found", message: "Store not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Failed to update legal info" });
  }
});

export default router;
