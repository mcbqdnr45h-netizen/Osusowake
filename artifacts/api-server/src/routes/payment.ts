import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { reservationsTable, surpriseBagsTable, storesTable, cartReservationsTable, notificationsTable } from "@workspace/db/schema";
import { eq, sql, and, ne } from "drizzle-orm";
import { sendPushToUser, storeOrderPushEnabled } from "../lib/push.js";
import { sendOrderEmailToStoreOwnerById } from "../utils/emails";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middlewares/auth.js";
import { isReviewDemoOwner } from "../lib/app-review.js";
import { invalidate } from "../lib/ttl-cache.js";
import {
  CreatePaymentIntentBody,
  ConfirmPaymentBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// App Store 審査用 決済バイパス
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Apple 審査員はテストカード (4242…) を使うが、当アプリは Stripe LIVE モードで
// 稼働しているためテストカードが拒否される。Apple App Review Guideline 2.3.10
// 「テスト用アカウントには完全な動作確認手段を提供せよ」に従い、登録された審査用
// メールアドレスでログインしているユーザーに限り、Stripe call をスキップして
// 予約を直接 confirm する。本番ユーザーには一切影響しない。
//
// セキュリティ:
//   - 完全一致のメールアドレスチェックのみで分岐（部分一致禁止）
//   - 該当ユーザーのパスワードは 20 文字ランダム生成済
//   - bypass 利用時は payment_intent_id に "pi_review_bypass_" プレフィックス
//     を付与し、Stripe Dashboard / 集計クエリから容易に除外可能
//   - 在庫減算もスキップするため審査用デモ店舗の在庫が枯渇しない
const REVIEW_BYPASS_PI_PREFIX = "pi_review_bypass_";
// ★ Fail-closed (#5): APP_REVIEW_BYPASS_EMAILS env が空なら bypass を完全停止する。
//   従来は "review-user@osusowakejapan.org" がデフォルト許可されていたが、
//   env 未設定 + そのアカウントがハイジャックされた場合に即時悪用可能だった。
//   Apple 審査時は必ず env を設定することを運用フローに追加すること。
function isAppReviewBypassEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const raw = process.env.APP_REVIEW_BYPASS_EMAILS?.trim();
  if (!raw) return false;
  const list = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

// ── App Review Bypass 監査ログ (#5) ─────────────────────────────────────────────
// bypass 経由のすべての決済を admin_audit_log に記録し、 不正利用を事後追跡可能に。
async function logBypassAudit(opts: {
  email: string;
  reservationId: number;
  endpoint: string;
  paymentIntentId?: string;
  amount?: number;
}): Promise<void> {
  try {
    await supabaseAdmin.from("admin_audit_log").insert({
      admin_email: opts.email,
      action: `app_review_bypass:${opts.endpoint}`,
      target_id: String(opts.reservationId),
      details: {
        paymentIntentId: opts.paymentIntentId ?? null,
        amount: opts.amount ?? null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.warn("[bypass-audit] write failed:", (e as Error).message);
  }
}

// ─── 手数料定数 ─────────────────────────────────────────────────────────────
// プラットフォーム手数料率（店舗側）: 20%（固定）。商品代金 (merchandise) に対して課金。
const PLATFORM_FEE_RATE = 0.20;
// Stripe 決済手数料率（JPY カード平均 3.6%）。実際にStripeから引かれるのは
// 顧客支払合計 (totalAmountJpy = ユーザー支払額) に対する 3.6%。
const STRIPE_FEE_RATE = 0.036;
// ユーザー側「システム利用料」: 5%（参考値、計算には使わない）
const USER_SERVICE_FEE_RATE = 0.05;

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 送金額の明示的計算ロジック（新収益モデル）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  入力:
 *    totalAmountJpy  = ユーザー支払合計 (= round10(merchandise * 1.05))
 *    merchandiseJpy  = 商品代金 (= bag.discountedPrice * quantity)
 *
 *  Step 1. ShopGross（店舗売上 = 20%控除後の店舗取り分・Stripe手数料前）
 *          = Math.floor(merchandiseJpy × 0.80)
 *
 *  Step 2. StripeFee（Stripe決済手数料）
 *          = Math.round(totalAmountJpy × 0.036)
 *
 *  Step 3. ShopTransferAmount（店舗への実送金額）
 *          = ShopGross - StripeFee
 *
 *  Step 4. PlatformRevenue（プラットフォーム純利益）
 *          = totalAmountJpy - ShopGross
 *          (内訳: 20% 店舗手数料 + 5% ユーザー利用料 + 端数調整)
 *
 *  例（merchandise = 350円, total = round10(350 × 1.05) = 370円）:
 *    ShopGross          = floor(350 × 0.80)          = 280円
 *    StripeFee          = round(370 × 0.036)         =  13円
 *    ShopTransferAmount = 280 - 13                    = 267円  ← 店舗実入金
 *    PlatformRevenue    = 370 - 280                   =  90円  ← プラットフォームNet（Stripe手数料前）
 *
 *    検算: 顧客 370 = 店舗 267 + Stripe 13 + プラットフォーム 90 ✓
 *    プラットフォーム純利益: 90円（= total - shopGross）
 *      ※ Stripe手数料13円は shopTransferAmount 側で差し引かれる（＝店舗が負担）ため、
 *        プラットフォームは platformRevenue を満額受け取る。
 *    内訳: 店舗手数料(350×20%=70円) + ユーザー利用料(total-merch = 370-350 = 20円) = 90円
 */
function calcFees(totalAmountJpy: number, merchandiseJpy: number): {
  platformRevenue: number;     // プラットフォーム取り分（Stripe手数料控除前）
  stripeFee: number;           // Stripe手数料（事前計算）
  shopTransferAmount: number;  // 店舗への実送金額
  shopGross: number;           // 店舗売上（20%控除後・Stripe手数料前）
} {
  const shopGross          = Math.floor(merchandiseJpy * (1 - PLATFORM_FEE_RATE)); // Step 1
  const stripeFee          = Math.round(totalAmountJpy * STRIPE_FEE_RATE);          // Step 2
  const shopTransferAmount = shopGross - stripeFee;                                 // Step 3
  const platformRevenue    = totalAmountJpy - shopGross;                            // Step 4
  return { platformRevenue, stripeFee, shopTransferAmount, shopGross };
}

/**
 * 旧データ互換: merchandiseAmount が NULL の予約 (新カラム追加前のデータ) は、
 * totalPrice が商品代金そのものとして扱われる旧仕様の値が入っている。
 */
function resolveMerchandise(reservation: { totalPrice: number; merchandiseAmount: number | null }): number {
  return reservation.merchandiseAmount ?? reservation.totalPrice;
}
void USER_SERVICE_FEE_RATE; // 参照警告抑制（将来の拡張用に保持）

/**
 * StripeのCustomerを取得または新規作成し、IDをSupabaseユーザーメタデータに保存する
 * カードの2回目以降自動入力（Saved Payment Methods）に使用
 */
async function getOrCreateStripeCustomer(stripe: any, userId: string): Promise<string | null> {
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !user) return null;

    const existingId = (user.user_metadata as any)?.stripe_customer_id as string | undefined;
    if (existingId) return existingId;

    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { supabase_user_id: userId },
    });

    await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: { ...(user.user_metadata as any), stripe_customer_id: customer.id },
    });

    console.log(`[getOrCreateStripeCustomer] created customer ${customer.id} for user ${userId}`);
    return customer.id;
  } catch (e) {
    console.error("[getOrCreateStripeCustomer] error:", e);
    return null;
  }
}

/** Stripe Connect エラーかどうか判定 */
function isStripeConnectError(err: any): boolean {
  return (
    err?.code === "transfers_not_allowed" ||
    err?.code === "account_invalid" ||
    err?.code === "on_behalf_of_not_allowed" ||
    err?.code === "account_country_invalid_address" ||
    err?.type === "StripeInvalidRequestError"
  );
}

/**
 * 既存 PaymentIntent を retrieve して「まだ支払い可能」な状態か判定し、
 * 再利用できればその client_secret を返す。
 * → チェックアウト画面を再ロード／戻る／ホットリロードしても新規 PI が
 *   作成されず Stripe ダッシュボードの「未完了」が増殖しない。
 */
const REUSABLE_PI_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

async function buildCustomerSessionSecret(
  stripe: any,
  customerId: string | null,
): Promise<string | null> {
  if (!customerId) return null;
  try {
    const session = await stripe.customerSessions.create({
      customer: customerId,
      components: {
        payment_element: {
          enabled:  true,
          features: {
            payment_method_redisplay:  "enabled",
            payment_method_save:       "enabled",
            payment_method_save_usage: "off_session",
            payment_method_remove:     "enabled",
          },
        },
      },
    });
    return session?.client_secret ?? null;
  } catch (e: any) {
    console.warn("[create-intent] customerSessions.create failed:", e?.message);
    return null;
  }
}

router.post("/payment/create-intent", requireAuth, async (req, res) => {
  try {
    const body = CreatePaymentIntentBody.parse(req.body);

    const [reservation] = await db
      .select({
        id:                reservationsTable.id,
        userId:            reservationsTable.userId,
        totalPrice:        reservationsTable.totalPrice,
        merchandiseAmount: reservationsTable.merchandiseAmount,
        paymentStatus:     reservationsTable.paymentStatus,
        bagId:             reservationsTable.bagId,
        storeId:           reservationsTable.storeId,
        paymentIntentId:   reservationsTable.paymentIntentId,
        status:            reservationsTable.status,
        quantity:          reservationsTable.quantity,
      })
      .from(reservationsTable)
      .where(eq(reservationsTable.id, body.reservationId));

    if (!reservation) {
      res.status(404).json({ error: "not_found", message: "Reservation not found" });
      return;
    }

    // ★ 認可: 予約の所有者本人のみ PaymentIntent を作成可能
    if (reservation.userId !== req.authUser!.id) {
      console.warn(`[SECURITY] /payment/create-intent: reservation ${reservation.id} owner=${reservation.userId} requester=${req.authUser!.id}`);
      res.status(403).json({ error: "forbidden", message: "この予約を操作する権限がありません" });
      return;
    }

    // ★ 課金前の在庫プリチェック ──────────────────────────────────────────
    //   既に完売/非公開/キャンセル済みなら、 課金させずにここで弾く。
    //   → 「決済→自動返金」の無駄（Stripe 手数料・買い手の混乱）を防ぐ。
    //   決済処理中の数秒で売り切れる稀なレースは /payment/confirm 側の自動返金が保険。
    //   ※ 既に paid の予約は再課金しないようスキップ（冪等）。
    if ((reservation.status as string) === "cancelled") {
      res.status(409).json({ error: "cancelled", message: "この予約はキャンセルされています（決済は行われていません）" });
      return;
    }
    if (reservation.paymentStatus !== "paid") {
      const [bagRow] = await db
        .select({ stock: surpriseBagsTable.stockCount, isActive: surpriseBagsTable.isActive })
        .from(surpriseBagsTable)
        .where(eq(surpriseBagsTable.id, reservation.bagId));
      if (!bagRow || !bagRow.isActive || bagRow.stock < reservation.quantity) {
        // 売り切れ確定 → この予約はもう成立しないので即キャンセルし、
        //   「未決済の予約があります」バナーに残り続けないようにする（在庫・課金とも無関係）。
        await db.update(reservationsTable).set({ status: "cancelled" }).where(eq(reservationsTable.id, reservation.id));
        res.status(409).json({ error: "out_of_stock", message: "申し訳ありません、 売り切れました（決済は行われていません）" });
        return;
      }
    }

    // ━━ App Store 審査用 決済バイパス ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 認可済みユーザーが審査用メールアドレスの場合、Stripe call を完全にスキップして
    // sentinel な paymentIntentId を返す。フロントは clientSecret === "REVIEW_BYPASS"
    // または reviewBypass === true を見て決済 UI を飛ばし、直接 /payment/confirm を呼ぶ。
    const reqUserEmail = req.authUser?.email;
    if (isAppReviewBypassEmail(reqUserEmail)) {
      const sentinelPiId = `${REVIEW_BYPASS_PI_PREFIX}${reservation.id}_${Date.now()}`;
      await db
        .update(reservationsTable)
        .set({ paymentIntentId: sentinelPiId })
        .where(eq(reservationsTable.id, reservation.id));
      console.warn(
        `🎯 [APP_REVIEW_BYPASS] /payment/create-intent SKIPPED Stripe — ` +
        `email=${reqUserEmail} reservation=${reservation.id} sentinelPI=${sentinelPiId}`,
      );
      // ★ 監査ログ (#5) — bypass 経由の全アクセスを admin_audit_log に記録
      await logBypassAudit({
        email: reqUserEmail!,
        reservationId: reservation.id,
        endpoint: "create-intent",
        paymentIntentId: sentinelPiId,
        amount: Math.round(reservation.totalPrice),
      });
      res.json({
        clientSecret: "REVIEW_BYPASS",
        paymentIntentId: sentinelPiId,
        amount: Math.round(reservation.totalPrice),
        currency: "jpy",
        reviewBypass: true,
      });
      return;
    }

    const total       = Math.round(reservation.totalPrice);
    const merchandise = Math.round(resolveMerchandise(reservation));
    // ── 送金額の明示的計算（新収益モデル）──────────────────────
    // ShopGross   = floor(merchandise × 75%)
    // StripeFee   = round(total × 3.6%)
    // ShopTransfer= ShopGross - StripeFee
    // PlatformRev = total - ShopGross
    const { platformRevenue, stripeFee, shopTransferAmount } = calcFees(total, merchandise);

    const stripeKey = process.env["STRIPE_SECRET_KEY"];

    if (stripeKey) {
      const [store] = await db
        .select({ stripeAccountId: storesTable.stripeAccountId, name: storesTable.name, id: storesTable.id })
        .from(storesTable)
        .where(eq(storesTable.id, reservation.storeId));

      const destinationAccountId = store?.stripeAccountId ?? null;

      try {
        const stripe = await import("stripe").then((m) => new m.default(stripeKey));

        // Stripe Customer 取得/作成（保存カードの自動表示のため）
        // 認可: クライアントから渡された userId は信頼せず、必ず認証済みユーザの ID を使う
        const userId = req.authUser!.id;
        const customerId = userId ? await getOrCreateStripeCustomer(stripe, userId) : null;

        // ── 既存 PI の再利用チェック（Stripe ダッシュボード「未完了」増殖防止）─────
        // チェックアウト画面の戻る／再ロード／ホットリロードで毎回新しい PI を
        // 作っていたため、放棄されたチェックアウトが大量に「未完了」として残っていた。
        // 同じ予約・同じ金額・再利用可能ステータスなら既存 PI を返す。
        const existingPiId = reservation.paymentIntentId;
        if (
          existingPiId &&
          !existingPiId.startsWith("pi_mock_") &&
          reservation.status !== "cancelled"
        ) {
          try {
            const existing = await stripe.paymentIntents.retrieve(existingPiId);
            const reusable =
              REUSABLE_PI_STATUSES.has(existing.status) &&
              existing.amount === total;
            if (reusable) {
              const sessSecret = await buildCustomerSessionSecret(
                stripe as any,
                customerId,
              );
              console.log(
                `♻️  PaymentIntent reused: ${existing.id} (status=${existing.status})`,
              );
              res.json({
                clientSecret:                existing.client_secret,
                customerSessionClientSecret: sessSecret,
                paymentIntentId:             existing.id,
                amount:                      existing.amount,
                currency:                    "jpy",
                platformRevenue,
                stripeFee,
                shopTransferAmount,
                chargeMode:                  "reused",
              });
              return;
            }
            // 金額が変わった等で再利用不可 → 古い PI は明示的にキャンセル
            if (REUSABLE_PI_STATUSES.has(existing.status)) {
              try {
                await stripe.paymentIntents.cancel(existing.id);
                console.log(
                  `🗑️  Cancelled stale PI ${existing.id} (amount/status mismatch)`,
                );
              } catch (cancelErr: any) {
                console.warn(
                  `[create-intent] cancel stale PI failed:`,
                  cancelErr?.message,
                );
              }
            }
          } catch (retrieveErr: any) {
            console.warn(
              `[create-intent] retrieve existing PI ${existingPiId} failed:`,
              retrieveErr?.message,
            );
            // retrieve に失敗 → 新規作成へ進む
          }
        }

        // ── Customer Session（保存済カードの再表示・保存・削除 UI を有効化）─────────
        // payment_method_types を ["card"] で固定すると、PaymentElement は customer_session
        // が無いと saved methods を一切表示しない。ここで明示的にセッションを作る。
        const customerSessionClientSecret = await buildCustomerSessionSecret(
          stripe as any,
          customerId,
        );

        // Stripeダッシュボードのメタデータで「どの店舗の売上か」を判別可能にする
        // store_id / store_name を必ず付与することで、1アカウント多店舗でも識別できる
        const feeMetadata = {
          reservationId:      String(reservation.id),
          store_id:           String(store?.id ?? reservation.storeId),
          store_name:         store?.name ?? "不明な店舗",
          platformFeeRate:    "20%",
          userServiceFeeRate: "5%",
          merchandiseAmount:  String(merchandise),         // 商品代金（20%課金ベース）
          platformRevenue:    String(platformRevenue),     // = total - floor(merch × 0.80)
          stripeFee:          String(stripeFee),           // = round(total × 0.036)
          shopTransferAmount: String(shopTransferAmount),  // = floor(merch × 0.80) - stripeFee
        };

        const baseParams: Parameters<typeof stripe.paymentIntents.create>[0] = {
          amount:   total,
          currency: "jpy",
          metadata: feeMetadata,
          // カード決済のみ許可（Stripe Link は無効化 — 日本ユーザーには馴染みがないため）
          payment_method_types: ["card"],
          // カスタマーを指定 → 次回以降は保存済みカードが自動表示される
          ...(customerId ? { customer: customerId, setup_future_usage: "off_session" } : {}),
        };

        let intent;
        let chargeMode = "direct";

        if (destinationAccountId) {
          // ── Tier 1: ShopTransferAmount を transfer_data.amount に直接指定 ──
          // = (total - PlatformRevenue) - StripeFee
          // プラットフォームNet = total - stripeFee - shopTransferAmount = PlatformRevenue
          try {
            intent = await stripe.paymentIntents.create({
              ...baseParams,
              transfer_data: {
                destination: destinationAccountId,
                amount:      shopTransferAmount, // ← ShopTransferAmount を直接指定
              },
            });
            chargeMode = "explicit_transfer_amount";
            console.log(
              `✅ PaymentIntent Tier1: ` +
              `total=${total}JPY | ` +
              `PlatformRevenue=${platformRevenue}JPY (20%) | ` +
              `StripeFee≈${stripeFee}JPY | ` +
              `ShopTransfer=${shopTransferAmount}JPY (明示) | ` +
              `Net=${platformRevenue}JPY ✓`
            );
          } catch (t1Err: any) {
            if (!isStripeConnectError(t1Err)) throw t1Err;
            console.warn(`⚠️  Tier1 失敗 [${t1Err.code ?? t1Err.type}] — Tier2 へ`);

            // ── Tier 2: application_fee_amount フォールバック ────────────────
            // ⚠️ デスティネーションチャージでは application_fee_amount = total - shopTransferAmount
            //    (= platformRevenue + stripeFee) にしないと店舗送金額がずれる:
            //    store受取 = total - application_fee_amount = total - (total - shopTransfer)
            //             = shopTransfer = 267円 ✓
            //    platform純利 = application_fee (103) - Stripe手数料 (13) = 90円 ✓
            const applicationFeeAmount = total - shopTransferAmount; // = platformRevenue + stripeFee
            try {
              intent = await stripe.paymentIntents.create({
                ...baseParams,
                application_fee_amount: applicationFeeAmount,
                transfer_data:          { destination: destinationAccountId },
              });
              chargeMode = "application_fee_amount";
              console.warn(`⚠️  Tier2: total=${total}JPY, appFee=${applicationFeeAmount}JPY, shopTransfer=${shopTransferAmount}JPY, dest=${destinationAccountId}`);
            } catch (t2Err: any) {
              if (!isStripeConnectError(t2Err)) throw t2Err;
              console.warn(`⚠️  Tier2 失敗 — 直接決済へ`);
              intent = await stripe.paymentIntents.create(baseParams);
              chargeMode = "direct";
            }
          }
        } else {
          intent = await stripe.paymentIntents.create(baseParams);
        }

        await db
          .update(reservationsTable)
          .set({ paymentIntentId: intent.id })
          .where(eq(reservationsTable.id, reservation.id));

        res.json({
          clientSecret:                 intent.client_secret,
          customerSessionClientSecret,
          paymentIntentId:              intent.id,
          amount:                       total,
          currency:                     "jpy",
          platformRevenue,
          stripeFee,
          shopTransferAmount,
          chargeMode,
        });
        return;
      } catch (stripeErr) {
        console.error("Stripe PaymentIntent error:", stripeErr);
      }
    }

    // Stripe 未設定時のモックフォールバック
    const mockIntentId = `pi_mock_${Date.now()}`;
    await db
      .update(reservationsTable)
      .set({ paymentIntentId: mockIntentId })
      .where(eq(reservationsTable.id, reservation.id));

    res.json({
      clientSecret:       `${mockIntentId}_secret_mock`,
      paymentIntentId:    mockIntentId,
      amount:             total,
      currency:           "jpy",
      platformRevenue,
      stripeFee,
      shopTransferAmount,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Failed to create payment intent" });
  }
});

router.post("/payment/confirm", requireAuth, async (req, res) => {
  try {
    const body = ConfirmPaymentBody.parse(req.body);

    // ★ 事前チェック: 予約所有者の本人確認
    const [preReservation] = await db
      .select({
        id:         reservationsTable.id,
        userId:     reservationsTable.userId,
        totalPrice: reservationsTable.totalPrice,
      })
      .from(reservationsTable)
      .where(eq(reservationsTable.id, body.reservationId));

    if (!preReservation) {
      res.status(404).json({ error: "not_found", message: "Reservation not found" });
      return;
    }
    if (preReservation.userId !== req.authUser!.id) {
      console.warn(`[SECURITY] /payment/confirm: reservation ${preReservation.id} owner=${preReservation.userId} requester=${req.authUser!.id}`);
      res.status(403).json({ error: "forbidden", message: "この予約を操作する権限がありません" });
      return;
    }

    // ★ Stripe 検証: 本物の paymentIntent が succeeded であることをサーバ側で確認
    //   これがないと、攻撃者が任意の文字列を paymentIntentId として送るだけで
    //   無料で予約を paid にできてしまう（致命的脆弱性）。
    //   テスト用 mock (`pi_mock_`) は STRIPE_SECRET_KEY 未設定時のみ許可する。
    const stripeKeyForVerify = process.env["STRIPE_SECRET_KEY"];
    const isMock = body.paymentIntentId.startsWith("pi_mock_");
    // ━━ App Store 審査用 決済バイパス ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // sentinel な PI ("pi_review_bypass_") かつログイン中のユーザーが審査用メール
    // アドレスの場合のみ Stripe verify をスキップする。両方の条件が満たされない限り
    // 通常の verify を行うため、攻撃者がメールアドレスを偽装したり sentinel PI を
    // 偶然送りつけても突破できない。
    const confirmUserEmail = req.authUser?.email;
    const isReviewBypass =
      body.paymentIntentId.startsWith(REVIEW_BYPASS_PI_PREFIX) &&
      isAppReviewBypassEmail(confirmUserEmail);
    if (isReviewBypass) {
      console.warn(
        `🎯 [APP_REVIEW_BYPASS] /payment/confirm SKIPPED Stripe verify — ` +
        `email=${confirmUserEmail} reservation=${body.reservationId} sentinelPI=${body.paymentIntentId}`,
      );
      // ★ 監査ログ (#5)
      await logBypassAudit({
        email: confirmUserEmail!,
        reservationId: body.reservationId,
        endpoint: "confirm",
        paymentIntentId: body.paymentIntentId,
        amount: Math.round(preReservation.totalPrice),
      });
    }
    if (!isMock && !isReviewBypass) {
      if (!stripeKeyForVerify) {
        res.status(503).json({ error: "stripe_not_configured", message: "Stripe が設定されていません" });
        return;
      }
      try {
        const stripeVerify = await import("stripe").then((m) => new m.default(stripeKeyForVerify));
        const intent = await stripeVerify.paymentIntents.retrieve(body.paymentIntentId);
        if (intent.status !== "succeeded") {
          console.warn(`[SECURITY] /payment/confirm: PI ${intent.id} status=${intent.status} (not succeeded) reservation=${body.reservationId}`);
          res.status(402).json({ error: "payment_not_succeeded", message: "決済が完了していません", stripeStatus: intent.status });
          return;
        }
        const piReservationId = parseInt(intent.metadata?.reservationId ?? "", 10);
        if (piReservationId !== body.reservationId) {
          console.warn(`[SECURITY] /payment/confirm: PI ${intent.id} metadata.reservationId=${piReservationId} mismatch with body.reservationId=${body.reservationId}`);
          res.status(403).json({ error: "reservation_mismatch", message: "決済情報と予約が一致しません" });
          return;
        }
        if (intent.amount !== Math.round(preReservation.totalPrice)) {
          console.warn(`[SECURITY] /payment/confirm: PI ${intent.id} amount=${intent.amount} mismatch with reservation.totalPrice=${preReservation.totalPrice}`);
          res.status(403).json({ error: "amount_mismatch", message: "決済金額が一致しません" });
          return;
        }
      } catch (verifyErr: any) {
        console.error(`[SECURITY] /payment/confirm: Stripe verify failed for PI ${body.paymentIntentId}:`, verifyErr?.message);
        res.status(402).json({ error: "stripe_verify_failed", message: "決済情報の検証に失敗しました" });
        return;
      }
    } else if (isMock && stripeKeyForVerify) {
      // 本番モード（STRIPE_SECRET_KEY 設定済）で pi_mock_ を弾く。
      // ※ pi_review_bypass_ はメールアドレス allowlist 経由でのみ通すので
      //   ここの分岐には入らない（isReviewBypass=true → 第一の if が false にならない）。
      // ※ ローカル dev (stripeKeyForVerify=undefined) で pi_mock_ を許可するのは
      //   テスト用の意図的な fallback。本番では STRIPE_SECRET_KEY が必ず存在する前提。
      console.warn(`[SECURITY] /payment/confirm: pi_mock_ rejected because Stripe is configured (reservation=${body.reservationId})`);
      res.status(403).json({ error: "mock_not_allowed", message: "テスト用の決済IDは本番で使用できません" });
      return;
    }

    // ★ アトミック決済確定（仮押さえ廃止後の中核ロジック）─────────────────────
    //   ① 予約行を FOR UPDATE でロック
    //   ② 既に paid → 冪等スキップ（フロント confirm と webhook の二重走行対策）
    //   ③ 商品行を FOR UPDATE でロック → 在庫不足なら refund フラグを立てて終了
    //   ④ 在庫を購入数だけデクリメント（0 になったら自動的に非公開化）
    //   ⑤ 予約を paid/confirmed に遷移
    //   トランザクションの直列化により「在庫1の同時決済」でも 1 人だけ確定する。
    // ───────────────────────────────────────────────────────────────────────────
    type ConfirmResult =
      | { kind: "not_found" }
      | { kind: "already_cancelled" }
      | { kind: "already_paid"; reservation: typeof reservationsTable.$inferSelect }
      | { kind: "out_of_stock"; reservation: typeof reservationsTable.$inferSelect }
      | { kind: "unpublished";  reservation: typeof reservationsTable.$inferSelect }
      | { kind: "paid";         reservation: typeof reservationsTable.$inferSelect; pickupCode: string | null };

    const result: ConfirmResult = await db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(reservationsTable)
        .where(eq(reservationsTable.id, body.reservationId))
        .for("update");

      if (!reservation) return { kind: "not_found" };

      if (reservation.status === "cancelled" || reservation.paymentStatus === "refunded") {
        return { kind: "already_cancelled" };
      }

      if (reservation.paymentStatus === "paid") {
        return { kind: "already_paid", reservation };
      }

      // 商品在庫を行ロックして取得
      const [bag] = await tx
        .select()
        .from(surpriseBagsTable)
        .where(eq(surpriseBagsTable.id, reservation.bagId))
        .for("update");

      if (!bag) {
        // bag 自体が消えている → 在庫切れ扱い
        await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "refunded",
            status: "cancelled",
            paymentIntentId: body.paymentIntentId,
          })
          .where(eq(reservationsTable.id, reservation.id));
        return { kind: "out_of_stock", reservation };
      }

      // 店舗側で非公開化された (isActive=false) → 決済を成立させず自動返金。
      // race condition: ユーザーが決済画面に進んだ直後に店舗が非公開化したケース。
      // App Review Bypass より先に判定 (審査用デモバッグは常に isActive=true 想定)。
      if (!bag.isActive) {
        await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "refunded",
            status: "cancelled",
            paymentIntentId: body.paymentIntentId,
          })
          .where(eq(reservationsTable.id, reservation.id));
        return { kind: "unpublished", reservation };
      }

      // ━━ App Review Bypass: 在庫減算をスキップして審査用デモバッグの在庫を維持 ━━
      // 二重ガード: 審査メール ∧ デモストアオーナー の両方一致のときのみバイパス。
      // 万一 review-user が実店舗のバッグを購入しても在庫は通常通り減らす。
      const bagStoreRows = await tx
        .select({ ownerId: storesTable.ownerId })
        .from(storesTable)
        .where(eq(storesTable.id, bag.storeId))
        .limit(1);
      const isReviewDemoBag = isReviewDemoOwner(bagStoreRows[0]?.ownerId ?? null);
      if (isReviewBypass && isReviewDemoBag) {
        const [updated] = await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "paid",
            status: "confirmed",
            paymentIntentId: body.paymentIntentId,
          })
          .where(eq(reservationsTable.id, reservation.id))
          .returning();
        return { kind: "paid", reservation: updated, pickupCode: updated.pickupCode };
      }

      if (bag.stockCount < reservation.quantity) {
        // 在庫切れ → 自動返金フラグを立てるため予約を refunded/cancelled に
        await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "refunded",
            status: "cancelled",
            paymentIntentId: body.paymentIntentId,
          })
          .where(eq(reservationsTable.id, reservation.id));
        return { kind: "out_of_stock", reservation };
      }

      // 在庫 OK → 原子的にデクリメント＋ paid 遷移
      const newStock = bag.stockCount - reservation.quantity;
      await tx
        .update(surpriseBagsTable)
        .set({
          stockCount: newStock,
          // 在庫が 0 になったら自動的に非公開
          ...(newStock === 0 ? { isActive: false } : {}),
        })
        .where(eq(surpriseBagsTable.id, bag.id));

      const [updated] = await tx
        .update(reservationsTable)
        .set({
          paymentStatus: "paid",
          status: "confirmed",
          paymentIntentId: body.paymentIntentId,
        })
        .where(eq(reservationsTable.id, reservation.id))
        .returning();

      return { kind: "paid", reservation: updated, pickupCode: updated.pickupCode };
    });

    // ── 結果に応じてレスポンスとサイドエフェクト ──────────────────────────────
    if (result.kind === "not_found") {
      res.status(404).json({ error: "not_found", message: "Reservation not found" });
      return;
    }

    if (result.kind === "already_cancelled") {
      res.status(409).json({
        error: "already_cancelled",
        message: "この予約は既にキャンセル済みです。",
      });
      return;
    }

    if (result.kind === "out_of_stock") {
      // ❗ 決済は成立してしまったが在庫切れ → Stripe で自動返金
      const stripeKey = process.env["STRIPE_SECRET_KEY"];
      if (stripeKey && body.paymentIntentId && !body.paymentIntentId.startsWith("pi_mock_")) {
        try {
          const stripe = await import("stripe").then((m) => new m.default(stripeKey));
          await stripe.refunds.create({
            payment_intent: body.paymentIntentId,
            reason: "requested_by_customer",
            metadata: {
              reservationId: String(body.reservationId),
              reason: "out_of_stock_after_payment",
            },
          });
          console.log(`💸 自動返金実行: PI ${body.paymentIntentId} (reservation ${body.reservationId}, 在庫切れ)`);
        } catch (refundErr: any) {
          console.error(`[payment] /confirm: Stripe refund failed for ${body.paymentIntentId}:`, refundErr?.message);
        }
      }
      res.status(409).json({
        error: "sold_out_refunded",
        message: "残念ながら他の方が一足先にご購入されました。お支払いは自動的に全額返金されます（数日以内に反映）。",
      });
      return;
    }

    if (result.kind === "unpublished") {
      // ❗ 決済は成立してしまったが店舗側で販売停止 → Stripe で自動返金
      const stripeKey = process.env["STRIPE_SECRET_KEY"];
      if (stripeKey && body.paymentIntentId && !body.paymentIntentId.startsWith("pi_mock_")) {
        try {
          const stripe = await import("stripe").then((m) => new m.default(stripeKey));
          await stripe.refunds.create({
            payment_intent: body.paymentIntentId,
            reason: "requested_by_customer",
            metadata: {
              reservationId: String(body.reservationId),
              reason: "unpublished_after_payment",
            },
          });
          console.log(`💸 自動返金実行: PI ${body.paymentIntentId} (reservation ${body.reservationId}, 店舗側で販売停止)`);
        } catch (refundErr: any) {
          console.error(`[payment] /confirm: Stripe refund failed for ${body.paymentIntentId}:`, refundErr?.message);
        }
      }
      res.status(409).json({
        error: "unpublished_refunded",
        message: "店舗側でこの商品の販売が停止されました。お支払いは自動的に全額返金されます（数日以内に反映）。",
      });
      return;
    }

    // ★ 在庫が減った/売り切れた → 一覧キャッシュを破棄（他ユーザーに古い在庫数を見せない）。
    //   これが無いと最大10秒「在庫あり」表示が残り、買えると思って決済→在庫切れ返金のUX事故になる。
    invalidate("bags:list"); invalidate("stores:list");

    // 既に paid / 今回 paid に遷移 — どちらも updated を返す
    const updated = result.reservation;
    res.json({
      id:                updated.id,
      userId:            updated.userId,
      bagId:             updated.bagId,
      storeId:           updated.storeId,
      quantity:          updated.quantity,
      totalPrice:        updated.totalPrice,
      merchandiseAmount: updated.merchandiseAmount,
      status:            updated.status,
      paymentIntentId:   updated.paymentIntentId,
      paymentStatus:     updated.paymentStatus,
      pickupCode:        updated.pickupCode,
      createdAt:         updated.createdAt,
      bag: null,
      store: null,
    });

    // 店舗オーナー / 購入者への購入通知
    //   - 過去は setImmediate + "kind=paid 限定" で送っていたが、
    //     ① Replit autoscale が応答後に worker をリサイクルすると setImmediate が消える
    //     ② webhook/verify-session/confirm の競合で誰も push しないケースがあった
    //   → setImmediate を外して inline await。kind 制限も外す。
    //     DB 二重挿入は事前 select で防止。push は APNs tag で端末側 dedupe される。
    try {
      console.log(`[payment] /confirm: 通知ブロック開始 reservation=${updated.id} kind=${result.kind}`);
      const [[store], [bag]] = await Promise.all([
        db.select({ ownerId: storesTable.ownerId, name: storesTable.name })
          .from(storesTable).where(eq(storesTable.id, updated.storeId)).limit(1),
        db.select({ id: surpriseBagsTable.id, title: surpriseBagsTable.title, pickupStart: surpriseBagsTable.pickupStart, pickupEnd: surpriseBagsTable.pickupEnd })
          .from(surpriseBagsTable).where(eq(surpriseBagsTable.id, updated.bagId)).limit(1),
      ]);

      // 店舗オーナー通知
      if (store?.ownerId) {
        const ownerTitle = "【重要】おすそわけバッグが購入されました！";
        const ownerBody  = `受取コード: ${updated.pickupCode ?? "---"} ｜ 受取準備をご確認ください`;
        const existingOwner = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(and(
            eq(notificationsTable.userId, store.ownerId),
            eq(notificationsTable.type, "bag_sold"),
            eq(notificationsTable.body, ownerBody),
          ))
          .limit(1);
        if (existingOwner.length === 0) {
          await db.insert(notificationsTable).values({ userId: store.ownerId, type: "bag_sold", title: ownerTitle, body: ownerBody, storeId: updated.storeId });
        }
        if (await storeOrderPushEnabled(store.ownerId)) await sendPushToUser(store.ownerId, { title: ownerTitle, body: ownerBody, tag: `bag-sold-${updated.id}`, url: "/store/orders" });
        // Web Push が届かない環境 (ブラウザのみ / 通知拒否 / iOS PWA 未追加) の補完として
        // 店舗オーナーへ注文メールを送信。 例外は内部で握り潰されるので await のみで OK。
        // ★ confirm/verify/webhook の三重発火で重複メールを送らないよう、DB通知と同じ
        //   冪等ガード内で送る（DB通知行が「一度だけ」マーカーになり、再起動後も有効）。
        if (existingOwner.length === 0) {
          await sendOrderEmailToStoreOwnerById({
            ownerId:    store.ownerId,
            storeName:  store.name ?? "店舗",
            bagTitle:   bag?.title ?? "おすそわけ袋",
            quantity:   updated.quantity,
            pickupCode: updated.pickupCode,
            pickupStart: bag?.pickupStart ?? null,
            pickupEnd:   bag?.pickupEnd ?? null,
            totalPrice:  updated.totalPrice,
            orderId:     updated.id,
          });
        }
      }

      // ユーザー（購入者）への購入完了通知
      if (updated.userId) {
        const pickupHint = bag?.pickupStart && bag?.pickupEnd
          ? ` 受取時間: ${bag.pickupStart}〜${bag.pickupEnd}`
          : "";
        const userTitle = "🛍️ おすそわけのご予約が確定しました！";
        const userBodyClean = `「${bag?.title ?? "おすそわけ袋"}」（${store?.name ?? "店舗"}）受取コード: ${updated.pickupCode ?? "---"}${pickupHint}`;
        const userBodyDb    = bag?.id ? `${userBodyClean} [bag:${bag.id}]` : userBodyClean;
        const existingUser = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(and(
            eq(notificationsTable.userId, updated.userId),
            eq(notificationsTable.type, "purchase_confirmed"),
            eq(notificationsTable.body, userBodyDb),
          ))
          .limit(1);
        if (existingUser.length === 0) {
          await db.insert(notificationsTable).values({ userId: updated.userId, type: "purchase_confirmed", title: userTitle, body: userBodyDb });
        }
        await sendPushToUser(updated.userId, { title: userTitle, body: userBodyClean, tag: `purchase-confirmed-${updated.id}`, url: bag?.id ? `/bags/${bag.id}` : "/my-reservations" });
      }
    } catch (e) {
      console.error("[payment] confirm-payment notification error:", e);
    }
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "bad_request", message: "Failed to confirm payment" });
  }
});

// ─── Stripe Checkout Session ───────────────────────────────────────────────
router.post("/checkout/session", requireAuth, async (req, res) => {
  try {
    const { reservationId, successUrl, cancelUrl } = req.body as {
      reservationId: number;
      successUrl: string;
      cancelUrl: string;
    };

    if (!reservationId || !successUrl || !cancelUrl) {
      res.status(400).json({ error: "bad_request", message: "reservationId, successUrl, cancelUrl are required" });
      return;
    }

    const [reservation] = await db
      .select({
        id: reservationsTable.id,
        userId: reservationsTable.userId,
        totalPrice: reservationsTable.totalPrice,
        merchandiseAmount: reservationsTable.merchandiseAmount,
        paymentStatus: reservationsTable.paymentStatus,
        bagId: reservationsTable.bagId,
        storeId: reservationsTable.storeId,
      })
      .from(reservationsTable)
      .where(eq(reservationsTable.id, reservationId));

    if (!reservation) {
      res.status(404).json({ error: "not_found", message: "Reservation not found" });
      return;
    }

    // 認可: 予約の所有者のみ checkout session を作成可
    if (reservation.userId !== req.authUser!.id) {
      console.warn(`[SECURITY] /checkout/session: reservation ${reservation.id} owner=${reservation.userId} requester=${req.authUser!.id}`);
      res.status(403).json({ error: "forbidden", message: "この予約の決済を開始する権限がありません" });
      return;
    }

    if (reservation.paymentStatus === "paid") {
      res.status(409).json({ error: "already_paid", message: "This reservation is already paid" });
      return;
    }

    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) {
      res.status(503).json({ error: "stripe_not_configured", message: "Stripe is not configured" });
      return;
    }

    // 店舗の Stripe アカウント ID と名称を取得（課金メタデータで店舗識別に使用）
    const [store] = await db
      .select({ stripeAccountId: storesTable.stripeAccountId, name: storesTable.name, id: storesTable.id })
      .from(storesTable)
      .where(eq(storesTable.id, reservation.storeId));

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    const total       = Math.round(reservation.totalPrice);
    const merchandise = Math.round(resolveMerchandise(reservation));
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Separate Charges and Transfers（分離チャージ&送金方式）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 1. チャージ全額をプラットフォームアカウントで受け取る（transfer_data なし）
    // Step 2. Stripe手数料がプラットフォームから引かれる: total - stripeFee = 残高
    // Step 3. 残高から shopTransferAmount を店舗に手動Transfer（/checkout/verify で実行）
    // Step 4. プラットフォームNet = total - stripeFee - shopTransferAmount = platformRevenue - stripeFee
    //
    // 例（merch=350円, total=370円）:
    //   チャージ        370円 → プラットフォームへ着金
    //   Stripe手数料  -  13円
    //   店舗Transfer  - 267円（/checkout/verify で stripe.transfers.create() ＝ floor(350×0.80)-13）
    //   ─────────────────────────
    //   プラットフォームNet 90円（= total - shopGross 370-280。Stripe手数料は店舗Transfer側で差引）
    const { platformRevenue, stripeFee, shopTransferAmount } = calcFees(total, merchandise);

    const destinationAccountId = store?.stripeAccountId ?? null;

    console.log(
      `[Checkout] Separate C&T: ` +
      `store_id=${store?.id} store_name="${store?.name}" ` +
      `total=${total}JPY | ` +
      `PlatformRevenue=${platformRevenue}JPY | ` +
      `StripeFee≈${stripeFee}JPY | ` +
      `ShopTransfer=${shopTransferAmount}JPY (支払い確認後に送金)`
    );

    // Stripeダッシュボードのメタデータに「どの店舗の売上か」と計算内訳を記録
    // store_id / store_name により、1アカウント多店舗でも Stripe 上で店舗識別が可能
    const feeMetadata: Record<string, string> = {
      reservationId:        String(reservation.id),
      store_id:             String(store?.id ?? reservation.storeId),
      store_name:           store?.name ?? "不明な店舗",
      chargeMode:           "separate_charges_and_transfers",
      platformFeeRate:      "20%",
      userServiceFeeRate:   "5%",
      merchandiseAmount:    String(merchandise),
      platformRevenue:      String(platformRevenue),
      stripeFeeEstimate:    String(stripeFee),
      shopTransferAmount:   String(shopTransferAmount),
    };
    if (destinationAccountId) {
      feeMetadata["storeStripeAccountId"] = destinationAccountId;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 【統一方式: Separate Charges and Transfers】
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //
    // ❌ 旧実装（application_fee_amount + transfer_data）の問題:
    //    Stripe が自動で「total - app_fee」を店舗へ送金した上に、
    //    /checkout/verify が さらに手動で Transfer → 二重送金 → プラットフォームがマイナスに
    //
    // ✅ 新実装（Separate C&T）（例: merch=350円, total=370円）:
    //    Step 1. チャージ全額（370円）がプラットフォームに着金
    //    Step 2. Stripe 手数料（13円）がプラットフォームから差し引かれる → 残高 357円
    //    Step 3. /checkout/verify で shopTransferAmount（267円）を店舗へ 1回だけ Transfer
    //    Step 4. プラットフォーム Net = 357 - 267 = 90円 ✓（保証）
    //
    //    店舗 267円 ✓ | プラットフォーム 90円 ✓ | Stripe 13円（3.6%）✓
    //    Stripe ダッシュボード: charge 1件 + transfer 1件 = シンプルで明瞭
    //
    // ※ application_fee_amount も transfer_data も使わない
    //    → 自動送金は発生しない → 二重送金なし → マイナス処理なし

    // ── Stripe Customer の取得または作成（カード2回目以降の自動入力のため）──
    // 認可: userId は信頼せず、必ず認証済みユーザの ID を使う
    const userId = req.authUser!.id;
    const customerId = userId ? await getOrCreateStripeCustomer(stripe, userId) : null;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // カスタマーを指定すれば保存済みカードが自動表示される
      ...(customerId
        ? { customer: customerId }
        : { customer_creation: "always" }),
      // ✅ 「このカードを保存する」チェックボックスを表示 → 次回以降は入力不要
      saved_payment_method_options: {
        payment_method_save: "enabled",
      },
      line_items: [
        {
          price_data: {
            currency: "jpy",
            product_data: {
              name: "おすそわけバッグ",
              description: "食品ロスを減らすサプライズバッグ",
              images: ["https://images.unsplash.com/photo-1542838132-92c53300491e?w=400"],
            },
            unit_amount: total,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl.includes("{CHECKOUT_SESSION_ID}")
        ? successUrl
        : `${successUrl}${successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        reservationId: String(reservation.id),
        userId:        userId || '',
        // Stripe ダッシュボードの「セッション一覧」でも直接店舗を特定できるよう付与
        store_id:      String(store?.id ?? reservation.storeId),
        store_name:    store?.name ?? "不明な店舗",
      },
      locale: "ja",
      payment_intent_data: { metadata: feeMetadata }, // ← app_fee/transfer_data は使わない
    });

    console.log(
      `[Checkout] Separate C&T セッション作成: ${session.id} | ` +
      `total=${total}JPY | platformRevenue=${platformRevenue}JPY(20%) | ` +
      `shopTransfer=${shopTransferAmount}JPY → /checkout/verify で実行`
    );

    await db
      .update(reservationsTable)
      .set({ paymentIntentId: session.id })
      .where(eq(reservationsTable.id, reservation.id));

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Stripe Checkout error:", err);
    res.status(500).json({ error: "stripe_error", message: "Failed to create checkout session" });
  }
});

// ─── Stripe Checkout Verify (after redirect) ────────────────────────────────
router.get("/checkout/verify", async (req, res) => {
  try {
    const { session_id, reservation_id } = req.query as { session_id?: string; reservation_id?: string };

    if (!session_id || !reservation_id) {
      res.status(400).json({ error: "bad_request", message: "session_id and reservation_id required" });
      return;
    }

    const reservationId = parseInt(reservation_id);
    const stripeKey = process.env["STRIPE_SECRET_KEY"];

    // ── 1. Stripe セッション確認 ────────────────────────────────
    let paymentStatus = "paid";
    let stripePaymentId: string | null = null;
    let supabaseUserId = "";
    // Transfer用（Separate C&T方式）
    let piMetadata: Record<string, string> = {};
    let chargeIdForTransfer: string | null = null;

    if (stripeKey) {
      const stripe = await import("stripe").then((m) => new m.default(stripeKey));
      const session = await stripe.checkout.sessions.retrieve(session_id);

      // ★ 認可: session.metadata.reservationId と URL クエリの reservation_id が一致することを必ず検証する。
      //   この検証なしだと、攻撃者が他人の session_id を手に入れて自分の reservation_id を付け回し、
      //   他人の決済成功イベントで自分の予約を paid に偽装できてしまう。
      const sessionReservationId = session.metadata?.reservationId;
      if (!sessionReservationId || sessionReservationId !== String(reservation_id)) {
        console.warn(
          `[SECURITY] /checkout/verify reservation_mismatch: session=${session_id} ` +
          `metadata.reservationId=${sessionReservationId ?? "(missing)"} query.reservation_id=${reservation_id}`
        );
        res.status(403).json({
          error: "reservation_mismatch",
          message: "予約IDと決済セッションが一致しません",
        });
        return;
      }

      paymentStatus = session.payment_status;
      stripePaymentId = (session.payment_intent as string) || session.id;
      supabaseUserId = session.metadata?.userId || "";

      if (session.payment_status !== "paid") {
        res.json({ status: session.payment_status, reservationId });
        return;
      }

      // PaymentIntent を取得してメタデータとcharge IDを確保
      if (stripePaymentId && stripePaymentId.startsWith("pi_")) {
        try {
          const pi = await stripe.paymentIntents.retrieve(stripePaymentId, {
            expand: ["latest_charge"],
          });
          piMetadata = (pi.metadata as Record<string, string>) || {};
          const lc = pi.latest_charge;
          chargeIdForTransfer = typeof lc === "string" ? lc : (lc as any)?.id ?? null;
        } catch (piErr) {
          console.warn("PaymentIntent retrieve error (non-fatal):", piErr);
        }
      }
    }

    // ── 2. 予約を取得（bag・store JOIN）──────────────────────────
    const [reservationFull] = await db
      .select({
        id: reservationsTable.id,
        userId: reservationsTable.userId,
        bagId: reservationsTable.bagId,
        storeId: reservationsTable.storeId,
        quantity: reservationsTable.quantity,
        totalPrice: reservationsTable.totalPrice,
        merchandiseAmount: reservationsTable.merchandiseAmount,
        paymentStatus: reservationsTable.paymentStatus,
        pickupCode: reservationsTable.pickupCode,
        bagTitle:     surpriseBagsTable.title,
        storeName:    storesTable.name,
        storeOwnerId: storesTable.ownerId,
        pickupStart:  surpriseBagsTable.pickupStart,
        pickupEnd:    surpriseBagsTable.pickupEnd,
        pickupStart2: surpriseBagsTable.pickupStart2,
        pickupEnd2:   surpriseBagsTable.pickupEnd2,
        pickupNextDay: surpriseBagsTable.pickupNextDay,
        bagCreatedAt: surpriseBagsTable.createdAt,
        stockCount:   surpriseBagsTable.stockCount,
      })
      .from(reservationsTable)
      .leftJoin(surpriseBagsTable, eq(reservationsTable.bagId, surpriseBagsTable.id))
      .leftJoin(storesTable, eq(reservationsTable.storeId, storesTable.id))
      .where(eq(reservationsTable.id, reservationId));

    if (!reservationFull) {
      res.status(404).json({ error: "not_found", message: "Reservation not found" });
      return;
    }

    // ★ アトミック在庫デクリメント＋ paid 遷移（仮押さえ廃止後の中核ロジック）
    //   Checkout Session 経由でも /payment/confirm と同じ排他制御で在庫整合性を担保する。
    //   既に paid → 冪等スキップ。在庫不足 → 自動返金フラグを立てて 409 相当を返す。
    type VerifyResult =
      | { kind: "already_cancelled" }
      | { kind: "already_paid" }
      | { kind: "out_of_stock" }
      | { kind: "paid" };

    const finalizeResult: VerifyResult = await db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(reservationsTable)
        .where(eq(reservationsTable.id, reservationId))
        .for("update");

      if (!reservation) return { kind: "already_cancelled" };
      if (reservation.status === "cancelled" || reservation.paymentStatus === "refunded") {
        return { kind: "already_cancelled" };
      }
      if (reservation.paymentStatus === "paid") {
        return { kind: "already_paid" };
      }

      const [bag] = await tx
        .select()
        .from(surpriseBagsTable)
        .where(eq(surpriseBagsTable.id, reservation.bagId))
        .for("update");

      if (!bag || bag.stockCount < reservation.quantity) {
        await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "refunded",
            status: "cancelled",
            ...(stripePaymentId ? { paymentIntentId: stripePaymentId } : {}),
          })
          .where(eq(reservationsTable.id, reservation.id));
        return { kind: "out_of_stock" };
      }

      const newStock = bag.stockCount - reservation.quantity;
      await tx
        .update(surpriseBagsTable)
        .set({
          stockCount: newStock,
          ...(newStock === 0 ? { isActive: false } : {}),
        })
        .where(eq(surpriseBagsTable.id, bag.id));

      await tx
        .update(reservationsTable)
        .set({
          paymentStatus: "paid",
          status: "confirmed",
          ...(stripePaymentId ? { paymentIntentId: stripePaymentId } : {}),
        })
        .where(eq(reservationsTable.id, reservation.id));

      return { kind: "paid" };
    });

    if (finalizeResult.kind === "already_cancelled") {
      // 既にキャンセル/返金済み — 副作用は実行せずにそのまま 409 を返す
      res.status(409).json({
        error: "already_cancelled",
        message: "この予約は既にキャンセルまたは返金済みです。",
      });
      return;
    }

    if (finalizeResult.kind === "out_of_stock") {
      // 決済成立後に在庫切れ判明 → Stripe で自動返金
      if (stripeKey && stripePaymentId && stripePaymentId.startsWith("pi_")) {
        try {
          const stripe = await import("stripe").then((m) => new m.default(stripeKey));
          await stripe.refunds.create({
            payment_intent: stripePaymentId,
            reason: "requested_by_customer",
            metadata: {
              reservationId: String(reservationId),
              reason: "out_of_stock_after_payment",
            },
          });
          console.log(`💸 自動返金実行 (verify): PI ${stripePaymentId} (reservation ${reservationId}, 在庫切れ)`);
        } catch (refundErr: any) {
          console.error(`[payment] /verify: Stripe refund failed for ${stripePaymentId}:`, refundErr?.message);
        }
      }
      res.status(409).json({
        error: "sold_out_refunded",
        message: "残念ながら他の方が一足先にご購入されました。お支払いは自動的に全額返金されます（数日以内に反映）。",
      });
      return;
    }

    // ★ 在庫が減った → 一覧キャッシュを破棄（他ユーザーに古い在庫数を見せない）。
    invalidate("bags:list"); invalidate("stores:list");

    // 仮押さえ（旧データ）の確定処理 — 在庫は戻さない（paid / already_paid 共通で実行可、冪等）
    await db
      .update(cartReservationsTable)
      .set({ status: "confirmed" })
      .where(eq(cartReservationsTable.reservationId, reservationId))
      .catch(() => {});

    // ── 4. 店舗への Transfer（Separate Charges and Transfers）─────
    // 【重要】Webhook 経由で paid に遷移済みのケース（already_paid）でも実行する必要がある。
    // → webhook は Transfer / Supabase orders 書き込みを行わないため、ここで補完する。
    // Stripe idempotency_key を使うことで verify と他経路の二重実行でも 1 回だけ Transfer される。
    {
      const isSeparateCT = piMetadata["chargeMode"] === "separate_charges_and_transfers";
      if (stripeKey && chargeIdForTransfer && piMetadata["storeStripeAccountId"] && isSeparateCT) {
        try {
          const stripe = await import("stripe").then((m) => new m.default(stripeKey));
          const transferAmount = parseInt(piMetadata["shopTransferAmount"] ?? "0", 10);
          const storeAccountId = piMetadata["storeStripeAccountId"];

          if (transferAmount > 0 && storeAccountId) {
            const transfer = await stripe.transfers.create({
              amount:             transferAmount,            // ShopTransferAmount（例: 267円）
              currency:           "jpy",
              destination:        storeAccountId,            // 店舗のStripeアカウント
              source_transaction: chargeIdForTransfer,       // このチャージと紐付け
              metadata: {
                reservationId:   String(reservationId),
                chargeMode:      "separate_charges_and_transfers",
                platformRevenue: piMetadata["platformRevenue"] ?? "",
                stripeFeeEst:    piMetadata["stripeFeeEstimate"] ?? "",
                shopTransfer:    String(transferAmount),
              },
            }, {
              // 同一予約の Transfer は何度呼ばれても 1 回しか作成されない
              idempotencyKey: `transfer:reservation:${reservationId}`,
            });
            console.log(
              `✅ Transfer成功: ${transferAmount}JPY → ${storeAccountId} ` +
              `(transfer_id=${transfer.id}, charge=${chargeIdForTransfer}) | ` +
              `platformNet≈${piMetadata["platformRevenue"]}JPY (20%保証)`
            );
          }
        } catch (transferErr: any) {
          // Transfer失敗は非致命的（手動対応可能）—— 決済確認フローは継続
          console.error("⚠️ Transfer error (non-fatal, manual action may be required):", transferErr?.message ?? transferErr);
        }
      } else if (stripeKey && stripePaymentId && !isSeparateCT) {
        // direct_transfer 方式: Stripe 自動送金済みのためスキップ（二重送金防止）
        console.log(`ℹ️ Transfer スキップ: chargeMode=${piMetadata["chargeMode"] ?? "不明"} — 自動送金済み (reservation=${reservationId})`);
      } else if (stripeKey && stripePaymentId) {
        // 送金先アカウント未設定の場合はスキップ（プラットフォームに全額留保）
        console.log(`ℹ️ Transfer スキップ: 送金先アカウント未設定 (reservation=${reservationId})`);
      }

      // ── 5. Supabase orders に書き込み ─────────────────────────
      // 在庫デクリメントは POST /reservations で実施済みのためここでは行わない
      const targetUserId = supabaseUserId || reservationFull.userId;
      if (targetUserId) {
        try {
          const { supabaseAdmin } = await import("../lib/supabase.js");

          // 既存の注文が存在する場合はスキップ（冪等性）
          const { data: existing } = await supabaseAdmin
            .from("orders")
            .select("id")
            .eq("reservation_id", reservationId)
            .maybeSingle();

          if (!existing) {
            const { error: insertErr } = await supabaseAdmin.from("orders").insert({
              user_id: targetUserId,
              product_id: null,
              bag_id: reservationFull.bagId,
              reservation_id: reservationId,
              final_price: reservationFull.totalPrice,
              status: "unpicked",
              stripe_payment_id: stripePaymentId,
              pickup_code: reservationFull.pickupCode,
              bag_title: reservationFull.bagTitle,
              store_name: reservationFull.storeName,
            });

            if (insertErr) {
              console.error("Supabase orders insert error:", insertErr);
            } else {
              console.log(`✅ Supabase orders 書き込み成功: reservation_id=${reservationId}, user_id=${targetUserId}`);
            }
          } else {
            console.log(`ℹ️ Supabase orders 既存レコードのためスキップ: reservation_id=${reservationId}`);
          }
        } catch (supaErr) {
          console.error("Supabase write error (non-fatal):", supaErr);
        }
      }

      // 購入通知 — kind 制限を撤廃。setImmediate も撤廃して inline await。
      //   DB 二重挿入は事前 select で防止。push は APNs tag で端末側 dedupe。
      try {
        console.log(`[payment] /verify-session: 通知ブロック開始 reservation=${reservationId} kind=${finalizeResult.kind}`);
        const ownerId    = reservationFull.storeOwnerId;
        const buyerUserId = targetUserId || reservationFull.userId;

        if (ownerId) {
          const ownerTitle = "【重要】おすそわけバッグが購入されました！";
          const ownerBody  = `受取コード: ${reservationFull.pickupCode ?? "---"} ｜ 受取準備をご確認ください`;
          const existingOwner = await db
            .select({ id: notificationsTable.id })
            .from(notificationsTable)
            .where(and(
              eq(notificationsTable.userId, ownerId),
              eq(notificationsTable.type, "bag_sold"),
              eq(notificationsTable.body, ownerBody),
            ))
            .limit(1);
          if (existingOwner.length === 0) {
            await db.insert(notificationsTable).values({ userId: ownerId, type: "bag_sold", title: ownerTitle, body: ownerBody, storeId: reservationFull.storeId ?? undefined });
          }
          if (await storeOrderPushEnabled(ownerId)) await sendPushToUser(ownerId, { title: ownerTitle, body: ownerBody, tag: `bag-sold-${reservationId}`, url: "/store/orders" });
          if (existingOwner.length === 0) {
          await sendOrderEmailToStoreOwnerById({
            ownerId,
            storeName:  reservationFull.storeName ?? "店舗",
            bagTitle:   reservationFull.bagTitle ?? "おすそわけ袋",
            quantity:   reservationFull.quantity ?? 1,
            pickupCode: reservationFull.pickupCode ?? null,
            pickupStart: reservationFull.pickupStart ?? null,
            pickupEnd:   reservationFull.pickupEnd ?? null,
            totalPrice:  reservationFull.totalPrice ?? null,
            orderId:     reservationId,
          });
          }
        }

        if (buyerUserId) {
          const pickupHint = reservationFull.pickupStart && reservationFull.pickupEnd
            ? ` 受取時間: ${reservationFull.pickupStart}〜${reservationFull.pickupEnd}`
            : "";
          const userTitle = "🛍️ おすそわけのご予約が確定しました！";
          const userBodyClean = `「${reservationFull.bagTitle ?? "おすそわけ袋"}」（${reservationFull.storeName ?? "店舗"}）受取コード: ${reservationFull.pickupCode ?? "---"}${pickupHint}`;
          const userBodyDb    = reservationFull.bagId ? `${userBodyClean} [bag:${reservationFull.bagId}]` : userBodyClean;
          const existingUser = await db
            .select({ id: notificationsTable.id })
            .from(notificationsTable)
            .where(and(
              eq(notificationsTable.userId, buyerUserId),
              eq(notificationsTable.type, "purchase_confirmed"),
              eq(notificationsTable.body, userBodyDb),
            ))
            .limit(1);
          if (existingUser.length === 0) {
            await db.insert(notificationsTable).values({ userId: buyerUserId, type: "purchase_confirmed", title: userTitle, body: userBodyDb });
          }
          await sendPushToUser(buyerUserId, { title: userTitle, body: userBodyClean, tag: `purchase-confirmed-${reservationId}`, url: reservationFull.bagId ? `/bags/${reservationFull.bagId}` : "/my-reservations" });
        }
      } catch (e) {
        console.error("[payment] verify-session notification error:", e);
      }
    }

    // ── 6. 受付票データを返す ────────────────────────────────────
    res.json({
      status: "paid",
      reservationId,
      pickupCode: reservationFull.pickupCode,
      bagTitle: reservationFull.bagTitle,
      storeName: reservationFull.storeName,
      totalPrice: reservationFull.totalPrice,
      merchandiseAmount: reservationFull.merchandiseAmount,
      pickupStart: reservationFull.pickupStart,
      pickupEnd: reservationFull.pickupEnd,
      pickupStart2: reservationFull.pickupStart2,
      pickupEnd2: reservationFull.pickupEnd2,
      pickupNextDay: reservationFull.pickupNextDay,
      bagCreatedAt: reservationFull.bagCreatedAt,
    });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: "verify_error", message: "Failed to verify session" });
  }
});

// ─── 保存済み支払い方法一覧 ────────────────────────────────────────────────
router.get("/payment/methods", requireAuth, async (req, res) => {
  try {
    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) { res.json({ methods: [] }); return; }

    // 認可: 認証済みユーザの user_metadata から自分の Stripe Customer ID のみ取得
    // → 他ユーザの customerId を listすることは構造的に不可能
    const userId = req.authUser!.id;
    const { data: { user }, error: getUserErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (getUserErr || !user) { res.status(401).json({ error: "unauthorized" }); return; }

    const customerId = (user.user_metadata as any)?.stripe_customer_id as string | undefined;
    if (!customerId) { res.json({ methods: [] }); return; }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // デフォルトの支払い方法を確認
    const customer = await stripe.customers.retrieve(customerId) as any;
    const defaultMethodId = customer?.invoice_settings?.default_payment_method as string | undefined;

    const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card" });

    res.json({
      methods: methods.data.map((m) => ({
        id: m.id,
        brand: m.card!.brand,
        last4: m.card!.last4,
        expMonth: m.card!.exp_month,
        expYear: m.card!.exp_year,
        isDefault: defaultMethodId ? m.id === defaultMethodId : false,
      })),
    });
  } catch (err) {
    console.error("[payment/methods] error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ─── 保存済み支払い方法の削除 ───────────────────────────────────────────────
router.delete("/payment/methods/:methodId", requireAuth, async (req, res) => {
  try {
    const methodId = req.params["methodId"];
    if (typeof methodId !== "string" || !methodId) {
      res.status(400).json({ error: "invalid_method_id" });
      return;
    }
    const stripeKey = process.env["STRIPE_SECRET_KEY"];
    if (!stripeKey) { res.status(503).json({ error: "stripe_not_configured" }); return; }

    // 認可: 認証済みユーザの user_metadata から自分の Stripe Customer ID を取得
    const userId = req.authUser!.id;
    const { data: { user }, error: getUserErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (getUserErr || !user) { res.status(401).json({ error: "unauthorized" }); return; }

    const customerId = (user.user_metadata as any)?.stripe_customer_id as string | undefined;
    if (!customerId) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const stripe = await import("stripe").then((m) => new m.default(stripeKey));

    // IDOR 防止: 支払い方法が本当にこのユーザーのものか確認
    const method = await stripe.paymentMethods.retrieve(methodId);
    if (method.customer !== customerId) {
      console.warn(`[SECURITY] /payment/methods DELETE: methodId=${methodId} ownerCustomer=${method.customer} requesterCustomer=${customerId} userId=${userId}`);
      res.status(403).json({ error: "forbidden" });
      return;
    }

    await stripe.paymentMethods.detach(methodId);
    res.json({ success: true });
  } catch (err) {
    console.error("[payment/methods/delete] error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

export default router;
