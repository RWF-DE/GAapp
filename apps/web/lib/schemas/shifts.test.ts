// シフト表のダイアログの入力（04「シフト表」の欄と送る前の確かめ、notes/T20.md「画面の約束」8。T20）：持ち場の名前の trim（25 文字）・
// 字数（補助面の文字）・場所と説明の null・並び順、時間枠の翌日・範囲の端、1日分の区切り・持ち場ごとの必要人数・96 の上限。
import { describe, expect, it } from 'vitest';
import {
  checkDayForm,
  checkDutyForm,
  checkSlotForm,
  DAY_END_TIMES,
  DAY_START_TIMES,
  dutyFormValuesOf,
  emptyDayForm,
  emptyDutyForm,
  isNeedCount,
  isNextDayEnd,
  sameDutyWrite,
  SHIFT_FORM_MESSAGES,
  slotFormValuesOf,
} from './shifts';

const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';

describe('T20 持ち場（checkDutyForm）', () => {
  const v = (over: Partial<Parameters<typeof checkDutyForm>[0]> = {}) => ({ name: '受付', place: '', note: '', sortOrder: '0', ...over });

  it('名前は JavaScript の trim（DB の CHECK と同じ 25 文字）の後に 1〜50 字（字数はコードポイント）', () => {
    expect(checkDutyForm(v({ name: '　\t 受付  ﻿' }))).toEqual({ ok: true, write: { name: '受付', place: null, note: null, sort_order: 0 } });
    expect(checkDutyForm(v({ name: ' 　 ' }))).toEqual({ ok: false, errors: { name: SHIFT_FORM_MESSAGES.nameRequired } });
    expect(checkDutyForm(v({ name: '𠮷'.repeat(50) })).ok).toBe(true);
    expect(checkDutyForm(v({ name: '𠮷'.repeat(51) }))).toEqual({ ok: false, errors: { name: SHIFT_FORM_MESSAGES.nameTooLong } });
  });

  it('場所・説明は前後の空白を除き、空なら null、100 字・1000 字まで。並び順は ±1,000,000 の整数', () => {
    expect(checkDutyForm(v({ place: ' 正門 ', note: ' 台車\n2人 ', sortOrder: ' -3 ' }))).toEqual({
      ok: true,
      write: { name: '受付', place: '正門', note: '台車\n2人', sort_order: -3 },
    });
    expect(checkDutyForm(v({ place: 'あ'.repeat(101) }))).toEqual({ ok: false, errors: { place: SHIFT_FORM_MESSAGES.placeTooLong } });
    expect(checkDutyForm(v({ note: 'あ'.repeat(1001) }))).toEqual({ ok: false, errors: { note: SHIFT_FORM_MESSAGES.noteTooLong } });
    expect(checkDutyForm(v({ sortOrder: '1.5' }))).toEqual({ ok: false, errors: { sortOrder: SHIFT_FORM_MESSAGES.orderInvalid } });
    expect(checkDutyForm(v({ sortOrder: '1000001' }))).toEqual({ ok: false, errors: { sortOrder: SHIFT_FORM_MESSAGES.orderRange } });
  });

  it('既定の並び順は今の最大＋1（なければ 0）。直すときは今の値。読み直した行との比べ方', () => {
    expect(emptyDutyForm([]).sortOrder).toBe('0');
    expect(emptyDutyForm([{ sort_order: 3 }, { sort_order: 7 }]).sortOrder).toBe('8');
    expect(dutyFormValuesOf({ name: '受付', place: null, note: 'x', sort_order: 2 })).toEqual({ name: '受付', place: '', note: 'x', sortOrder: '2' });
    expect(sameDutyWrite({ name: '受付', place: '', note: null, sort_order: 1 }, { name: '受付', place: null, note: null, sort_order: 1 })).toBe(true);
    expect(sameDutyWrite({ name: '受付', place: null, note: null, sort_order: 1 }, { name: '受付', place: null, note: null, sort_order: 2 })).toBe(false);
  });
});

describe('T20 時間枠（checkSlotForm）', () => {
  it('送る値は `+09:00`。終わりが始まり以前なら翌日（同じ時刻はちょうど 24 時間）', () => {
    expect(checkSlotForm({ date: '2027-10-15', start: '09:00', end: '10:00' })).toEqual({
      ok: true,
      write: { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' },
      nextDay: false,
    });
    expect(checkSlotForm({ date: '2027-10-15', start: '23:00', end: '01:00' })).toEqual({
      ok: true,
      write: { starts_at: '2027-10-15T23:00:00+09:00', ends_at: '2027-10-16T01:00:00+09:00' },
      nextDay: true,
    });
    expect(checkSlotForm({ date: '2027-10-15', start: '09:00', end: '09:00' })).toMatchObject({ ok: true, nextDay: true });
    expect(isNextDayEnd({ start: '23:00', end: '01:00' })).toBe(true);
    expect(isNextDayEnd({ start: '09:00', end: '10:00' })).toBe(false);
  });

  it('日付は必須で 2000-01-01〜2200-12-31（暦にない日付も誤り）。2200-12-31 の翌日にかかる終わりも誤り。時刻は必須', () => {
    expect(checkSlotForm({ date: '', start: '09:00', end: '10:00' })).toEqual({ ok: false, errors: { date: SHIFT_FORM_MESSAGES.dateRequired } });
    expect(checkSlotForm({ date: '1999-12-31', start: '09:00', end: '10:00' })).toEqual({ ok: false, errors: { date: SHIFT_FORM_MESSAGES.outOfRange } });
    expect(checkSlotForm({ date: '2027-02-30', start: '09:00', end: '10:00' })).toEqual({ ok: false, errors: { date: SHIFT_FORM_MESSAGES.outOfRange } });
    expect(checkSlotForm({ date: '2000-01-01', start: '00:00', end: '01:00' }).ok).toBe(true);
    expect(checkSlotForm({ date: '2200-12-31', start: '22:00', end: '23:00' }).ok).toBe(true);
    expect(checkSlotForm({ date: '2200-12-31', start: '23:00', end: '01:00' })).toEqual({ ok: false, errors: { end: SHIFT_FORM_MESSAGES.outOfRange } });
    expect(checkSlotForm({ date: '2027-10-15', start: '', end: '' })).toEqual({
      ok: false,
      errors: { start: SHIFT_FORM_MESSAGES.startRequired, end: SHIFT_FORM_MESSAGES.endRequired },
    });
  });

  it('直すときの入力（開始の Asia/Tokyo の日付と時刻）', () => {
    expect(slotFormValuesOf({ starts_at: '2027-10-15T14:00:00Z', ends_at: '2027-10-15T16:00:00Z' })).toEqual({ date: '2027-10-15', start: '23:00', end: '01:00' });
  });
});

describe('T20 1日分（checkDayForm）', () => {
  const duties = [{ id: D1 }, { id: D2 }];

  it('既定：開いている日、09:00〜17:00、60 分、持ち場は全部を置いて必要人数 1', () => {
    expect(emptyDayForm('2027-10-15', duties)).toEqual({
      date: '2027-10-15',
      start: '09:00',
      end: '17:00',
      step: 60,
      needs: { [D1]: { on: true, count: 1 }, [D2]: { on: true, count: 1 } },
    });
  });

  it('時間枠と、置く持ち場だけのます（持ち場の並び）を送る', () => {
    const r = checkDayForm({ ...emptyDayForm('2027-10-15', duties), end: '11:00', needs: { [D1]: { on: true, count: 2 }, [D2]: { on: false, count: 1 } } }, duties);
    expect(r).toEqual({
      ok: true,
      write: {
        slots: [
          { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' },
          { starts_at: '2027-10-15T10:00:00+09:00', ends_at: '2027-10-15T11:00:00+09:00' },
        ],
        needs: [{ duty_id: D1, required_count: 2 }],
      },
    });
  });

  it('誤り：終わりが始まり以前・区切りの値・必要人数の範囲・日付', () => {
    const base = emptyDayForm('2027-10-15', duties);
    expect(checkDayForm({ ...base, start: '17:00', end: '09:00' }, duties)).toEqual({ ok: false, errors: { end: SHIFT_FORM_MESSAGES.endBefore } });
    expect(checkDayForm({ ...base, step: 45 }, duties)).toEqual({ ok: false, errors: { step: SHIFT_FORM_MESSAGES.stepInvalid } });
    expect(checkDayForm({ ...base, needs: { [D1]: { on: true, count: 101 } } }, duties)).toEqual({ ok: false, errors: { needs: SHIFT_FORM_MESSAGES.needRange } });
    expect(checkDayForm({ ...base, date: '2201-01-01' }, duties)).toEqual({ ok: false, errors: { date: SHIFT_FORM_MESSAGES.outOfRange } });
  });

  it('時刻の選択肢：始まりは 00:00〜23:45、終わりは 00:15〜24:00（15 分ごと）。必要人数は 0〜100 の整数', () => {
    expect([DAY_START_TIMES.length, DAY_START_TIMES[0], DAY_START_TIMES.at(-1)]).toEqual([96, '00:00', '23:45']);
    expect([DAY_END_TIMES.length, DAY_END_TIMES[0], DAY_END_TIMES.at(-1)]).toEqual([96, '00:15', '24:00']);
    expect([0, 100, -1, 101, 1.5].map(isNeedCount)).toEqual([true, true, false, false, false]);
  });
});
