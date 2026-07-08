import { db } from "@workspace/db";
import { storesTable, surpriseBagsTable } from "@workspace/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { sendPushToUser, type PushPayload } from "./push.js";
import { supabaseAdmin } from "./supabase.js";
import { parseHolidayWeekdays } from "./recurring-publisher.js";

// ── 店への「未出品リマインド」──
//   今のおすそわけ最大のボトルネックは供給（店が出品しない）。
//   毎日決まった時刻に「今日まだ1件も出品していない承認済み店」のオーナーへ
//   「出してみませんか？」とプッシュして、出品忘れ・後回しを直接潰す施策。
//
//   ガードレール:
//     1. env UNLISTED_REMINDER=off で即停止（デプロイ不要）
//     2. env UNLISTED_REMINDER_HOUR で送信時刻(JST時)を調整（既定 15時）
//     3. sentLog で「その日1回だけ」に制限（1分ごと呼び出しの多重送信を防ぐ）
//     4. 1オーナーが複数店を持っていても、オーナー単位で1通に集約（連投しない）

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowJST() {
  const d = new Date(Date.now() + JST_OFFSET_MS);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dateStr: d.toISOString().slice(0, 10),
    dow: d.getUTCDay(), // 0=日..6=土 (JST)
  };
}

// 「今日の日付(JST)」を記録して当日の重複送信を防ぐ。プロセス内メモリ。
//   min_machines_running=1 なので基本1プロセス。再起動でリセットされるが、
//   時刻窓（HH:00〜HH:59）+ このログで実質1日1回に収まる。
const sentLog = new Set<string>();

/**
 * 未出品の承認済み店オーナーへリマインドを送る。
 * index.ts の setInterval で1分ごとに呼び出す想定。
 */
export async function remindUnlistedStores(): Promise<void> {
  // 1. kill スイッチ
  if ((process.env.UNLISTED_REMINDER ?? "on").toLowerCase() === "off") return;

  // 2. 送信時刻ゲート（JST の targetHour 台の間に1回）
  const targetHour = Number(process.env.UNLISTED_REMINDER_HOUR ?? "15");
  const { hour, dateStr, dow: todayDow } = nowJST();
  if (!Number.isFinite(targetHour) || hour !== targetHour) return;

  // 3. 当日1回に制限
  const logKey = `unlisted:${dateStr}`;
  if (sentLog.has(logKey)) return;
  sentLog.add(logKey);

  try {
    // 承認済み・有効・オーナー紐付けありの店（定休日判定に holiday も取得）
    const stores = await db
      .select({
        id:      storesTable.id,
        name:    storesTable.name,
        ownerId: storesTable.ownerId,
        holiday: storesTable.holiday,
      })
      .from(storesTable)
      .where(
        and(
          eq(storesTable.status, "approved"),
          eq(storesTable.isActive, true),
          isNotNull(storesTable.ownerId),
        ),
      );

    if (stores.length === 0) {
      console.log("[unlisted-reminder] 対象店なし");
      return;
    }

    // 「今日 客が買えるバッグ」を持つ店ID（＝実質 出品済み）。
    //   ★ 前日出品(pickupNextDay=true)は created_at が昨日でも「今日の受取」を serve する。
    //     created_at=今日 だけで判定すると、 毎朝の定期出品を前夜に出している店を
    //     「今日 未出品」と誤検知して営業中なのにリマインドしてしまう(実害)。
    //     受取日が今日になるバッグ＝ 当日出品(created=今日) / 前日出品(created=昨日) の両方を拾う。
    const listedRows = await db
      .select({ storeId: surpriseBagsTable.storeId })
      .from(surpriseBagsTable)
      .where(
        sql`(${surpriseBagsTable.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')::date
            = CASE WHEN ${surpriseBagsTable.pickupNextDay}
                   THEN (now() AT TIME ZONE 'Asia/Tokyo')::date - 1
                   ELSE (now() AT TIME ZONE 'Asia/Tokyo')::date
              END`,
      );
    const listed = new Set(listedRows.map((r) => r.storeId));

    // 未出品店 → オーナー単位に集約（1オーナー複数店でも1通に）。
    let skippedHoliday = 0;
    const ownerIds = new Set<string>();
    for (const s of stores) {
      if (listed.has(s.id)) continue;
      // ★ 定休日ガード: 今日(JST曜日)が店の定休曜日なら、 そもそも出せないのでリマインドしない。
      //   これが無いと「毎週◯曜定休」の店に毎週その曜日リマインドが飛び続ける(実害)。
      //   recurring-publisher と同じ parseHolidayWeekdays を使い、 判定基準を統一する。
      if (parseHolidayWeekdays(s.holiday).has(todayDow)) {
        skippedHoliday++;
        continue;
      }
      if (s.ownerId) ownerIds.add(s.ownerId);
    }
    if (skippedHoliday > 0) {
      console.log(`[unlisted-reminder] 定休日のためスキップ ${skippedHoliday}店`);
    }

    if (ownerIds.size === 0) {
      console.log(`[unlisted-reminder] 未出品店なし（承認${stores.length}店は全て出品済み）`);
      return;
    }

    // このリマインドを OPT-OUT したオーナー(notif_unlisted_reminder=false)を除外
    const { data: optOutRows } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("notif_unlisted_reminder", false);
    for (const row of optOutRows ?? []) {
      if (row.id) ownerIds.delete(row.id as string);
    }

    if (ownerIds.size === 0) {
      console.log("[unlisted-reminder] 対象オーナーは全員 OPT-OUT のため送信なし");
      return;
    }

    const payload: PushPayload = {
      title: "📢 今日のおすそわけ、まだ出品されていません",
      body: "閉店前の余った食品を、サプライズバッグで出してみませんか？ タップして出品できます。",
      tag: `unlisted-reminder-${dateStr}`,
      url: "/store/dashboard",
    };

    let sent = 0;
    for (const ownerId of ownerIds) {
      try {
        await sendPushToUser(ownerId, payload);
        sent++;
      } catch (e) {
        console.error(`[unlisted-reminder] 送信失敗 owner=${ownerId.slice(0, 8)}:`, e);
      }
    }
    console.log(`[unlisted-reminder] ${sent}/${ownerIds.size} オーナーへ送信 (JST ${targetHour}時)`);
  } catch (err) {
    console.error("[unlisted-reminder] error:", err);
    sentLog.delete(logKey); // 失敗時は当日リトライできるようリセット
  }
}
