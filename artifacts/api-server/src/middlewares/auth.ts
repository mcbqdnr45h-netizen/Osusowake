import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { supabaseAdmin } from "../lib/supabase.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: { id: string; email: string | null };
      authStore?: { id: number; ownerId: string | null };
    }
  }
}

/**
 * Supabase アクセストークン (JWT) をサーバー内でローカル検証する。
 *
 * 経緯: 旧実装は毎リクエストで supabaseAdmin.auth.getUser(token) を呼び、Auth
 *   サービスへネットワーク往復していた。 Supabase の region 障害 (2026-06-30〜)
 *   で Auth が劣化し、この往復が最大 5 分ハング → 認証必須画面 (ランキング/
 *   マイバッグ) が無限スケルトンに。 JWT は自己完結の署名付きトークンなので、
 *   公開鍵さえあればネットワーク無しでローカル検証できる。
 *
 * 署名方式: このプロジェクトは非対称鍵へローテート済 (現行 = ECC P-256 / ES256、
 *   旧 = Legacy HS256 で 3 か月前に previous 化 → 実トークンはもう存在しない)。
 *   よって現行ユーザートークンは ES256。 ES256 は公開鍵で検証でき、鍵は秘密でない。
 *
 * 鍵の供給:
 *   - SUPABASE_JWT_PUBLIC_JWKS : 公開鍵 JWK の JSON (単体 / 配列 / {keys:[...]} 可)。
 *     Supabase Dashboard → Settings → JWT Keys → CURRENT KEY の ⋮ → 公開鍵をコピー。
 *     kid ごとにマップ化して保持 (将来のローテートも配列に足せば対応可)。
 *   - SUPABASE_JWT_SECRET : Legacy HS256 用の予備 (通常は不要。設定時のみ有効)。
 *
 * 依存追加なし。 Node 標準の crypto で検証:
 *   - ES256: crypto.verify("sha256", ..., { dsaEncoding: "ieee-p1363" }) ← JWT の
 *     生 R||S 署名フォーマットに一致。
 *   - HS256: HMAC-SHA256 + timingSafeEqual。
 *
 * 戻り値: 検証成功なら payload、失敗 (署名不一致 / exp 切れ / kid 不明 / alg 非対応 /
 *   形式不正) なら null。 null の場合は呼び出し側が getUser フォールバックへ回す。
 */
type JwtPayload = { sub?: string; email?: string; exp?: number; [k: string]: unknown };
type Jwk = { kid?: string; kty?: string; alg?: string; [k: string]: unknown };

const es256Keys = new Map<string, crypto.KeyObject>();
(function loadEs256Jwks() {
  const raw = process.env.SUPABASE_JWT_PUBLIC_JWKS ?? "";
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    console.error("[requireAuth] SUPABASE_JWT_PUBLIC_JWKS parse failed:", e?.message);
    return;
  }
  const arr: Jwk[] = Array.isArray(parsed)
    ? (parsed as Jwk[])
    : Array.isArray((parsed as any)?.keys)
      ? ((parsed as any).keys as Jwk[])
      : [parsed as Jwk];
  for (const jwk of arr) {
    if (!jwk || jwk.kty !== "EC" || !jwk.kid) continue;
    try {
      // kid は小文字で格納 (ダッシュボード表示は大文字だが JWKS/token の kid は
      // 小文字。 大小のドリフトを吸収するため lookup 側も小文字化する)。
      es256Keys.set(String(jwk.kid).toLowerCase(), crypto.createPublicKey({ key: jwk as any, format: "jwk" }));
    } catch (e: any) {
      console.error("[requireAuth] skip invalid JWK:", e?.message);
    }
  }
  console.log(`[requireAuth] loaded ${es256Keys.size} ES256 public key(s) for local JWT verify: [${Array.from(es256Keys.keys()).join(", ")}]`);
})();

const HS256_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";

function verifyJwtLocally(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const signingInput = `${headerB64}.${payloadB64}`;
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }

  let signatureOk = false;
  if (header.alg === "ES256") {
    if (es256Keys.size === 0) return null; // 公開鍵未取得 → getUser フォールバックへ
    // kid 一致鍵を優先。 見つからなければ読み込み済み全鍵で総当たり検証
    // (kid の大小/形式ドリフト対策。 署名検証自体は必須なので安全)。
    const byKid = header.kid ? es256Keys.get(header.kid.toLowerCase()) : undefined;
    const candidates = byKid ? [byKid] : Array.from(es256Keys.values());
    for (const key of candidates) {
      try {
        if (
          crypto.verify(
            "sha256",
            Buffer.from(signingInput, "utf8"),
            { key, dsaEncoding: "ieee-p1363" },
            sig,
          )
        ) {
          signatureOk = true;
          break;
        }
      } catch {
        /* 次の鍵を試す */
      }
    }
    if (!signatureOk) return null;
  } else if (header.alg === "HS256") {
    if (!HS256_SECRET) return null;
    const expected = crypto.createHmac("sha256", HS256_SECRET).update(signingInput).digest();
    signatureOk = expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
  } else {
    return null;
  }
  if (!signatureOk) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // exp (秒) を検証。 60 秒の時計ずれ許容。
  if (typeof payload.exp === "number" && Date.now() / 1000 - 60 >= payload.exp) {
    return null;
  }
  return payload;
}

/**
 * Bearer トークンを検証して req.authUser をセットする。
 * 失敗時は 401 を返す（next は呼ばない）。
 *
 * 検証順:
 *   1. ローカル HS256 検証 (ネットワーク無し・高速・障害耐性)。 成功なら即 next。
 *   2. フォールバック: getUser を 4 秒タイムアウト付きで呼ぶ。 ローカル検証が
 *      不能 (鍵未設定 / alg 非対称) or null のときのみ。 Auth 障害時でも 5 分
 *      ハングせず、タイムアウトなら 503 を即返す。
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "ログインが必要です" });
    return;
  }

  // 1) ローカル検証 (primary path)
  const payload = verifyJwtLocally(token);
  if (payload?.sub) {
    req.authUser = {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
    };
    next();
    return;
  }

  // 2) フォールバック: getUser (短タイムアウト付き)
  try {
    const { data: { user }, error } = await Promise.race([
      supabaseAdmin.auth.getUser(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("auth_timeout")), 4000),
      ),
    ]);
    if (error || !user) {
      res.status(401).json({ error: "unauthorized", message: "セッションが無効です" });
      return;
    }
    req.authUser = { id: user.id, email: user.email ?? null };
    next();
  } catch (err: any) {
    if (err?.message === "auth_timeout") {
      console.error("[requireAuth] getUser timed out (Auth degraded); local JWT verify unavailable");
      res.status(503).json({
        error: "auth_unavailable",
        message: "認証サービスが混雑しています。少し待って再度お試しください。",
      });
      return;
    }
    console.error("[requireAuth] token verify failed:", err?.message);
    res.status(401).json({ error: "unauthorized" });
  }
}

/**
 * req.params.storeId の店舗が現在のユーザー所有であることを検証する単一責務 middleware。
 *
 * ★ 必ず requireAuth の **後ろ** にチェーンすること:
 *     router.post("/x", requireAuth, requireStoreOwner, handler)
 *
 * 成功時は req.authStore に { id, ownerId } をセットする。
 * 失敗時は 400 / 403 / 404 / 500 を返す（401 は requireAuth 側で処理）。
 */
export async function requireStoreOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    // requireAuth を先に通していない設定ミス → 露見させる（fail-closed）
    console.error("[requireStoreOwner] requireAuth が先に実行されていません（middleware 設定ミス）");
    res.status(500).json({ error: "internal_error", message: "auth middleware misconfigured" });
    return;
  }
  const storeId = parseInt(String(req.params.storeId ?? ""), 10);
  if (Number.isNaN(storeId)) {
    res.status(400).json({ error: "bad_request", message: "Invalid storeId" });
    return;
  }
  try {
    const [store] = await db
      .select({ id: storesTable.id, ownerId: storesTable.ownerId })
      .from(storesTable)
      .where(eq(storesTable.id, storeId))
      .limit(1);
    if (!store) {
      res.status(404).json({ error: "not_found", message: "店舗が見つかりません" });
      return;
    }
    if (!store.ownerId || store.ownerId !== req.authUser.id) {
      console.warn(`[SECURITY] storeOwner mismatch storeId=${storeId} ownerId=${store.ownerId} requester=${req.authUser.id}`);
      res.status(403).json({ error: "forbidden", message: "この店舗を操作する権限がありません" });
      return;
    }
    req.authStore = { id: store.id, ownerId: store.ownerId };
    next();
  } catch (err: any) {
    console.error("[requireStoreOwner] db lookup failed:", err?.message);
    res.status(500).json({ error: "internal_error" });
  }
}
