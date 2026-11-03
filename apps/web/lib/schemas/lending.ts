// テント等の貸し出しの入力（T21・D-57。04「テント等の貸し出し」の欄と送る前の確かめ、notes/T21.md「画面の約束」4〜6）。
// DB（0018 の CHECK）と同じ形にしてから送る（備品・申請・記録は RPC を通らない直接の書き込みなので、DB は除かずに拒む）：
// - 備品の名前は zod の trim（JavaScript の String.prototype.trim。DB の CHECK と同じ 25 文字）の後に 1〜100 字、単位は 1〜10 字。
//   字数は文字（Unicode のコードポイント。charCount）で数え、DB の length と同じにする。
// - 数（在庫・申請・割り当て・渡した・返った・破損）は 0〜10000 の整数。うち破損 ≤ 返った ≤ 渡した（lending_records_counts_check）。
// - 記録のメモは前後の空白を除き、空なら null、2000 字まで。
import { GROUP_CATEGORIES, MAX_COUNT, type GroupCategory } from '@gaapp/shared';
import { z } from 'zod';
import { DEFAULT_LENDING_UNIT, DEFAULT_REQUESTABLE_CATEGORIES } from '@/lib/modules/lending/labels';
import { charCount } from './notice-fields';

/** 名前の上限（lending_items_name_check） */
export const LENDING_ITEM_NAME_MAX = 100;
/** 単位の上限（lending_items_unit_check） */
export const LENDING_UNIT_MAX = 10;
/** 記録のメモの上限（lending_records_note_check） */
export const LENDING_NOTE_MAX = 2000;
/** 数の上限（0〜10000。DB の CHECK と同じ） */
export const LENDING_COUNT_MAX = MAX_COUNT;
/** 並びの範囲（integer。画面では ±1,000,000 まで。マスタ設定の並び順と同じ） */
export const LENDING_SORT_ORDER_MAX = 1_000_000;
/** 申請できる区分の上限（lending_items_categories_check。区分は4つ） */
export const LENDING_CATEGORIES_MAX = GROUP_CATEGORIES.length;

/** 欄の誤りの文言 */
export const LENDING_FORM_MESSAGES = {
  nameRequired: '名前を入れてください',
  nameTooLong: `名前は ${LENDING_ITEM_NAME_MAX} 字までです`,
  unitRequired: '単位を入れてください',
  unitTooLong: `単位は ${LENDING_UNIT_MAX} 字までです`,
  stock: `在庫は 0〜${LENDING_COUNT_MAX} の整数で入れてください`,
  sortOrder: `並びは -${LENDING_SORT_ORDER_MAX}〜${LENDING_SORT_ORDER_MAX} の整数で入れてください`,
  count: `0〜${LENDING_COUNT_MAX} の整数にしてください`,
  returnedOverLent: '返った数は渡した数以下にしてください',
  damagedOverReturned: '破損の数は返った数以下にしてください',
  noteTooLong: `メモは ${LENDING_NOTE_MAX} 字までです`,
} as const;

/** 数（0〜10000 の整数） */
export const lendingCountSchema = z.number().int().min(0).max(LENDING_COUNT_MAX);

/** 整数の文字（全角の数字も受ける）を数にする。空・形が違えば null */
export function parseIntText(text: string): number | null {
  const t = text.normalize('NFKC').trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------- 備品

/** 備品のダイアログの入力（数は文字のまま持ち、送る前に確かめる） */
export interface LendingItemFormValues {
  name: string;
  unit: string;
  stock: string;
  categories: GroupCategory[];
  sortOrder: string;
}

/** 欄ごとの誤り */
export type LendingItemFormErrors = Partial<Record<'name' | 'unit' | 'stock' | 'sortOrder', string>>;

/** 送る値（id・year_id は画面が入れる） */
export interface LendingItemWrite {
  name: string;
  unit: string;
  stock: number;
  requestable_categories: GroupCategory[];
  sort_order: number;
}

/** 登録のときの入力（単位は「個」、在庫は 0、区分は模擬店・部門、並びは今の最大＋1） */
export function emptyLendingItemForm(nextSortOrder: number): LendingItemFormValues {
  return { name: '', unit: DEFAULT_LENDING_UNIT, stock: '0', categories: [...DEFAULT_REQUESTABLE_CATEGORIES], sortOrder: String(nextSortOrder) };
}

/** 編集で開くときの値（その備品の今の値） */
export function lendingItemFormValuesOf(row: Pick<LendingItemWrite, 'name' | 'unit' | 'stock' | 'requestable_categories' | 'sort_order'>): LendingItemFormValues {
  return {
    name: row.name,
    unit: row.unit,
    stock: String(row.stock),
    categories: normalizeCategories(row.requestable_categories),
    sortOrder: String(row.sort_order),
  };
}

/** 区分を列挙の順にそろえ、重なりと知らない値を除く */
export function normalizeCategories(cs: readonly string[]): GroupCategory[] {
  const set = new Set(cs);
  return GROUP_CATEGORIES.filter((c) => set.has(c));
}

const itemNameSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: LENDING_FORM_MESSAGES.nameRequired })
  .refine((s) => charCount(s) <= LENDING_ITEM_NAME_MAX, { message: LENDING_FORM_MESSAGES.nameTooLong });
const unitSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: LENDING_FORM_MESSAGES.unitRequired })
  .refine((s) => charCount(s) <= LENDING_UNIT_MAX, { message: LENDING_FORM_MESSAGES.unitTooLong });

/**
 * 備品のダイアログの確かめ（送る値か、欄ごとの誤り）。名前・単位は trim の後に字数、在庫は 0〜10000 の整数、並びは ±1,000,000 の整数。
 * 申請できる区分は 0 個もよい（申請させない備品）。
 */
export function checkLendingItemForm(v: LendingItemFormValues): { ok: true; write: LendingItemWrite } | { ok: false; errors: LendingItemFormErrors } {
  const errors: LendingItemFormErrors = {};
  const name = itemNameSchema.safeParse(v.name);
  if (!name.success) errors.name = name.error.issues[0]?.message ?? LENDING_FORM_MESSAGES.nameRequired;
  const unit = unitSchema.safeParse(v.unit);
  if (!unit.success) errors.unit = unit.error.issues[0]?.message ?? LENDING_FORM_MESSAGES.unitRequired;
  const stock = parseIntText(v.stock);
  if (stock === null || !lendingCountSchema.safeParse(stock).success) errors.stock = LENDING_FORM_MESSAGES.stock;
  const order = parseIntText(v.sortOrder);
  if (order === null || Math.abs(order) > LENDING_SORT_ORDER_MAX) errors.sortOrder = LENDING_FORM_MESSAGES.sortOrder;
  if (Object.keys(errors).length > 0 || !name.success || !unit.success || stock === null || order === null) return { ok: false, errors };
  return {
    ok: true,
    write: { name: name.data, unit: unit.data, stock, requestable_categories: normalizeCategories(v.categories), sort_order: order },
  };
}

/** 2つの書き込みが同じか（(B1) の「登録されていました」「保存されていました」と、変更がないかの判定） */
export function sameLendingItemWrite(a: LendingItemWrite, b: LendingItemWrite): boolean {
  return (
    a.name === b.name &&
    a.unit === b.unit &&
    a.stock === b.stock &&
    a.sort_order === b.sort_order &&
    normalizeCategories(a.requestable_categories).join(',') === normalizeCategories(b.requestable_categories).join(',')
  );
}

// ---------------------------------------------------------------- 受け渡し・返却の記録

/** 1つの備品の記録の入力 */
export interface LendingRecordValues {
  lent: number;
  returned: number;
  damaged: number;
  /** メモ（入力のまま。送るときに前後の空白を除き、空なら null） */
  note: string;
}

export type LendingRecordErrors = Partial<Record<'lent' | 'returned' | 'damaged' | 'note', string>>;

/** 記録の入力の確かめ（0〜10000 の整数、うち破損 ≤ 返った ≤ 渡した、メモは 2000 字まで）。誤りがなければ空 */
export function checkLendingRecord(v: LendingRecordValues): LendingRecordErrors {
  const e: LendingRecordErrors = {};
  for (const k of ['lent', 'returned', 'damaged'] as const) {
    if (!lendingCountSchema.safeParse(v[k]).success) e[k] = LENDING_FORM_MESSAGES.count;
  }
  if (!e.lent && !e.returned && v.returned > v.lent) e.returned = LENDING_FORM_MESSAGES.returnedOverLent;
  if (!e.returned && !e.damaged && v.damaged > v.returned) e.damaged = LENDING_FORM_MESSAGES.damagedOverReturned;
  if (charCount(v.note.trim()) > LENDING_NOTE_MAX) e.note = LENDING_FORM_MESSAGES.noteTooLong;
  return e;
}

/** 送るメモ（前後の空白を除き、空なら null。D-33） */
export function recordNoteOf(note: string | null | undefined): string | null {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
}

// ---------------------------------------------------------------- 割り当てのセル

/**
 * 割り当てのセルの文字を読む：空なら null（行を消して未入力に戻す）、0〜10000 の整数ならその数、ほかは undefined（誤り。入力を戻す）。
 */
export function parseAssignmentCell(text: string): number | null | undefined {
  if (text.normalize('NFKC').trim() === '') return null;
  const n = parseIntText(text);
  return n !== null && lendingCountSchema.safeParse(n).success ? n : undefined;
}
