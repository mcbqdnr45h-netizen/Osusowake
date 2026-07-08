import { db } from "@workspace/db";
import {
  apnsRegistrationsTable,
  fcmRegistrationsTable,
  webPushSubscriptionsTable,
  notificationsTable,
} from "@workspace/db/schema";
import { sendPushToUsers, getStoreOrAdminUserIds } from "./push.js";
import { sendToAnonymousDevices, sendToAnonymousWebPush } from "./daily-engagement.js";
import { supabaseAdmin } from "./supabase.js";

// ── 新規出品の「全体プッシュ」──
//   お気に入り登録の有無に関わらず、手動出品(定期出品ではない)を
//   プッシュ購読済みの全ユーザーへ配信する。出品が少ない今だけの初期ブースト施策。
//   ★ 定期出品(recurring-publisher)からは呼ばない ― 毎朝の自動公開を全員配信したら
//     スパムになるため。手動 POST /bags からのみ呼ぶ。
//
//   ガードレール(出品が増えたら暴発するので最初から付ける):
//     1. env BROADCAST_NEW_LISTINGS=off で即停止(デプロイ不要)
//     2. 夜間(JST 21:00〜翌8:00)は全体配信スキップ(お気に入り通知は別で飛ぶ)
//     3. 1日の全体配信回数上限(BROADCAST_MAX_PER_DAY, 既定5)。全体配信は全員に飛ぶので
//        「1日の全体配信回数 = 各ユーザーが1日に受ける全体通知数」= 実質ユーザー単位の上限。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowJST() {
  const d = new Date(Date.now() + JST_OFFSET_MS);
  return { hour: d.getUTCHours(), dateStr: d.toISOString().slice(0, 10) };
}

// 夜間(21:00〜翌8:00)は全体配信しない
function isQuietHour(hour: number): boolean {
  return hour >= 21 || hour < 8;
}

// 1日の全体配信回数カウンタ(JST日付でリセット)。プロセス内メモリ。
//   min_machines_running=1 なので基本1プロセス。再起動でリセットされるが、
//   「多少多く送る」方向の誤差で実害小。厳密性より実装の軽さを優先。
const dailyCounter: { dateStr: string; count: number } = { dateStr: "", count: 0 };

function bumpDailyCounter(dateStr: string): number {
  if (dailyCounter.dateStr !== dateStr) {
    dailyCounter.dateStr = dateStr;
    dailyCounter.count = 0;
  }
  dailyCounter.count += 1;
  return dailyCounter.count;
}

// 「お気に入り外の新規出品(全体配信)」を OPT-OUT したユーザーID (notif_new_listing=false)。
//   会員向けの宛先から除外する。匿名端末は識別できないので対象外(そのまま送る)。
async function newListingOptOutUserIds(): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("notif_new_listing", false);
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.id) ids.add(row.id as string);
  }
  return ids;
}

// プッシュ購読済みの全ユーザーID(重複排除)。apns / fcm / webpush の和集合。
async function allSubscribedUserIds(): Promise<string[]> {
  const [apns, fcm, web] = await Promise.all([
    db.select({ userId: apnsRegistrationsTable.userId }).from(apnsRegistrationsTable),
    db.select({ userId: fcmRegistrationsTable.userId }).from(fcmRegistrationsTable),
    db.select({ userId: webPushSubscriptionsTable.userId }).from(webPushSubscriptionsTable),
  ]);
  const set = new Set<string>();
  for (const r of apns) set.add(r.userId);
  for (const r of fcm) set.add(r.userId);
  for (const r of web) set.add(r.userId);
  return [...set];
}

export interface BroadcastNewListingArgs {
  storeId: number;
  storeName: string;
  /** 出品した店のオーナー(自分に通知しない) */
  ownerUserId?: string | null;
  bagId?: number;
  bagTitle: string;
  priceLabel: string;
  stockCount: number;
  /** 既にお気に入り通知を送ったユーザー(二重通知しない) */
  excludeUserIds: string[];
}

// 全体配信を実行。ガードレールで弾かれた場合は何もせず false を返す。
export async function broadcastNewListing(args: BroadcastNewListingArgs): Promise<boolean> {
  // 1. kill スイッチ
  if ((process.env.BROADCAST_NEW_LISTINGS ?? "on").toLowerCase() === "off") return false;

  // 2. 夜間スキップ
  const { hour, dateStr } = nowJST();
  if (isQuietHour(hour)) {
    console.log(`[broadcast] 夜間(JST ${hour}時)のためスキップ store=${args.storeId}`);
    return false;
  }

  // 3. 1日上限
  //   ★ チェックと加算を「await を挟まず」原子的に行う。 間に await(宛先クエリ等)を挟むと、
  //     手動出品が同時発火した際に両方が加算前の count でチェックを通過し、上限を超えて
  //     配信されうる(TOCTOU レース)。 Node は単一スレッドなので、await を挟まずに
  //     check→加算まで走らせれば同一 count を2回通過することは構造的に起きない。
  //   ★ 予約制: ここで枠を確保してから宛先構築する。 以降でエラー/早期returnしても枠は消費
  //     されるが、それは「少なく送る」安全側の誤差(上限厳守を優先)。
  const maxPerDay = Number(process.env.BROADCAST_MAX_PER_DAY ?? "5");
  if (Number.isFinite(maxPerDay) && maxPerDay > 0) {
    if (dailyCounter.dateStr === dateStr && dailyCounter.count >= maxPerDay) {
      console.log(`[broadcast] 本日の全体配信上限(${maxPerDay})到達のためスキップ store=${args.storeId}`);
      return false;
    }
    bumpDailyCounter(dateStr); // 枠を確保(await前=原子的)
  }

  // 会員宛先 = 購読者全員 − お気に入り勢(既に通知済) − 出品店オーナー
  //   − 全体配信 OPT-OUT 勢 − 店舗オーナー/管理者(お客さん向け発見通知は店に送らない)
  const exclude = new Set(args.excludeUserIds);
  if (args.ownerUserId) exclude.add(args.ownerUserId);
  const [optOut, storeOrAdmin] = await Promise.all([
    newListingOptOutUserIds(),
    getStoreOrAdminUserIds(),
  ]);
  for (const id of optOut) exclude.add(id);
  for (const id of storeOrAdmin) exclude.add(id);
  const recipients = (await allSubscribedUserIds()).filter((id) => !exclude.has(id));

  const title = `🍱 ${args.storeName} が新しいおすそわけを出品`;
  const bodyClean = `「${args.bagTitle}」${args.priceLabel}〜 在庫: ${args.stockCount}個`;
  const bodyDb = args.bagId ? `${bodyClean} [bag:${args.bagId}]` : bodyClean;
  const tag = args.bagId ? `new-bag-${args.bagId}` : `new-bag-${args.storeId}-${Date.now()}`;
  const url = args.bagId ? `/bags/${args.bagId}` : `/stores/${args.storeId}`;
  const payload = { title, body: bodyClean, tag, url };

  // 会員(userId)向けはアプリ内通知(DB)も残す。 匿名端末は userId が無いので push のみ。
  if (recipients.length > 0) {
    try {
      await db.insert(notificationsTable).values(
        recipients.map((userId) => ({
          userId,
          type: "new_bag",
          title,
          body: bodyDb,
          storeId: args.storeId,
        })),
      );
    } catch (e) {
      console.error("[broadcast] notification insert error (non-fatal):", e);
    }
  }

  // 会員 push + 未登録の匿名端末(iOS/Web) push を並行送信。
  //   ★ 匿名クエリは会員登録済み(昇格済み)端末を NOT IN で除外するので二重送信にならない。
  //   ★ 夜間スキップ・1日上限・kill スイッチは関数冒頭で会員/匿名まとめてゲート済み。
  const [, anonIos, anonWeb] = await Promise.all([
    recipients.length > 0 ? sendPushToUsers(recipients, payload) : Promise.resolve(),
    sendToAnonymousDevices(payload),
    sendToAnonymousWebPush(payload),
  ]);
  console.log(`[broadcast] 全体配信 store=${args.storeId} 会員${recipients.length} 匿名iOS${anonIos} 匿名Web${anonWeb}`);
  return true;
}
