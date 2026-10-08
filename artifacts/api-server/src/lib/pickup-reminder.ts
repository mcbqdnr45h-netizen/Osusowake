import { db } from '@workspace/db';
import { reservationsTable, surpriseBagsTable, storesTable, notificationsTable } from '@workspace/db/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { sendPushToUser } from './push.js';

/**
 * 受取時間の1時間前に確定済み予約のユーザーへリマインダーを送る。
 * 5分ごとに呼び出すことを想定（index.ts の setInterval で実行）。
 */
export async function sendPickupReminders(): Promise<void> {
  // サーバは UTC 稼働。pickupStart/End は JST の "HH:MM" 文字列なので、比較は必ず
  // JST 基準で行う（旧実装は now.getHours()=UTC で 9 時間ズレ、前日の期限切れ予約に誤通知していた）。
  const JST_OFFSET = 9 * 60 * 60 * 1000;
  const nowJST     = new Date(Date.now() + JST_OFFSET); // JST 壁時計を UTC フィールドで保持
  const nowMins    = nowJST.getUTCHours() * 60 + nowJST.getUTCMinutes();
  // 60分後の HH:MM（JST、1440分で折り返し）
  const targetMins = (nowMins + 60) % (24 * 60);

  try {
    const rows = await db
      .select({
        reservationId: reservationsTable.id,
        userId:        reservationsTable.userId,
        bagId:         reservationsTable.bagId,
        bagTitle:      surpriseBagsTable.title,
        storeName:     storesTable.name,
        pickupStart:   surpriseBagsTable.pickupStart,
        pickupEnd:     surpriseBagsTable.pickupEnd,
        pickupEnd2:    surpriseBagsTable.pickupEnd2,
        pickupNextDay: surpriseBagsTable.pickupNextDay,
        createdAt:     reservationsTable.createdAt,
      })
      .from(reservationsTable)
      .leftJoin(surpriseBagsTable, eq(reservationsTable.bagId,   surpriseBagsTable.id))
      .leftJoin(storesTable,       eq(reservationsTable.storeId, storesTable.id))
      .where(
        and(
          eq(reservationsTable.status,        'confirmed'),
          eq(reservationsTable.paymentStatus, 'paid'),
        ),
      );

    for (const row of rows) {
      if (!row.pickupStart || !row.userId) continue;

      const [sh, sm] = row.pickupStart.split(':').map(Number);
      const pickupMins = sh * 60 + sm;

      // targetMins と pickupMins の差が ±5分以内かチェック（60分前ウィンドウ）
      const diff = ((pickupMins - targetMins + 24 * 60) % (24 * 60));
      if (diff > 5) continue;

      // ★ 受取窓がすでに終了している予約には送らない。
      //   旧実装は時刻(HH:MM)だけで判定し日付を見ていなかったため、前日の受取期限切れ予約
      //   (status は confirmed のまま残る)に翌日また「あと1時間」と誤通知していた。
      //   予約作成日(JST)を受取日とし、pickupEnd(日跨ぎなら翌日)を過ぎていたら skip。
      const createdJST    = new Date(row.createdAt.getTime() + JST_OFFSET);
      // 受取日(JST)。 前日出品(pickupNextDay)は受取が翌日なので +1 日する。
      //   これが無いと翌日受取の予約が「受取窓 終了済み」と誤判定され、 リマインダーが
      //   一切飛ばなかった（endMs を出品日基準で計算 → 翌朝には常に過去扱い）。
      const pickupBase    = row.pickupNextDay
        ? new Date(createdJST.getTime() + 24 * 60 * 60 * 1000)
        : createdJST;
      const pickupDateStr = pickupBase.toISOString().slice(0, 10); // JST の受取日 YYYY-MM-DD
      // 2部制(受取2枠): 受取窓の終わりは「最後の枠の終わり」= pickupEnd2 があればそちら。
      const effEnd = row.pickupEnd2 || row.pickupEnd;
      if (effEnd) {
        const [eh, em] = effEnd.split(':').map(Number);
        const overnight = (eh * 60 + em) <= pickupMins; // 最後の枠end <= 最初のstart → 日跨ぎ窓
        // JST 壁時計を UTC として解釈したエポックで now(JST) と比較する
        let endMs = new Date(`${pickupDateStr}T${effEnd}:00Z`).getTime();
        if (overnight) endMs += 24 * 60 * 60 * 1000;
        if (nowJST.getTime() >= endMs) continue; // 受取窓 終了済み → 送らない
      } else if (pickupDateStr !== nowJST.toISOString().slice(0, 10)) {
        // pickupEnd 不明: 受取日が今日でなければ古い予約として skip
        continue;
      }

      // 同一予約にすでにリマインダーを送っていたらスキップ（重複防止）
      const [existing] = await db
        .select({ id: notificationsTable.id })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.userId, row.userId),
            eq(notificationsTable.type,   'pickup_reminder'),
            // ★ 末尾に `[bag:ID]` トークンを付与するようにしたため、 末尾固定の
            //   `'%#106'` では重複検出が漏れて再送される。 両端ワイルドカード + 単語境界に
            //   なる文字 (空白 or 文字列終端) で挟むことで誤ヒット (#1060 等) も防ぐ。
            or(
              sql`body LIKE ${'%#' + row.reservationId}`,
              sql`body LIKE ${'%#' + row.reservationId + ' %'}`,
            ),
          ),
        )
        .limit(1);

      if (existing) continue;

      const title = '⏰ 受取時間が近づいています';
      const body  = `${row.storeName ?? '店舗'}「${row.bagTitle ?? 'おすそわけ袋'}」の受取開始まで約1時間です`;

      // アプリ内通知（末尾に reservationId を埋め込んで重複チェックに使う）
      // ★ さらに [bag:ID] トークンを末尾に付与し、 フロントの「詳細を見る」 で
      //   bag detail に直接遷移できるようにする (NotificationsBell.tsx で抽出/除去)
      const bagToken = row.bagId ? ` [bag:${row.bagId}]` : '';
      await db.insert(notificationsTable).values({
        userId: row.userId,
        type:   'pickup_reminder',
        title,
        body:   `${body} #${row.reservationId}${bagToken}`,
      });

      // Web Push (本文にはトークンを入れない: アプリ外通知の見栄えを汚さないため。
      //  画面内ベルからの遷移用トークンは DB 通知本文側のみに付与済)
      await sendPushToUser(row.userId, {
        title,
        body,
        tag:  `pickup-reminder-${row.reservationId}`,
        url:  row.bagId ? `/bags/${row.bagId}` : '/my-reservations',
        data: { reservationId: row.reservationId, bagId: row.bagId ?? null },
      });

      console.log(`[pickup-reminder] sent: user=${row.userId} reservation=${row.reservationId}`);
    }
  } catch (err) {
    console.error('[pickup-reminder] error:', err);
  }
}

/**
 * 受取終了30分前、まだ受取が済んでいない(confirmed のままの)予約のユーザーへ
 * 最終リマインダーを送る。受取済(picked_up)・キャンセル済は対象外。
 * 5分ごとに呼び出すことを想定（index.ts の setInterval で実行）。
 */
export async function sendPickupDeadlineReminders(): Promise<void> {
  const JST_OFFSET = 9 * 60 * 60 * 1000;
  const nowJST     = new Date(Date.now() + JST_OFFSET); // JST 壁時計を UTC フィールドで保持

  try {
    const rows = await db
      .select({
        reservationId: reservationsTable.id,
        userId:        reservationsTable.userId,
        bagId:         reservationsTable.bagId,
        bagTitle:      surpriseBagsTable.title,
        storeName:     storesTable.name,
        pickupStart:   surpriseBagsTable.pickupStart,
        pickupEnd:     surpriseBagsTable.pickupEnd,
        pickupEnd2:    surpriseBagsTable.pickupEnd2,
        pickupNextDay: surpriseBagsTable.pickupNextDay,
        createdAt:     reservationsTable.createdAt,
      })
      .from(reservationsTable)
      .leftJoin(surpriseBagsTable, eq(reservationsTable.bagId,   surpriseBagsTable.id))
      .leftJoin(storesTable,       eq(reservationsTable.storeId, storesTable.id))
      .where(
        and(
          // confirmed のみ = 支払済かつ未受取。受取済(picked_up)は自動的に対象外。
          eq(reservationsTable.status,        'confirmed'),
          eq(reservationsTable.paymentStatus, 'paid'),
        ),
      );

    for (const row of rows) {
      if (!row.userId) continue;
      // 受取窓の終わり = 最後の枠の終わり(2部制なら pickupEnd2)。不明なら判定不能で skip。
      const effEnd = row.pickupEnd2 || row.pickupEnd;
      if (!effEnd) continue;

      // 受取日(JST): 予約作成日、前日出品(pickupNextDay)は翌日（開始前リマインダーと同じロジック）
      const createdJST    = new Date(row.createdAt.getTime() + JST_OFFSET);
      const pickupBase    = row.pickupNextDay
        ? new Date(createdJST.getTime() + 24 * 60 * 60 * 1000)
        : createdJST;
      const pickupDateStr = pickupBase.toISOString().slice(0, 10);

      const [eh, em] = effEnd.split(':').map(Number);
      let overnight = false;
      if (row.pickupStart) {
        const [sh, sm] = row.pickupStart.split(':').map(Number);
        overnight = (eh * 60 + em) <= (sh * 60 + sm); // 終了 <= 開始 → 日跨ぎ窓
      }
      let endMs = new Date(`${pickupDateStr}T${effEnd}:00Z`).getTime();
      if (overnight) endMs += 24 * 60 * 60 * 1000;

      // 終了30分前ウィンドウ: [end-30分, end-22分)。
      // 実行間隔5分に対し幅8分なので必ず1回は入り、2回入っても下の重複チェックで1通に抑える。
      const nowMs = nowJST.getTime();
      if (nowMs < endMs - 30 * 60_000 || nowMs >= endMs - 22 * 60_000) continue;

      // 同一予約にすでに送っていたらスキップ（開始前リマインダーと同じ body 末尾 #ID 方式）
      const [existing] = await db
        .select({ id: notificationsTable.id })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.userId, row.userId),
            eq(notificationsTable.type,   'pickup_deadline'),
            or(
              sql`body LIKE ${'%#' + row.reservationId}`,
              sql`body LIKE ${'%#' + row.reservationId + ' %'}`,
            ),
          ),
        )
        .limit(1);

      if (existing) continue;

      const title = '🛍️ お受け取りはお済みですか？';
      const body  = `${row.storeName ?? '店舗'}「${row.bagTitle ?? 'おすそわけ袋'}」の受取終了まで残り約30分です`;

      // アプリ内通知（末尾 #ID は重複チェック用。受取直前はチケット画面が正なので bag トークンは付けない）
      await db.insert(notificationsTable).values({
        userId: row.userId,
        type:   'pickup_deadline',
        title,
        body:   `${body} #${row.reservationId}`,
      });

      await sendPushToUser(row.userId, {
        title,
        body,
        tag:  `pickup-deadline-${row.reservationId}`,
        url:  '/my-reservations',
        data: { reservationId: row.reservationId, bagId: row.bagId ?? null },
      });

      console.log(`[pickup-deadline] sent: user=${row.userId} reservation=${row.reservationId}`);
    }
  } catch (err) {
    console.error('[pickup-deadline] error:', err);
  }
}
