import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { storesTable, surpriseBagsTable, reportsTable, reviewsTable, reservationsTable, notificationsTable } from "@workspace/db/schema";
import { eq, sql, and, ne, gte, count, desc } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase";
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
 * Stripe JP に送る address_kanji / address_kana をまとめて正規化。
 * - kana側: 半角カナ→全角カナ + 数字を半角化
 * - 両方: townに数字混入してたら line1 に分離
 */
function buildJpAddress(k: {
  postalCode: string;
  stateKanji: string; cityKanji: string; townKanji: string; line1Kanji: string;
  stateKana:  string; cityKana:  string; townKana:  string; line1Kana:  string;
}) {
  const postal = (k.postalCode ?? '').replace(/[^0-9]/g, '');
  const kanjiSplit = splitTownLine1(k.townKanji ?? '', k.line1Kanji ?? '');
  const kanaRaw    = splitTownLine1(k.townKana  ?? '', k.line1Kana  ?? '');
  const kanaSplit = {
    town:  toFullWidthKana(kanaRaw.town),
    line1: toFullWidthKana(kanaRaw.line1),
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
      state:       toFullWidthKana((k.stateKana ?? '').trim()),
      city:        toFullWidthKana((k.cityKana  ?? '').trim()),
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
  // 本日完売 (social proof): 今日 JST に作られたバッグが在庫0なら true。
  //   ★ 決済で在庫0になると isActive=false になる (totalBagsAvailable からは消える) ため、
  //     ここは isActive を見ない (= 完売済み非アクティブも拾う)。
  //     前日出品 (pickupNextDay) のバッグは作成日が前日なので「今日 or 昨日 JST 作成」を対象にする。
  soldOutToday: sql<boolean>`COALESCE(BOOL_OR(
    ${surpriseBagsTable.stockCount} <= 0
    AND DATE(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')
        >= DATE(NOW() AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 day'
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
router.post("/stores/apply", requireAuth, async (req, res) => {
  try {
    const body = req.body;
    // ★ ownerId は認証トークンから取得（リクエストボディの ownerId は無視 = なりすまし防止）
    const ownerId = req.authUser!.id;
    console.log("[/stores/apply] 申請受付 ownerId=", ownerId, "name=", body.name);

    if (!body.name || !body.address || !body.city) {
      return res.status(400).json({ error: "bad_request", message: "必須項目（店舗名・住所・市区町村）が不足しています" });
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
            const { data: signedData } = await supabaseAdmin.storage
              .from("store-documents")
              .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);
            licenseImageUrl = signedData?.signedUrl ?? null;
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

    // Generate a long-lived signed URL (10 years) for admin review
    const { data: signedData, error: signedError } = await supabaseAdmin.storage
      .from("store-documents")
      .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);

    if (signedError) {
      console.warn("[upload-document] Failed to create signed URL:", signedError.message);
    }

    console.log("[upload-document] ✅ Uploaded:", filePath);
    res.json({ path: filePath, url: signedData?.signedUrl ?? `storage://${filePath}` });
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
          const { data: signedData } = await supabaseAdmin.storage
            .from("store-documents")
            .createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);
          if (signedData?.signedUrl) {
            updateData.licenseImageUrl = signedData.signedUrl;
            console.log(`[/reapply] ✅ 営業許可証 再アップロード完了: storeId=${storeId} path=${filePath}`);
          }
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

    const { returnUrl, refreshUrl } = req.body as { returnUrl?: string; refreshUrl?: string };

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
    const linkType: "account_onboarding" | "account_update" =
      account.details_submitted && currentlyDue.length > 0
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
    res.status(500).json({ error: "stripe_error", message: err?.message ?? "Failed to create account link" });
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
      const anchor = schedule.monthly_anchor;
      let next = new Date(year, month, anchor);
      if (next <= baseDate) next = new Date(year, month + 1, anchor);
      nextPayoutDate = next.toISOString().slice(0, 10);
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
    console.log(`📤 [KYC] Stripe accounts.update payload for account ${store.stripeAccountId}:`);
    console.log(JSON.stringify(updateParams, null, 2));

    const account = await stripe.accounts.update(store.stripeAccountId, updateParams as any);

    // ── 法人代表者を Persons API で登録/更新（accounts.update では設定不可）──
    if (resolvedBusinessType === 'company' && repPersonPayload !== null) {
      try {
        const kyc_existingPersons = await stripe.accounts.listPersons(store.stripeAccountId, { limit: 10 });
        const kyc_existing = kyc_existingPersons.data.find(p => p.relationship?.representative);
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

    // charges_enabled なら自動承認（デフォルトON。app_settings で 'false' を明示すると無効）
    let kycAutoApproved = false;
    if (account.charges_enabled) {
      try {
        const settingRows = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified'`);
        const settingVal = (settingRows.rows[0] as any)?.value ?? 'true';
        if (settingVal !== 'false') kycAutoApproved = true;
      } catch (_) {
        kycAutoApproved = true; // DB読み込みエラー時もデフォルトON
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
    // 個人事業主: individual.verification.document
    // 法人: representative.verification.document
    const existingAccount = await stripe.accounts.retrieve(store.stripeAccountId);
    const isCompany = existingAccount.business_type === "company";
    const verificationUpdate = isCompany
      ? { representative: { verification: { document: { [side]: file.id } } } }
      : { individual:     { verification: { document: { [side]: file.id } } } };

    console.log(`📤 [KYC-DOC] Sending verification to ${isCompany ? "representative" : "individual"}.verification.document`);

    // ── accounts.update で verification.document に fileId をセット ──
    const account = await stripe.accounts.update(store.stripeAccountId, verificationUpdate as any);

    console.log(`✅ [KYC-DOC] accounts.update succeeded for store ${storeId}`);
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
    console.log(`[bank-setup] 住所正規化結果 — kanji.town="${jpAddr.address_kanji.town}" line1="${jpAddr.address_kanji.line1}" / kana.town="${jpAddr.address_kana.town}" line1="${jpAddr.address_kana.line1}"`);

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

    console.log(`📤 [bank-setup] STEP4 accounts.update (sync): ${JSON.stringify(step4Payload, null, 2)}`);
    let kycWarning = false;
    try {
      const kycAcc = await stripeCall(
        stripe.accounts.update(accountId!, step4Payload as any),
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
        kycWarning = true;
      } else {
        console.log(`✅ [bank-setup] STEP4 OK — remaining currently_due (verification docs expected): ${JSON.stringify(stillDue)}`);
      }
    } catch (kycErr: any) {
      const errMsg = kycErr?.raw?.message ?? kycErr?.message ?? '';
      console.warn(`⚠️  [bank-setup] STEP4 accounts.update FAILED — reverting to pending: ${errMsg}`);
      // 個人情報が届かなかったのでステータスを pending に戻して再入力を促す
      try {
        await db.update(storesTable).set({ status: 'pending' }).where(eq(storesTable.id, storeId));
      } catch (_) {}
      kycWarning = true;
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
      repPayload.relationship = {
        representative:    true,
        director:          true,
        executive:         true,
        owner:             true,
        percent_ownership: 100,
        title:             k.representativeTitle?.trim() || "代表取締役",
      };
      // Stripe JP: 代表者の政治的関与を明示（未設定だと KYC pending になる場合がある）
      repPayload.political_exposure = "none";

      console.log(`📤 [bank-setup] STEP4b person payload: ${JSON.stringify(repPayload, null, 2)}`);
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
        // エラーをログに出すが処理は継続（書類なしでは一部要件が残るのは正常）
        console.warn(`⚠️  [bank-setup] STEP4b Persons API FAILED: ${personErr?.raw?.message ?? personErr?.message}`);
        console.warn(`   type=${personErr?.type} code=${personErr?.raw?.code ?? personErr?.code} param=${personErr?.raw?.param ?? personErr?.param}`);
        console.warn(`   raw: ${JSON.stringify(personErr?.raw ?? { message: personErr?.message })}`);
      }
    }

    // ── STEP 4b-2: directors_provided: true を送信（全取締役の情報が揃ったことを Stripe に通知）──
    // persons.create の後に設定しないと Stripe が受け付けない
    if (businessType === "company" && syncPersonId) {
      try {
        await stripeCall(
          stripe.accounts.update(accountId!, { company: { directors_provided: true } } as any),
          "accounts.update(directors_provided)", 10000
        );
        console.log(`✅ [bank-setup] STEP4b-2 directors_provided=true submitted`);
      } catch (dirErr: any) {
        console.warn(`⚠️  [bank-setup] STEP4b-2 directors_provided FAILED (non-fatal): ${dirErr?.raw?.message ?? dirErr?.message}`);
      }
    }

    // ── STEP 4c: 法人番号（tax_id）同期送信 ──
    if (businessType === "company") {
      const isTestKey = (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
      const rawTaxId  = (kycData.companyTaxId ?? "").replace(/-/g, '').trim();
      // ⚠️ "0000000000000" は Stripe JP テスト環境で invalid。テスト時は "9999999999999" を使用する
      const taxId = rawTaxId.length === 13 ? rawTaxId : (isTestKey ? "9999999999999" : null);
      if (taxId) {
        try {
          await stripeCall(
            stripe.accounts.update(accountId!, { company: { tax_id: taxId } } as any),
            "accounts.update(tax_id-sync)", 15000
          );
          console.log(`✅ [bank-setup] STEP4c company.tax_id submitted (test=${isTestKey})`);
        } catch (taxErr: any) {
          console.warn(`⚠️  [bank-setup] STEP4c tax_id FAILED (non-fatal): ${taxErr?.raw?.message ?? taxErr?.message}`);
        }
      }
    }

    // STEP1-4 完了 → クライアントにレスポンスを返す（BG は書類アップロードのみ）
    console.log(`✅ [bank-setup] STEP1-4 complete — responding to client (syncPersonId=${syncPersonId}, kycWarning=${kycWarning})`);
    res.json({ success: true, accountId, partial: true, kycWarning });

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

      if (frontFile) console.log(`✅ [bank-setup] BG Front doc: ${(frontFile as any).id}`);
      else           console.warn(`⚠️  [bank-setup] BG Front doc upload failed`);
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
              const { data: licSigned, error: licSignErr } = await supabaseAdmin.storage
                .from("store-documents")
                .createSignedUrl(licPath, 60 * 60 * 24 * 365 * 10);
              if (licSignErr || !licSigned?.signedUrl) {
                licenseUploadFailed = true;
                licenseUploadError = `signed_url: ${licSignErr?.message ?? "no_url"}`;
                console.error(`❌ [bank-setup] BG License signed URL FAILED (storeId=${storeId}): ${licSignErr?.message}`);
              } else {
                licenseImageUrl = licSigned.signedUrl;
                console.log(`✅ [bank-setup] BG License doc saved: ${licPath}`);
              }
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
          console.warn(`⚠️  [bank-setup] BG individual doc update FAILED: ${indDocErr?.raw?.message ?? indDocErr?.message}`);
        }
      }

      // 書類添付後の charges_enabled / payouts_enabled を確認
      let kycPayoutsEnabled: boolean | null = null;
      try {
        const refreshed = await stripeCall(
          stripe.accounts.retrieve(accountId!),
          "accounts.retrieve(post-docs)", 10000
        ) as any;
        kycChargesEnabled = refreshed?.charges_enabled ?? false;
        kycPayoutsEnabled = refreshed?.payouts_enabled ?? false;
        console.log(`   post-docs charges_enabled=${refreshed?.charges_enabled} payouts_enabled=${refreshed?.payouts_enabled}`);
        console.log(`   post-docs currently_due: ${JSON.stringify(refreshed?.requirements?.currently_due)}`);
        console.log(`   post-docs eventually_due: ${JSON.stringify(refreshed?.requirements?.eventually_due)}`);
      } catch (_) {}

      // STEP 5: DB 更新 + オーナーの role を確実に store_owner に設定
      // charges_enabled なら自動承認（デフォルトON。app_settings で 'false' を明示すると無効）
      let autoApproved = false;
      if (kycChargesEnabled === true) {
        try {
          const settingRows = await db.execute(sql`SELECT value FROM app_settings WHERE key = 'auto_approve_stripe_verified'`);
          const settingVal = (settingRows.rows[0] as any)?.value ?? 'true';
          if (settingVal !== 'false') autoApproved = true;
        } catch (_) {
          autoApproved = true; // DB読み込みエラー時もデフォルトON
        }
      }

      const newStatus = autoApproved ? "approved" : "applied";
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
