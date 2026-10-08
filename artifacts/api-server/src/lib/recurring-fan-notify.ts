import { db } from "@workspace/db";
import { favoritesTable, notificationsTable } from "@workspace/db/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import { sendPushToUsers, filterFavoriteUpdateOptIn, getStoreOrAdminUserIds } from "./push.js";
import { computeUserTotal } from "./pricing.js";

// 定期出品の自動公開を、その店をお気に入り登録した客にだけ知らせる。
// 2026-07-08 に「毎日同じ店から通知が来る」苦情で全停止した経緯があるため、
// 同じ店からは1人あたり7日に1回、どの店からも1人あたり1日1回までに絞る。
// 上限の判定は notifications テーブル(type=recurring_fan)の送信履歴で行う。
export const RECURRING_FAN_TYPE = "recurring_fan";

const PER_STORE_COOLDOWN_DAYS = 7;
const QUIET_START_HOUR = 21; // JST 21:00〜翌8:00 は送らない(全体配信と同じ)
const QUIET_END_HOUR = 8;

function jstNow(): { hour: number; startOfDayUtc: Date } {
  const JST_OFFSET = 9 * 60 * 60 * 1000;
  const jst = new Date(Date.now() + JST_OFFSET);
  const startOfDayJstAsUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return { hour: jst.getUTCHours(), startOfDayUtc: new Date(startOfDayJstAsUtc - JST_OFFSET) };
}

export async function notifyFavoritesOfRecurring(args: {
  storeId: number;
  storeName: string;
  bagId: number;
  bagTitle: string;
  discountedPrice: number;
  stockCount: number;
}): Promise<void> {
  if (process.env.RECURRING_FAN_NOTIFY_DISABLED === "1") return;

  const { hour, startOfDayUtc } = jstNow();
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
    console.log(`[recurring-fan] 夜間(JST ${hour}時)のためスキップ store=${args.storeId} bag=${args.bagId}`);
    return;
  }

  const fanRows = await db
    .select({ userId: favoritesTable.userId })
    .from(favoritesTable)
    .where(eq(favoritesTable.storeId, args.storeId));
  if (fanRows.length === 0) return;

  const storeOrAdminIds = await getStoreOrAdminUserIds();
  const consumerFans = [...new Set(fanRows.map((f) => f.userId))].filter((id) => !storeOrAdminIds.has(id));
  if (consumerFans.length === 0) return;

  const cooldownSince = new Date(Date.now() - PER_STORE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const recentFromThisStore = await db
    .select({ userId: notificationsTable.userId })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.type, RECURRING_FAN_TYPE),
      eq(notificationsTable.storeId, args.storeId),
      gte(notificationsTable.createdAt, cooldownSince),
      inArray(notificationsTable.userId, consumerFans),
    ));
  const sentToday = await db
    .select({ userId: notificationsTable.userId })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.type, RECURRING_FAN_TYPE),
      gte(notificationsTable.createdAt, startOfDayUtc),
      inArray(notificationsTable.userId, consumerFans),
    ));
  const blocked = new Set([...recentFromThisStore, ...sentToday].map((r) => r.userId));
  const eligible = consumerFans.filter((id) => !blocked.has(id));
  if (eligible.length === 0) {
    console.log(`[recurring-fan] 全員上限内のためスキップ store=${args.storeId} fans=${consumerFans.length}`);
    return;
  }

  const priceLabel = `¥${computeUserTotal(Number(args.discountedPrice)).toLocaleString()}`;
  const title = `🛍️ お気に入りの${args.storeName}が出品中`;
  const body = `「${args.bagTitle}」${priceLabel}〜 在庫: ${args.stockCount}個`;

  await db.insert(notificationsTable).values(
    eligible.map((userId) => ({
      userId,
      type: RECURRING_FAN_TYPE,
      title,
      body: `${body} [bag:${args.bagId}]`,
      storeId: args.storeId,
    })),
  );

  const pushRecipients = await filterFavoriteUpdateOptIn(eligible);
  if (pushRecipients.length > 0) {
    await sendPushToUsers(pushRecipients, {
      title,
      body,
      tag: `recurring-fan-${args.bagId}`,
      url: `/bags/${args.bagId}`,
    });
  }
  console.log(
    `[recurring-fan] store=${args.storeId} bag=${args.bagId} fans=${consumerFans.length} ` +
    `ベル=${eligible.length} push=${pushRecipients.length} 上限で除外=${blocked.size}`,
  );
}
