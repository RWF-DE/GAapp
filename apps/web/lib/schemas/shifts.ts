// シフト表のダイアログの入力（04「シフト表」の持ち場・時間枠・1日分・ますの欄と送る前の確かめ、notes/T20.md「画面の約束」8。T20・D-56）。
// DB（0017 の CHECK）と同じ形にしてから送る（書き込みは RPC を通らない直接の insert・update なので、DB は除かずに拒む）：
// - 持ち場の名前は zod の trim（JavaScript の String.prototype.trim。DB の CHECK と同じ 25 文字）の後に 1〜50 字。場所・説明は前後の空白を
//   除き、空なら null（D-33）、100 字・1000 字まで。字数は文字（Unicode のコードポイント。lib/schemas/notice-fields.ts の charCount）。
// - 並び順は整数（±1,000,000。マスタ設定の並び順と同じ）。
// - 時間枠：日付（Asia/Tokyo の 2000-01-01〜2200-12-31）・始まり・終わり（`HH:mm`）。終わりが始まり以前なら翌日の時刻（0 時をまたぐ枠。
//   24 時間まで）。送る値は `YYYY-MM-DDTHH:mm:00+09:00`。
// - 1日分：日付・始まり・終わり（24:00 まで。始まりより後）・区切り（15・30・60・90・120 分）・持ち場ごとの「置く」と必要人数（0〜100）。
//   並ぶ時間枠は 1〜96（lib/modules/shifts/board.ts の slotsOfDayPlan）。
import { z } from 'zod';
import { addDays, formatTime, tokyoDate } from '@/lib/datetime';
import { DAY_PLAN_MAX, minutesOf, slotsOfDayPlan, SLOT_STEPS, tokyoIsoAt, type BoardDuty, type BoardSlot, type PlannedSlot } from '@/lib/modules/shifts/board';
import { charCount } from './notice-fields';

/** 持ち場の名前の上限（shift_duties_name_check の `length(name) <= 50`） */
export const DUTY_NAME_MAX = 50;
/** 場所の上限（shift_duties_place_check） */
export const DUTY_PLACE_MAX = 100;
/** 説明の上限（shift_duties_note_check） */
export const DUTY_NOTE_MAX = 1000;
/** 並び順（integer）。画面では ±1,000,000 まで（マスタ設定と同じ） */
export const DUTY_SORT_ORDER_MAX = 1_000_000;
/** 必要人数（shift_needs_required_count_check の 0〜100） */
export const NEED_MAX = 100;
/** 日付の範囲（shift_slots_date_range_check。Asia/Tokyo の日付。D-18・D-54） */
export const SHIFT_DATE_MIN = '2000-01-01';
export const SHIFT_DATE_MAX = '2200-12-31';

/** 欄の誤りの文言（04「シフト表」の送る前の確かめ） */
export const SHIFT_FORM_MESSAGES = {
  nameRequired: '名前を入れてください',
  nameTooLong: `名前は ${DUTY_NAME_MAX} 字までです`,
  placeTooLong: `場所は ${DUTY_PLACE_MAX} 字までです`,
  noteTooLong: `説明は ${DUTY_NOTE_MAX} 字までです`,
  orderInvalid: '並び順は整数で入れてください',
  orderRange: `並び順は -${DUTY_SORT_ORDER_MAX}〜${DUTY_SORT_ORDER_MAX} の整数にしてください`,
  dateRequired: '日付を入れてください',
  outOfRange: '2000年1月1日〜2200年12月31日の日付にしてください',
  startRequired: '始まりの時刻を入れてください',
  endRequired: '終わりの時刻を入れてください',
  endBefore: '終わりは始まりより後にしてください',
  tooMany: `時間枠は 1 回に ${DAY_PLAN_MAX} までです。区切りを長くするか、時刻を分けて作ってください`,
  stepInvalid: '区切りを選んでください',
  needRange: `必要人数は 0〜${NEED_MAX} の整数にしてください`,
} as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 暦にある日付か（`YYYY-MM-DD`。2027-02-30 などは偽） */
export function isCalendarDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const inRange = (date: string) => date >= SHIFT_DATE_MIN && date <= SHIFT_DATE_MAX;

// ---------------------------------------------------------------- 持ち場

/** 持ち場のダイアログの入力 */
export interface DutyFormValues {
  name: string;
  place: string;
  note: string;
  /** 並び順（文字。整数） */
  sortOrder: string;
}

/** 持ち場の送る値（id・year_id・日時は入れない） */
export interface DutyWrite {
  name: string;
  place: string | null;
  note: string | null;
  sort_order: number;
}

export type DutyFormErrors = Partial<Record<keyof DutyFormValues, string>>;

/** 新しい持ち場の入力（並び順は今の持ち場の最大＋1。なければ 0） */
export function emptyDutyForm(duties: readonly Pick<BoardDuty, 'sort_order'>[]): DutyFormValues {
  const max = duties.reduce((m, d) => Math.max(m, d.sort_order), Number.NEGATIVE_INFINITY);
  const next = Number.isFinite(max) ? Math.min(max + 1, DUTY_SORT_ORDER_MAX) : 0;
  return { name: '', place: '', note: '', sortOrder: String(next) };
}

/** 持ち場を直すときの入力（今の値） */
export function dutyFormValuesOf(d: Pick<BoardDuty, 'name' | 'place' | 'note' | 'sort_order'>): DutyFormValues {
  return { name: d.name, place: d.place ?? '', note: d.note ?? '', sortOrder: String(d.sort_order) };
}

/** 任意の文字（前後の空白を除き、空なら null。max 字まで） */
const optionalChars = (max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .refine((s) => s === null || charCount(s) <= max, { message });

const dutySchema = z.object({
  name: z
    .string()
    .trim()
    .refine((s) => s.length > 0, { message: SHIFT_FORM_MESSAGES.nameRequired })
    .refine((s) => charCount(s) <= DUTY_NAME_MAX, { message: SHIFT_FORM_MESSAGES.nameTooLong }),
  place: optionalChars(DUTY_PLACE_MAX, SHIFT_FORM_MESSAGES.placeTooLong),
  note: optionalChars(DUTY_NOTE_MAX, SHIFT_FORM_MESSAGES.noteTooLong),
  sortOrder: z
    .string()
    .trim()
    .regex(/^-?\d+$/u, { message: SHIFT_FORM_MESSAGES.orderInvalid })
    .transform(Number)
    .pipe(z.number().int().min(-DUTY_SORT_ORDER_MAX, { message: SHIFT_FORM_MESSAGES.orderRange }).max(DUTY_SORT_ORDER_MAX, { message: SHIFT_FORM_MESSAGES.orderRange })),
});

/** 持ち場の送る前の確かめ（通れば送る値、通らなければ欄ごとの最初の誤り） */
export function checkDutyForm(v: DutyFormValues): { ok: true; write: DutyWrite } | { ok: false; errors: DutyFormErrors } {
  const r = dutySchema.safeParse(v);
  if (!r.success) {
    const errors: DutyFormErrors = {};
    for (const issue of r.error.issues) {
      const key = issue.path[0] as keyof DutyFormValues | undefined;
      if (key && !(key in errors)) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, write: { name: r.data.name, place: r.data.place, note: r.data.note, sort_order: r.data.sortOrder } };
}

/** 読み直した持ち場が送った値と同じか（名前・場所・説明〔null と空をそろえる〕・並び順） */
export function sameDutyWrite(d: Pick<BoardDuty, 'name' | 'place' | 'note' | 'sort_order'>, w: DutyWrite): boolean {
  return d.name === w.name && (d.place || null) === (w.place || null) && (d.note || null) === (w.note || null) && d.sort_order === w.sort_order;
}

// ---------------------------------------------------------------- 時間枠

/** 時間枠のダイアログの入力 */
export interface SlotFormValues {
  /** 日付（`YYYY-MM-DD`。Asia/Tokyo） */
  date: string;
  /** 始まり（`HH:mm`） */
  start: string;
  /** 終わり（`HH:mm`。始まり以前なら翌日） */
  end: string;
}

/** 時間枠の送る値（`+09:00` の ISO 文字列） */
export type SlotWrite = PlannedSlot;

export type SlotFormErrors = Partial<Record<keyof SlotFormValues, string>>;

/** 時間枠を直すときの入力（今の値。日付は開始の Asia/Tokyo の日付） */
export function slotFormValuesOf(s: Pick<BoardSlot, 'starts_at' | 'ends_at'>): SlotFormValues {
  return { date: tokyoDate(s.starts_at), start: formatTime(s.starts_at), end: formatTime(s.ends_at) };
}

/** 終わりが翌日になるか（始まり・終わりが読めて、終わりが始まり以前） */
export function isNextDayEnd(v: Pick<SlotFormValues, 'start' | 'end'>): boolean {
  const s = minutesOf(v.start);
  const e = minutesOf(v.end);
  return s !== null && e !== null && e <= s;
}

/** 時間枠の送る前の確かめ（終わりが始まり以前なら翌日の時刻。開始・終わりの日付は 2000-01-01〜2200-12-31） */
export function checkSlotForm(v: SlotFormValues): { ok: true; write: SlotWrite; nextDay: boolean } | { ok: false; errors: SlotFormErrors } {
  const errors: SlotFormErrors = {};
  const date = v.date.trim();
  if (date === '') errors.date = SHIFT_FORM_MESSAGES.dateRequired;
  else if (!isCalendarDate(date) || !inRange(date)) errors.date = SHIFT_FORM_MESSAGES.outOfRange;
  const s = minutesOf(v.start.trim());
  const e = minutesOf(v.end.trim());
  if (s === null) errors.start = SHIFT_FORM_MESSAGES.startRequired;
  if (e === null) errors.end = SHIFT_FORM_MESSAGES.endRequired;
  if (Object.keys(errors).length > 0 || s === null || e === null) return { ok: false, errors };
  const nextDay = e <= s;
  const endDate = nextDay ? addDays(date, 1) : date;
  if (!inRange(endDate)) return { ok: false, errors: { end: SHIFT_FORM_MESSAGES.outOfRange } };
  return { ok: true, write: { starts_at: tokyoIsoAt(date, s), ends_at: tokyoIsoAt(endDate, e) }, nextDay };
}

// ---------------------------------------------------------------- 1日分をまとめて作る

/** 1日分のダイアログの持ち場ごとの入力 */
export interface DayNeedValue {
  /** 置く（既定は全部） */
  on: boolean;
  /** 必要人数（0〜100。既定 1） */
  count: number;
}

/** 1日分のダイアログの入力 */
export interface DayFormValues {
  date: string;
  start: string;
  /** `HH:mm` か `24:00` */
  end: string;
  /** 区切り（分） */
  step: number;
  /** 持ち場の id → 置く・必要人数 */
  needs: Record<string, DayNeedValue>;
}

export type DayFormErrors = Partial<Record<'date' | 'start' | 'end' | 'step' | 'needs', string>>;

/** 1日分の既定（日付は開いている日、始まり 09:00・終わり 17:00・区切り 60 分、持ち場は全部を置いて必要人数 1） */
export function emptyDayForm(date: string, duties: readonly Pick<BoardDuty, 'id'>[]): DayFormValues {
  return { date, start: '09:00', end: '17:00', step: 60, needs: Object.fromEntries(duties.map((d) => [d.id, { on: true, count: 1 }])) };
}

/** 1日分の送る値（add_shift_slots の p_slots・p_needs） */
export interface DayWrite {
  slots: PlannedSlot[];
  needs: { duty_id: string; required_count: number }[];
}

/**
 * 1日分の送る前の確かめ（並ぶ時間枠は slotsOfDayPlan。1〜96 個）。needs は置く持ち場だけを、持ち場の並び（duties の順）で送る。
 */
export function checkDayForm(v: DayFormValues, duties: readonly Pick<BoardDuty, 'id'>[]): { ok: true; write: DayWrite } | { ok: false; errors: DayFormErrors } {
  const errors: DayFormErrors = {};
  const date = v.date.trim();
  if (date === '') errors.date = SHIFT_FORM_MESSAGES.dateRequired;
  else if (!isCalendarDate(date) || !inRange(date)) errors.date = SHIFT_FORM_MESSAGES.outOfRange;
  if (minutesOf(v.start) === null) errors.start = SHIFT_FORM_MESSAGES.startRequired;
  if (minutesOf(v.end, true) === null) errors.end = SHIFT_FORM_MESSAGES.endRequired;
  if (!(SLOT_STEPS as readonly number[]).includes(v.step)) errors.step = SHIFT_FORM_MESSAGES.stepInvalid;
  const needs: DayWrite['needs'] = [];
  for (const d of duties) {
    const n = v.needs[d.id];
    if (!n?.on) continue;
    if (!Number.isInteger(n.count) || n.count < 0 || n.count > NEED_MAX) errors.needs ??= SHIFT_FORM_MESSAGES.needRange;
    needs.push({ duty_id: d.id, required_count: n.count });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const plan = slotsOfDayPlan({ date, start: v.start, end: v.end, stepMinutes: v.step });
  if (!plan.ok) {
    if (plan.reason === 'too_many') return { ok: false, errors: { end: SHIFT_FORM_MESSAGES.tooMany } };
    if (plan.reason === 'order') return { ok: false, errors: { end: SHIFT_FORM_MESSAGES.endBefore } };
    return { ok: false, errors: { date: SHIFT_FORM_MESSAGES.outOfRange } };
  }
  return { ok: true, write: { slots: plan.slots, needs } };
}

/** 1日分の始まりの選択肢（00:00〜23:45。15 分ごと） */
export const DAY_START_TIMES: readonly string[] = Array.from({ length: 96 }, (_, k) => tokyoIsoAt('2000-01-01', k * 15).slice(11, 16));
/** 1日分の終わりの選択肢（00:15〜24:00。15 分ごと） */
export const DAY_END_TIMES: readonly string[] = [...DAY_START_TIMES.slice(1), '24:00'];

// ---------------------------------------------------------------- ます

/** 必要人数が 0〜100 の整数か */
export function isNeedCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= NEED_MAX;
}
