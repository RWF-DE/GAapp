// 日時の表示と入力（画面の設計 2.8。T09a）。保存は timestamptz、画面は Asia/Tokyo（端末のタイムゾーンによらない）。
// Asia/Tokyo は夏時間がないので、入力の変換は +09:00 で固定してよい。

export const TOKYO = 'Asia/Tokyo';
const OFFSET = '+09:00';
const OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/** Asia/Tokyo の年・月・日・時・分・秒（Date の UTC の値を 9 時間ずらして読む） */
function tokyoParts(d: Date) {
  const t = new Date(d.getTime() + OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
  };
}

function toDate(v: string | Date): Date | null {
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `2026/10/05 18:01`（読めなければ空文字） */
export function formatDateTime(v: string | Date | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(v);
  if (!d) return '';
  const p = tokyoParts(d);
  return `${p.y}/${pad(p.mo)}/${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** `2026/10/05 18:01:09`（TokyoTime の title） */
export function formatDateTimeSeconds(v: string | Date | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(v);
  if (!d) return '';
  const p = tokyoParts(d);
  return `${p.y}/${pad(p.mo)}/${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** `10/5 18:01`（スマホのカード・提出済みの表示） */
export function formatShortDateTime(v: string | Date | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(v);
  if (!d) return '';
  const p = tokyoParts(d);
  return `${p.mo}/${p.d} ${pad(p.h)}:${pad(p.mi)}`;
}

/** `18:01`（下書きの「保存していない入力があります（hh:mm）」など） */
export function formatTime(v: string | Date | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const d = toDate(typeof v === 'number' ? new Date(v) : v);
  if (!d) return '';
  const p = tokyoParts(d);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** 1日目などの date（`YYYY-MM-DD`）を `2026/10/17` にする。タイムゾーンを通さない */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
}

/** timestamptz の値 → `<input type="datetime-local">` の値（Asia/Tokyo の `YYYY-MM-DDTHH:mm`） */
export function toDateTimeLocal(v: string | null | undefined): string {
  if (!v) return '';
  const d = toDate(v);
  if (!d) return '';
  const p = tokyoParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** `<input type="datetime-local">` の値を Asia/Tokyo とみなし、`YYYY-MM-DDTHH:mm:00+09:00` にする（空・形が違えば null） */
export function fromDateTimeLocal(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}${OFFSET}`;
  return toDate(iso) ? iso : null;
}

/** 日付（`YYYY-MM-DD`）の Asia/Tokyo の 0 時（`YYYY-MM-DDT00:00:00+09:00`）。履歴の期間の絞り込みの gte に使う */
export function tokyoStartOfDay(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付は YYYY-MM-DD');
  return `${date}T00:00:00${OFFSET}`;
}

/** 次の日の Asia/Tokyo の 0 時（期間の終わりの lt に使う。to の日を含める） */
export function tokyoStartOfNextDay(date: string): string {
  const d = new Date(`${tokyoStartOfDay(date).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)}T00:00:00${OFFSET}`;
}

/** 今日の日付（Asia/Tokyo の `YYYY-MM-DD`） */
export function tokyoToday(now: Date = new Date()): string {
  const p = tokyoParts(now);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
