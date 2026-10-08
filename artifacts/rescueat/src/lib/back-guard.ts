import { useEffect } from 'react';

/**
 * Android の「戻る」を、開いている画面（モーダル・シート）に先に渡すための仕組み。
 *
 * ★ 背景 (2026-08-12)
 *   iPhone には戻るボタンが無いので今まで問題にならなかったが、Android では
 *   モーダルを開いたまま戻るを押すと、モーダルが閉じずに【ページごと前の画面へ戻る】。
 *   出品モーダルの入力中に押すと、書いた内容がまるごと消える。
 *
 * ★ 仕組み
 *   開いている画面が自分の「閉じる処理」をこの積み木に積む。
 *   戻るが押されたら【一番上に積まれたもの＝一番手前の画面】だけを閉じる。
 *   何も積まれていなければ、従来どおりページを戻る（または最後はアプリ終了）。
 */

type Guard = () => void;

const stack: Guard[] = [];

export function pushBackGuard(fn: Guard): void {
  stack.push(fn);
}

export function popBackGuard(fn: Guard): void {
  const i = stack.lastIndexOf(fn);
  if (i >= 0) stack.splice(i, 1);
}

/** 戻るを1つ消費した場合は true（＝ページ遷移させない） */
export function consumeBackGuard(): boolean {
  const fn = stack.pop();
  if (!fn) return false;
  try { fn(); } catch { /* 閉じる処理の失敗で戻る操作自体を壊さない */ }
  return true;
}

export function hasBackGuard(): boolean {
  return stack.length > 0;
}

/**
 * モーダル側はこれを1行呼ぶだけ。
 *   useBackGuard(open, onClose)
 * open が true の間だけ、Android の戻るで onClose が呼ばれる。
 */
export function useBackGuard(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    // 最新の onClose を呼ぶためにラップする（依存で積み直さない）
    const guard = () => onClose();
    pushBackGuard(guard);
    return () => popBackGuard(guard);
    // onClose は毎回変わりうるので依存に入れない（active の変化でのみ積み替える）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
