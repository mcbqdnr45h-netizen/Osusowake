import { Resend } from "resend";
import { escapeHtml } from "../lib/escape.js";
import { supabaseAdmin } from "../lib/supabase.js";

function getResend(): { resend: Resend; from: string } | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return {
    resend: new Resend(key),
    from:   process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev",
  };
}

/**
 * 店舗承認完了メールをオーナーに送信する。
 * 冪等ではないので呼び出し元で approvalEmailSent フラグを確認すること。
 *
 * @returns true = 送信成功, false = APIキー未設定 or 送信失敗
 */
export async function sendStoreApprovalEmail(params: {
  ownerEmail: string;
  storeName:  string;
}): Promise<boolean> {
  const r = getResend();
  if (!r) {
    console.warn("[email] RESEND_API_KEY not set — 店舗承認メールをスキップ");
    return false;
  }

  const appUrl = process.env.APP_URL ?? "https://osusowake.app";

  const { error } = await r.resend.emails.send({
    from:    `おすそわけ <${r.from}>`,
    to:      params.ownerEmail,
    subject: "【おすそわけ】店舗が公開されました🎉",
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- ヘッダー -->
    <div style="background:linear-gradient(135deg,#F26419 0%,#E04E00 100%);padding:40px 32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="color:#ffffff;font-size:24px;font-weight:900;margin:0 0 8px;">店舗が公開されました！</h1>
      <p style="color:rgba(255,255,255,0.9);font-size:14px;margin:0;">おめでとうございます</p>
    </div>

    <!-- 本文 -->
    <div style="padding:32px;">
      <p style="color:#333333;font-size:15px;line-height:1.8;margin:0 0 24px;">
        <strong>${escapeHtml(params.storeName)}</strong> オーナー様<br><br>
        おすそわけ へのご登録ありがとうございます。<br>
        Stripe 本人確認（KYC）が完了し、<strong>店舗がおすそわけに公開</strong>されました。<br>
        さっそく「おすそわけバッグ」を出品して、食品ロスを一緒に減らしましょう！
      </p>

      <!-- ステップカード -->
      <div style="background:#fff8f3;border:2px solid #F26419;border-radius:16px;padding:24px;margin-bottom:24px;">
        <p style="color:#F26419;font-size:12px;font-weight:900;margin:0 0 14px;letter-spacing:0.08em;text-transform:uppercase;">Next Step</p>
        <p style="color:#333333;font-size:15px;font-weight:bold;margin:0 0 6px;">🛍️ おすそわけバッグを出品する</p>
        <p style="color:#666666;font-size:13px;line-height:1.7;margin:0;">
          店舗ダッシュボードからバッグを作成し、<br>
          在庫数・価格・受取時間を設定して出品できます。<br>
          出品後すぐにユーザーに表示されます。
        </p>
      </div>

      <!-- CTAボタン -->
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${appUrl}/store"
           style="display:inline-block;background:linear-gradient(135deg,#F26419,#E04E00);color:#ffffff;font-size:16px;font-weight:900;padding:16px 40px;border-radius:14px;text-decoration:none;letter-spacing:0.02em;">
          店舗ダッシュボードへ →
        </a>
      </div>

      <p style="color:#999999;font-size:12px;line-height:1.7;margin:0;text-align:center;">
        ご不明な点はアプリ内のサポート（マイページ → ヘルプ）からご連絡ください。<br>
        おすそわけ 運営チーム
      </p>
    </div>

    <!-- フッター -->
    <div style="background:#f5f5f0;padding:20px 32px;text-align:center;">
      <p style="color:#aaaaaa;font-size:11px;margin:0;">おすそわけ — お店の余ったおいしさを、あなたへ。</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });

  if (error) {
    console.error("[email] 店舗承認メール送信失敗:", error);
    return false;
  }

  console.log(`[email] ✅ 店舗承認メール送信: ${params.ownerEmail} (${params.storeName})`);
  return true;
}

/**
 * 店舗オーナーに「注文が入りました」メールを送信する。
 * Web Push が来ない環境 (ブラウザのみで利用中・通知拒否中など) のための補完通知。
 * 呼び出し元で send 失敗を握り潰せるよう例外は投げず boolean を返す。
 */
export async function sendStoreOrderNotificationEmail(params: {
  ownerEmail: string;
  storeName:  string;
  bagTitle:   string;
  quantity:   number;
  pickupCode: string | null;
  pickupStart?: string | null;
  pickupEnd?:   string | null;
  totalPrice?:  number | null;
  orderId?:     number | string | null;
}): Promise<boolean> {
  const r = getResend();
  if (!r) {
    console.warn("[email] RESEND_API_KEY not set — 店舗注文メールをスキップ");
    return false;
  }

  const appUrl = process.env.APP_URL ?? "https://osusowakejapan.org";
  const pickupTime = params.pickupStart && params.pickupEnd
    ? `${params.pickupStart} 〜 ${params.pickupEnd}`
    : "（バッグ情報をご確認ください）";
  const priceLine = typeof params.totalPrice === "number"
    ? `<tr><td style="padding:8px 0;color:#666;">お支払い額</td><td style="padding:8px 0;text-align:right;font-weight:bold;color:#111;">¥${params.totalPrice.toLocaleString()}</td></tr>`
    : "";
  const orderIdStr = params.orderId != null
    ? `ORD-${String(params.orderId).padStart(8, "0")}`
    : "—";

  const { error } = await r.resend.emails.send({
    from:    `おすそわけ <${r.from}>`,
    to:      params.ownerEmail,
    subject: `【おすそわけ】${params.storeName} にご注文が入りました🛍️`,
    html: `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#F26419 0%,#E04E00 100%);padding:32px;text-align:center;">
      <div style="font-size:42px;margin-bottom:8px;">🛍️</div>
      <h1 style="color:#fff;font-size:22px;font-weight:900;margin:0;">ご注文が入りました</h1>
      <p style="color:rgba(255,255,255,0.9);font-size:13px;margin:8px 0 0;">${escapeHtml(params.storeName)}</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="color:#333;font-size:14px;line-height:1.7;margin:0 0 20px;">
        おすそわけバッグが購入されました。<br>
        受取時間までにご準備をお願いします。
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#666;width:38%;">注文番号</td><td style="padding:8px 0;text-align:right;font-family:monospace;color:#111;">${escapeHtml(orderIdStr)}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">商品</td><td style="padding:8px 0;text-align:right;font-weight:bold;color:#111;">${escapeHtml(params.bagTitle)}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">数量</td><td style="padding:8px 0;text-align:right;font-weight:bold;color:#111;">${params.quantity} 個</td></tr>
        <tr><td style="padding:8px 0;color:#666;">受取時間</td><td style="padding:8px 0;text-align:right;color:#111;">${escapeHtml(pickupTime)}</td></tr>
        ${priceLine}
      </table>
      <div style="background:#fff8f3;border:2px dashed #F26419;border-radius:14px;padding:18px;margin:24px 0;text-align:center;">
        <p style="color:#F26419;font-size:11px;font-weight:900;margin:0 0 6px;letter-spacing:0.08em;">PICKUP CODE</p>
        <p style="color:#111;font-size:28px;font-weight:900;letter-spacing:0.2em;font-family:monospace;margin:0;">${escapeHtml(params.pickupCode ?? "---")}</p>
        <p style="color:#666;font-size:11px;margin:8px 0 0;">お客様がご来店時にこのコードを提示します</p>
      </div>
      <div style="text-align:center;margin:24px 0 12px;">
        <a href="${appUrl}/store/orders" style="display:inline-block;background:linear-gradient(135deg,#F26419,#E04E00);color:#fff;font-size:15px;font-weight:900;padding:14px 36px;border-radius:12px;text-decoration:none;">
          注文一覧を見る →
        </a>
      </div>
      <p style="color:#999;font-size:11px;line-height:1.6;margin:20px 0 0;text-align:center;">
        本メールは Web プッシュ通知が届かない環境でも確実にお知らせするため自動配信されています。<br>
        通知設定の変更は店舗ダッシュボードから行えます。
      </p>
    </div>
    <div style="background:#f5f5f0;padding:16px 32px;text-align:center;">
      <p style="color:#aaa;font-size:10px;margin:0;">おすそわけ — お店の余ったおいしさを、あなたへ。</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });

  if (error) {
    console.error("[email] 店舗注文メール送信失敗:", error);
    return false;
  }
  console.log(`[email] ✅ 店舗注文メール送信: ${params.ownerEmail} (${params.storeName} / pickup=${params.pickupCode ?? "—"})`);
  return true;
}

/**
 * 店舗オーナーの ID から auth.users を引いてメール送信まで一気にやるラッパー。
 * 呼び出し側の payment.ts / stripe-webhook.ts でボイラープレートが減る。
 * 失敗しても投げず、 ログだけ吐いて false を返す (push 通知をブロックさせない)。
 */
export async function sendOrderEmailToStoreOwnerById(args: {
  ownerId: string;
  storeName: string;
  bagTitle: string;
  quantity: number;
  pickupCode: string | null;
  pickupStart?: string | null;
  pickupEnd?:   string | null;
  totalPrice?:  number | null;
  orderId?:     number | string | null;
  // ★ push が1台以上の端末へ届いたか。false/undefined のときは「push が届いていない」
  //   = このメールが唯一の注文通知なので、opt-out を無視して必ず送る (注文取りこぼし=
  //   オーバーブッキング防止)。true のときだけ opt-out を尊重し、邪魔なメールを止める。
  pushDelivered?: boolean;
}): Promise<boolean> {
  try {
    // ★ 注文メールは本来「push が届かない環境のフォールバック」。
    //   push が届いている店舗にだけ opt-out を効かせ、届いていない店舗には必ず送る。
    if (args.pushDelivered === true) {
      const { data: prefRow, error: prefErr } = await supabaseAdmin
        .from("users")
        .select("notif_email_orders")
        .eq("id", args.ownerId)
        .maybeSingle();
      if (!prefErr && prefRow) {
        const wants = (prefRow as { notif_email_orders?: boolean | null }).notif_email_orders;
        // push 配信済みなら、明示的に「常にメールも欲しい」(true) 店だけ送る。
        if (wants !== true) {
          console.log(`[email] push 配信済み & 明示 opt-in でないため注文メール送信スキップ ownerId=${args.ownerId}`);
          return false;
        }
      }
    }

    const { data, error } = await supabaseAdmin.auth.admin.getUserById(args.ownerId);
    if (error || !data?.user?.email) {
      console.warn(`[email] 店舗オーナーのメールが取得できず注文メール送信スキップ ownerId=${args.ownerId}`);
      return false;
    }
    return await sendStoreOrderNotificationEmail({
      ownerEmail: data.user.email,
      storeName:  args.storeName,
      bagTitle:   args.bagTitle,
      quantity:   args.quantity,
      pickupCode: args.pickupCode,
      pickupStart: args.pickupStart ?? null,
      pickupEnd:   args.pickupEnd ?? null,
      totalPrice:  args.totalPrice ?? null,
      orderId:     args.orderId ?? null,
    });
  } catch (e) {
    console.error("[email] sendOrderEmailToStoreOwnerById 例外:", e);
    return false;
  }
}
