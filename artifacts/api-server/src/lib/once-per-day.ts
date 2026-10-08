import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * 「その日、そのジョブは1回だけ」をDBで保証する共有ロック。
 *
 * ★ 背景 (2026-08-06)
 *   定期通知の重複防止が各ジョブの【メモリ上の Set】だけだったため、
 *   サーバーが再起動するとその記録が消え、同じ通知が同じ日に何度も飛んでいた。
 *   デプロイが多い日ほど再送が増える構造で、実際に店舗様が
 *   「未出品リマインドが2回来た」と報告（同じ穴が客向けの日次通知にもあった）。
 *
 * ★ 仕組み
 *   app_settings に `key = <jobKey>` / `value = <YYYY-MM-DD>` を書き込む。
 *   「値が今日と違うときだけ更新して、更新できた側だけが true を受け取る」ため、
 *   再起動しても、machine が複数あっても、送信は1回に収束する（アトミック）。
 *
 * ★ フェイルセーフ
 *   DBが落ちている等で判定できない場合は **false（送らない）** に倒す。
 *   通知は「多重に送る」方が「送られない」より害が大きいため。
 */
export async function claimOncePerDay(jobKey: string, dateStr: string): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${`once:${jobKey}`}, ${dateStr}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
        WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
      RETURNING key
    `);
    return (res.rows?.length ?? 0) > 0;
  } catch (e) {
    console.error(`[once-per-day] 判定に失敗したため送信を見送ります job=${jobKey}:`, e);
    return false;
  }
}
