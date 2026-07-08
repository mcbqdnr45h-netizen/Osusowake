import { db } from '@workspace/db';
import {
  surpriseBagsTable,
  storesTable,
  webPushSubscriptionsTable,
  apnsRegistrationsTable,
} from '@workspace/db/schema';
import { eq, gt, and, sql } from 'drizzle-orm';
import { sendPushToUsers, sendApnsPushToRawTokens, sendWebPushToRawSubs, getStoreOrAdminUserIds, type PushPayload } from './push.js';
import { supabaseAdmin } from './supabase.js';
import { bagVisibleSql } from './bag-visibility.js';

/**
 * 毎日2回（昼前 11:45・夕方 16:30 JST）全登録ユーザーにエンゲージメント通知を送る。
 *   ※ 食事を決める直前(ランチ/ディナー前)に当てて反応率を上げる狙い。
 * - 出品中バッグが1件以上ある場合のみ送信（空振り通知防止）
 * - 重複防止: セッション内の lastSentSlot で管理（サーバー再起動時はリセット）
 */

// JST = UTC+9
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 送信スロット定義
const SLOTS: { hour: number; minute: number; key: string; makeMessage: (count: number) => { title: string; body: string } }[] = [
  {
    hour: 11, minute: 45, key: 'morning',
    makeMessage: (count) => ({
      title: '🍱 今日のランチ、おすそわけがお得です',
      body:  `${count}件のバッグが出品中。今日のランチや夕食をお得に！`,
    }),
  },
  {
    hour: 16, minute: 30, key: 'evening',
    makeMessage: (count) => ({
      title: '🌙 夕方のおすそわけ、まだ間に合います',
      body:  `${count}件のバッグが残っています。今夜の食事はおすそわけで決めよう！`,
    }),
  },
];

// 「今日の日付(JST) + スロットキー」を記録して重複送信を防ぐ
const sentLog = new Set<string>();

/** 現在の JST 時刻を返す */
function nowJST() {
  const nowUtcMs = Date.now() + JST_OFFSET_MS;
  const d = new Date(nowUtcMs);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), dateStr: d.toISOString().slice(0, 10) };
}

/** 現在「お客様に実際に表示中」の出品バッグ数を返す。 */
async function countActiveBags(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(surpriseBagsTable)
    .leftJoin(storesTable, eq(surpriseBagsTable.storeId, storesTable.id))
    .where(
      and(
        eq(surpriseBagsTable.isActive, true),
        gt(surpriseBagsTable.stockCount, 0),
        eq(storesTable.status, 'approved'),
        eq(storesTable.isActive, true), // ★ /api/bags と同じ: 一時停止(isActive=false)の店のバッグは数えない
        // ★ お客様に実際に表示中(notExpired)のものだけ数える。 共有SQLに一本化(lib/bag-visibility.ts)。
        bagVisibleSql,
      ),
    );
  return result[0]?.count ?? 0;
}

/** デイリー通知をOPT-INしているユーザーIDセットを返す（デフォルト: 全員 ON）*/
async function getOptInUserIds(): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id')
    .neq('notif_daily_engagement', false); // NULL または true → 通知あり
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.id) ids.add(row.id as string);
  }
  return ids;
}

/** プッシュ登録済み かつ opt-in のユーザーIDを重複なしで返す */
async function getAllSubscribedUserIds(): Promise<string[]> {
  const [[webRows, apnsRows], optInIds, storeOrAdmin] = await Promise.all([
    Promise.all([
      db.select({ userId: webPushSubscriptionsTable.userId }).from(webPushSubscriptionsTable),
      db.select({ userId: apnsRegistrationsTable.userId }).from(apnsRegistrationsTable),
    ]),
    getOptInUserIds(),
    getStoreOrAdminUserIds(), // お客さん向けの日次発見通知は店舗/管理者に送らない
  ]);
  const ids = new Set<string>();
  for (const r of [...webRows, ...apnsRows]) {
    if (r.userId && optInIds.has(r.userId) && !storeOrAdmin.has(r.userId)) ids.add(r.userId);
  }
  return [...ids];
}

/**
 * 会員登録前(匿名)の iOS 端末トークンへデイリー通知を送る。
 *   apns_registrations に載っている(=ログイン済み)トークンは除外して二重送信を防ぐ。
 *   失効トークンは掃除する。
 */
export async function sendToAnonymousDevices(payload: PushPayload): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT device_token FROM anonymous_push_devices
    WHERE platform = 'ios'
      AND device_token IS NOT NULL
      AND device_token NOT IN (SELECT device_token FROM apns_registrations WHERE device_token IS NOT NULL)
  `)).rows as { device_token: string }[];

  const tokens = rows.map((r) => r.device_token).filter(Boolean);
  if (tokens.length === 0) return 0;

  const { sent, deadTokens } = await sendApnsPushToRawTokens(tokens, payload);

  if (deadTokens.length > 0) {
    await db.execute(sql`
      DELETE FROM anonymous_push_devices
      WHERE device_token IN (${sql.join(deadTokens.map((t) => sql`${t}`), sql`, `)})
    `).catch(() => {});
    console.log(`[daily-engagement] 匿名iOS: 失効トークン ${deadTokens.length}件を掃除`);
  }
  return sent;
}

/**
 * 会員登録前(匿名)の Web Push 購読へデイリー通知を送る。
 *   web_push_subscriptions に載っている(=ログイン済み)endpoint は除外して二重送信を防ぐ。
 *   失効した購読は掃除する。
 */
export async function sendToAnonymousWebPush(payload: PushPayload): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT endpoint, p256dh, auth FROM anonymous_web_push_subscriptions
    WHERE endpoint IS NOT NULL
      AND endpoint NOT IN (SELECT endpoint FROM web_push_subscriptions WHERE endpoint IS NOT NULL)
  `)).rows as { endpoint: string; p256dh: string; auth: string }[];

  if (rows.length === 0) return 0;

  const { sent, deadEndpoints } = await sendWebPushToRawSubs(rows, payload);

  if (deadEndpoints.length > 0) {
    await db.execute(sql`
      DELETE FROM anonymous_web_push_subscriptions
      WHERE endpoint IN (${sql.join(deadEndpoints.map((e) => sql`${e}`), sql`, `)})
    `).catch(() => {});
    console.log(`[daily-engagement] 匿名Web: 失効購読 ${deadEndpoints.length}件を掃除`);
  }
  return sent;
}

/** デイリー通知の実リーチ数（=実際に届く宛先数）の内訳。 board 表示用。 */
export interface NotificationReach {
  members: number;   // プッシュ登録済み かつ opt-in の会員（apns+web 重複排除）
  anonIos: number;   // 会員登録前の匿名iOS端末（apns未昇格のみ）
  anonWeb: number;   // 会員登録前の匿名Web購読（web未昇格のみ）
  total: number;     // 合計（次回デイリー通知が実際に届く総数）
}

/**
 * 次回デイリー通知が実際に届く宛先数を、 送信ロジックと完全に同じ集合定義で数える。
 *   会員 = getAllSubscribedUserIds()（opt-in かつ push登録済みの重複排除ユーザー）
 *   匿名iOS/Web = 送信時と同じ「未昇格の匿名端末/購読」だけ。
 */
export async function getNotificationReach(): Promise<NotificationReach> {
  const [memberIds, anonIosRes, anonWebRes] = await Promise.all([
    getAllSubscribedUserIds(),
    db.execute(sql`
      SELECT COUNT(*)::int AS n FROM anonymous_push_devices
      WHERE platform = 'ios' AND device_token IS NOT NULL
        AND device_token NOT IN (SELECT device_token FROM apns_registrations WHERE device_token IS NOT NULL)
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS n FROM anonymous_web_push_subscriptions
      WHERE endpoint IS NOT NULL
        AND endpoint NOT IN (SELECT endpoint FROM web_push_subscriptions WHERE endpoint IS NOT NULL)
    `),
  ]);
  const members = memberIds.length;
  const anonIos = Number((anonIosRes.rows[0] as { n: number } | undefined)?.n ?? 0);
  const anonWeb = Number((anonWebRes.rows[0] as { n: number } | undefined)?.n ?? 0);
  return { members, anonIos, anonWeb, total: members + anonIos + anonWeb };
}

/**
 * 1分ごとに呼び出す。
 * 現在時刻が送信スロットに一致 & まだ未送信なら全ユーザーへ通知を送る。
 */
export async function runDailyEngagementNotifications(): Promise<void> {
  const { hour, minute, dateStr } = nowJST();

  for (const slot of SLOTS) {
    // ★ 「分ちょうど」ではなく「その時刻以降」で判定する。 1分ごとの setInterval は
    //   実行がドリフト/遅延したり、 再起動が 11:45:30 に起きると分ちょうどを1度も観測できず
    //   その日の通知が丸ごと飛ばない事故が起きうる。 hour一致 & minute>=slot で窓(例11:45〜11:59)を作り、
    //   sentLog で当日1回に絞る。 recurring-publisher と同じ「>=」方式に統一。
    if (hour !== slot.hour || minute < slot.minute) continue;

    const logKey = `${dateStr}:${slot.key}`;
    if (sentLog.has(logKey)) continue; // 今日このスロットは送済み
    sentLog.add(logKey);

    try {
      const [count, userIds] = await Promise.all([countActiveBags(), getAllSubscribedUserIds()]);
      if (count === 0) {
        console.log(`[daily-engagement] ${slot.key}: 出品バッグ0件のためスキップ`);
        continue;
      }

      const { title, body } = slot.makeMessage(count);
      const payload: PushPayload = { title, body, tag: `daily-${slot.key}`, url: '/' };

      // 会員(userId 紐付け)と 匿名端末(iOS APNs)・匿名Web Push(会員登録前)へ並行送信。
      const [, anonIos, anonWeb] = await Promise.all([
        userIds.length > 0 ? sendPushToUsers(userIds, payload) : Promise.resolve(),
        sendToAnonymousDevices(payload),
        sendToAnonymousWebPush(payload),
      ]);
      console.log(`[daily-engagement] ${slot.key}: 会員${userIds.length}人 + 匿名iOS${anonIos}件 + 匿名Web${anonWeb}件へ送信 (バッグ${count}件)`);

      if (userIds.length === 0 && anonIos === 0 && anonWeb === 0) {
        console.log(`[daily-engagement] ${slot.key}: 送信先0のため実送信なし`);
      }
    } catch (err) {
      console.error(`[daily-engagement] ${slot.key} 送信エラー:`, err);
      sentLog.delete(logKey); // 失敗した場合は再試行できるようリセット
    }
  }
}
