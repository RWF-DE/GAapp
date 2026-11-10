// 提出物の入力（04「提出状況」の提出物の設定の登録・編集のダイアログと、セルのシートの承認・差し戻し・紙での承認のダイアログ、notes/T19.md
// 「パート B・C の約束」5。T19・D-55）。DB（0016 の documents の CHECK と RPC の確かめ）と同じ形にしてから送る（提出物は RPC を通らない
// 直接の insert・update なので、DB は除かずに拒む）：
// - 題名は zod の trim（JavaScript の String.prototype.trim。DB の CHECK と同じ 25 文字）の後に 1〜100 字。
// - 説明は前後の空白を除き、空なら null、2000 字まで（D-33）。
// - 締切は日付（2000-01-01〜2200-12-31）と時刻（HH:mm。既定 17:00）を Asia/Tokyo として読み、`YYYY-MM-DDTHH:mm:00+09:00` で送る。
// - 出す団体の区分は1つ以上（DB が重なりを除いて並べる）。
// - 提出先の URL（T24。D-62）は前後の空白を除き、空なら null。`https://` で始まり、空白・制御文字を含まない 500 字まで（DB の
//   documents_submit_url_check と同じ形。lib/modules/documents/submit-url.ts）。「ファイルが要る」は T24 でやめた（送らない。DB がいつも false）。
// - 差し戻しの理由は必須で 1〜1000 字、承認のメモは任意（空なら null）、紙での承認のメモは必須（どれも前後の空白を除く）。
// - 字数は文字（Unicode のコードポイント。lib/schemas/notice-fields.ts の charCount）で数え、DB の length と同じにする。
import { Constants, type GroupCategory } from '@gaapp/shared';
import { z } from 'zod';
import type { DocumentRow, DocumentWrite } from '@/lib/data/documents';
import { formatTime, tokyoDate } from '@/lib/datetime';
import { isSubmitUrl, SUBMIT_URL_MAX } from '@/lib/modules/documents/submit-url';
import { REVIEW_NOTE_MAX, REVIEW_NOTE_MESSAGES, reviewNoteSchema } from './document-fields';
import { charCount } from './notice-fields';

// 差し戻しの理由（RPC_ARGS と同じもの）は小さなファイル（document-fields.ts）に置き、ここから同じ名前で出し直す
export { normalizeReviewNote, REVIEW_NOTE_MAX, REVIEW_NOTE_MESSAGES, reviewNoteSchema } from './document-fields';

/** 題名の上限（documents_title_check の `length(title) <= 100`） */
export const DOCUMENT_TITLE_MAX = 100;
/** 説明の上限（documents_description_check の `length(description) <= 2000`） */
export const DOCUMENT_DESCRIPTION_MAX = 2000;
/** 締切の日付の範囲（documents_deadline_check。Asia/Tokyo の日付。年度の1日目と同じ範囲。D-18） */
export const DOCUMENT_DATE_MIN = '2000-01-01';
export const DOCUMENT_DATE_MAX = '2200-12-31';
/** 締切の時刻の既定 */
export const DEFAULT_DEADLINE_TIME = '17:00';
/** 提出先の URL の上限（documents_submit_url_check。T24） */
export const DOCUMENT_SUBMIT_URL_MAX = SUBMIT_URL_MAX;

/** 欄の誤りの文言（04「提出状況」の提出物の設定の送る前の確かめ） */
export const DOCUMENT_FORM_MESSAGES = {
  titleRequired: '題名を入れてください',
  titleTooLong: `題名は ${DOCUMENT_TITLE_MAX} 字までです`,
  descriptionTooLong: `説明は ${DOCUMENT_DESCRIPTION_MAX} 字までです`,
  dateRequired: '締切の日付を入れてください',
  timeRequired: '締切の時刻を入れてください',
  outOfRange: '2000年1月1日〜2200年12月31日の日付にしてください',
  categoryRequired: '出す団体の区分を1つ以上選んでください',
  submitUrlInvalid: '提出先の URL は https:// で始まる形で入れてください（空白は入れられません）',
  submitUrlTooLong: `提出先の URL は ${SUBMIT_URL_MAX} 字までです`,
} as const;

/** 登録・編集のダイアログの入力の値 */
export interface DocumentFormValues {
  title: string;
  description: string;
  /** 締切の日付（`YYYY-MM-DD`。Asia/Tokyo） */
  deadlineDate: string;
  /** 締切の時刻（`HH:mm`。Asia/Tokyo） */
  deadlineTime: string;
  /** 出す団体の区分 */
  categories: GroupCategory[];
  /** 飲食の団体だけ（Q8） */
  foodOnly: boolean;
  /** 提出先の URL（T24。共有ドライブのフォルダ・Google フォームなど。空なら提出先なし） */
  submitUrl: string;
}

/** 欄ごとの誤り */
export type DocumentFormErrors = Partial<Record<'title' | 'description' | 'deadlineDate' | 'deadlineTime' | 'categories' | 'submitUrl', string>>;

/** 新しく登録するときの入力（時刻は 17:00、飲食の団体だけは外す。区分は選ばない。提出先の URL は空） */
export const EMPTY_DOCUMENT_FORM: Readonly<DocumentFormValues> = Object.freeze({
  title: '',
  description: '',
  deadlineDate: '',
  deadlineTime: DEFAULT_DEADLINE_TIME,
  categories: [],
  foodOnly: false,
  submitUrl: '',
});

/** 編集で開くときの値（その提出物の今の値。締切は Asia/Tokyo の日付と時刻、説明・提出先の URL が null なら空） */
export function documentFormValuesOf(
  row: Pick<DocumentRow, 'title' | 'description' | 'deadline' | 'target_categories' | 'food_only' | 'submit_url'>,
): DocumentFormValues {
  return {
    title: row.title,
    description: row.description ?? '',
    deadlineDate: tokyoDate(row.deadline),
    deadlineTime: formatTime(row.deadline),
    categories: [...row.target_categories],
    foodOnly: row.food_only,
    submitUrl: row.submit_url ?? '',
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 暦にある日付か（`YYYY-MM-DD`。2026-02-30 などは偽） */
function isCalendarDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const CATEGORIES: readonly GroupCategory[] = Constants.public.Enums.group_category;

/** 題名（前後の空白を除いた後で 1〜100 字） */
export const documentTitleSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: DOCUMENT_FORM_MESSAGES.titleRequired })
  .refine((s) => charCount(s) <= DOCUMENT_TITLE_MAX, { message: DOCUMENT_FORM_MESSAGES.titleTooLong });

/** 説明（前後の空白を除き、空なら null。2000 字まで） */
export const documentDescriptionSchema = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s))
  .refine((s) => s === null || charCount(s) <= DOCUMENT_DESCRIPTION_MAX, { message: DOCUMENT_FORM_MESSAGES.descriptionTooLong });

/** 出す団体の区分（1つ以上。知らない値は除く。列挙の順にそろえる） */
export const documentCategoriesSchema = z
  .array(z.string())
  .transform((cs) => CATEGORIES.filter((c) => cs.includes(c)))
  .refine((cs) => cs.length > 0, { message: DOCUMENT_FORM_MESSAGES.categoryRequired });

/** 提出先の URL（T24。前後の空白を除き、空なら null。https・空白と制御文字なし・500 字まで） */
export const documentSubmitUrlSchema = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s))
  .refine((s) => s === null || [...s].length <= SUBMIT_URL_MAX, { message: DOCUMENT_FORM_MESSAGES.submitUrlTooLong })
  .refine((s) => s === null || [...s].length > SUBMIT_URL_MAX || isSubmitUrl(s), { message: DOCUMENT_FORM_MESSAGES.submitUrlInvalid });

/** 締切（`YYYY-MM-DDTHH:mm:00+09:00`）。日付・時刻が合わなければ欄ごとの誤り */
function checkDeadline(date: string, time: string): { ok: true; deadline: string } | { ok: false; errors: DocumentFormErrors } {
  const d = date.trim();
  const t = time.trim();
  const errors: DocumentFormErrors = {};
  if (d === '') errors.deadlineDate = DOCUMENT_FORM_MESSAGES.dateRequired;
  else if (!isCalendarDate(d) || d < DOCUMENT_DATE_MIN || d > DOCUMENT_DATE_MAX) errors.deadlineDate = DOCUMENT_FORM_MESSAGES.outOfRange;
  if (t === '' || !TIME.test(t)) errors.deadlineTime = DOCUMENT_FORM_MESSAGES.timeRequired;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, deadline: `${d}T${t}:00+09:00` };
}

/**
 * 送る前の確かめ（04 の文言）。通れば送る値（DocumentWrite）、通らなければ欄ごとの最初の誤り。
 *
 * @example
 * const r = checkDocumentForm(values);
 * if (!r.ok) setErrors(r.errors);
 */
export function checkDocumentForm(v: DocumentFormValues): { ok: true; write: DocumentWrite } | { ok: false; errors: DocumentFormErrors } {
  const errors: DocumentFormErrors = {};
  const title = documentTitleSchema.safeParse(v.title);
  if (!title.success) errors.title = title.error.issues[0]?.message ?? DOCUMENT_FORM_MESSAGES.titleRequired;
  const description = documentDescriptionSchema.safeParse(v.description);
  if (!description.success) errors.description = description.error.issues[0]?.message ?? DOCUMENT_FORM_MESSAGES.descriptionTooLong;
  const categories = documentCategoriesSchema.safeParse(v.categories);
  if (!categories.success) errors.categories = DOCUMENT_FORM_MESSAGES.categoryRequired;
  const deadline = checkDeadline(v.deadlineDate, v.deadlineTime);
  if (!deadline.ok) Object.assign(errors, deadline.errors);
  const submitUrl = documentSubmitUrlSchema.safeParse(v.submitUrl);
  if (!submitUrl.success) errors.submitUrl = submitUrl.error.issues[0]?.message ?? DOCUMENT_FORM_MESSAGES.submitUrlInvalid;
  if (!title.success || !description.success || !categories.success || !deadline.ok || !submitUrl.success) return { ok: false, errors };
  return {
    ok: true,
    write: {
      title: title.data,
      description: description.data,
      deadline: deadline.deadline,
      target_categories: categories.data,
      food_only: v.foodOnly,
      submit_url: submitUrl.data,
    },
  };
}

/** 送る値にする（確かめに通らなければ null。テストと、下書きから戻したときの比べに使う） */
export function toDocumentWrite(v: DocumentFormValues): DocumentWrite | null {
  const r = checkDocumentForm(v);
  return r.ok ? r.write : null;
}

/**
 * 登録・編集のダイアログの入力の zod（react-hook-form の resolver などで使う形。誤りの path は欄の名前、文言と送る値は checkDocumentForm
 * と同じ）。出力は送る値（DocumentWrite）。
 */
export const documentFormSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    deadlineDate: z.string(),
    deadlineTime: z.string(),
    categories: z.array(z.string()),
    foodOnly: z.boolean(),
    submitUrl: z.string(),
  })
  .transform((v, ctx): DocumentWrite => {
    const r = checkDocumentForm({ ...v, categories: v.categories as GroupCategory[] });
    if (r.ok) return r.write;
    for (const [path, message] of Object.entries(r.errors)) ctx.addIssue({ code: 'custom', path: [path], message });
    return z.NEVER;
  });

/** 承認のメモ（任意。前後の空白を除き、空なら null。1000 字まで） */
export const approveNoteSchema = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s))
  .refine((s) => s === null || charCount(s) <= REVIEW_NOTE_MAX, { message: REVIEW_NOTE_MESSAGES.noteTooLong });

/** 紙などで受け取った承認のメモ（必須。前後の空白を除いて 1〜1000 字。例「10/3 に紙で受け取りました」） */
export const paperNoteSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: REVIEW_NOTE_MESSAGES.paperRequired })
  .refine((s) => charCount(s) <= REVIEW_NOTE_MAX, { message: REVIEW_NOTE_MESSAGES.noteTooLong });

/** 理由・メモの入力の「{n}/1000」の n（前後の空白を除かない今の字数。コードポイント） */
export function noteLength(s: string): number {
  return charCount(s);
}

/** 差し戻しの理由の確かめ（ダイアログ。通れば送る値、通らなければ文言） */
export function checkReturnNote(note: string): { ok: true; note: string } | { ok: false; message: string } {
  const r = reviewNoteSchema.safeParse(note);
  return r.success ? { ok: true, note: r.data } : { ok: false, message: r.error.issues[0]?.message ?? REVIEW_NOTE_MESSAGES.returnRequired };
}
