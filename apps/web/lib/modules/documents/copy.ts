// 前年度から写す（04「提出状況」の提出物の設定の「前年度から写す」、Q10。T19・D-55）。純粋な関数。
// 締切は、1日目の差の日数だけずらす（Asia/Tokyo の時刻は同じ。Asia/Tokyo には夏時間がないので、日数 × 24 時間を足すのと同じ）。
// DB の previous_year_documents の new_deadline・copy_previous_documents と同じ計算（画面はふつう RPC の new_deadline を出し、これは
// 比べるため〔テスト〕と、範囲の外を前もって知るために使う）。
import { daysBetween } from '@/lib/datetime-weekday';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 締切の範囲（documents_deadline_check。Asia/Tokyo の日付で 2000-01-01〜2200-12-31） */
export const DEADLINE_MIN_DATE = '2000-01-01';
export const DEADLINE_MAX_DATE = '2200-12-31';

/** 日時（ms）を Asia/Tokyo の `YYYY-MM-DDTHH:mm:ss+09:00` にする */
function toTokyoIso(ms: number): string {
  return `${new Date(ms + TOKYO_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

/**
 * 締切をずらす：前年度の1日目（prevFestivalStart）から今の年度の1日目（festivalStart）までの日数だけ後ろへ（前の年度が後なら前へ）。
 * 時刻は Asia/Tokyo で同じ。読めなければ null。
 *
 * @example
 * shiftDeadline('2026-10-05T08:00:00Z', '2026-10-17', '2027-10-16') // '2027-10-04T17:00:00+09:00'
 */
export function shiftDeadline(deadline: string, prevFestivalStart: string, festivalStart: string): string | null {
  const days = daysBetween(prevFestivalStart, festivalStart);
  const t = Date.parse(deadline);
  if (days === null || Number.isNaN(t)) return null;
  return toTokyoIso(t + days * DAY_MS);
}

/** 締切が範囲（Asia/Tokyo の 2000-01-01〜2200-12-31）の中か（ずらした締切の deadline_out_of_range を前もって知る） */
export function deadlineInRange(deadline: string): boolean {
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return false;
  const day = toTokyoIso(t).slice(0, 10);
  return day >= DEADLINE_MIN_DATE && day <= DEADLINE_MAX_DATE;
}

/** 写した後の知らせ（「{N} 件を写しました」。選んだのに写らなかったもの〔同じ題名〕があれば「（同じ題名の {k} 件は写しませんでした）」を添える） */
export function copySummary(selected: number, copied: number): string {
  const skipped = Math.max(0, selected - copied);
  return `${copied} 件を写しました${skipped > 0 ? `（同じ題名の ${skipped} 件は写しませんでした）` : ''}`;
}
