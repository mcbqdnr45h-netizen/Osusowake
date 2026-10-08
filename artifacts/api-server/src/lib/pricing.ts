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

// ─── 手数料・送金額の分割（単一ソース）─────────────────────────────────────
// ★ payment.ts の calcFees と完全に同一のロジック。 変更するときは両方を必ず揃える
//   （売上明細書と実際の Stripe 送金額を1円もズレさせないため）。
export const PLATFORM_FEE_RATE = 0.20; // 店舗手数料 20%
export const STRIPE_FEE_RATE   = 0.036; // Stripe 決済手数料 3.6%

/**
 * ユーザー支払合計(total)と商品代金(merchandise)から、手数料と送金額を計算する。
 *   shopGross          = floor(merchandise × 0.80)         店舗売上(20%控除後・Stripe手数料前)
 *   stripeFee          = round(total × 0.036)              Stripe決済手数料
 *   shopTransferAmount = shopGross - stripeFee             店舗への実送金額
 *   platformRevenue    = total - shopGross                 プラットフォーム取り分(Stripe手数料前)
 */
export function calcFees(totalAmountJpy: number, merchandiseJpy: number): {
  platformRevenue: number;
  stripeFee: number;
  shopTransferAmount: number;
  shopGross: number;
} {
  const shopGross          = Math.floor(merchandiseJpy * (1 - PLATFORM_FEE_RATE));
  const stripeFee          = Math.round(totalAmountJpy * STRIPE_FEE_RATE);
  const shopTransferAmount = shopGross - stripeFee;
  const platformRevenue    = totalAmountJpy - shopGross;
  return { platformRevenue, stripeFee, shopTransferAmount, shopGross };
}
