import webpush from 'web-push';
import apn from '@parse/node-apn';
import admin from 'firebase-admin';
import { db } from '@workspace/db';
import { webPushSubscriptionsTable, apnsRegistrationsTable, fcmRegistrationsTable } from '@workspace/db/schema';
import { eq } from 'drizzle-orm';
import { supabaseAdmin } from './supabase.js';

/**
 * 「お気に入り店舗の更新」通知を OPT-OUT したユーザー(notif_favorite_update=false)を
 * 宛先から除外して返す共通フィルタ。設定トグルを実際に効かせるために、お気に入り店の
 * 新出品プッシュ(手動出品 / 定期出品の初回公開)の直前で通す。
 *   ★ DB/Supabase 障害時は「除外せず全員に送る」へフェイルオープンする
 *     (通知が黙って消えるより、多く届くほうが害が小さいため)。
 */
export async function filterFavoriteUpdateOptIn(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('notif_favorite_update', false);
    const optOut = new Set<string>();
    for (const row of data ?? []) if (row.id) optOut.add(row.id as string);
    if (optOut.size === 0) return userIds;
    return userIds.filter((id) => !optOut.has(id));
  } catch (e) {
    console.error('[push] filterFavoriteUpdateOptIn error (fail-open):', e);
    return userIds;
  }
}

/**
 * 店舗オーナー / 管理者の userId 集合を返す。 お客さん向けの「発見系」プッシュ
 * (新着出品の全体配信 / 日次エンゲージメント) は店舗・管理者に送らないため、
 * これを宛先から除外する。 店舗には自店の注文通知だけ届くべきで、 よそ店の
 * 出品通知は不要 (店舗オーナー報告 2026-07-07)。
 *   ★ 障害時は空集合へフェイルオープン (= 誰も除外しない)。 お客さんへの配信を
 *     絶対に止めない方向に倒す。 稀に店舗へ発見通知が漏れるのは許容 (害小)。
 */
export async function getStoreOrAdminUserIds(): Promise<Set<string>> {
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('id')
      .neq('role', 'customer');
    const ids = new Set<string>();
    for (const row of data ?? []) if (row.id) ids.add(row.id as string);
    return ids;
  } catch (e) {
    console.error('[push] getStoreOrAdminUserIds error (fail-open):', e);
    return new Set<string>();
  }
}

/**
 * 店舗オーナーが「新規注文の通知(bag_sold push)」を受け取る設定か返す。
 * notif_new_order=false のオーナーには自店注文の push を送らない (設定トグルを実際に効かせる)。
 *   ★ アプリ内ベル(注文履歴)は別途 insert され残るので、push を止めても注文自体は取りこぼさない。
 *   ★ 障害時は true へフェイルオープン (= 送る)。 重要な注文通知を黙って落とさない方向。
 */
export async function storeOrderPushEnabled(ownerId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('notif_new_order')
      .eq('id', ownerId)
      .maybeSingle();
    return (data as { notif_new_order?: boolean | null } | null)?.notif_new_order !== false;
  } catch (e) {
    console.error('[push] storeOrderPushEnabled error (fail-open):', e);
    return true;
  }
}

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject    = process.env.VAPID_SUBJECT ?? 'mailto:hello@osusowakejapan.org';

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  console.log('[push] VAPID configured ✅');
} else {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です – web push は無効');
}

const APNS_BUNDLE_ID = 'com.yuhi.osusowake';
let apnsProvider: apn.Provider | null = null;
let apnsProviderSandbox: apn.Provider | null = null;

function normalizeApnsKey(raw: string): string {
  const body = raw
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\s+/g, '');

  const chunks = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN PRIVATE KEY-----\n${chunks}\n-----END PRIVATE KEY-----`;
}

// ── Firebase Cloud Messaging (FCM, Android) 初期化 ────────────────────────────
//   FIREBASE_SERVICE_ACCOUNT は Firebase コンソール (プロジェクト設定 →
//   サービスアカウント →「新しい秘密鍵の生成」) でダウンロードした JSON 文字列
//   をそのまま Fly secret に入れる。 base64 化等は不要。
//   未設定でも APNs / Web Push と独立に動作する (Android push だけ無効化される)。
let fcmApp: admin.app.App | null = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // private_key 内の \n リテラルを実改行に戻す (Fly secret は文字列化されるため)
    if (typeof cred.private_key === 'string') {
      cred.private_key = cred.private_key.replace(/\\n/g, '\n');
    }
    fcmApp = admin.initializeApp({ credential: admin.credential.cert(cred) }, 'osusowake-fcm');
    console.log('[push] FCM configured ✅');
  } catch (err: any) {
    console.error('[push] FCM 初期化失敗 (FIREBASE_SERVICE_ACCOUNT の JSON 不正):', err?.message ?? err);
  }
} else {
  console.warn('[push] FIREBASE_SERVICE_ACCOUNT が未設定 – Android FCM は無効');
}

if (process.env.APNS_PRIVATE_KEY && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID) {
  try {
    const apnsKey = normalizeApnsKey(process.env.APNS_PRIVATE_KEY);
    const tokenCfg = {
      key:    apnsKey,
      keyId:  process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    };
    apnsProvider        = new apn.Provider({ token: tokenCfg, production: true  });
    apnsProviderSandbox = new apn.Provider({ token: tokenCfg, production: false });
    console.log('[push] APNs configured ✅ (dual: production + sandbox, auto-fallback enabled)');
  } catch (err: any) {
    console.error('[push] APNs Provider 初期化失敗:', err?.message ?? err);
  }
} else {
  console.warn('[push] APNS_PRIVATE_KEY / APNS_KEY_ID / APNS_TEAM_ID が未設定 – APNs は無効');
}

export interface PushPayload {
  title: string;
  body:  string;
  icon?: string;
  tag?:  string;
  url?:  string;
  data?: Record<string, unknown>;
}

async function sendApnsPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const uShort = userId.slice(0, 8);
  if (!apnsProvider) {
    console.warn(`[push] APNs provider 未初期化 (user ${uShort})`);
    return;
  }

  const allRegs = await db
    .select()
    .from(apnsRegistrationsTable)
    .where(eq(apnsRegistrationsTable.userId, userId));

  // ★ 防御的 dedup: 同じユーザーに複数行 (古いトークンが残ってる) がある場合、
  //   最新の updatedAt を持つ1行だけに送信する。これで同じ端末に2回届く事故を防ぐ。
  //   登録 API 側の掃除と二重防御。
  const regs = allRegs
    .slice()
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 1);

  console.log(`[push] APNs 送信開始 user=${uShort} regs=${regs.length}/${allRegs.length} title="${payload.title}"`);

  if (regs.length === 0) {
    console.warn(`[push] user ${uShort} のデバイストークンが DB に無い`);
    return;
  }

  const notification = new apn.Notification();
  notification.expiry     = Math.floor(Date.now() / 1000) + 3600;
  notification.badge      = 1;
  notification.sound      = 'default';
  notification.alert      = { title: payload.title, body: payload.body };
  notification.topic      = APNS_BUNDLE_ID;
  notification.payload    = { url: payload.url ?? '/', ...(payload.data ?? {}) };
  notification.pushType   = 'alert';
  // ★ apns-collapse-id: 同じ tag の通知は端末で1個に統合される。
  //   confirm / webhook / verify-session の3経路から同一 tag で push しても
  //   通知センターに重複表示されない。設定しないと別通知として並んでしまう。
  if (payload.tag) {
    notification.collapseId = payload.tag.slice(0, 64);
  }

  const tokens = regs.map((r) => r.deviceToken);

  async function trySend(provider: apn.Provider, label: 'prod' | 'sandbox', toks: string[]) {
    try {
      const r = await provider.send(notification, toks);
      console.log(`[push] APNs[${label}] 結果 user=${uShort} sent=${r.sent.length} failed=${r.failed.length}`);
      return r;
    } catch (err: any) {
      console.error(`[push] APNs[${label}] send 例外 user=${uShort}:`, err?.message ?? err);
      return null;
    }
  }

  const prodResult = await trySend(apnsProvider, 'prod', tokens);
  if (!prodResult) return;

  const envMismatchTokens: string[] = [];
  for (const fail of prodResult.failed) {
    const reason = (fail.response as any)?.reason;
    const status = (fail as any)?.status;
    const errStr = (fail as any)?.error ? String((fail as any).error) : '';
    console.warn(`[push] APNs[prod] 失敗 token=${fail.device?.slice(0, 10)}... status=${status} reason=${reason} err=${errStr}`);
    if (reason === 'BadEnvironmentKeyInToken' || reason === 'BadDeviceToken') {
      envMismatchTokens.push(fail.device);
    } else if (reason === 'Unregistered') {
      await db.delete(apnsRegistrationsTable).where(eq(apnsRegistrationsTable.deviceToken, fail.device)).catch(() => {});
      console.log('[push] 無効な APNs トークンを削除(Unregistered):', fail.device?.slice(0, 10) + '...');
    }
  }

  if (envMismatchTokens.length > 0 && apnsProviderSandbox) {
    console.log(`[push] sandbox フォールバック試行 user=${uShort} tokens=${envMismatchTokens.length}`);
    const sbResult = await trySend(apnsProviderSandbox, 'sandbox', envMismatchTokens);
    if (sbResult) {
      for (const fail of sbResult.failed) {
        const reason = (fail.response as any)?.reason;
        const status = (fail as any)?.status;
        console.warn(`[push] APNs[sandbox] 失敗 token=${fail.device?.slice(0, 10)}... status=${status} reason=${reason}`);
        if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
          await db.delete(apnsRegistrationsTable).where(eq(apnsRegistrationsTable.deviceToken, fail.device)).catch(() => {});
          console.log('[push] 無効な APNs トークンを削除(sandbox失敗):', fail.device?.slice(0, 10) + '...');
        }
      }
      if (sbResult.sent.length > 0) {
        console.log(`[push] ✅ sandbox 送信成功: ${sbResult.sent.length} 件`);
      }
    }
  }

  if (prodResult.sent.length > 0) {
    console.log(`[push] ✅ prod 送信成功: ${prodResult.sent.length} 件`);
  }
}

/**
 * APNs のアプリアイコンのバッジ数だけを更新するサイレント(背景)プッシュ。
 * 通知の既読時に badge=0 を送って「アイコンの 1 が消えない」問題を解消する用途。
 * アラート/音は出さない (content-available の background push)。
 * ※ 背景プッシュは iOS により遅延/間引きされ得るベストエフォート。
 *   端末ローカルでの確実なクリアは AppDelegate の applicationDidBecomeActive で別途実施。
 */
export async function setApnsBadgeForUser(userId: string, badge: number): Promise<void> {
  const uShort = userId.slice(0, 8);
  if (!apnsProvider) return;

  const allRegs = await db
    .select()
    .from(apnsRegistrationsTable)
    .where(eq(apnsRegistrationsTable.userId, userId));
  const regs = allRegs
    .slice()
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 1);
  if (regs.length === 0) return;

  const n = new apn.Notification();
  n.expiry           = Math.floor(Date.now() / 1000) + 3600;
  n.badge            = Math.max(0, Math.trunc(badge) || 0);
  n.topic            = APNS_BUNDLE_ID;
  n.contentAvailable = true;        // サイレント(背景)更新。alert/sound は付けない
  n.pushType         = 'background';
  n.priority         = 5;           // background push は priority 5 必須

  const tokens = regs.map((r) => r.deviceToken);

  async function trySend(provider: apn.Provider, label: 'prod' | 'sandbox', toks: string[]) {
    try {
      const r = await provider.send(n, toks);
      console.log(`[push] badge[${label}] user=${uShort} badge=${n.badge} sent=${r.sent.length} failed=${r.failed.length}`);
      return r;
    } catch (err: any) {
      console.error(`[push] badge[${label}] 例外 user=${uShort}:`, err?.message ?? err);
      return null;
    }
  }

  const prod = await trySend(apnsProvider, 'prod', tokens);
  if (!prod) return;

  const envMismatch: string[] = [];
  for (const fail of prod.failed) {
    const reason = (fail.response as any)?.reason;
    if (reason === 'BadEnvironmentKeyInToken' || reason === 'BadDeviceToken') {
      envMismatch.push(fail.device);
    } else if (reason === 'Unregistered') {
      await db.delete(apnsRegistrationsTable).where(eq(apnsRegistrationsTable.deviceToken, fail.device)).catch(() => {});
    }
  }
  if (envMismatch.length > 0 && apnsProviderSandbox) {
    await trySend(apnsProviderSandbox, 'sandbox', envMismatch);
  }
}

/**
 * 会員登録前の匿名端末(userId 無し)へ直接 APNs 送信する。
 *   apns_registrations を経由せず、生の deviceToken 配列に一斉送信する。
 *   デイリー通知(出品中◯件)を非会員にも届けるための専用パス。
 *   prod → BadEnvironment のみ sandbox フォールバック。失効トークンは呼び出し側で掃除。
 * @returns 失効(Unregistered/BadDeviceToken)で今後掃除すべき deviceToken 配列
 */
export async function sendApnsPushToRawTokens(
  tokens: string[],
  payload: PushPayload,
): Promise<{ sent: number; deadTokens: string[] }> {
  const deadTokens: string[] = [];
  if (!apnsProvider || tokens.length === 0) return { sent: 0, deadTokens };

  const notification = new apn.Notification();
  notification.expiry   = Math.floor(Date.now() / 1000) + 3600;
  notification.badge    = 1;
  notification.sound    = 'default';
  notification.alert    = { title: payload.title, body: payload.body };
  notification.topic    = APNS_BUNDLE_ID;
  notification.payload  = { url: payload.url ?? '/', ...(payload.data ?? {}) };
  notification.pushType = 'alert';
  if (payload.tag) notification.collapseId = payload.tag.slice(0, 64);

  let sentCount = 0;

  async function trySend(provider: apn.Provider, label: 'prod' | 'sandbox', toks: string[]) {
    try {
      const r = await provider.send(notification, toks);
      console.log(`[push] anon APNs[${label}] sent=${r.sent.length} failed=${r.failed.length}`);
      return r;
    } catch (err: any) {
      console.error(`[push] anon APNs[${label}] send 例外:`, err?.message ?? err);
      return null;
    }
  }

  const prodResult = await trySend(apnsProvider, 'prod', tokens);
  if (!prodResult) return { sent: 0, deadTokens };
  sentCount += prodResult.sent.length;

  const envMismatchTokens: string[] = [];
  for (const fail of prodResult.failed) {
    const reason = (fail.response as any)?.reason;
    if (reason === 'BadEnvironmentKeyInToken' || reason === 'BadDeviceToken') {
      envMismatchTokens.push(fail.device);
    } else if (reason === 'Unregistered') {
      deadTokens.push(fail.device);
    }
  }

  if (envMismatchTokens.length > 0 && apnsProviderSandbox) {
    const sbResult = await trySend(apnsProviderSandbox, 'sandbox', envMismatchTokens);
    if (sbResult) {
      sentCount += sbResult.sent.length;
      for (const fail of sbResult.failed) {
        const reason = (fail.response as any)?.reason;
        if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
          deadTokens.push(fail.device);
        }
      }
    }
  }

  return { sent: sentCount, deadTokens };
}

export async function sendWebPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) return;

  const subs = await db
    .select()
    .from(webPushSubscriptionsTable)
    .where(eq(webPushSubscriptionsTable.userId, userId));

  if (subs.length === 0) return;

  const notification = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    icon:  payload.icon ?? '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag:   payload.tag,
    data:  { url: payload.url ?? '/', ...payload.data },
  });

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notification,
        );
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await db
            .delete(webPushSubscriptionsTable)
            .where(eq(webPushSubscriptionsTable.id, sub.id))
            .catch(() => {});
          console.log(`[push] 期限切れサブスクリプションを削除: ${sub.endpoint.slice(0, 50)}...`);
        } else {
          console.warn('[push] sendNotification error:', err?.statusCode, String(err?.body ?? '').slice(0, 80));
        }
      }
    }),
  );
}

/**
 * 会員登録前の匿名 Web Push 購読(userId 無し)へ直接送信する。
 *   web_push_subscriptions を経由せず、生の購読オブジェクト配列に一斉送信する。
 * @returns 失効(410/404)で今後掃除すべき endpoint 配列
 */
export async function sendWebPushToRawSubs(
  subs: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload,
): Promise<{ sent: number; deadEndpoints: string[] }> {
  const deadEndpoints: string[] = [];
  if (!vapidPublicKey || !vapidPrivateKey || subs.length === 0) {
    return { sent: 0, deadEndpoints };
  }

  const notification = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    icon:  payload.icon ?? '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag:   payload.tag,
    data:  { url: payload.url ?? '/', ...payload.data },
  });

  let sent = 0;
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notification,
        );
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          deadEndpoints.push(sub.endpoint);
        } else {
          console.warn('[push] anon webpush error:', err?.statusCode, String(err?.body ?? '').slice(0, 80));
        }
      }
    }),
  );

  return { sent, deadEndpoints };
}

// ★ 重複送信防止 (in-memory dedup):
//   confirm / webhook / verify-session の3経路から同じ (userId, tag) で
//   sendPushToUser が呼ばれても、最初の1回だけ実際に送信する。
//   collapseId だけでは APNs の配信タイミングによっては端末で重複表示
//   される事があるため、送信側で完全に止める。TTL 10分。
const recentPushDedup = new Map<string, number>();
const PUSH_DEDUP_TTL_MS = 10 * 60 * 1000;

function shouldSkipDuplicate(userId: string, tag: string | undefined): boolean {
  if (!tag) return false;
  const key = `${userId}::${tag}`;
  const now = Date.now();
  // 期限切れエントリを掃除 (Map が肥大化しないように)
  for (const [k, ts] of recentPushDedup) {
    if (now - ts > PUSH_DEDUP_TTL_MS) recentPushDedup.delete(k);
  }
  const prev = recentPushDedup.get(key);
  if (prev && now - prev < PUSH_DEDUP_TTL_MS) {
    console.log(`[push] dedup skip user=${userId.slice(0, 8)} tag=${tag} (${Math.round((now - prev) / 1000)}s 前に送信済)`);
    return true;
  }
  recentPushDedup.set(key, now);
  return false;
}

async function sendFcmPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!fcmApp) return;
  const tokens = await db
    .select({ token: fcmRegistrationsTable.deviceToken, id: fcmRegistrationsTable.id })
    .from(fcmRegistrationsTable)
    .where(eq(fcmRegistrationsTable.userId, userId));
  if (tokens.length === 0) return;

  await Promise.allSettled(tokens.map(async (row) => {
    try {
      await fcmApp!.messaging().send({
        token: row.token,
        notification: { title: payload.title, body: payload.body },
        // data 経由でも届けて、 アプリ前面時にもアプリ内ハンドリングできるようにする
        data: {
          ...(payload.tag ? { tag: payload.tag } : {}),
          ...(payload.url ? { url: payload.url } : {}),
          ...Object.fromEntries(
            Object.entries(payload.data ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        },
        android: {
          priority: 'high',
          notification: {
            tag:       payload.tag,
            clickAction: 'FCM_PLUGIN_ACTIVITY', // Capacitor Push が拾うアクション
          },
        },
      });
    } catch (err: any) {
      const code: string = err?.errorInfo?.code ?? err?.code ?? '';
      // 失効トークンは DB から掃除する
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-argument' ||
        code === 'messaging/invalid-registration-token'
      ) {
        await db.delete(fcmRegistrationsTable).where(eq(fcmRegistrationsTable.id, row.id)).catch(() => {});
        console.log(`[push] FCM 失効トークン削除 user=${userId.slice(0, 8)} id=${row.id}`);
      } else {
        console.warn(`[push] FCM 送信失敗 user=${userId.slice(0, 8)} code=${code}:`, err?.message ?? err);
      }
    }
  }));
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (shouldSkipDuplicate(userId, payload.tag)) return;
  await Promise.allSettled([
    sendWebPushToUser(userId, payload),
    sendApnsPushToUser(userId, payload),
    sendFcmPushToUser(userId, payload),
  ]);
}

export async function sendWebPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (userIds.length === 0) return;
  await Promise.allSettled(userIds.map((id) => sendWebPushToUser(id, payload)));
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (userIds.length === 0) return;
  await Promise.allSettled(userIds.map((id) => sendPushToUser(id, payload)));
}
