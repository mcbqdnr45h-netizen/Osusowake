const USER_FEE_RATE = 0.05;

export function getDisplayPrice(basePrice: number | null | undefined): number {
  if (!basePrice || basePrice <= 0) return 0;
  return Math.ceil((basePrice * (1 + USER_FEE_RATE)) / 10) * 10;
}

export function getDisplaySavings(
  originalPrice: number | null | undefined,
  discountedPrice: number | null | undefined,
): number {
  return Math.max(0, getDisplayPrice(originalPrice) - getDisplayPrice(discountedPrice));
}

// 割引率は「店舗が設定した販売価格どうし」で計算する（店舗管理画面・SNS文面と同じ定義）。
// 表示価格（利用料込み・10円切り上げ）で計算すると丸め誤差で 1% ずれる
// （例: ¥550→¥280 は 49% OFF だが、表示価格 ¥580→¥300 では 48%）。
export function getDisplayDiscountPercent(
  originalPrice: number | null | undefined,
  discountedPrice: number | null | undefined,
): number {
  const o = originalPrice ?? 0;
  const d = discountedPrice ?? 0;
  if (o <= 0 || d <= 0 || d >= o) return 0;
  return Math.round((1 - d / o) * 100);
}
