// 日本の祝日・銀行営業日の判定。
//
// 用途: 店舗ダッシュボードの「振込予定日」表示を、実際の銀行営業日
// （＝Stripe payout の着金日）に一致させる。銀行は土日と国民の祝日、
// および振替休日・国民の休日に休業するため、これらをすべて考慮する。
//
// 祝日はハードコード表を持たず、法律（国民の祝日に関する法律）に基づき
// アルゴリズムで算出する＝毎年メンテ不要で失効しない。
// 春分/秋分の近似式は西暦 1980–2099 で有効。
//
// ※ 銀行の年末年始休業（12/31–1/3）も非営業日として扱う。

// ── 基本ヘルパー ─────────────────────────────────────
export function parseDateYMD(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

export function toYMD(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// 「2026-07-27」→「7月27日(月)」。曜日を付けて誤読を防ぐ。
export function formatYmdWithWeekday(ymd: string): string {
  const d = parseDateYMD(ymd);
  if (!d) return ymd.replace(/-/g, '/');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${wd})`;
}

// ── 祝日算出 ─────────────────────────────────────────
// その月の第n月曜の「日」を返す（ハッピーマンデー用）
function nthMonday(year: number, month: number, n: number): number {
  const first = new Date(year, month - 1, 1).getDay(); // 0=Sun..6=Sat
  const firstMonday = 1 + ((8 - first) % 7);
  return firstMonday + (n - 1) * 7;
}

// 春分の日（3月）— 1980–2099 有効の近似式
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
// 秋分の日（9月）
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

// 法定の「国民の祝日」そのもの（振替休日・国民の休日を含まない）を M-D 集合で返す
function baseHolidays(year: number): Set<string> {
  const s = new Set<string>();
  const add = (m: number, d: number) => s.add(`${m}-${d}`);
  add(1, 1);                          // 元日
  add(1, nthMonday(year, 1, 2));      // 成人の日（1月第2月曜）
  add(2, 11);                         // 建国記念の日
  if (year >= 2020) add(2, 23);       // 天皇誕生日（令和）
  add(3, vernalEquinoxDay(year));     // 春分の日
  add(4, 29);                         // 昭和の日
  add(5, 3);                          // 憲法記念日
  add(5, 4);                          // みどりの日
  add(5, 5);                          // こどもの日
  add(7, nthMonday(year, 7, 3));      // 海の日（7月第3月曜・2022以降通常）
  if (year >= 2016) add(8, 11);       // 山の日
  add(9, nthMonday(year, 9, 3));      // 敬老の日（9月第3月曜）
  add(9, autumnalEquinoxDay(year));   // 秋分の日
  add(10, nthMonday(year, 10, 2));    // スポーツの日（10月第2月曜・2022以降通常）
  add(11, 3);                         // 文化の日
  add(11, 23);                        // 勤労感謝の日
  return s;
}

// 振替休日・国民の休日を加えた、その年の全休日を M-D 集合で返す
const holidayCache = new Map<number, Set<string>>();
function holidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const base = baseHolidays(year);
  const all = new Set(base);
  const key = (m: number, d: number) => `${m}-${d}`;

  // 国民の休日: 前日・翌日がともに祝日で、自身は祝日でない平日（日曜除く）
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      if (base.has(key(m, d))) continue;
      const cur = new Date(year, m - 1, d);
      if (cur.getDay() === 0) continue; // 日曜は国民の休日にならない
      const prev = new Date(year, m - 1, d - 1);
      const next = new Date(year, m - 1, d + 1);
      const pk = key(prev.getMonth() + 1, prev.getDate());
      const nk = key(next.getMonth() + 1, next.getDate());
      if (base.has(pk) && base.has(nk)) all.add(key(m, d));
    }
  }

  // 振替休日: 祝日が日曜のとき、その後最初の「祝日でない日」を休日にする
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      if (!base.has(key(m, d))) continue;
      const dt = new Date(year, m - 1, d);
      if (dt.getDay() !== 0) continue; // 日曜の祝日のみ振替対象
      const sub = new Date(dt);
      do {
        sub.setDate(sub.getDate() + 1);
      } while (base.has(key(sub.getMonth() + 1, sub.getDate())));
      all.add(key(sub.getMonth() + 1, sub.getDate()));
    }
  }

  holidayCache.set(year, all);
  return all;
}

// ── 公開API ─────────────────────────────────────────
/** 日本の国民の祝日（振替休日・国民の休日含む）か */
export function isJapaneseHoliday(date: Date): boolean {
  return holidaysForYear(date.getFullYear()).has(`${date.getMonth() + 1}-${date.getDate()}`);
}

/** 銀行の年末年始休業（12/31–1/3）か */
function isBankYearEndClosure(date: Date): boolean {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return (m === 12 && d === 31) || (m === 1 && d >= 1 && d <= 3);
}

/** 銀行営業日か（土日・祝日・振替・国民の休日・年末年始でない） */
export function isBusinessDay(date: Date): boolean {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  if (isJapaneseHoliday(date)) return false;
  if (isBankYearEndClosure(date)) return false;
  return true;
}

/** YMD文字列が非営業日（土日祝・振替・国民の休日・年末年始）か */
export function isNonBusinessDayYMD(ymd: string): boolean {
  const d = parseDateYMD(ymd);
  return d ? !isBusinessDay(d) : false;
}

/** YMD文字列を、その日以降で最初の銀行営業日に繰り下げて返す */
export function shiftYMDToBusinessDay(ymd: string): string {
  const d = parseDateYMD(ymd);
  if (!d) return ymd;
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return toYMD(d);
}
