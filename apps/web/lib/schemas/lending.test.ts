// テント等の貸し出しの入力（T21。notes/T21.md「画面の約束」4・5）：備品のダイアログ（名前・単位の trim と字数〔コードポイント〕、
// 在庫・並びの整数、区分の並びと重なり、既定）、記録（0〜10000、破損 ≤ 返った ≤ 渡した、メモ）、割り当てのセル。
import { describe, expect, it } from 'vitest';
import {
  checkLendingItemForm,
  checkLendingRecord,
  emptyLendingItemForm,
  LENDING_FORM_MESSAGES,
  lendingItemFormValuesOf,
  normalizeCategories,
  parseAssignmentCell,
  parseIntText,
  recordNoteOf,
  sameLendingItemWrite,
} from './lending';

const form = (over: Partial<ReturnType<typeof emptyLendingItemForm>> = {}) => ({ ...emptyLendingItemForm(3), name: 'テント', ...over });

describe('T21 備品のダイアログ', () => {
  it('既定：単位「個」・在庫 0・区分は模擬店と部門・並びは渡した数', () => {
    expect(emptyLendingItemForm(7)).toEqual({ name: '', unit: '個', stock: '0', categories: ['stall', 'department'], sortOrder: '7' });
  });

  it('名前・単位は前後の空白（全角の空白も）を除いて送る。区分は列挙の順で重なりを除く', () => {
    const r = checkLendingItemForm(form({ name: '\u3000 テント ', unit: ' 張 ', stock: '１２', categories: ['company', 'stall', 'company'], sortOrder: ' -2 ' }));
    expect(r).toEqual({ ok: true, write: { name: 'テント', unit: '張', stock: 12, requestable_categories: ['stall', 'company'], sort_order: -2 } });
    // 区分は 0 個もよい（申請させない備品）
    expect(checkLendingItemForm(form({ categories: [] }))).toMatchObject({ ok: true, write: { requestable_categories: [] } });
  });

  it('名前は 1〜100 字（コードポイント）、単位は 1〜10 字、在庫は 0〜10000 の整数、並びは ±1,000,000 の整数', () => {
    const errors = (v: Parameters<typeof form>[0]) => {
      const r = checkLendingItemForm(form(v));
      return r.ok ? {} : r.errors;
    };
    expect(errors({ name: '  ' })).toEqual({ name: LENDING_FORM_MESSAGES.nameRequired });
    expect(errors({ name: 'あ'.repeat(100) })).toEqual({});
    expect(errors({ name: 'あ'.repeat(101) })).toEqual({ name: LENDING_FORM_MESSAGES.nameTooLong });
    // 絵文字は 1 字（JavaScript の length では 2）
    expect(errors({ name: '😀'.repeat(100) })).toEqual({});
    expect(errors({ unit: '' })).toEqual({ unit: LENDING_FORM_MESSAGES.unitRequired });
    expect(errors({ unit: '1234567890' })).toEqual({});
    expect(errors({ unit: '12345678901' })).toEqual({ unit: LENDING_FORM_MESSAGES.unitTooLong });
    for (const stock of ['', '-1', '10001', '1.5', 'abc']) expect(errors({ stock }), stock).toEqual({ stock: LENDING_FORM_MESSAGES.stock });
    expect(errors({ stock: '10000' })).toEqual({});
    for (const sortOrder of ['', '1000001', 'x']) expect(errors({ sortOrder }), sortOrder).toEqual({ sortOrder: LENDING_FORM_MESSAGES.sortOrder });
  });

  it('編集で開くときの値と、同じ書き込みか（区分の並びによらない）', () => {
    const row = { name: 'テント', unit: '張', stock: 3, requestable_categories: ['department', 'stall'] as const, sort_order: 1 };
    expect(lendingItemFormValuesOf({ ...row, requestable_categories: [...row.requestable_categories] })).toEqual({
      name: 'テント',
      unit: '張',
      stock: '3',
      categories: ['stall', 'department'],
      sortOrder: '1',
    });
    const w = { ...row, requestable_categories: ['stall', 'department'] as ('stall' | 'department')[] };
    expect(sameLendingItemWrite(w, { ...w, requestable_categories: ['department', 'stall'] })).toBe(true);
    expect(sameLendingItemWrite(w, { ...w, stock: 4 })).toBe(false);
    expect(normalizeCategories(['rest_area', 'x', 'stall'])).toEqual(['stall', 'rest_area']);
  });
});

describe('T21 受け渡し・返却の記録', () => {
  it('うち破損 ≤ 返った ≤ 渡した（違えば欄の下の文言）。0〜10000 の整数', () => {
    expect(checkLendingRecord({ lent: 2, returned: 2, damaged: 1, note: '' })).toEqual({});
    expect(checkLendingRecord({ lent: 1, returned: 2, damaged: 0, note: '' })).toEqual({ returned: LENDING_FORM_MESSAGES.returnedOverLent });
    expect(checkLendingRecord({ lent: 2, returned: 1, damaged: 2, note: '' })).toEqual({ damaged: LENDING_FORM_MESSAGES.damagedOverReturned });
    expect(checkLendingRecord({ lent: 10001, returned: 0, damaged: 0, note: '' })).toEqual({ lent: LENDING_FORM_MESSAGES.count });
    expect(checkLendingRecord({ lent: 1.5, returned: 0, damaged: 0, note: '' })).toEqual({ lent: LENDING_FORM_MESSAGES.count });
  });

  it('メモは前後の空白を除いて 2000 字まで。空なら null で送る', () => {
    expect(checkLendingRecord({ lent: 1, returned: 1, damaged: 1, note: 'あ'.repeat(2000) })).toEqual({});
    expect(checkLendingRecord({ lent: 1, returned: 1, damaged: 1, note: 'あ'.repeat(2001) })).toEqual({ note: LENDING_FORM_MESSAGES.noteTooLong });
    expect(recordNoteOf('  ')).toBeNull();
    expect(recordNoteOf(null)).toBeNull();
    expect(recordNoteOf(' 破れ ')).toBe('破れ');
  });
});

describe('T21 割り当てのセルと整数の文字', () => {
  it('空は null（未入力に戻す）、0〜10000 の整数はその数（全角も）、ほかは undefined', () => {
    expect(parseAssignmentCell('')).toBeNull();
    expect(parseAssignmentCell(' ')).toBeNull();
    expect(parseAssignmentCell('0')).toBe(0);
    expect(parseAssignmentCell('３')).toBe(3);
    expect(parseAssignmentCell('10000')).toBe(10000);
    expect(parseAssignmentCell('10001')).toBeUndefined();
    expect(parseAssignmentCell('-1')).toBeUndefined();
    expect(parseAssignmentCell('1.0')).toBeUndefined();
    expect(parseIntText('99999999999999999999')).toBeNull();
  });
});
