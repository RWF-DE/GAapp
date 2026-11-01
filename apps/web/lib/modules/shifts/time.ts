// シフトの時間枠の時刻と日の出し方（04「シフト表」「自分のシフト」・「ダッシュボードに出すもの（シフト・作業）」、notes/T20.md
// 「画面の約束」4・5・10。T20・D-56）。純粋な関数（時計は now だけ）。日時は Asia/Tokyo で決め、端末のタイムゾーンによらない。
// シフト表（board.ts）・自分のシフト（my-shift.ts）・ダッシュボード（portal.ts）が共有する小さな関数だけを置く（/ の JS にシフト表の
// 組み立てを入れないため。portal.ts は board.ts を読まない）。
import { addDays, formatTime, tokyoDate, tokyoToday } from '@/lib/datetime';
import { formatShortDateWeekday } from '@/lib/datetime-weekday';

/** 時間枠の開始と終わり（timestamptz の ISO 文字列） */
export interface SlotTimes {
  starts_at: string;
  ends_at: string;
}

/** 日時の ms（読めなければ NaN） */
export function timeOf(iso: string): number {
  return Date.parse(iso);
}

/** 時間枠の日（開始の Asia/Tokyo の日付 `YYYY-MM-DD`。0 時をまたぐ枠は開始の日）。読めなければ空文字 */
export function slotDayOf(s: Pick<SlotTimes, 'starts_at'>): string {
  return tokyoDate(s.starts_at);
}

/**
 * 時間枠の時刻：「09:00〜10:00」。終わりが次の日なら「23:00〜翌 01:00」（ちょうど次の日の 0 時なら「23:00〜24:00」）。
 * 読めなければ空文字。
 */
export function slotTimeLabel(s: SlotTimes): string {
  const start = formatTime(s.starts_at);
  const end = formatTime(s.ends_at);
  if (!start || !end) return '';
  const startDay = tokyoDate(s.starts_at);
  const endDay = tokyoDate(s.ends_at);
  if (endDay === startDay) return `${start}〜${end}`;
  if (endDay === addDays(startDay, 1)) return end === '00:00' ? `${start}〜24:00` : `${start}〜翌 ${end}`;
  return `${start}〜${endDay.slice(5).replace('-', '/')} ${end}`;
}

/** 今の枠か（始まり ≤ 今 < 終わり） */
export function isSlotNow(s: SlotTimes, now: number): boolean {
  return timeOf(s.starts_at) <= now && now < timeOf(s.ends_at);
}

/** 終わった枠か（終わり ≤ 今。終わりちょうどは終わった側） */
export function isSlotPast(s: Pick<SlotTimes, 'ends_at'>, now: number): boolean {
  return timeOf(s.ends_at) <= now;
}

/** これからの枠か（終わりが今より後。今の枠を含む。足りない枠の「これからの時間枠」） */
export function isSlotUpcoming(s: Pick<SlotTimes, 'ends_at'>, now: number): boolean {
  return timeOf(s.ends_at) > now;
}

/** 祭の日の名前（年度の1日目から数えた日。02 の festival_day の4つ）。ほかの日は null */
export function festivalDayName(date: string, festivalStart: string | null | undefined): string | null {
  if (!festivalStart) return null;
  const names: readonly [number, string][] = [
    [-2, '前々日'],
    [-1, '前日'],
    [0, '1日目'],
    [1, '2日目'],
  ];
  for (const [offset, name] of names) if (addDays(festivalStart, offset) === date) return name;
  return null;
}

/** 今の Asia/Tokyo の年 */
function thisYearOf(now: number): number {
  return Number(tokyoToday(new Date(now)).slice(0, 4));
}

/** `YYYY-MM-DD` の短い形（「10/15」。年が今年と違えば「2028/10/15」） */
function shortDate(date: string, thisYear: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  const md = `${Number(m[2])}/${Number(m[3])}`;
  return Number(m[1]) === thisYear ? md : `${m[1]}/${md}`;
}

/**
 * シフト表の日のタブの名前（04「シフト表」）：祭の日なら「前日（10/15）」、ほかは「10/18（土）」。年が今年（Asia/Tokyo）と違えば
 * 年も付ける（「2028/1/5（水）」「前日（2028/10/15）」）。読めなければ空文字。
 */
export function shiftDayLabel(date: string, festivalStart: string | null | undefined, now: number): string {
  const year = thisYearOf(now);
  const festival = festivalDayName(date, festivalStart);
  if (festival) {
    const d = shortDate(date, year);
    return d ? `${festival}（${d}）` : '';
  }
  return formatShortDateWeekday(date, year);
}
