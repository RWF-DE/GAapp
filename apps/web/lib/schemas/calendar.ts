// 締切と予定のダイアログの入力（04「締切と予定」の登録・編集の欄と送る前の確かめ、notes/T18.md「後半（画面）の約束」7。T18・D-54）。
// DB（0015 の events の CHECK）と同じ形にしてから送る（書き込みは RPC を通らない直接の insert・update なので、DB は除かずに拒む）：
// - 題名は zod の trim（JavaScript の String.prototype.trim。DB の CHECK と同じ 25 文字）の後に 1〜100 字。
// - メモは前後の空白を除き、空なら null、1000 字まで。
// - 字数は文字（Unicode のコードポイント。lib/schemas/notice-fields.ts の charCount）で数え、DB の length と同じにする。
// - 終日なら、開始の日（と最後の日）の Asia/Tokyo の 00:00 を送る（events_all_day_check）。最後の日が空か開始の日と同じなら null。
// - 終日でなければ、`<input type="datetime-local">` の値を Asia/Tokyo とみなして `+09:00` を付けて送る。
// - 最後の日・終わりは開始より前にしない（同じはよい。events_ends_at_check）。日付は Asia/Tokyo の 2000-01-01〜2200-12-31
//   （events_date_range_check）。
import { Constants } from '@gaapp/shared';
import { z } from 'zod';
import type { CalendarEventRow, EventAudience, EventKind, EventWrite } from '@/lib/data/calendar';
import { fromDateTimeLocal, toDateTimeLocal, tokyoDate, tokyoStartOfDay } from '@/lib/datetime';
import { charCount } from './notice-fields';

/** 題名の上限（events_title_check の `length(title) <= 100`） */
export const EVENT_TITLE_MAX = 100;
/** メモの上限（events_note_check の `length(note) <= 1000`） */
export const EVENT_NOTE_MAX = 1000;
/** 日付の範囲（events_date_range_check。Asia/Tokyo の日付。年度の1日目と同じ範囲。D-18） */
export const EVENT_DATE_MIN = '2000-01-01';
export const EVENT_DATE_MAX = '2200-12-31';

/** 欄の誤りの文言（04「締切と予定」の送る前の確かめ） */
export const EVENT_FORM_MESSAGES = {
  titleRequired: '題名を入れてください',
  titleTooLong: `題名は ${EVENT_TITLE_MAX} 字までです`,
  noteTooLong: `メモは ${EVENT_NOTE_MAX} 字までです`,
  dateRequired: '日付を入れてください',
  startRequired: '開始の日時を入れてください',
  endDateBefore: '最後の日は、開始の日と同じか後にしてください',
  endBefore: '終わりは、開始と同じか後にしてください',
  outOfRange: '2000年1月1日〜2200年12月31日の日付にしてください',
} as const;

/** ダイアログの入力の値 */
export interface EventFormValues {
  kind: EventKind;
  audience: EventAudience;
  title: string;
  allDay: boolean;
  /** 終日：日付（`YYYY-MM-DD`。必須） */
  startDate: string;
  /** 終日：最後の日（`YYYY-MM-DD`。空でもよい） */
  endDate: string;
  /** 時刻つき：開始（`<input type="datetime-local">` の値。Asia/Tokyo。必須） */
  start: string;
  /** 時刻つき：終わり（同じ形。空でもよい） */
  end: string;
  note: string;
}

/** 欄ごとの誤り */
export type EventFormErrors = Partial<Record<'title' | 'note' | 'startDate' | 'endDate' | 'start' | 'end', string>>;

/** 新しく登録するときの入力（種類は予定、対象は総務〔読む人のいちばん狭いもの〕、終日は外す、ほかは空。後半の判断したことの 16） */
export const EMPTY_EVENT_FORM: Readonly<EventFormValues> = Object.freeze({
  kind: 'event',
  audience: 'soumu',
  title: '',
  allDay: false,
  startDate: '',
  endDate: '',
  start: '',
  end: '',
  note: '',
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_PART = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

/** `<input type="datetime-local">` の値の日付（`YYYY-MM-DD`。形が違えば空文字） */
function datePartOf(local: string): string {
  return LOCAL_DATE_PART.exec(local)?.[1] ?? '';
}

/**
 * 編集で開くときの値（その項目の今の値）。終日：startDate＝開始の Asia/Tokyo の日付、endDate＝終わりの日付（なければ・開始の日と
 * 同じなら空）。時刻つき：start・end＝Asia/Tokyo の datetime-local の値（終わりがなければ空）。メモが null なら空。
 */
export function eventFormValuesOf(row: Pick<CalendarEventRow, 'kind' | 'audience' | 'title' | 'starts_at' | 'ends_at' | 'all_day' | 'note'>): EventFormValues {
  const base = { kind: row.kind, audience: row.audience, title: row.title, allDay: row.all_day, note: row.note ?? '' };
  if (row.all_day) {
    const startDate = tokyoDate(row.starts_at);
    const last = row.ends_at ? tokyoDate(row.ends_at) : '';
    return { ...base, startDate, endDate: last && last !== startDate ? last : '', start: '', end: '' };
  }
  return { ...base, startDate: '', endDate: '', start: toDateTimeLocal(row.starts_at), end: row.ends_at ? toDateTimeLocal(row.ends_at) : '' };
}

/**
 * 終日の切り替え（04「締切と予定」）：入れると、開始・終わりの日時の日付を日付・最後の日に入れる（同じ日なら最後の日は空。開始の日時が
 * なければ今の日付のまま）。外すと、日付の 09:00 を開始に入れ（日付がなければ今の開始のまま）、終わりは空にする（00:00 の時刻つきの
 * 項目を作りにくくし、開始より前の終わりを残さない。後半の判断したことの 15）。使わない側の欄は空にする。
 */
export function toggleAllDay(v: EventFormValues, allDay: boolean): EventFormValues {
  if (allDay === v.allDay) return v;
  if (allDay) {
    const startDate = datePartOf(v.start) || v.startDate;
    const last = datePartOf(v.end);
    return { ...v, allDay, startDate, endDate: last && last !== startDate ? last : '', start: '', end: '' };
  }
  const start = DATE_ONLY.test(v.startDate) ? `${v.startDate}T09:00` : v.start;
  return { ...v, allDay, start, end: '', startDate: '', endDate: '' };
}

/** 題名（前後の空白を除いた後で 1〜100 字） */
const titleSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: EVENT_FORM_MESSAGES.titleRequired })
  .refine((s) => charCount(s) <= EVENT_TITLE_MAX, { message: EVENT_FORM_MESSAGES.titleTooLong });

/** メモ（前後の空白を除き、空なら null。1000 字まで） */
const noteSchema = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s))
  .refine((s) => s === null || charCount(s) <= EVENT_NOTE_MAX, { message: EVENT_FORM_MESSAGES.noteTooLong });

const textSchema = z.object({
  kind: z.enum(Constants.public.Enums.event_kind),
  audience: z.enum(Constants.public.Enums.event_audience),
  title: titleSchema,
  note: noteSchema,
});

/** 暦にある日付か（`YYYY-MM-DD`。2026-02-30 などは偽） */
function isCalendarDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const inRange = (date: string) => date >= EVENT_DATE_MIN && date <= EVENT_DATE_MAX;

/**
 * 日付と時刻を確かめて送る値にする（終日：startDate・endDate、時刻つき：start・end）。誤りは欄ごとに1つ。
 */
function checkWhen(v: EventFormValues): { ok: true; when: Pick<EventWrite, 'starts_at' | 'ends_at' | 'all_day'> } | { ok: false; errors: EventFormErrors } {
  const errors: EventFormErrors = {};
  if (v.allDay) {
    const start = v.startDate.trim();
    const end = v.endDate.trim();
    if (start === '') errors.startDate = EVENT_FORM_MESSAGES.dateRequired;
    else if (!isCalendarDate(start) || !inRange(start)) errors.startDate = EVENT_FORM_MESSAGES.outOfRange;
    if (end !== '') {
      if (!isCalendarDate(end) || !inRange(end)) errors.endDate = EVENT_FORM_MESSAGES.outOfRange;
      else if (!errors.startDate && end < start) errors.endDate = EVENT_FORM_MESSAGES.endDateBefore;
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      when: { all_day: true, starts_at: tokyoStartOfDay(start), ends_at: end !== '' && end !== start ? tokyoStartOfDay(end) : null },
    };
  }
  const startRaw = v.start.trim();
  const endRaw = v.end.trim();
  const startsAt = startRaw === '' ? null : fromDateTimeLocal(startRaw);
  const endsAt = endRaw === '' ? null : fromDateTimeLocal(endRaw);
  if (startRaw === '') errors.start = EVENT_FORM_MESSAGES.startRequired;
  else if (startsAt === null || !inRange(tokyoDate(startsAt))) errors.start = EVENT_FORM_MESSAGES.outOfRange;
  if (endRaw !== '') {
    if (endsAt === null || !inRange(tokyoDate(endsAt))) errors.end = EVENT_FORM_MESSAGES.outOfRange;
    else if (!errors.start && startsAt !== null && Date.parse(endsAt) < Date.parse(startsAt)) errors.end = EVENT_FORM_MESSAGES.endBefore;
  }
  if (Object.keys(errors).length > 0 || startsAt === null) return { ok: false, errors };
  return { ok: true, when: { all_day: false, starts_at: startsAt, ends_at: endsAt } };
}

/**
 * 送る前の確かめ（04 の文言）。通れば送る値（EventWrite）、通らなければ欄ごとの最初の誤り。
 *
 * @example
 * const r = checkEventForm(values);
 * if (!r.ok) setErrors(r.errors);
 */
export function checkEventForm(v: EventFormValues): { ok: true; write: EventWrite } | { ok: false; errors: EventFormErrors } {
  const errors: EventFormErrors = {};
  const text = textSchema.safeParse({ kind: v.kind, audience: v.audience, title: v.title, note: v.note });
  if (!text.success) {
    for (const issue of text.error.issues) {
      const key = issue.path[0];
      if ((key === 'title' || key === 'note') && !(key in errors)) errors[key] = issue.message;
    }
  }
  const when = checkWhen(v);
  if (!when.ok) Object.assign(errors, when.errors);
  if (!text.success || !when.ok) {
    // 種類・対象の形の誤り（ラジオなので起きない）は欄を持たないので、題名の欄に出す
    if (Object.keys(errors).length === 0) errors.title = '入力の形が違います';
    return { ok: false, errors };
  }
  return { ok: true, write: { kind: text.data.kind, audience: text.data.audience, title: text.data.title, note: text.data.note, ...when.when } };
}
