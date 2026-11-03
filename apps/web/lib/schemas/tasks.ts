// 作業のダイアログの入力（04「作業一覧」の欄と送る前の確かめ、notes/T20.md「画面の約束」7・8。T20・D-56）。
// DB（0017 の tasks の CHECK）と同じ形にしてから送る（書き込みは RPC を通らない直接の insert・update なので、DB は除かずに拒む）：
// - 題名は zod の trim（JavaScript の String.prototype.trim。DB の CHECK と同じ 25 文字）の後に 1〜100 字。説明は前後の空白を除き、空なら
//   null、2000 字まで。字数は文字（Unicode のコードポイント）。
// - 担当者はその年度の総務の user_id か null（「担当者なし」）。総務かは DB のトリガーが確かめる（not_soumu）。
// - 締切は日付が空なら null（時刻だけは誤り）。日付があれば時刻の既定は 17:00。`YYYY-MM-DDTHH:mm:00+09:00` で送る（Asia/Tokyo）。
//   日付は 2000-01-01〜2200-12-31（tasks_due_at_check）。
import { z } from 'zod';
import { formatTime, tokyoDate } from '@/lib/datetime';
import type { TaskRow } from '@/lib/modules/shifts/reads';
import { charCount } from './notice-fields';

/** 題名の上限（tasks_title_check の `length(title) <= 100`） */
export const TASK_TITLE_MAX = 100;
/** 説明の上限（tasks_note_check の `length(note) <= 2000`） */
export const TASK_NOTE_MAX = 2000;
/** 締切の日付の範囲（tasks_due_at_check。Asia/Tokyo の日付） */
export const TASK_DATE_MIN = '2000-01-01';
export const TASK_DATE_MAX = '2200-12-31';
/** 締切の時刻の既定 */
export const TASK_DEFAULT_TIME = '17:00';

/** 欄の誤りの文言（04「作業一覧」の送る前の確かめ） */
export const TASK_FORM_MESSAGES = {
  titleRequired: '題名を入れてください',
  titleTooLong: `題名は ${TASK_TITLE_MAX} 字までです`,
  noteTooLong: `説明は ${TASK_NOTE_MAX} 字までです`,
  dueDateRequired: '締切の日付を入れてください',
  outOfRange: '2000年1月1日〜2200年12月31日の日付にしてください',
  dueTimeInvalid: '締切の時刻を「17:00」の形で入れてください',
  assigneeInvalid: '担当者を選び直してください',
} as const;

/** ダイアログの入力の値 */
export interface TaskFormValues {
  title: string;
  note: string;
  /** 担当者の user_id（空文字は「担当者なし」） */
  assigneeId: string;
  /** 締切の日付（`YYYY-MM-DD`。空なら締切なし） */
  dueDate: string;
  /** 締切の時刻（`HH:mm`。日付があって空なら 17:00） */
  dueTime: string;
}

/** 送る値（書いた人・直した人・日時・状態・id・year_id は入れない。状態は状態のボタンだけ） */
export interface TaskWrite {
  title: string;
  note: string | null;
  assignee_id: string | null;
  due_at: string | null;
}

export type TaskFormErrors = Partial<Record<keyof TaskFormValues, string>>;

/** 新しく作るときの入力（担当者なし・締切なし） */
export const EMPTY_TASK_FORM: Readonly<TaskFormValues> = Object.freeze({ title: '', note: '', assigneeId: '', dueDate: '', dueTime: '' });

/** 編集で開くときの値（その作業の今の値。締切は Asia/Tokyo の日付と時刻） */
export function taskFormValuesOf(t: Pick<TaskRow, 'title' | 'note' | 'assignee_id' | 'due_at'>): TaskFormValues {
  return {
    title: t.title,
    note: t.note ?? '',
    assigneeId: t.assignee_id ?? '',
    dueDate: t.due_at ? tokyoDate(t.due_at) : '',
    dueTime: t.due_at ? formatTime(t.due_at) : '',
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isCalendarDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const textSchema = z.object({
  title: z
    .string()
    .trim()
    .refine((s) => s.length > 0, { message: TASK_FORM_MESSAGES.titleRequired })
    .refine((s) => charCount(s) <= TASK_TITLE_MAX, { message: TASK_FORM_MESSAGES.titleTooLong }),
  note: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .refine((s) => s === null || charCount(s) <= TASK_NOTE_MAX, { message: TASK_FORM_MESSAGES.noteTooLong }),
  assigneeId: z.union([z.literal(''), z.uuid({ message: TASK_FORM_MESSAGES.assigneeInvalid })]).transform((s) => (s === '' ? null : s)),
});

/**
 * 送る前の確かめ（04 の文言）。通れば送る値（TaskWrite）、通らなければ欄ごとの最初の誤り。
 *
 * @example
 * const r = checkTaskForm(values);
 * if (!r.ok) setErrors(r.errors);
 */
export function checkTaskForm(v: TaskFormValues): { ok: true; write: TaskWrite } | { ok: false; errors: TaskFormErrors } {
  const errors: TaskFormErrors = {};
  const text = textSchema.safeParse({ title: v.title, note: v.note, assigneeId: v.assigneeId });
  if (!text.success) {
    for (const issue of text.error.issues) {
      const key = issue.path[0];
      if ((key === 'title' || key === 'note' || key === 'assigneeId') && !(key in errors)) errors[key] = issue.message;
    }
  }
  const date = v.dueDate.trim();
  const time = v.dueTime.trim();
  let dueAt: string | null = null;
  if (date === '') {
    if (time !== '') errors.dueDate = TASK_FORM_MESSAGES.dueDateRequired;
  } else if (!isCalendarDate(date) || date < TASK_DATE_MIN || date > TASK_DATE_MAX) {
    errors.dueDate = TASK_FORM_MESSAGES.outOfRange;
  } else {
    const t = time === '' ? TASK_DEFAULT_TIME : time;
    if (!HHMM.test(t)) errors.dueTime = TASK_FORM_MESSAGES.dueTimeInvalid;
    else dueAt = `${date}T${t}:00+09:00`;
  }
  if (!text.success || Object.keys(errors).length > 0) {
    if (Object.keys(errors).length === 0) errors.title = '入力の形が違います';
    return { ok: false, errors };
  }
  return { ok: true, write: { title: text.data.title, note: text.data.note, assignee_id: text.data.assigneeId, due_at: dueAt } };
}

/** 同じ時刻か（DB は UTC で返すので、文字列でなく Date.parse で比べる。どちらも null なら同じ） */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && ta === tb;
}

/**
 * 読み直した作業が送った値と同じか（題名・説明〔null と空をそろえる〕・担当者は同じ値、締切は同じ時刻）。(B1) の「保存されていました」
 * 「作られていました」と、編集で何も変えていないかの判定に使う。
 */
export function sameTaskWrite(row: Pick<TaskRow, 'title' | 'note' | 'assignee_id' | 'due_at'>, w: TaskWrite): boolean {
  return row.title === w.title && (row.note || null) === (w.note || null) && row.assignee_id === w.assignee_id && sameInstant(row.due_at, w.due_at);
}
