import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storesRouter from "./stores";
import bagsRouter from "./bags";
import reservationsRouter from "./reservations";
import paymentRouter from "./payment";
import supabaseTestRouter from "./supabase-test";
import uploadRouter from "./upload";
import notificationsRouter from "./notifications";
import classifyRouter from "./classify";
import favoritesRouter from "./favorites";
import rankingRouter from "./ranking";
import userPreferencesRouter from "./user-preferences";
import pushNotificationsRouter from "./push-notifications";
import adminRouter from "./admin";
import authRouter from "./auth";
import stripeWebhookRouter from "./stripe-webhook";
import recurringRouter from "./recurring";
import publicListingsRouter from "./public-listings";
import { supabaseAdmin, supabaseAnon } from "../lib/supabase.js";
import { validateNickname, normalizeNickname } from "../lib/nickname-validator.js";
import { Resend } from "resend";

const router: IRouter = Router();

router.use(adminRouter);
router.use(authRouter);
router.use(stripeWebhookRouter);
router.use(healthRouter);
router.use(storesRouter);
router.use(bagsRouter);
router.use(reservationsRouter);
router.use(paymentRouter);
router.use(supabaseTestRouter);
router.use(uploadRouter);
router.use(notificationsRouter);
router.use(classifyRouter);
router.use(favoritesRouter);
router.use(rankingRouter);
router.use(userPreferencesRouter);
router.use(pushNotificationsRouter);
router.use(recurringRouter);
router.use(publicListingsRouter);

// ── POST /auth/forgot-password ── ブランドメール送信（Resend 経由）──────────
router.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email, redirectTo } = req.body as { email?: string; redirectTo?: string };
    if (!email?.trim()) {
      res.status(400).json({ error: "bad_request", message: "メールアドレスは必須です" });
      return;
    }

    // redirectTo を確定: フロントから来た値 → 環境変数 → fallback
    const appDomain = process.env.APP_DOMAIN ?? process.env.REPLIT_DEV_DOMAIN ?? "";
    const finalRedirectTo =
      redirectTo ||
      (appDomain ? `https://${appDomain}/rescueat/reset-password` : "");

    console.log("[forgot-password] redirectTo:", finalRedirectTo);

    // Supabase Admin でリカバリーリンクを生成（メールは送信しない）
    const linkOpts: Record<string, unknown> = {
      type: "recovery",
      email: email.trim(),
      options: { redirectTo: finalRedirectTo },
    };
    const { data, error: genErr } = await supabaseAdmin.auth.admin.generateLink(
      linkOpts as Parameters<typeof supabaseAdmin.auth.admin.generateLink>[0],
    );

    if (genErr || !data?.properties?.action_link) {
      const reason = genErr?.message ?? "no action_link";
      console.warn("[forgot-password] generateLink failed for:", email.trim(), "reason:", reason);
      // ★ セキュリティ修正 (2026-07-08): メールアドレス列挙 (email enumeration) 対策。
      //   「ユーザーが存在しない」を明示すると、攻撃者が任意のアドレスを叩いて
      //   「登録済みかどうか」を判定できてしまう (会員リストの割り出し)。よって
      //   存在しないアカウントでも「送信しました」と同じ 200 を返し、区別させない。
      const isNotFound = /not.?found|does.?not.?exist|user.+not/i.test(reason);
      if (isNotFound) {
        res.json({ ok: true });
        return;
      }
      // それ以外（Supabase 一時障害等）は 500 を返す
      res.status(500).json({
        error:   "generate_link_failed",
        message: "リンク生成に失敗しました。しばらくしてからもう一度お試しください。",
      });
      return;
    }

    const resetLink = data.properties.action_link;

    // Resend でブランドメールを送信
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.error("[forgot-password] RESEND_API_KEY not set");
      res.status(500).json({ error: "config_error", message: "メール設定が不完全です" });
      return;
    }
    const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
    const resend = new Resend(resendKey);

    const { error: sendError } = await resend.emails.send({
      from:    `おすそわけ事務局 <${fromDomain}>`,
      to:      email.trim(),
      subject: "【おすそわけ】パスワード再設定のご案内",
      html:    buildPasswordResetHtml(resetLink),
    });

    if (sendError) {
      console.warn("[forgot-password] Resend failed (domain not verified), falling back to Supabase email");
      // Resend ドメイン未認証時は Supabase 標準メールでフォールバック
      const { error: fallbackErr } = await supabaseAnon.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: finalRedirectTo || undefined,
      });
      if (fallbackErr) {
        // レート制限の場合は "しばらく待ってから" メッセージ
        const isRateLimit = fallbackErr.message?.includes("after") || fallbackErr.message?.includes("seconds") || fallbackErr.status === 429;
        console.error("[forgot-password] Supabase fallback error:", fallbackErr.message);
        res.status(500).json({
          error: "send_error",
          message: isRateLimit
            ? "送信が完了するまで少し時間をおいてから再試行してください（60秒以上）"
            : "メールの送信に失敗しました。しばらくしてからお試しください。",
        });
        return;
      }
      console.log("[forgot-password] fallback email sent via Supabase to:", email.trim());
      res.json({ ok: true });
      return;
    }

    console.log("[forgot-password] branded email sent to:", email.trim());
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[forgot-password] error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

function buildPasswordResetHtml(resetLink: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>パスワード再設定 — おすそわけ</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F3;font-family:'Hiragino Kaku Gothic Pro','Hiragino Sans','Yu Gothic UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#F5F5F3;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation"
          style="max-width:560px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- ── ヘッダー（グラデーション） ── -->
          <tr>
            <td style="background:linear-gradient(135deg,#F26419 0%,#F6AE2D 100%);padding:36px 40px;text-align:center;">
              <p style="margin:0 0 4px;font-size:32px;font-weight:900;color:#ffffff;letter-spacing:-1px;line-height:1;">
                おすそわけ
              </p>
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.8);font-weight:600;letter-spacing:0.5px;">
                食品ロスをなくす、おすそわけマーケット
              </p>
            </td>
          </tr>

          <!-- ── 本文 ── -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#1A1A1A;line-height:1.3;">
                パスワード再設定のご案内
              </p>
              <div style="width:40px;height:4px;background:linear-gradient(90deg,#F26419,#F6AE2D);border-radius:2px;margin:0 0 24px;"></div>

              <p style="margin:0 0 12px;font-size:15px;color:#555;line-height:1.8;">
                おすそわけをご利用いただきありがとうございます。
              </p>
              <p style="margin:0 0 32px;font-size:15px;color:#555;line-height:1.8;">
                以下のボタンをタップして、新しいパスワードを設定してください。<br/>
                ボタンが表示されない場合は、末尾のURLを直接ブラウザに貼り付けてください。
              </p>

              <!-- ── CTAボタン ── -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="padding-bottom:32px;">
                    <a href="${resetLink}"
                      style="display:inline-block;background:linear-gradient(135deg,#F26419 0%,#F6AE2D 100%);color:#ffffff;font-size:16px;font-weight:900;text-decoration:none;padding:18px 48px;border-radius:100px;box-shadow:0 6px 20px rgba(242,100,25,0.4);letter-spacing:0.3px;">
                      パスワードを再設定する
                    </a>
                  </td>
                </tr>
              </table>

              <!-- ── 補足テキスト ── -->
              <div style="background:#FFF8F0;border-radius:12px;padding:16px 20px;border-left:4px solid #F26419;">
                <p style="margin:0;font-size:13px;color:#777;line-height:1.7;">
                  ⚠️ このメールに心当たりがない場合は、そのまま破棄してください。<br/>
                  リンクの有効期限は <strong>24時間</strong> です。
                </p>
              </div>

              <!-- URLテキスト -->
              <p style="margin:20px 0 0;font-size:11px;color:#aaa;line-height:1.6;word-break:break-all;">
                リンク: <a href="${resetLink}" style="color:#F26419;text-decoration:none;">${resetLink}</a>
              </p>
            </td>
          </tr>

          <!-- ── フッター ── -->
          <tr>
            <td style="background:#F8F8F7;padding:20px 40px;text-align:center;border-top:1px solid #EBEBEA;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:900;color:#888;">おすそわけ</p>
              <p style="margin:0;font-size:11px;color:#bbb;">© 2026 おすそわけ. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

router.put("/user/display-name", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: "unauthorized", message: "ログインが必要です" }); return; }

  const { displayName } = req.body as { displayName?: string };
  const result = validateNickname(displayName);
  if (!result.ok) {
    res.status(400).json({ error: "invalid_display_name", message: result.reason }); return;
  }
  const trimmed = normalizeNickname(displayName as string);

  try {
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) { res.status(401).json({ error: "unauthorized", message: "セッションが無効です" }); return; }

    // ★ 防御的 2-step 保存: public.users 行が auth.users と sync されていない場合
    // (sync trigger 失敗・古い登録ユーザー等) でも保存できるようにする。
    // upsert を使うと既存行の email も上書きされ得るため、 既存行有無で分岐する。
    const { data: existing, error: selErr } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (selErr) {
      console.error("[/user/display-name] select failed:", selErr.message);
      res.status(500).json({ error: "save_failed", message: `保存に失敗しました (${selErr.code || "DB"})` });
      return;
    }

    let dbErr;
    if (existing) {
      // 既存行 → display_name のみ更新 (email を null で上書きしない)
      const { error } = await supabaseAdmin
        .from("users")
        .update({ display_name: trimmed })
        .eq("id", user.id);
      dbErr = error;
    } else {
      // 行なし → email を含めて insert
      const { error } = await supabaseAdmin
        .from("users")
        .insert({ id: user.id, email: user.email ?? null, display_name: trimmed });
      dbErr = error;
    }

    if (dbErr) {
      console.error("[/user/display-name] save failed:", dbErr.message, dbErr.details);
      res.status(500).json({
        error: "save_failed",
        message: `保存に失敗しました (${dbErr.code || "DB"})`,
      });
      return;
    }
    res.json({ ok: true, display_name: trimmed });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/user/display-name] error:", msg);
    res.status(500).json({ error: "save_failed", message: msg });
  }
});

router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "No token provided" });
    return;
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      res.status(401).json({ error: "unauthorized", message: "Invalid token" });
      return;
    }
    const meta = (user.user_metadata ?? {}) as Record<string, string>;
    res.json({
      id: user.id,
      name: meta.full_name || meta.name || user.email?.split("@")[0] || "ユーザー",
      email: user.email ?? "",
      role: meta.role ?? "user",
      createdAt: user.created_at,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/me] error:", msg);
    res.status(500).json({ error: "internal_error", message: msg });
  }
});

export default router;
