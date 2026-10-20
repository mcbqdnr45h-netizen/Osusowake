import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { supabaseAdmin } from "./supabase";

// 営業許可証などの書類画像（非公開バケット store-documents）。
//   DB には「保管場所（パス）」だけを入れ、 画面に返すたびに1時間だけ有効なリンクを作る。
//   2026-10-21 までは10年有効のリンクを DB に入れていた（DB が漏れると10年見られる）。
//   古い行が残っていても読めるよう、 リンクからパスを取り出す処理も持つ。
export const STORE_DOCUMENTS_BUCKET = "store-documents";
const VIEW_TTL_SEC = 60 * 60;
const DOCUMENT_KEYS = new Set(["licenseImageUrl", "idImageUrl", "license_image_url", "id_image_url"]);

export function documentPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("storage://")) return value.slice("storage://".length);
  if (!/^https?:\/\//.test(value)) return value;
  const m = /\/object\/(?:sign|public|authenticated)\/store-documents\/([^?]+)/.exec(value);
  return m ? decodeURIComponent(m[1]) : null;
}

// 1件だけ見るためのリンク。 作れなかった時は元の値をそのまま返す（従来の動きを壊さない）。
export async function documentViewUrl(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const path = documentPath(value);
  if (!path) return value;
  const { data, error } = await supabaseAdmin.storage.from(STORE_DOCUMENTS_BUCKET).createSignedUrl(path, VIEW_TTL_SEC);
  if (error || !data?.signedUrl) {
    console.warn(`[store-documents] 表示用リンクを作れませんでした path=${path}: ${error?.message ?? "no_url"}`);
    return value;
  }
  return data.signedUrl;
}

// レスポンスの中の書類リンク欄を探して、 まとめて1時間リンクに差し替える。
function collectDocumentFields(node: unknown, out: Array<{ obj: Record<string, unknown>; key: string }>, depth: number): void {
  if (depth > 5 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectDocumentFields(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (DOCUMENT_KEYS.has(key)) {
      if (typeof val === "string" && val) out.push({ obj, key });
    } else if (val !== null && typeof val === "object") {
      collectDocumentFields(val, out, depth + 1);
    }
  }
}

async function signDocumentFields(body: unknown): Promise<void> {
  const fields: Array<{ obj: Record<string, unknown>; key: string }> = [];
  collectDocumentFields(body, fields, 0);
  if (fields.length === 0) return;
  const paths = fields.map((f) => documentPath(f.obj[f.key] as string));
  const unique = [...new Set(paths.filter((p): p is string => !!p))];
  if (unique.length === 0) return;
  const { data, error } = await supabaseAdmin.storage.from(STORE_DOCUMENTS_BUCKET).createSignedUrls(unique, VIEW_TTL_SEC);
  if (error || !data) {
    console.warn(`[store-documents] 表示用リンクをまとめて作れませんでした: ${error?.message ?? "no_data"}`);
    return;
  }
  const byPath = new Map<string, string>();
  for (const d of data) if (d.path && d.signedUrl) byPath.set(d.path, d.signedUrl);
  fields.forEach((f, i) => {
    const p = paths[i];
    const signed = p ? byPath.get(p) : undefined;
    if (signed) f.obj[f.key] = signed;
  });
}

// すべての API レスポンスに掛ける。 書類リンク欄が無いレスポンスは何もしない。
export function signStoreDocumentLinks(_req: Request, res: Response, next: NextFunction): void {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    const fields: Array<{ obj: Record<string, unknown>; key: string }> = [];
    collectDocumentFields(body, fields, 0);
    if (fields.length === 0) return send(body);
    signDocumentFields(body).then(
      () => send(body),
      (err) => {
        console.warn("[store-documents] リンク差し替えに失敗（元の値で返す）:", err?.message ?? err);
        send(body);
      },
    );
    return res;
  }) as Response["json"];
  next();
}

// 一回だけ: DB の10年リンクを保管場所に書き換え、 ファイルを新しい場所へ移して古いリンクを無効にする。
//   移動に失敗した行は、 元の場所のパスだけ入れる（リンクの合言葉は DB から消える）。
export async function migrateStoreDocumentLinks(): Promise<void> {
  const FLAG = "store_documents_paths_migrated_2026_10";
  const done = await db.execute(sql`SELECT 1 FROM app_settings WHERE key = ${FLAG}`);
  if (done.rows.length > 0) return;

  const rows = await db.execute(sql`
    SELECT id, license_image_url, id_image_url FROM stores
    WHERE license_image_url LIKE 'http%' OR id_image_url LIKE 'http%' OR license_image_url LIKE 'storage://%'`);
  let moved = 0, pathOnly = 0, skipped = 0;
  for (const row of rows.rows as Array<{ id: number; license_image_url: string | null; id_image_url: string | null }>) {
    for (const column of ["license_image_url", "id_image_url"] as const) {
      const oldValue = row[column];
      if (!oldValue || !/^(https?|storage):\/\//.test(oldValue)) continue;
      const oldPath = documentPath(oldValue);
      if (!oldPath) { skipped++; continue; }
      const slash = oldPath.lastIndexOf("/");
      const newPath = `${oldPath.slice(0, slash + 1)}v2-${oldPath.slice(slash + 1)}`;
      const { error: moveErr } = await supabaseAdmin.storage.from(STORE_DOCUMENTS_BUCKET).move(oldPath, newPath);
      const finalPath = moveErr ? oldPath : newPath;
      const updated = column === "license_image_url"
        ? await db.execute(sql`UPDATE stores SET license_image_url = ${finalPath} WHERE id = ${row.id} AND license_image_url = ${oldValue}`)
        : await db.execute(sql`UPDATE stores SET id_image_url = ${finalPath} WHERE id = ${row.id} AND id_image_url = ${oldValue}`);
      if ((updated.rowCount ?? 0) === 0) {
        // その間に書き換わっていたら、 ファイルを元の場所に戻す
        if (!moveErr) await supabaseAdmin.storage.from(STORE_DOCUMENTS_BUCKET).move(newPath, oldPath);
        skipped++;
        continue;
      }
      if (moveErr) {
        pathOnly++;
        console.warn(`[store-documents] 移動できず元の場所のまま storeId=${row.id}: ${moveErr.message}`);
      } else {
        moved++;
      }
    }
  }
  await db.execute(sql`INSERT INTO app_settings (key, value) VALUES (${FLAG}, ${`moved=${moved} pathOnly=${pathOnly} skipped=${skipped}`}) ON CONFLICT (key) DO NOTHING`);
  console.log(`[migration] store documents → paths ✅ moved=${moved} pathOnly=${pathOnly} skipped=${skipped}`);
}
