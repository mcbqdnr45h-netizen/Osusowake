import { Router, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { storesTable, notificationsTable, surpriseBagsTable, reservationsTable, cartReservationsTable } from "@workspace/db/schema";
import { eq, sql, and, ne } from "drizzle-orm";
import { Resend } from "resend";
import { sendStoreApprovalEmail, sendOrderEmailToStoreOwnerById } from "../utils/emails";
import { sendPushToUser, storeOrderPushEnabled } from "../lib/push.js";
import { getAllAdminUsers } from "../lib/admin.js";
import { invalidate } from "../lib/ttl-cache.js";

const router = Router();

// ── Stripe インスタンスを返すヘルパー（ESM 対応 dynamic import）────────────────
async function getStripe() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return null;
  const stripeLib = await import("stripe");
  const Stripe = stripeLib.default;
  return new Stripe(stripeKey, { apiVersion: "2024-11-20.acacia" as any });
}

// ── Separate Charges & Transfers の店舗送金ヘルパー ────────────────────────────
// /checkout/verify と完全に同一のパラメータ・idempotencyKey で Transfer を作成する。
// → 両経路から呼ばれても Stripe 側で 1 回だけ作成され（二重送金なし）、
//   かつパラメータ完全一致のため idempotency error にならず prior response が再生される。
//
// 呼び出しコンテキスト:
//   - "paid":          このイベントで初めて paid 遷移した（通常パス）
//   - "already_paid":  別経路（/checkout/verify 等）が先に paid にしたが、
//                      その経路で Transfer が失敗していた可能性に備えてリトライ
async function executeShopTransferIfNeeded(params: {
  intent: { id: string; metadata?: Record<string, string>; latest_charge?: string | null };
  reservationId: number;
  context: "paid" | "already_paid";
}): Promise<void> {
  const { intent, reservationId, context } = params;
  try {
    const piMetadata = (intent.metadata ?? {}) as Record<string, string>;
    const isSeparateCT = piMetadata["chargeMode"] === "separate_charges_and_transfers";
    const transferAmount = parseInt(piMetadata["shopTransferAmount"] ?? "0", 10);
    const storeAccountId = piMetadata["storeStripeAccountId"];
    const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : null;

    if (!isSeparateCT) {
      console.log(`[stripe-webhook] ℹ️ Transfer スキップ: chargeMode=${piMetadata["chargeMode"] ?? "不明"} (reservation=${reservationId}, ctx=${context})`);
      return;
    }
    if (!(transferAmount > 0)) {
      console.log(`[stripe-webhook] ℹ️ Transfer スキップ: 送金額=${transferAmount} (reservation=${reservationId}, ctx=${context})`);
      return;
    }
    if (!storeAccountId) {
      console.log(`[stripe-webhook] ℹ️ Transfer スキップ: 送金先アカウント未設定 (reservation=${reservationId}, ctx=${context})`);
      return;
    }
    if (!chargeId) {
      console.warn(`[stripe-webhook] ⚠️ Transfer スキップ: latest_charge 未取得 (reservation=${reservationId}, ctx=${context})`);
      return;
    }

    const stripe = await getStripe();
    if (!stripe) return;

    // ★ /checkout/verify の Transfer 呼び出しと metadata を完全一致させること。
    //   Stripe の冪等キーは「同一キー＋同一パラメータ」の場合のみ prior response を返す。
    //   差分があると idempotency error。
    const transfer = await stripe.transfers.create({
      amount:             transferAmount,
      currency:           "jpy",
      destination:        storeAccountId,
      source_transaction: chargeId,
      metadata: {
        reservationId:   String(reservationId),
        chargeMode:      "separate_charges_and_transfers",
        platformRevenue: piMetadata["platformRevenue"] ?? "",
        stripeFeeEst:    piMetadata["stripeFeeEstimate"] ?? "",
        shopTransfer:    String(transferAmount),
      },
    }, {
      // /checkout/verify と共通キー → 二重実行防止 + 同一パラメータで replay 安全
      idempotencyKey: `transfer:reservation:${reservationId}`,
    });
    console.log(
      `[stripe-webhook] ✅ Transfer (${context}): ${transferAmount}JPY → ${storeAccountId} ` +
      `(transfer_id=${transfer.id}, charge=${chargeId}, reservation=${reservationId})`
    );
  } catch (transferErr: any) {
    // Transfer失敗は非致命的 — paid 遷移は既に完了済み。Stripe の payment_intent.succeeded
    // 再送（最大3日）でこのハンドラが再実行されれば already_paid 経路から再試行される。
    console.error(
      `[stripe-webhook] ⚠️ Transfer error (non-fatal, reservation=${reservationId}, ctx=${context}):`,
      transferErr?.message ?? transferErr
    );
  }
}

// ── app_settings から値を取得するヘルパー ─────────────────────────────────────
async function getSetting(key: string, defaultValue: string = 'false'): Promise<string> {
  try {
    const result = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${key}`);
    const row = result.rows[0] as { value: string } | undefined;
    return row?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

// ── 管理者へのStripe KYC完了通知メール ────────────────────────────────────────
async function sendAdminKycEmail(store: {
  id: number;
  name: string;
  imageUrl: string | null;
  address: string;
  city: string | null;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  ownerId: string | null;
}) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.warn("[stripe-webhook] RESEND_API_KEY not set — スキップ");
    return false;
  }

  // #6 フェーズ B: ハードコード ADMIN_EMAIL を廃止し、 全 admin (DB role='admin') に通知。
  const admins = await getAllAdminUsers();
  const adminEmails = admins.map((a) => a.email).filter((e): e is string => !!e);
  if (adminEmails.length === 0) {
    console.warn("[stripe-webhook] 管理者が 1 名もいない (DB role='admin' 0 件) → KYC 完了通知メールをスキップ");
    return false;
  }

  const resend = new Resend(resendApiKey);
  const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
  const appUrl = process.env.APP_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost'}`;
  const crypto = await import('node:crypto');
  // 認可: ADMIN_APPROVAL_SECRET が未設定なら fail-closed（デフォルト値を使わない）
  const secret = process.env.ADMIN_APPROVAL_SECRET;
  if (!secret) {
    console.error("[stripe-webhook] ADMIN_APPROVAL_SECRET 未設定 → 承認メール送信を中止 (fail-closed)");
    return false;
  }
  const token = crypto.createHmac('sha256', secret).update(String(store.id)).digest('hex');
  const approveUrl = `${appUrl}/api/admin/approve-store?storeId=${store.id}&token=${token}`;
  const adminUrl = `${appUrl}/admin`;

  const imageHtml = store.imageUrl
    ? `<img src="${store.imageUrl}" alt="${store.name}" style="width:100%;max-height:200px;object-fit:cover;display:block;border-radius:12px;margin-bottom:16px;" />`
    : `<div style="width:100%;height:120px;background:#f5e9df;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:40px;margin-bottom:16px;">🏪</div>`;

  const stripeStatusHtml = `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:16px;margin-bottom:16px;">
      <p style="color:#15803d;font-size:13px;font-weight:900;margin:0 0 10px;letter-spacing:0.05em;">✅ STRIPE 審査状況</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="color:#555;font-size:13px;padding:3px 0;">決済受付 (charges_enabled)</td><td style="color:${store.chargesEnabled ? '#15803d' : '#dc2626'};font-weight:bold;font-size:13px;text-align:right;">${store.chargesEnabled ? '✅ OK' : '❌ 未完了'}</td></tr>
        <tr><td style="color:#555;font-size:13px;padding:3px 0;">情報提出 (details_submitted)</td><td style="color:${store.detailsSubmitted ? '#15803d' : '#dc2626'};font-weight:bold;font-size:13px;text-align:right;">${store.detailsSubmitted ? '✅ OK' : '❌ 未完了'}</td></tr>
        <tr><td style="color:#555;font-size:13px;padding:3px 0;">振込可能 (payouts_enabled)</td><td style="color:${store.payoutsEnabled ? '#15803d' : '#dc2626'};font-weight:bold;font-size:13px;text-align:right;">${store.payoutsEnabled ? '✅ OK' : '⏳ 処理中'}</td></tr>
        <tr><td style="color:#555;font-size:13px;padding:3px 0;">Stripeアカウント ID</td><td style="color:#555;font-size:11px;text-align:right;font-family:monospace;">${store.stripeAccountId ?? '—'}</td></tr>
      </table>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: `おすそわけ <${fromDomain}>`,
    to: adminEmails,
    subject: `【おすそわけ】🎉 Stripe KYC完了 — 承認依頼: ${store.name}`,
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <div style="background:linear-gradient(135deg,#F26419 0%,#d44a00 100%);padding:40px 32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:900;margin:0 0 6px;">Stripe KYC 審査が完了しました</h1>
      <p style="color:rgba(255,255,255,0.9);font-size:14px;margin:0;">管理者承認をお願いします</p>
    </div>

    <div style="padding:32px;">
      <p style="color:#333333;font-size:15px;line-height:1.7;margin:0 0 20px;">
        勇飛さん、以下の店舗が Stripe の本人確認（KYC）を完了し、<strong>決済を受け取れる状態</strong>になりました。<br>
        内容を確認の上、承認をお願いします。
      </p>

      ${imageHtml}

      <div style="background:#fff8f0;border:2px solid #F26419;border-radius:16px;padding:20px;margin-bottom:16px;">
        <h2 style="color:#F26419;font-size:18px;font-weight:900;margin:0 0 8px;">${store.name}</h2>
        <p style="color:#666;font-size:13px;margin:0;">${store.address}${store.city ? `、${store.city}` : ''}</p>
        <p style="color:#999;font-size:12px;margin:6px 0 0;font-family:monospace;">店舗ID: ${store.id}</p>
      </div>

      ${stripeStatusHtml}

      <div style="text-align:center;margin-bottom:16px;">
        <a href="${approveUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#22c55e,#16a34a);color:#ffffff;font-size:16px;font-weight:900;padding:16px 40px;border-radius:14px;text-decoration:none;letter-spacing:0.02em;">
          ✅ ワンクリックで承認する
        </a>
      </div>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${adminUrl}"
           style="display:inline-block;background:#f5f5f0;color:#333;font-size:13px;font-weight:700;padding:10px 24px;border-radius:10px;text-decoration:none;border:1px solid #ddd;">
          🛡 管理者ダッシュボードを開く
        </a>
      </div>

      <p style="color:#999999;font-size:12px;line-height:1.6;margin:0;text-align:center;">
        このメールは おすそわけ システムから自動送信されています。<br>
        承認リンクはセキュリティのため1回限り有効です。
      </p>
    </div>

    <div style="background:#f5f5f0;padding:20px 32px;text-align:center;">
      <p style="color:#aaaaaa;font-size:11px;margin:0;">おすそわけ — おいしいものを、もっとみんなへ。</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });

  if (error) {
    console.error("[stripe-webhook] admin KYC email error:", error);
    return false;
  }
  console.log(`[stripe-webhook] ✅ admin KYC email sent for store ${store.id} (${store.name})`);
  return true;
}

// ── POST /stripe-webhook ───────────────────────────────────────────────────────
router.post("/stripe-webhook", async (req: Request, res: Response) => {
  const stripe = await getStripe();
  if (!stripe) {
    console.warn("[stripe-webhook] STRIPE_SECRET_KEY not set — スキップ");
    res.json({ received: true, skipped: "no_stripe_key" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  // Stripe は「お客様のアカウント」用と「連結アカウント」用で別エンドポイント・別シークレット
  // を発行するため、複数のシークレットを順に試して検証する。
  const candidateSecrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_CONNECT,
    process.env.STRIPE_WEBHOOK_SECRET_2,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  let event: any;

  if (candidateSecrets.length > 0 && sig) {
    let lastErr: any = null;
    for (const secret of candidateSecrets) {
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
      }
    }
    if (!event) {
      console.error("[stripe-webhook] 署名検証失敗（全候補シークレットで一致せず）:", lastErr?.message);
      res.status(400).json({ error: `Webhook Error: ${lastErr?.message ?? "signature mismatch"}` });
      return;
    }
  } else {
    // 本番環境では fail-closed（シークレット未設定 = 偽イベント注入を許容しないため拒否）
    // 開発環境（NODE_ENV !== "production"）のみ署名なしで受け付ける
    if (process.env.NODE_ENV === "production") {
      console.error("[stripe-webhook] ❌ 本番で webhook シークレット未設定 — 署名検証必須のため拒否");
      res.status(503).json({ error: "webhook_secret_not_configured" });
      return;
    }
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    console.warn("[stripe-webhook] ⚠️ STRIPE_WEBHOOK_SECRET 未設定 — 署名検証なし（開発環境のみ許可）");
  }

  // ── Idempotency: 「先行 claim 型」 ───────────────────────────────────────
  // Stripe は配信失敗時に最大3日間リトライするため、重複処理で二重請求/二重発送を起こす可能性。
  // 設計: Postgres のユニーク制約 (event_id PK) を使って 1 つの worker だけが
  // 'processing' を取得できるようにする → 同一 event.id の並列処理を物理的に排除。
  //
  //  - INSERT (status='processing') を試行
  //    - 成功 → 自分が処理担当。res.on("finish") で 'succeeded'/'failed' に確定
  //    - 23505 (重複) → 既存 row を SELECT
  //        - 'succeeded' → スキップ
  //        - 'processing' で stale (>10分) → UPDATE で奪取して処理
  //        - 'processing' で fresh → スキップ（別 worker が処理中）
  //        - 'failed'    → UPDATE で奪取して再処理
  //
  // 個々のハンドラ（payment_intent.succeeded / account.updated 等）は DB 内で
  // 冪等な更新を行う前提だが、この先行 claim によりそもそも並列実行が起きない。
  let webhookClaimed = false;
  if (event?.id) {
    const eventId = event.id as string;
    const eventType = (event.type ?? "unknown") as string;
    try {
      const ins = await pool.query(
        `INSERT INTO stripe_webhook_events (event_id, event_type, status, received_at, updated_at)
         VALUES ($1, $2, 'processing', NOW(), NOW())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, eventType]
      );
      if ((ins.rowCount ?? 0) > 0) {
        webhookClaimed = true;
      } else {
        // 既存 row 検査
        const existing = await pool.query(
          `SELECT status, updated_at FROM stripe_webhook_events WHERE event_id = $1 LIMIT 1`,
          [eventId]
        );
        const row = existing.rows[0] as { status: string; updated_at: Date } | undefined;
        if (!row || row.status === "succeeded") {
          console.log(`[stripe-webhook] 🔁 重複イベント受信 (succeeded): ${eventId} (${eventType}) — スキップ`);
          res.json({ received: true, duplicate: true });
          return;
        }
        if (row.status === "processing") {
          const ageMs = Date.now() - new Date(row.updated_at).getTime();
          if (ageMs < 10 * 60 * 1000) {
            // ★ fresh processing: 先行 worker が生存中の可能性大。ただしクラッシュしている可能性も
            // 排除できないので 503 を返して Stripe に再送させる（指数バックオフ）。
            // 再送時に先行 worker が完了していれば 'succeeded' で重複スキップされ取りこぼしなし。
            console.log(`[stripe-webhook] 🔁 並列処理中 (age=${Math.round(ageMs/1000)}s): ${eventId} — 503 で Stripe 再送依頼`);
            res.status(503).json({ error: "in_progress", message: "still processing — retry later" });
            return;
          }
          // stale → DB 時刻基準で原子的に奪取（updated_at 完全一致だと精度差で失敗するため interval を使う）
          const claim = await pool.query(
            `UPDATE stripe_webhook_events SET status = 'processing', updated_at = NOW()
              WHERE event_id = $1 AND status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'
              RETURNING event_id`,
            [eventId]
          );
          if ((claim.rowCount ?? 0) > 0) {
            console.warn(`[stripe-webhook] ⚠️ stale processing を奪取 (age=${Math.round(ageMs/1000)}s): ${eventId}`);
            webhookClaimed = true;
          } else {
            // 競合で他 worker が奪取済 → 同じく Stripe に再送依頼
            console.log(`[stripe-webhook] 別 worker が奪取済: ${eventId} — 503`);
            res.status(503).json({ error: "in_progress", message: "another worker took over" });
            return;
          }
        } else {
          // failed → 奪取して再処理
          const claim = await pool.query(
            `UPDATE stripe_webhook_events SET status = 'processing', updated_at = NOW()
              WHERE event_id = $1 AND status = 'failed'
              RETURNING event_id`,
            [eventId]
          );
          if ((claim.rowCount ?? 0) > 0) {
            console.log(`[stripe-webhook] 🔄 failed → 再処理: ${eventId}`);
            webhookClaimed = true;
          } else {
            // 他 worker が先に奪取した → 503 で再送依頼（取りこぼし防止のため fail-closed）
            console.log(`[stripe-webhook] failed 奪取失敗（他 worker が処理中）: ${eventId} — 503`);
            res.status(503).json({ error: "in_progress", message: "another worker took over" });
            return;
          }
        }
      }
    } catch (claimErr: any) {
      // ★ fail-closed: DB エラーで claim できない場合は 503 を返して Stripe にリトライさせる。
      //   処理続行すると並列重複実行のリスクがあるため、整合性を優先する。
      console.error("[stripe-webhook] ❌ idempotency claim 失敗 — 503 で Stripe 再送依頼:", claimErr?.message);
      res.status(503).json({ error: "idempotency_unavailable", message: "retry later" });
      return;
    }

    // 処理完了後に最終ステータスを確定
    if (webhookClaimed) {
      res.on("finish", () => {
        const finalStatus = (res.statusCode >= 200 && res.statusCode < 300) ? "succeeded" : "failed";
        pool.query(
          `UPDATE stripe_webhook_events SET status = $2, updated_at = NOW() WHERE event_id = $1`,
          [eventId, finalStatus]
        ).catch((updErr: any) => {
          console.warn(`[stripe-webhook] 最終ステータス更新失敗 (event=${eventId}, status=${finalStatus}):`, updErr?.message);
        });
        if (finalStatus === "failed") {
          console.log(`[stripe-webhook] event ${eventId} status=failed (HTTP ${res.statusCode}) — Stripe が再送します`);
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 🛡 安全網: payment_intent.succeeded
  // フロント (Checkout.tsx) の /api/payment/confirm 呼び出しが iOS の通信不調などで
  // 失敗した場合に備え、Stripe からの確実な webhook で予約を paid/confirmed に
  // 自動同期する。冪等（既に paid なら何もしない）。
  // ─────────────────────────────────────────────────────────────────────────
  if (event.type === "payment_intent.succeeded") {
    try {
      const intent = event.data.object as {
        id: string;
        amount: number;
        metadata?: Record<string, string>;
        latest_charge?: string | null;
      };
      const reservationIdStr = intent.metadata?.reservationId;
      const reservationId = reservationIdStr ? parseInt(reservationIdStr, 10) : NaN;
      if (!reservationId || Number.isNaN(reservationId)) {
        console.warn(`[stripe-webhook] payment_intent.succeeded: metadata.reservationId なし — intent=${intent.id}`);
        res.json({ received: true, type: event.type, handled: false, reason: "no_reservation_id" });
        return;
      }

      // ★ アトミック確定（仮押さえ廃止後）: 在庫ロック → 在庫不足なら自動返金、
      //   足りていれば在庫デクリメント＋ paid 遷移。フロントの /api/payment/confirm
      //   と並行しても DB トランザクションの直列化で 1 回だけ確定する。
      type WebhookResult =
        | { kind: "not_found" }
        | { kind: "already_cancelled" }
        | { kind: "already_paid" }
        | { kind: "out_of_stock" }
        | { kind: "paid"; storeId: number; pickupCode: string | null };

      const result: WebhookResult = await db.transaction(async (tx) => {
        const [reservation] = await tx
          .select()
          .from(reservationsTable)
          .where(eq(reservationsTable.id, reservationId))
          .for("update");

        if (!reservation) return { kind: "not_found" };

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
              paymentIntentId: intent.id,
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

        const [updated] = await tx
          .update(reservationsTable)
          .set({
            paymentStatus: "paid",
            status: "confirmed",
            paymentIntentId: intent.id,
          })
          .where(eq(reservationsTable.id, reservation.id))
          .returning({ storeId: reservationsTable.storeId, pickupCode: reservationsTable.pickupCode });

        return { kind: "paid", storeId: updated.storeId, pickupCode: updated.pickupCode };
      });

      if (result.kind === "not_found") {
        console.warn(`[stripe-webhook] payment_intent.succeeded: reservation ${reservationId} 見つからず`);
        res.json({ received: true, type: event.type, handled: false, reason: "reservation_not_found" });
        return;
      }
      if (result.kind === "already_cancelled") {
        // ★ レース対策: cancel が先に DB をロックしてキャンセル → その後 Stripe で
        //   payment_intent が succeeded になった場合、 ここで自動返金しないと
        //   「DB cancelled / Stripe で実課金」 の charged-but-cancelled 状態になる。
        //   event.type === "payment_intent.succeeded" なので intent は必ず succeeded。
        //   返金失敗時は 5xx を返して Stripe webhook 再送機構に委ねる。
        try {
          const stripe = await getStripe();
          if (!stripe) {
            // Stripe 未設定 — 返金不可だが、 既に DB 上 cancelled なので状態整合は取れている
            console.warn(`[stripe-webhook] race detected but Stripe not configured (PI ${intent.id})`);
          } else {
            const existingRefunds = await stripe.refunds.list({ payment_intent: intent.id, limit: 10 });
            const totalRefunded = existingRefunds.data.reduce(
              (sum, r) => sum + ((r.status === "succeeded" || r.status === "pending") ? r.amount : 0),
              0,
            );
            const fullPI = await stripe.paymentIntents.retrieve(intent.id);
            const piAmount = fullPI.amount;

            if (totalRefunded < piAmount) {
              const refund = await stripe.refunds.create({
                payment_intent: intent.id,
                reason: "requested_by_customer",
                metadata: {
                  reservationId: String(reservationId),
                  reason: "cancelled_before_webhook",
                },
              });
              console.warn(`[stripe-webhook] ⚠️ race auto-refund: PI ${intent.id} (reservation ${reservationId}, cancel が webhook より先行, refundId=${refund.id})`);
            } else {
              console.log(`[stripe-webhook] race detected but PI ${intent.id} 既に全額返金済 (${totalRefunded}/${piAmount})`);
            }

            // ★ 返金成功 (もしくは既に全額返金済) → DB paymentStatus を refunded に同期
            //   会計/監査整合のため status=cancelled + paymentStatus=refunded に揃える。
            try {
              await db
                .update(reservationsTable)
                .set({ paymentStatus: "refunded" })
                .where(eq(reservationsTable.id, reservationId));
            } catch (syncErr: any) {
              console.error(`[stripe-webhook] paymentStatus refunded sync failed (reservation=${reservationId}):`, syncErr?.message);
            }
          }
        } catch (refundErr: any) {
          // ★ 返金失敗 → 5xx で返して Stripe に再送させる (charged-but-cancelled の永続化を防ぐ)
          console.error(`[stripe-webhook] race auto-refund failed for PI ${intent.id} (will be retried by Stripe):`, refundErr?.message);
          res.status(500).json({
            received: true,
            type: event.type,
            handled: false,
            error: "refund_failed_will_retry",
            reason: refundErr?.message ?? "unknown",
          });
          return;
        }
        console.log(`[stripe-webhook] payment_intent.succeeded: reservation ${reservationId} は既にキャンセル済み（返金済みで冪等完了）`);
        res.json({ received: true, type: event.type, handled: true, idempotent: true, reason: "already_cancelled_refunded" });
        return;
      }
      if (result.kind === "already_paid") {
        console.log(`[stripe-webhook] payment_intent.succeeded: reservation ${reservationId} は既に paid（冪等スキップ）`);
        // ★ Transfer リカバリー: 別経路（/checkout/verify）が paid にした後で
        //   Transfer を失敗していた可能性があるため、ここでも再試行する。
        //   /checkout/verify と同じ idempotencyKey を使うので、既に成功している場合は
        //   Stripe が prior response を返して二重送金にならない。
        await executeShopTransferIfNeeded({ intent, reservationId, context: "already_paid" });
        res.json({ received: true, type: event.type, handled: true, idempotent: true });
        return;
      }
      if (result.kind === "out_of_stock") {
        // 在庫切れ → Stripe 自動返金
        try {
          const stripe = await getStripe();
          if (stripe) {
            await stripe.refunds.create({
              payment_intent: intent.id,
              reason: "requested_by_customer",
              metadata: {
                reservationId: String(reservationId),
                reason: "out_of_stock_after_payment",
              },
            });
            console.log(`💸 webhook 自動返金: PI ${intent.id} (reservation ${reservationId}, 在庫切れ)`);
          }
        } catch (refundErr: any) {
          console.error(`[stripe-webhook] auto-refund failed:`, refundErr?.message);
        }
        res.json({ received: true, type: event.type, handled: true, action: "refunded_oos" });
        return;
      }

      // ★ result.kind === "paid"
      const row = { id: reservationId, storeId: result.storeId, pickupCode: result.pickupCode };

      // ★ 在庫が減った → 一覧キャッシュを破棄（confirm/verify を踏まず webhook だけで確定した場合の在庫表示ズレを防ぐ）。
      invalidate("bags:list"); invalidate("stores:list");

      // 旧 cart_reservation テーブル（互換）— 残っていれば確定
      await db
        .update(cartReservationsTable)
        .set({ status: "confirmed" })
        .where(eq(cartReservationsTable.reservationId, reservationId))
        .catch(() => {});

      console.log(`[stripe-webhook] ✅ 安全網発動: reservation ${reservationId} を paid/confirmed に更新（intent=${intent.id}）`);

      // 🚚 Separate Charges & Transfers — 店舗送金（共通ヘルパー経由）
      // ユーザが /checkout/verify を踏まずにブラウザを閉じた場合の救済。
      await executeShopTransferIfNeeded({ intent, reservationId, context: "paid" });

      // 購入通知（店舗オーナー + ユーザー）
      //   DB 二重挿入を防ぐため事前 select。push は APNs tag で端末側 dedupe。
      try {
        console.log(`[stripe-webhook] 通知ブロック開始 reservation=${row.id}`);
        const [[store], [bag], [reservation]] = await Promise.all([
          db.select({ ownerId: storesTable.ownerId, name: storesTable.name })
            .from(storesTable).where(eq(storesTable.id, row.storeId)).limit(1),
          // ★ 予約から辿ってそのバッグを取る（reservations → surprise_bags の内部結合）。
          //   旧実装は from=surprise_bags に定数条件の leftJoin を掛ける読みにくい形だった。
          //   確実に「この予約のバッグ」だけを返す明快な形に統一。
          db.select({ id: surpriseBagsTable.id, title: surpriseBagsTable.title, pickupStart: surpriseBagsTable.pickupStart, pickupEnd: surpriseBagsTable.pickupEnd })
            .from(reservationsTable)
            .innerJoin(surpriseBagsTable, eq(surpriseBagsTable.id, reservationsTable.bagId))
            .where(eq(reservationsTable.id, row.id)).limit(1),
          db.select({
              userId: reservationsTable.userId,
              quantity: reservationsTable.quantity,
              totalPrice: reservationsTable.totalPrice,
            })
            .from(reservationsTable).where(eq(reservationsTable.id, row.id)).limit(1),
        ]);

        // 店舗オーナー通知
        if (store?.ownerId) {
          const ownerTitle = "【重要】おすそわけバッグが購入されました！";
          const ownerBody  = `受取コード: ${row.pickupCode ?? "---"} ｜ 受取準備をご確認ください`;
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
            await db.insert(notificationsTable).values({ userId: store.ownerId, type: "bag_sold", title: ownerTitle, body: ownerBody, storeId: row.storeId });
          }
          let ownerPushSent = 0;
          if (await storeOrderPushEnabled(store.ownerId)) {
            ownerPushSent = await sendPushToUser(store.ownerId, { title: ownerTitle, body: ownerBody, tag: `bag-sold-${row.id}`, url: "/store/orders" });
          }
          // Web Push 補完: ブラウザのみ利用中・通知拒否中のオーナーに必ず届くようメール併用。
          //   ★ push が1台も届かなかった場合 (ownerPushSent===0) は opt-out を無視して必ず送る
          //     =注文の取りこぼし(オーバーブッキング)防止。届いた場合は opt-in 店のみメール。
          //   ★ confirm/verify/webhook の三重発火で重複送信しないよう DB通知と同じ冪等ガード内で送る。
          if (existingOwner.length === 0) {
            await sendOrderEmailToStoreOwnerById({
              ownerId:    store.ownerId,
              storeName:  store.name ?? "店舗",
              bagTitle:   bag?.title ?? "おすそわけ袋",
              quantity:   reservation?.quantity ?? 1,
              pickupCode: row.pickupCode ?? null,
              pickupStart: bag?.pickupStart ?? null,
              pickupEnd:   bag?.pickupEnd ?? null,
              totalPrice:  reservation?.totalPrice ?? null,
              orderId:     row.id,
              pushDelivered: ownerPushSent > 0,
            });
          }
        }

        // ユーザー（購入者）通知
        if (reservation?.userId) {
          const pickupHint = bag?.pickupStart && bag?.pickupEnd
            ? ` 受取時間: ${bag.pickupStart}〜${bag.pickupEnd}`
            : "";
          const userTitle = "🛍️ おすそわけのご予約が確定しました！";
          const userBodyClean = `「${bag?.title ?? "おすそわけ袋"}」（${store?.name ?? "店舗"}）受取コード: ${row.pickupCode ?? "---"}${pickupHint}`;
          const userBodyDb    = bag?.id ? `${userBodyClean} [bag:${bag.id}]` : userBodyClean;
          const existingUser = await db
            .select({ id: notificationsTable.id })
            .from(notificationsTable)
            .where(and(
              eq(notificationsTable.userId, reservation.userId),
              eq(notificationsTable.type, "purchase_confirmed"),
              eq(notificationsTable.body, userBodyDb),
            ))
            .limit(1);
          if (existingUser.length === 0) {
            await db.insert(notificationsTable).values({ userId: reservation.userId, type: "purchase_confirmed", title: userTitle, body: userBodyDb });
          }
          await sendPushToUser(reservation.userId, { title: userTitle, body: userBodyClean, tag: `purchase-confirmed-${row.id}`, url: bag?.id ? `/bags/${bag.id}` : "/my-reservations" });
        }
      } catch (notifErr) {
        console.error('[stripe-webhook] 安全網からの通知挿入失敗:', notifErr);
      }

      res.json({ received: true, type: event.type, handled: true, reservationId, action: "marked_paid" });
      return;
    } catch (err: any) {
      console.error('[stripe-webhook] payment_intent.succeeded handler error:', err);
      res.status(500).json({ error: "internal_error", message: err?.message });
      return;
    }
  }

  // ── account.updated イベントのみ処理 ────────────────────────────────────────
  if (event.type !== "account.updated") {
    res.json({ received: true, type: event.type, handled: false });
    return;
  }

  const account = event.data.object as {
    id: string;
    charges_enabled: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
    requirements?: {
      past_due?: string[];
      currently_due?: string[];
      disabled_reason?: string | null;
      errors?: { code: string; reason: string; requirement: string }[];
    };
  };

  console.log(`[stripe-webhook] account.updated: ${account.id}, charges_enabled=${account.charges_enabled}, disabled_reason=${account.requirements?.disabled_reason ?? 'none'}`);

  if (!account.charges_enabled) {
    // charges 無効 → 必ずDBの stripeChargesEnabled を false に更新してから詳細処理
    try {
      // stripeChargesEnabled = false に更新
      // 同時に showOnMap も false に強制クリア
      //   理由: 管理者が以前 show_on_map=true を立てていた店舗で Stripe が無効化されると、
      //   マップ表示条件 (show_on_map=true バイパス) を抜けて決済不可の店舗が地図に残ってしまう。
      //   Stripe が落ちた瞬間にマップからも消すのが安全。
      await db
        .update(storesTable)
        .set({ stripeChargesEnabled: false, showOnMap: false })
        .where(eq(storesTable.stripeAccountId, account.id));

      // この店舗に紐づく出品中バッグを全て自動停止（客が注文しても決済できないため）
      const affectedStores = await db
        .select({ id: storesTable.id })
        .from(storesTable)
        .where(eq(storesTable.stripeAccountId, account.id));
      if (affectedStores.length > 0) {
        await db
          .update(surpriseBagsTable)
          .set({ isActive: false })
          .where(eq(surpriseBagsTable.storeId, affectedStores[0].id));
        console.log(`[stripe-webhook] 🔴 charges_enabled=false → store ${affectedStores[0].id} の出品バッグを全て停止`);
      }
    } catch (dbErr: any) {
      console.error('[stripe-webhook] stripeChargesEnabled=false 更新失敗:', dbErr?.message);
    }

    // charges 無効 + past_due がある → Stripe が本人確認エラーを検出した可能性
    const pastDue = account.requirements?.past_due ?? [];
    const disabledReason = account.requirements?.disabled_reason ?? '';
    const isRequirementsIssue = pastDue.length > 0 || disabledReason === 'requirements.past_due';

    if (isRequirementsIssue) {
      try {
        const storeRows = await db
          .select({ id: storesTable.id, name: storesTable.name, ownerId: storesTable.ownerId, status: storesTable.status })
          .from(storesTable)
          .where(eq(storesTable.stripeAccountId, account.id))
          .limit(1);

        if (storeRows.length > 0) {
          const store = storeRows[0];
          // external_account が past_due に含まれている → 口座の再登録も必要
          const needsBankReregister = pastDue.some(f => f === 'external_account' || f.startsWith('external_account'));

          // applied 状態 → pending に戻して再入力フローへ誘導
          // approved 状態 → status は触らずそのまま（営業継続不可だが履歴は残す）
          //   どちらの場合も「再入力が必要」通知 + 警告UIを表示する
          if (store.status === 'applied') {
            await db.update(storesTable).set({
              status: 'pending',
              stripeNeedsBankReregister: needsBankReregister || false,
            }).where(eq(storesTable.id, store.id));
            console.log(`[stripe-webhook] ⚠️  KYC requirements error — store ${store.id} (applied) reverted to pending. past_due: ${pastDue.join(', ')}`);
          } else if (needsBankReregister) {
            // approved の場合も口座再登録フラグだけは立てる
            await db.update(storesTable).set({
              stripeNeedsBankReregister: true,
            }).where(eq(storesTable.id, store.id));
            console.log(`[stripe-webhook] ⚠️  KYC requirements error — store ${store.id} (${store.status}) needs bank re-register. past_due: ${pastDue.join(', ')}`);
          } else {
            console.log(`[stripe-webhook] ⚠️  KYC requirements error — store ${store.id} (${store.status}) needs re-submit. past_due: ${pastDue.join(', ')}`);
          }

          // 店舗オーナーに通知（status 問わず常に送る）
          try {
            const missingLabels = pastDue.slice(0, 5).map(f => {
              if (f.includes('address')) return '住所';
              if (f.includes('dob')) return '生年月日';
              if (f.includes('first_name') || f.includes('last_name')) return '氏名';
              if (f.includes('phone')) return '電話番号';
              if (f.includes('email')) return 'メールアドレス';
              if (f.includes('verification') || f.includes('document')) return '本人確認書類';
              return f;
            }).filter((v, i, a) => a.indexOf(v) === i);

            if (store.ownerId) {
              const bodyMsg = store.status === 'approved'
                ? `決済が一時停止されました。再開には本人確認の再提出が必要です（${missingLabels.join('・')}など）。店舗ダッシュボードから再登録してください。`
                : `決済システムによる審査で確認が必要な項目があります（${missingLabels.join('・')}など）。店舗ダッシュボードから再登録してください。`;
              await db.insert(notificationsTable).values({
                userId: store.ownerId,
                type: 'store_action_required',
                title: store.status === 'approved'
                  ? '⚠️ 決済が停止されました（本人確認の再提出が必要）'
                  : '⚠️ 本人確認情報の再入力が必要です',
                body: bodyMsg,
                read: false,
              });
            }
          } catch (notifErr) {
            console.error('[stripe-webhook] notification insert error:', notifErr);
          }

          res.json({
            received: true,
            action: store.status === 'applied' ? 'reverted_to_pending' : 'notified_owner',
            storeId: store.id,
            status: store.status,
            past_due: pastDue,
          });
          return;
        }
      } catch (err: any) {
        console.error('[stripe-webhook] requirements error handling failed:', err?.message);
      }
    }

    res.json({ received: true, charges_enabled: false, handled: false });
    return;
  }

  try {
    // ── 対応する店舗を検索 ────────────────────────────────────────────────────
    const storeRows = await db
      .select()
      .from(storesTable)
      .where(eq(storesTable.stripeAccountId, account.id))
      .limit(1);

    if (storeRows.length === 0) {
      console.log(`[stripe-webhook] stripe_account_id=${account.id} の店舗が見つかりません`);
      res.json({ received: true, store: null });
      return;
    }

    const store = storeRows[0];

    // ── payouts_enabled=false の場合：DB更新 & 既存出品バッグを自動停止 ──────
    // charges_enabled=true でも payouts 停止中は新規出品ブロック済み（API側）
    // Webhook 受信時点で既に公開中のバッグも念のため全停止する
    if (!account.payouts_enabled) {
      try {
        await db
          .update(storesTable)
          .set({ stripePayoutsEnabled: false })
          .where(eq(storesTable.id, store.id));
        await db
          .update(surpriseBagsTable)
          .set({ isActive: false })
          .where(eq(surpriseBagsTable.storeId, store.id));
        console.log(`[stripe-webhook] 🟡 payouts_enabled=false → store ${store.id} の出品バッグを全て停止`);
      } catch (err: any) {
        console.error('[stripe-webhook] payouts_disabled bag stop error:', err?.message);
      }
    }

    // ── 自動承認設定を確認（デフォルトON）────────────────────────────────────
    const autoApprove = (await getSetting('auto_approve_stripe_verified', 'true')) === 'true';

    // ── 自動承認モード ON → 審査待ちなら即承認 ──────────────────────────────
    // 'applied' = 口座登録済みでStripe審査待ち（最も一般的なケース）
    // 'pending' / 'pending_review' = 旧ステータス互換
    if (autoApprove && (store.status === 'applied' || store.status === 'pending_review' || store.status === 'pending')) {
      await db
        .update(storesTable)
        .set({ status: 'approved' as any, isActive: true, stripeChargesEnabled: true })
        .where(eq(storesTable.id, store.id));

      console.log(`[stripe-webhook] ✅ 自動承認: store ${store.id} (${store.name})`);

      // 店舗オーナーに通知
      if (store.ownerId) {
        try {
          await db.insert(notificationsTable).values({
            userId: store.ownerId,
            type: "store_approved",
            title: "🎉 店舗が承認されました！",
            body: `${store.name} がおすそわけに公開されました。おすそわけバッグを出品しましょう！`,
            read: false,
          });
        } catch (e) {
          console.error("[stripe-webhook] notification insert error:", e);
        }
      }

      // ── 店舗オーナーに承認メール送信（approval_email_sent フラグで重複防止）──
      if (!(store as any).approvalEmailSent) {
        try {
          const ownerRow = await pool.query<{ email: string }>(
            `SELECT email FROM users WHERE id = $1 LIMIT 1`,
            [store.ownerId],
          );
          const ownerEmail = ownerRow.rows[0]?.email;
          if (ownerEmail) {
            const sent = await sendStoreApprovalEmail({ ownerEmail, storeName: store.name });
            if (sent) {
              await db.execute(sql`UPDATE stores SET approval_email_sent = true WHERE id = ${store.id}`);
            }
          }
        } catch (e) {
          console.error("[stripe-webhook] 店舗承認メール送信エラー:", e);
        }
      }

      // 自動承認の場合でも管理者にメール送信（KYC完了記録として）
      // 送信成功時のみフラグを立てる (失敗時は次回 webhook で再試行)
      if (!(store as any).stripeKycAdminEmailSent) {
        const ok = await sendAdminKycEmail({
          id: store.id,
          name: store.name,
          imageUrl: store.imageUrl,
          address: store.address,
          city: store.city,
          stripeAccountId: store.stripeAccountId,
          chargesEnabled: account.charges_enabled,
          detailsSubmitted: account.details_submitted,
          payoutsEnabled: account.payouts_enabled,
          ownerId: store.ownerId,
        });
        if (ok) {
          await db.execute(sql`UPDATE stores SET stripe_kyc_admin_email_sent = true WHERE id = ${store.id}`);
        } else {
          console.warn(`[stripe-webhook] auto-approve KYC メール送信失敗 — 次回 webhook で再試行: store ${store.id}`);
        }
      }

      res.json({ received: true, action: "auto_approved", storeId: store.id });
      return;
    }

    // ── charges_enabled を DB に反映（自動承認ON/OFF共通） ─────────────────
    await db
      .update(storesTable)
      .set({ stripeChargesEnabled: true })
      .where(eq(storesTable.id, store.id));

    // ── 自動承認 OFF → 管理者に承認依頼メール（重複送信防止）───────────────
    const alreadySent = (store as any).stripeKycAdminEmailSent === true;

    if (!alreadySent) {
      const ok = await sendAdminKycEmail({
        id: store.id,
        name: store.name,
        imageUrl: store.imageUrl,
        address: store.address,
        city: store.city,
        stripeAccountId: store.stripeAccountId,
        chargesEnabled: account.charges_enabled,
        detailsSubmitted: account.details_submitted,
        payoutsEnabled: account.payouts_enabled,
        ownerId: store.ownerId,
      });

      if (ok) {
        await db.execute(sql`UPDATE stores SET stripe_kyc_admin_email_sent = true WHERE id = ${store.id}`);
      }

      res.json({ received: true, action: "admin_email_sent", storeId: store.id, ok });
    } else {
      console.log(`[stripe-webhook] 既に管理者メール送信済み: store ${store.id}`);
      res.json({ received: true, action: "already_notified", storeId: store.id });
    }

  } catch (err: any) {
    console.error("[stripe-webhook] error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

export default router;
