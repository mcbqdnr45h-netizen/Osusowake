import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

/**
 * プレパーミッション(事前許可訴求)の調整レイヤー。
 *
 * 狙い: 起動時にいきなり OS の通知許可ダイアログを出すと拒否されやすい。
 *   先にアプリ内のカスタムシートで価値を伝え、「オンにする」を押した人だけ
 *   OS ダイアログを出す。これで許可率が大きく上がる。
 *
 * 各 push フック(native/web)が「許可を求めて登録する」関数をここへ登録し、
 * NotificationNudgeSheet のボタンからまとめて呼び出す。
 */

type PushRequester = () => Promise<boolean>;

const requesters = new Set<PushRequester>();

/** push フックが自身の「許可要求+登録」関数を登録する。 返り値で解除。 */
export function registerPushRequester(fn: PushRequester): () => void {
  requesters.add(fn);
  return () => {
    requesters.delete(fn);
  };
}

/** 登録済みの全 requester を呼び、いずれかが granted になれば true。 */
export async function requestAllPushPermissions(): Promise<boolean> {
  let anyGranted = false;
  for (const fn of requesters) {
    try {
      if (await fn()) anyGranted = true;
    } catch {
      /* 個別失敗は無視して次へ */
    }
  }
  return anyGranted;
}

/**
 * まだ許可を「決めていない」(prompt/default)かつ push 対応環境か。
 *   true のときだけプレパーミッションシートを出す価値がある。
 *   既に granted/denied の人には出さない(denied は OS ダイアログを二度と出せない為)。
 */
export async function shouldOfferPush(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const p = await PushNotifications.checkPermissions();
      return p.receive === 'prompt' || p.receive === 'prompt-with-rationale';
    } catch {
      return false;
    }
  }
  // Web
  if (typeof Notification === 'undefined') return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  return Notification.permission === 'default';
}
