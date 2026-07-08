import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase";
import { validateNickname, normalizeNickname } from "../lib/nickname-validator";
import { markAdminMfaVerified } from "../lib/admin-mfa";
import { Resend } from "resend";
import { promises as dnsPromises } from "node:dns";
import { randomInt } from "node:crypto";

// ── 使い捨てメールドメインのブロックリスト（代表例） ─────────────────────────
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.net", "guerrillamail.org", "sharklasers.com",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "tempmail.net",
  "temp-mail.org", "temp-mail.io", "throwaway.email", "throwawaymail.com",
  "yopmail.com", "yopmail.net", "yopmail.fr", "trashmail.com", "trashmail.net",
  "trashmail.de", "maildrop.cc", "mintemail.com", "fakeinbox.com", "fakemail.net",
  "getairmail.com", "dispostable.com", "spamgourmet.com", "mytemp.email",
  "tempinbox.com", "tempr.email", "mohmal.com", "moakt.com", "emailondeck.com",
  "burnermail.io", "discard.email", "mvrht.net", "spamex.com", "anonbox.net",
  "mailcatch.com", "spambox.us", "tempmailo.com", "mintemail.email", "mailnesia.com",
  "smailpro.com", "tempail.com", "tempmail.plus", "mailtothis.com", "wegwerfemail.de",
  "byom.de", "trbvm.com", "spam4.me", "0815.ru", "33mail.com",
  "muehlemann.org", "mailtemp.info", "anonmail.top", "spamavert.com", "mt2015.com",
]);

// DNS ルックアップにタイムアウトを設定（遅い DNS でサインアップが詰まらないように）
// ★ 600ms: 主要メールドメイン (gmail/icloud/yahoo/outlook) は通常 50-200ms で解決する。
//   それ以上待つメリットは小さく、登録 UX を優先してタイムアウトは通過扱い (valid: true)。
const DNS_TIMEOUT_MS = 600;
function withDnsTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error("dns_timeout");
      err.code = "ETIMEOUT";
      reject(err);
    }, DNS_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// メールアドレスの形式とドメインの実在性（MX レコード）を検証
async function validateEmailExistence(email: string): Promise<{ valid: boolean; reason?: string }> {
  const trimmed = email.trim().toLowerCase();
  // 1. 形式チェック（RFC5322 簡易版）
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(trimmed)) {
    return { valid: false, reason: "invalid_format" };
  }
  const domain = trimmed.split("@")[1];
  if (!domain || domain.length > 253) {
    return { valid: false, reason: "invalid_format" };
  }
  // 2. 使い捨てメールドメインを拒否
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { valid: false, reason: "disposable" };
  }
  // 3. MX レコードを引いてドメインがメール受信可能か確認（タイポや偽ドメイン排除）
  // ★ A レコード fallback は削除 (タイムアウト時に追加で待たせる原因 → 登録が遅くなる)。
  //    MX が無い = no_mx で即返す。NXDOMAIN は domain_not_found。
  try {
    const records = await withDnsTimeout(dnsPromises.resolveMx(domain));
    if (!records || records.length === 0) {
      return { valid: false, reason: "no_mx" };
    }
    return { valid: true };
  } catch (err: any) {
    // ドメインが存在しない (NXDOMAIN) → 確実に無効
    if (err?.code === "ENOTFOUND") {
      return { valid: false, reason: "domain_not_found" };
    }
    // ドメインは存在するが MX レコードが無い → メール受信不可
    if (err?.code === "ENODATA") {
      return { valid: false, reason: "no_mx" };
    }
    // ★ 一時的障害のみ valid:true で通過 (whitelist 方式: 想定外エラーは弾く)
    //    - ETIMEOUT: withDnsTimeout が投げるカスタムエラー
    //    - ETIMEDOUT: Node.js DNS のタイムアウトエラー
    //    - EAI_AGAIN: 一時的な DNS resolver 障害 (リトライ可能)
    //    - ESERVFAIL: DNS サーバー側の一時障害
    const TRANSIENT = new Set(["ETIMEOUT", "ETIMEDOUT", "EAI_AGAIN", "ESERVFAIL"]);
    if (TRANSIENT.has(err?.code)) {
      console.warn("[validateEmailExistence] DNS transient error (passing through):", err?.code, err?.message);
      return { valid: true };
    }
    // それ以外の想定外エラーは無効扱い (誤通過よりも弾く方が安全)
    console.warn("[validateEmailExistence] DNS unknown error:", err?.code, err?.message);
    return { valid: false, reason: "no_mx" };
  }
}

// ── 管理者 OTP ストア（インメモリ） ──────────────────────────────────────────
interface OtpEntry {
  code:      string;
  expiresAt: number;
  attempts:  number;
}
const adminOtpStore = new Map<string, OtpEntry>();

function generateOtp(): string {
  // ★ セキュリティ修正 (2026-07-08): Math.random() は暗号論的に安全でなく、
  //   予測可能な PRNG のため管理者 MFA の OTP には不適。crypto.randomInt で
  //   一様・予測不能な 6 桁 (100000〜999999) を生成する。
  return String(randomInt(100000, 1000000));
}

function buildAdminOtpHtml(code: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>管理者ログイン確認</title></head>
<body style="margin:0;padding:0;background:#F5F5F3;font-family:'Hiragino Kaku Gothic Pro','Yu Gothic UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F3;padding:40px 16px;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0"
  style="max-width:480px;width:100%;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.09);">
  <tr><td style="background:linear-gradient(135deg,#7C3AED,#4F46E5);padding:32px 40px;text-align:center;">
    <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;">🛡️ おすそわけ</div>
    <div style="color:rgba(255,255,255,0.80);font-size:13px;margin-top:6px;">管理者ログイン確認コード</div>
  </td></tr>
  <tr><td style="padding:40px 40px 32px;">
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.7;">
      管理者ダッシュボード（神モード）へのログインが検出されました。<br>
      以下の確認コードを入力してください。
    </p>
    <div style="background:#F3F0FF;border:2px solid #7C3AED;border-radius:16px;padding:28px;text-align:center;margin-bottom:24px;">
      <div style="font-size:13px;color:#6B21A8;font-weight:700;letter-spacing:2px;margin-bottom:12px;">確認コード</div>
      <div style="font-size:48px;font-weight:900;color:#4F46E5;letter-spacing:12px;font-feature-settings:'tnum';">${code}</div>
    </div>
    <p style="margin:0 0 8px;color:#6B7280;font-size:13px;">⏱ このコードは <strong>10分間</strong> 有効です。</p>
    <p style="margin:0;color:#EF4444;font-size:13px;font-weight:700;">⚠️ このコードを他人と共有しないでください。</p>
  </td></tr>
  <tr><td style="background:#F9F9F7;padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;">
    <p style="margin:0;color:#9CA3AF;font-size:11px;">このメールに心当たりがない場合は、即座にパスワードを変更してください。</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// #6 フェーズ B: ハードコード ADMIN_EMAIL を完全廃止し、 DB role=admin で一元判定。
// 共通ヘルパー (lib/admin.ts) 経由で判定する。
import { isUserAdmin } from "../lib/admin.js";

async function checkAdmin(user: { id?: string | null; email?: string | null } | null | undefined): Promise<boolean> {
  if (!user?.id) return false;
  return isUserAdmin({ id: user.id });
}

const router: IRouter = Router();

// ── POST /auth/create-profile ─────────────────────────────────────────────────
// 新規ユーザーのプロフィールを Admin クライアント（RLS バイパス）で upsert する
// フロントからの supabase.from('users').upsert() は RLS でブロックされるため必須
router.post("/auth/create-profile", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // JWT からユーザーを検証
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { role, full_name, phone_number, display_name } = req.body as {
    role?: string;
    full_name?: string;
    phone_number?: string;
    display_name?: string;
  };

  if (!role || !full_name) {
    res.status(400).json({ error: "role, full_name are required" });
    return;
  }

  // ★★ セキュリティ修正 (2026-07-08): サインアップ時に client 指定の role を絶対に信用しない。
  //   users_role_check は 'admin' も許可しているため、旧実装では新規ユーザが
  //   POST /auth/create-profile {role:"admin"} を1回叩くだけで管理者に昇格できた
  //   (INSERT 分岐は role を verbatim で書き込んでいた=権限昇格の重大脆弱性)。
  //   サインアップで自己申告できるのは customer / store_owner のみ。想定外の値
  //   ('admin' 含む) はすべて最小権限 customer にフェイルクローズする。
  //   admin 付与は /admin/admins 経由 (既存 admin + MFA) のみに限定する。
  const SIGNUP_ALLOWED_ROLES = new Set(["customer", "store_owner"]);
  const safeRole = SIGNUP_ALLOWED_ROLES.has(role) ? role : "customer";
  // ★ T004 OAuth (Apple/Google) では provider metadata に phone が無い → 空欄を許容して NULL 保存。
  //   後から MyPage 設定 / 予約フローで補完を促す。 phone_number 列は NULL 可。
  const normalizedPhone: string | null =
    typeof phone_number === "string" && phone_number.trim().length > 0 ? phone_number.trim() : null;

  // ★ 仕様変更 2026-05: display_name (ニックネーム) は登録時はすべて任意。
  //   customer もニックネーム不要で登録可能とし、 ランキング参加 (オプトイン) 時にのみ
  //   PATCH /user/ranking-preference 側で display_name 必須を要求する。
  //   渡された場合のみバリデーションして保存する。
  let normalizedDisplayName: string | null = null;
  if (display_name && typeof display_name === "string" && display_name.trim().length > 0) {
    const result = validateNickname(display_name);
    if (!result.ok) {
      res.status(400).json({ error: "invalid_display_name", message: result.reason });
      return;
    }
    normalizedDisplayName = normalizeNickname(display_name);
  }

  try {
    // ★ 原子的 UPSERT: INSERT ... ON CONFLICT (id) DO UPDATE。
    //   display_name は COALESCE で「既存値が NULL の場合のみ EXCLUDED で上書き」する。
    //   これにより SignUp 時の display_name は確実に保存され、 既存ユーザーが再 create-profile を
    //   呼ばれても (例: 確認メール後の自動再作成) 既に設定された display_name は失われない。
    //
    //   ★ セキュリティ修正 (2026-05-02): role は ON CONFLICT で上書きしない。
    //     旧仕様では `role = EXCLUDED.role` のため、 認証済みユーザが /auth/create-profile を
    //     直接叩くだけで自由にロールを書き換えられた (=customer→store_owner の権限昇格脆弱性)。
    //     新仕様では INSERT 時 (新規ユーザ) のみ役割を確定させ、 既存ユーザの role は完全に
    //     固定する。 customer→store_owner への正規昇格は /auth/update-role 経由 (intended_role 検証付き) のみ。
    //
    //   制約名で 23505 を分類し、phone_number の重複と id の重複を区別する。
    try {
      await db.execute(sql`
        INSERT INTO users (id, email, role, full_name, phone_number, display_name)
        VALUES (${user.id}, ${user.email!}, ${safeRole}, ${full_name.trim()}, ${normalizedPhone}, ${normalizedDisplayName})
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          phone_number = COALESCE(users.phone_number, EXCLUDED.phone_number),
          display_name = COALESCE(users.display_name, EXCLUDED.display_name)
      `);
    } catch (dbErr: any) {
      const code = dbErr?.code ?? dbErr?.cause?.code;
      const constraint = dbErr?.constraint ?? dbErr?.cause?.constraint ?? "";
      const detail = dbErr?.detail ?? dbErr?.cause?.detail ?? "";
      console.error("[auth/create-profile] write error:", { code, constraint, detail, message: dbErr?.message });
      if (code === "23505") {
        // 制約名 / detail から phone_number 重複を識別
        const isPhone = constraint.includes("phone") || detail.includes("phone");
        if (isPhone) {
          res.status(409).json({ error: "phone_taken", message: "この電話番号は既に登録されています" });
          return;
        }
        // それ以外の unique 違反は内部エラー扱い (id 衝突は通常起こり得ない: id は auth.users 由来で一意)
        res.status(500).json({ error: "db_error", message: "ユーザー情報の保存に失敗しました" });
        return;
      }
      res.status(500).json({ error: "db_error", message: dbErr?.message ?? "DB error" });
      return;
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[auth/create-profile]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /api/auth/profile ──────────────────────────────────────────────────────
// JWT を検証してプロフィールを返す（Admin クライアントで RLS バイパス）
router.get("/auth/profile", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) { res.status(401).json({ error: "unauthorized" }); return; }

  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, email, role, full_name, phone_number, display_name")
      .eq("id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      res.status(500).json({ error: "db_error", message: error.message });
      return;
    }
    res.json({ profile: data ?? null });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── PATCH /api/auth/update-role ────────────────────────────────────────────────
// サインイン後にロールを確定させる（ロール整合チェック付き）
// - store_owner タブからログイン: DB が customer(=trigger自動作成) なら store_owner に昇格
// - customer タブからログイン: DB が store_owner なら 403 を返す
router.patch("/auth/update-role", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) { res.status(401).json({ error: "unauthorized" }); return; }

  const { desiredRole } = req.body as { desiredRole?: string };
  if (desiredRole !== "store_owner" && desiredRole !== "customer") {
    res.status(400).json({ error: "invalid_role" });
    return;
  }

  try {
    // 現在の DB プロフィールを取得
    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id, role, full_name")
      .eq("id", user.id)
      .single();

    // ── ケース分岐 ──────────────────────────────────────────────────────────
    if (!existing) {
      // プロフィールなし（メール確認後の初回ログイン等）→ 新規作成
      const { error: insertErr } = await supabaseAdmin.from("users").insert({
        id: user.id,
        email: user.email!,
        role: desiredRole,
      });
      if (insertErr) {
        res.status(500).json({ error: "db_error", message: insertErr.message });
        return;
      }
      res.json({ ok: true, role: desiredRole, action: "created" });
      return;
    }

    const currentRole = existing.role as string;
    // Supabase auth メタデータの intended_role（signUpAsStore で埋め込み）
    const intendedRole = (user.user_metadata?.intended_role as string | undefined) ?? null;

    if (desiredRole === "store_owner") {
      if (currentRole === "store_owner") {
        // 既に store_owner → そのまま OK
        res.json({ ok: true, role: currentRole, action: "noop" });
        return;
      }
      // ★ customer → store_owner 昇格は **intended_role === "store_owner"** を持つアカウントのみ許可。
      //   旧仕様では「full_name=null なら昇格 OK」 にしていたため、 一般ユーザ (signUp で customer
      //   登録したが名前未入力) が店舗タブからログイン → 自動で store_owner に昇格 → 店舗ダッシュ
      //   ボードに入れてしまう穴があった。 intended_role は signUpAsStore() でのみ埋め込まれるので、
      //   この値を持たないアカウントの店舗タブログインは全て拒否する。
      if (currentRole === "customer" && intendedRole === "store_owner") {
        await supabaseAdmin.from("users").update({ role: "store_owner" }).eq("id", user.id);
        console.log(`[/auth/update-role] customer → store_owner 昇格 (intended_role 一致) userId=${user.id}`);
        res.json({ ok: true, role: "store_owner", action: "upgraded" });
        return;
      }
      // それ以外 (一般ユーザが店舗タブで誤ログイン) → 403
      console.warn(`[/auth/update-role] 🚫 customer → store_owner 昇格拒否 userId=${user.id} currentRole=${currentRole} intendedRole=${intendedRole ?? "(なし)"} hasFullName=${!!existing.full_name}`);
      res.status(403).json({
        error: "role_mismatch",
        message: "このアカウントは一般ユーザー用です。「お客さま」 タブからログインしてください。 店舗オーナーとして利用したい場合は別のメールアドレスで新規登録してください。",
      });
      return;
    }

    // desiredRole = 'customer'
    if (currentRole === "store_owner") {
      // 店舗オーナーが一般タブでログイン → 拒否
      res.status(403).json({
        error: "role_mismatch",
        message: "このアカウントは店舗オーナー用です。「飲食店・パートナー」タブからログインしてください。",
      });
      return;
    }
    // customer で intended_role=store_owner（メール確認後に誤って user タブでログイン）→ 拒否
    if (currentRole === "customer" && !existing.full_name && intendedRole === "store_owner") {
      res.status(403).json({
        error: "role_mismatch",
        message: "店舗オーナーとして登録されています。「飲食店・パートナー」タブからログインしてください。",
      });
      return;
    }
    // customer → customer → そのまま OK
    res.json({ ok: true, role: currentRole, action: "noop" });
  } catch (err: any) {
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /auth/check-email ─────────────────────────────────────────────────────
// メールアドレスの実在性検証（形式・MX レコード・使い捨てメールドメイン）
router.post("/auth/check-email", async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) {
    res.status(400).json({ valid: false, reason: "email_required" });
    return;
  }
  try {
    const result = await validateEmailExistence(email);
    res.json(result);
  } catch (err: any) {
    console.error("[auth/check-email]", err);
    // ★ 想定外の例外時は無効扱い (validateEmailExistence の方針一貫性確保)。
    //   一時的障害は validateEmailExistence 内で valid:true 通過済みなので、
    //   ここに到達するのは想定外のエラー → 弾く方が安全。
    res.json({ valid: false, reason: "no_mx" });
  }
});

// ── POST /auth/check-phone ─────────────────────────────────────────────────────
// 電話番号の重複チェック（管理者クライアントで RLS をバイパス）
router.post("/auth/check-phone", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: string };
  if (!phone?.trim()) {
    res.status(400).json({ error: "phone is required" });
    return;
  }
  try {
    const result = await db.execute(sql`
      SELECT id FROM users WHERE phone_number = ${phone.trim()} LIMIT 1
    `);
    res.json({ taken: result.rows.length > 0 });
  } catch (err: any) {
    console.error("[auth/check-phone]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── POST /auth/cleanup-user ────────────────────────────────────────────────────
// auth.users から孤立したユーザーを削除（DB upsert 失敗後のロールバック）
// セキュリティ: userId は Supabase auth の JWT から取得した ID のみ受け付ける
router.post("/auth/cleanup-user", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // トークンからユーザーを検証（自分自身のアカウントのみ削除可能）
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    // users テーブルの状態を確認
    const { data: existing } = await supabaseAdmin
      .from("users")
      .select("id, full_name")
      .eq("id", user.id)
      .single();

    if (existing && existing.full_name) {
      // full_name が設定済み = 正常に登録されたユーザー → 削除しない
      res.status(400).json({ error: "user_already_registered" });
      return;
    }

    // レコードが存在しない OR full_name=null（Supabase トリガーが自動生成した不完全レコード）
    // → public.users の行を先に削除してから auth.users を削除
    if (existing) {
      await supabaseAdmin.from("users").delete().eq("id", user.id);
    }
    await supabaseAdmin.auth.admin.deleteUser(user.id);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[auth/cleanup-user]", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

// ── GET /auth/is-admin ────────────────────────────────────────────────────────
router.get("/auth/is-admin", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.json({ isAdmin: false }); return; }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) { res.json({ isAdmin: false }); return; }
  res.json({ isAdmin: await checkAdmin(user) });
});

// ── POST /auth/admin-otp/send ─────────────────────────────────────────────────
// 管理者メールに 6桁 OTP を送信する
router.post("/auth/admin-otp/send", async (req: Request, res: Response) => {  // ↓ checkAdmin (#6) を使用
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user || !(await checkAdmin(user))) {
    res.status(403).json({ error: "forbidden" }); return;
  }

  const email = user.email!;

  // 前回コードが有効かつ 30秒以内の再送信はブロック
  const existing = adminOtpStore.get(email);
  if (existing && existing.expiresAt > Date.now() + (10 * 60 * 1000 - 30 * 1000)) {
    res.status(429).json({ error: "too_soon", message: "30秒後に再送信できます" }); return;
  }

  const code = generateOtp();
  adminOtpStore.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error("[admin-otp/send] RESEND_API_KEY not set");
    res.status(500).json({ error: "mail_config" }); return;
  }

  try {
    const fromDomain = process.env.RESEND_FROM_DOMAIN ?? "onboarding@resend.dev";
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from:    `おすそわけ事務局 <${fromDomain}>`,
      to:      email,
      subject: "【おすそわけ管理者】ログイン確認コード",
      html:    buildAdminOtpHtml(code),
    });
    console.log(`[admin-otp/send] OTP sent to admin`);
    res.json({ ok: true });
  } catch (err: any) {
    adminOtpStore.delete(email);
    console.error("[admin-otp/send] Resend error:", err?.message);
    res.status(500).json({ error: "mail_send_failed", message: err?.message });
  }
});

// ── POST /auth/admin-otp/verify ───────────────────────────────────────────────
// OTP コードを検証する
router.post("/auth/admin-otp/verify", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user || !(await checkAdmin(user))) {
    res.status(403).json({ error: "forbidden" }); return;
  }

  const { code } = req.body as { code?: string };
  if (!code?.trim()) { res.status(400).json({ error: "code_required" }); return; }

  const email = user.email!;
  const entry = adminOtpStore.get(email);

  if (!entry) {
    res.status(400).json({ error: "no_otp", message: "コードが送信されていません。再送信してください" }); return;
  }
  if (Date.now() > entry.expiresAt) {
    adminOtpStore.delete(email);
    res.status(400).json({ error: "expired", message: "コードの有効期限が切れました。再送信してください" }); return;
  }

  entry.attempts++;
  if (entry.attempts > 5) {
    adminOtpStore.delete(email);
    res.status(429).json({ error: "too_many_attempts", message: "試行回数が上限を超えました。再ログインしてください" }); return;
  }

  if (entry.code !== code.trim()) {
    const left = 5 - entry.attempts;
    res.status(400).json({ error: "invalid_code", message: `コードが正しくありません（残り ${left} 回）`, attemptsLeft: left }); return;
  }

  adminOtpStore.delete(email);
  // ★ サーバ側に MFA 検証済みを記録 → requireAdmin がこれを必須化する（実効化の要）。
  const verifiedAt = Date.now();
  const expiresAt = markAdminMfaVerified(user.id);
  console.log("[admin-otp/verify] Admin MFA verified successfully");
  res.json({ ok: true, verifiedAt, expiresAt });
});

// ── DELETE /api/user/account ──────────────────────────────────────────────────
// App Store 必須：ログイン中ユーザーの完全削除
router.delete("/user/account", async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    // 1. 店舗オーナーの場合：店舗データのクリーンアップ
    const { data: ownedStores } = await supabaseAdmin
      .from("stores")
      .select("id, stripe_account_id")
      .eq("owner_id", user.id);

    if (ownedStores && ownedStores.length > 0) {
      for (const store of ownedStores) {
        // 1a. 出品中バッグを全て停止
        await supabaseAdmin
          .from("surprise_bags")
          .update({ is_active: false })
          .eq("store_id", store.id);

        // 1b. Stripe Connect アカウントを削除（連携解除）
        if (store.stripe_account_id) {
          try {
            const stripeKey = process.env["STRIPE_SECRET_KEY"];
            if (stripeKey) {
              const stripe = await import("stripe").then((m) => new m.default(stripeKey));
              await stripe.accounts.del(store.stripe_account_id);
              console.log(`[user/account] Stripe account ${store.stripe_account_id} deleted`);
            }
          } catch (stripeErr: any) {
            // Stripe 削除失敗は致命的ではないのでログに留め処理続行
            console.warn(`[user/account] Stripe account delete failed (${store.stripe_account_id}):`, stripeErr?.message);
          }
        }

        // 1c. 店舗を suspended に更新（FK制約のためすぐに行は削除しない）
        await supabaseAdmin
          .from("stores")
          .update({ status: "suspended", is_active: false })
          .eq("id", store.id);
      }
    }

    // 2. 予約・お気に入り・通知など（CASCADE FK があれば自動削除されるが念のため明示）
    await supabaseAdmin.from("reservations").delete().eq("user_id", user.id);
    await supabaseAdmin.from("favorites").delete().eq("user_id", user.id);

    // 3. public.users 行を削除
    await supabaseAdmin.from("users").delete().eq("id", user.id);

    // 4. auth.users を削除（Supabase Admin API）
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (delErr) throw delErr;

    console.log(`[user/account] Deleted user ${user.id}${ownedStores?.length ? ` (+ ${ownedStores.length} stores)` : ''}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[user/account] delete error:", err);
    res.status(500).json({ error: "internal_error", message: err?.message });
  }
});

export default router;
