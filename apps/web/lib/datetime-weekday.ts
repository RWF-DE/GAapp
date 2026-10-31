// 曜日つきの日付と、暦の日付の差（Asia/Tokyo。T18：締切と予定〔/calendar〕とダッシュボードの「締切と予定」。04「締切と予定」の
// 日付の出し方、notes/T18.md「後半（画面）の約束」2）。どれも端末のタイムゾーンを通さない（lib/datetime.ts と同じく、日時は UTC に
// 9 時間を足して読み、`YYYY-MM-DD` は UTC の暦の日付として読む）。Asia/Tokyo には夏時間がないので、Asia/Tokyo の日付どうしの差は
// 暦の日付の差と同じ。
// lib/datetime.ts に置かないのは、lib/datetime.ts がどの画面の最初に読む JS にも丸ごと入るため（/stock・/request・/my を含む。
// 使わない関数も消えない）。ここは締切と予定の部品（lib/modules/portal.ts・lib/modules/calendar・components/calendar）だけが読む
// （notes/T18.md の「後半の実装で決めたこと」）。
import { formatTime, tokyoDate } from './datetime';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` を暦の日付として読む（年・月・日と、その日の UTC の 0 時の ms）。形が違う・ない日なら null */
function calendarDay(date: string): { y: number; mo: number; d: number; t: number } | null {
  const m = DATE_ONLY.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // 2026-02-30 のようなない日（Date.UTC は次の月に繰り越す）と、0〜99 年（Date.UTC が 1900 年代にする）は読まない
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return { y, mo, d, t };
}

/**
 * 曜日（'日'〜'土'）。`YYYY-MM-DD` を暦の日付として読む。形が違う・ない日なら空文字。
 *
 * @example
 * weekdayOf('2027-10-16') // '土'
 */
export function weekdayOf(date: string): string {
  const c = calendarDay(date);
  return c ? WEEKDAYS[new Date(c.t).getUTCDay()]! : '';
}

/**
 * 日付だけ（`YYYY-MM-DD`）の短い形と曜日：`10/16（土）`。thisYear を渡し、年がそれと違えば `2028/1/1（土）`。形が違えば空文字。
 *
 * @example
 * formatShortDateWeekday('2027-10-16', 2027) // '10/16（土）'
 * formatShortDateWeekday('2028-01-01', 2027) // '2028/1/1（土）'
 */
export function formatShortDateWeekday(date: string, thisYear?: number): string {
  const c = calendarDay(date);
  if (!c) return '';
  const wd = WEEKDAYS[new Date(c.t).getUTCDay()]!;
  return thisYear === undefined || c.y === thisYear ? `${c.mo}/${c.d}（${wd}）` : `${c.y}/${c.mo}/${c.d}（${wd}）`;
}

/**
 * 日時（timestamptz の文字列か Date）の Asia/Tokyo の短い形と曜日：`9/30（木）17:00`。thisYear と年が違えば `2028/1/5（水）09:00`。
 * 読めなければ空文字。日付だけの値（`YYYY-MM-DD`）は時刻がないので空文字（formatShortDateWeekday を使う）。
 *
 * @example
 * formatShortDateTimeWeekday('2027-09-30T08:00:00Z', 2027) // '9/30（木）17:00'
 */
export function formatShortDateTimeWeekday(v: string | Date, thisYear?: number): string {
  if (typeof v === 'string' && DATE_ONLY.test(v)) return '';
  const day = tokyoDate(v);
  if (!day) return '';
  return `${formatShortDateWeekday(day, thisYear)}${formatTime(v)}`;
}

/**
 * /calendar の日の見出し：`10月16日（土）`（thisYear と年が違えば `2028年1月1日（土）`）。形が違えば空文字。
 *
 * @example
 * formatDayHeading('2027-10-16', 2027) // '10月16日（土）'
 */
export function formatDayHeading(date: string, thisYear?: number): string {
  const c = calendarDay(date);
  if (!c) return '';
  const wd = WEEKDAYS[new Date(c.t).getUTCDay()]!;
  return thisYear === undefined || c.y === thisYear ? `${c.mo}月${c.d}日（${wd}）` : `${c.y}年${c.mo}月${c.d}日（${wd}）`;
}

/**
 * 日付の差（to − from の日数）。`YYYY-MM-DD` を UTC の暦で数える（Date.UTC の差 ÷ 86,400,000）。Asia/Tokyo は夏時間がないので、
 * Asia/Tokyo の日付（tokyoDate）どうしの差もこれでよい（時刻の差を 24 時間で割らない）。形が違う・ない日なら null。
 *
 * @example
 * daysBetween('2027-10-14', '2027-10-16') // 2
 * daysBetween('2027-10-14', '2027-10-13') // -1
 */
export function daysBetween(from: string, to: string): number | null {
  const a = calendarDay(from);
  const b = calendarDay(to);
  if (!a || !b) return null;
  return Math.round((b.t - a.t) / DAY_MS);
}
