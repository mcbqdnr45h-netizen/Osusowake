// ─── 価格計算の単一ソース ───────────────────────────────────────────────────
// お客様が実際に支払う金額 = 商品代金(merchandise) にユーザー側 5%「システム利用料」を
// 加算し、10円単位で切り上げた額。 決済(reservations.ts / payment.ts)と完全一致させる。
//
// 切り上げ(四捨五入でない)理由: 低額帯 (例 merchandise=51円) で四捨五入すると
//   userTotal=50円 となり「店舗の販売価格 > お客様の支払額」の逆転が起きるため。
//
// 例: merchandise=350円 → 370円 / 480円 → 510円 / 120円 → 130円 / 51円 → 60円
export const USER_SERVICE_FEE_RATE = 0.05;

export function roundTo10(n: number): number {
  return Math.ceil(n / 10) * 10;
}

/** 商品代金(円)から、お客様が支払う合計額(5%利用料込み・10円切上)を返す。 */
export function computeUserTotal(merchandiseJpy: number): number {
  return roundTo10(merchandiseJpy * (1 + USER_SERVICE_FEE_RATE));
}
