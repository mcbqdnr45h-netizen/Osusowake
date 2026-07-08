import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const WEEKDAY = ['日','月','火','水','木','金','土'];

/**
 * 受取時間を「日付 開始〜終了」形式にフォーマット
 * @param start    "HH:MM" | null | undefined
 * @param end      "HH:MM" | null | undefined
 * @param refDate  基準日（省略 = 今日）。ISO文字列 or Date を渡すとその日付を使用
 */
/**
 * バッグの受け取り日が今日か明日かを JST カレンダー日付で判定する。
 * 受け取り日 = 出品日(createdAt の JST 日付) + (翌日受け取りなら +1)。
 * 時刻ではなく日付で比較するので、 深夜0時をまたいでもラベルがズレない。
 */
export function getPickupDateLabel(
  createdAt: string | Date | null | undefined,
  pickupNextDay: boolean | undefined,
): { isToday: boolean; isTomorrow: boolean; prefix: string } {
  const none = { isToday: false, isTomorrow: false, prefix: '' };
  if (!createdAt) return none;
  const created = new Date(createdAt);
  if (isNaN(created.getTime())) return none;
  const jstDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  const addDays = (ymd: string, n: number) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return {
      str: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`,
      mo: dt.getUTCMonth() + 1, day: dt.getUTCDate(),
    };
  };
  const pickup = addDays(jstDate(created), pickupNextDay ? 1 : 0);
  const today = jstDate(new Date());
  const tomorrow = addDays(today, 1).str;
  if (pickup.str === today) return { isToday: true, isTomorrow: false, prefix: '' };
  if (pickup.str === tomorrow) return { isToday: false, isTomorrow: true, prefix: '明日' };
  return { isToday: false, isTomorrow: false, prefix: `${pickup.mo}/${pickup.day}` };
}

export function formatPickupTime(
  start: string | null | undefined,
  end:   string | null | undefined,
  refDate?: Date | string | null,
): string {
  if (!start && !end) return '';

  const jstOpts = { timeZone: 'Asia/Tokyo' } as const;
  const todayStr = new Date().toLocaleDateString('ja-JP', { ...jstOpts, year:'numeric', month:'2-digit', day:'2-digit' });
  const base     = refDate ? new Date(refDate) : new Date();
  const baseStr  = base.toLocaleDateString('ja-JP', { ...jstOpts, year:'numeric', month:'2-digit', day:'2-digit' });

  const time = start
    ? (end ? `${start}〜${end}` : start)
    : `〜${end}`;

  if (baseStr === todayStr) {
    return time;
  }

  const m = base.toLocaleDateString('ja-JP', { ...jstOpts, month: 'numeric' });
  const d = base.toLocaleDateString('ja-JP', { ...jstOpts, day: 'numeric' });
  const w = WEEKDAY[base.getDay()];
  return `${m}/${d}(${w}) ${time}`;
}

// 受取日の基準 Date を返す。前日出品(pickupNextDay)なら公開日(JST暦日)の翌日、それ以外は公開日当日。
// formatPickupTime の refDate に渡すと、受取“日付”を（購入日ではなく実受取日で）正しく表示できる。
// ★ 2026-07-03 事故対応: 前日出品バッグで購入日=受取日と誤解される事故の再発防止。
export function effectivePickupDate(
  bagCreatedAt: string | Date | null | undefined,
  pickupNextDay?: boolean | null,
): Date | null {
  if (!bagCreatedAt) return null;
  const created = new Date(bagCreatedAt);
  if (isNaN(created.getTime())) return null;
  const jstYmd = created.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD (JST)
  const [y, m, d] = jstYmd.split('-').map(Number);
  // 12:00 JST (03:00 UTC) に固定して暦日跨ぎの丸め事故を避ける。
  return new Date(Date.UTC(y, m - 1, d + (pickupNextDay ? 1 : 0), 3, 0, 0));
}

/**
 * 受取時間を表示用に整形。 2部制(受取2枠)なら "11:00〜14:00 / 17:00〜19:00"、 1枠なら "11:00〜14:00"。
 * 日付プレフィックスは付けない（呼び出し側で「本日/明日」等を別途付与する想定）。
 */
export function pickupWindowsLabel(
  start?: string | null,
  end?: string | null,
  start2?: string | null,
  end2?: string | null,
): string {
  const fmt = (s?: string | null, e?: string | null) =>
    s ? (e ? `${s}〜${e}` : s) : (e ? `〜${e}` : '');
  const w1 = fmt(start, end);
  const w2 = start2 && end2 ? fmt(start2, end2) : '';
  return w2 ? `${w1} / ${w2}` : w1;
}
