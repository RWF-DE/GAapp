// 締切と予定のダイアログの入力（lib/schemas/calendar.ts。04「締切と予定」の欄と送る前の確かめ、notes/T18.md「後半（画面）の約束」7。T18）
import { describe, expect, it } from 'vitest';
import {
  checkEventForm,
  EMPTY_EVENT_FORM,
  EVENT_DATE_MAX,
  EVENT_DATE_MIN,
  EVENT_FORM_MESSAGES as M,
  EVENT_NOTE_MAX,
  EVENT_TITLE_MAX,
  eventFormValuesOf,
  toggleAllDay,
  type EventFormValues,
} from './calendar';

const form = (over: Partial<EventFormValues> = {}): EventFormValues => ({ ...EMPTY_EVENT_FORM, title: '説明会', start: '2027-10-14T13:00', ...over });
const allDay = (over: Partial<EventFormValues> = {}): EventFormValues => form({ allDay: true, start: '', startDate: '2027-10-16', ...over });
const ok = (v: EventFormValues) => {
  const r = checkEventForm(v);
  if (!r.ok) throw new Error(`通らなかった：${JSON.stringify(r.errors)}`);
  return r.write;
};
const errorsOf = (v: EventFormValues) => {
  const r = checkEventForm(v);
  return r.ok ? {} : r.errors;
};

/** DB の CHECK（events_title_check）と JavaScript の trim が除く 25 文字 */
const TRIMMED = ['\t', '\n', '\v', '\f', '\r', ' ', ' ', ' ', ...Array.from({ length: 11 }, (_, k) => String.fromCharCode(0x2000 + k)), ' ', ' ', ' ', ' ', '　', '﻿'];

describe('T18 既定の入力と上限', () => {
  it('種類は予定、対象は総務、終日は外す、ほかは空。上限は DB の CHECK と同じ', () => {
    expect(EMPTY_EVENT_FORM).toEqual({ kind: 'event', audience: 'soumu', title: '', allDay: false, startDate: '', endDate: '', start: '', end: '', note: '' });
    expect(Object.isFrozen(EMPTY_EVENT_FORM)).toBe(true);
    expect([EVENT_TITLE_MAX, EVENT_NOTE_MAX, EVENT_DATE_MIN, EVENT_DATE_MAX]).toEqual([100, 1000, '2000-01-01', '2200-12-31']);
  });
});

describe('T18 checkEventForm：題名とメモ', () => {
  it('題名は前後の空白（DB と同じ 25 文字のどれも）を除いて送る。中の空白と U+200B・U+0085 は残す', () => {
    expect(TRIMMED).toHaveLength(25);
    for (const c of TRIMMED) expect(ok(form({ title: `${c}${c}説明 会${c}` })).title, `U+${c.charCodeAt(0).toString(16)}`).toBe('説明 会');
    expect(ok(form({ title: '​説明会' })).title).toBe('​説明会');
    expect(ok(form({ title: '説明会\u0085' })).title).toBe('説明会\u0085');
  });

  it('題名が空・空白だけなら「題名を入れてください」。100 字（補助面の文字も1字）は通り、101 字は「題名は 100 字までです」', () => {
    expect(errorsOf(form({ title: '' }))).toEqual({ title: M.titleRequired });
    expect(errorsOf(form({ title: ' 　\t' }))).toEqual({ title: M.titleRequired });
    expect(ok(form({ title: '𠮷'.repeat(100) })).title).toBe('𠮷'.repeat(100));
    expect(errorsOf(form({ title: '𠮷'.repeat(101) }))).toEqual({ title: M.titleTooLong });
    expect(errorsOf(form({ title: `  ${'あ'.repeat(100)}  ` }))).toEqual({});
  });

  it('メモは前後の空白を除いて送り、空・空白だけなら null。1000 字まで（文字で数える）。中の改行は残す', () => {
    expect(ok(form({ note: '' })).note).toBeNull();
    expect(ok(form({ note: ' \n　 ' })).note).toBeNull();
    expect(ok(form({ note: '\n 一行目\n  二行目 \n' })).note).toBe('一行目\n  二行目');
    expect(ok(form({ note: '𠮷'.repeat(1000) })).note).toBe('𠮷'.repeat(1000));
    expect(errorsOf(form({ note: '𠮷'.repeat(1001) }))).toEqual({ note: M.noteTooLong });
  });
});

describe('T18 checkEventForm：終日', () => {
  it('日付は必須。開始の日の Asia/Tokyo の 00:00 を送り、最後の日が空なら null', () => {
    expect(errorsOf(allDay({ startDate: '' }))).toEqual({ startDate: M.dateRequired });
    expect(ok(allDay())).toEqual({
      kind: 'event',
      audience: 'soumu',
      title: '説明会',
      note: null,
      all_day: true,
      starts_at: '2027-10-16T00:00:00+09:00',
      ends_at: null,
    });
  });

  it('最後の日：同じ日なら null（1日だけ）、後なら最後の日の 00:00、前なら「最後の日は、開始の日と同じか後にしてください」', () => {
    expect(ok(allDay({ endDate: '2027-10-16' })).ends_at).toBeNull();
    expect(ok(allDay({ endDate: '2027-10-17' })).ends_at).toBe('2027-10-17T00:00:00+09:00');
    expect(errorsOf(allDay({ endDate: '2027-10-15' }))).toEqual({ endDate: M.endDateBefore });
  });

  it('日付の範囲は 2000-01-01〜2200-12-31（端は通る）。ない日・形の違いも範囲の文言', () => {
    expect(ok(allDay({ startDate: '2000-01-01', endDate: '2200-12-31' })).ends_at).toBe('2200-12-31T00:00:00+09:00');
    expect(errorsOf(allDay({ startDate: '1999-12-31' }))).toEqual({ startDate: M.outOfRange });
    expect(errorsOf(allDay({ endDate: '2201-01-01' }))).toEqual({ endDate: M.outOfRange });
    expect(errorsOf(allDay({ startDate: '2027-02-30' }))).toEqual({ startDate: M.outOfRange });
    expect(errorsOf(allDay({ startDate: '12345-01-01' }))).toEqual({ startDate: M.outOfRange });
  });

  it('終日のときは時刻の欄を見ない（残っていても送らない）', () => {
    expect(ok(allDay({ start: 'oops', end: 'x' })).starts_at).toBe('2027-10-16T00:00:00+09:00');
  });
});

describe('T18 checkEventForm：時刻つき', () => {
  it('開始は必須。Asia/Tokyo の日時（+09:00）で送り、終わりが空なら null', () => {
    expect(errorsOf(form({ start: '' }))).toEqual({ start: M.startRequired });
    const w = ok(form({ start: '2027-10-14T13:00' }));
    expect([w.all_day, w.starts_at, w.ends_at]).toEqual([false, '2027-10-14T13:00:00+09:00', null]);
  });

  it('終わり：開始と同じはよい、後なら送る、前なら「終わりは、開始と同じか後にしてください」', () => {
    expect(ok(form({ end: '2027-10-14T13:00' })).ends_at).toBe('2027-10-14T13:00:00+09:00');
    expect(ok(form({ end: '2027-10-15T12:00' })).ends_at).toBe('2027-10-15T12:00:00+09:00');
    expect(errorsOf(form({ end: '2027-10-14T12:59' }))).toEqual({ end: M.endBefore });
  });

  it('日付の範囲（Asia/Tokyo の日付）。端は通る', () => {
    expect(ok(form({ start: '2000-01-01T00:00', end: '2200-12-31T23:59' })).ends_at).toBe('2200-12-31T23:59:00+09:00');
    expect(errorsOf(form({ start: '1999-12-31T23:59' }))).toEqual({ start: M.outOfRange });
    expect(errorsOf(form({ end: '2201-01-01T00:00' }))).toEqual({ end: M.outOfRange });
    expect(errorsOf(form({ start: '2027-13-01T00:00' }))).toEqual({ start: M.outOfRange });
  });

  it('締切にも終わり（期限）を入れられる。種類・対象はそのまま送る', () => {
    const w = ok(form({ kind: 'deadline', audience: 'all', start: '2027-10-10T09:00', end: '2027-10-20T17:00' }));
    expect([w.kind, w.audience, w.starts_at, w.ends_at]).toEqual(['deadline', 'all', '2027-10-10T09:00:00+09:00', '2027-10-20T17:00:00+09:00']);
  });

  it('欄ごとに最初の誤りを全部返す（題名・日時・メモ）', () => {
    expect(errorsOf(form({ title: '', start: '', note: 'あ'.repeat(1001) }))).toEqual({ title: M.titleRequired, start: M.startRequired, note: M.noteTooLong });
  });
});

describe('T18 eventFormValuesOf・toggleAllDay（編集で開く値と終日の切り替え）', () => {
  const row = {
    kind: 'deadline' as const,
    audience: 'groups' as const,
    title: '書類の提出',
    starts_at: '2027-10-15T15:00:00+00:00',
    ends_at: '2027-10-16T15:00:00+00:00',
    all_day: true,
    note: null,
  };

  it('終日：日付と最後の日（Asia/Tokyo）。終わりがない・開始と同じ日なら最後の日は空。メモの null は空', () => {
    expect(eventFormValuesOf(row)).toEqual({
      kind: 'deadline',
      audience: 'groups',
      title: '書類の提出',
      allDay: true,
      startDate: '2027-10-16',
      endDate: '2027-10-17',
      start: '',
      end: '',
      note: '',
    });
    expect(eventFormValuesOf({ ...row, ends_at: null }).endDate).toBe('');
    expect(eventFormValuesOf({ ...row, ends_at: row.starts_at }).endDate).toBe('');
  });

  it('時刻つき：開始・終わりは Asia/Tokyo の datetime-local の値。終わりがなければ空。そのまま送ると同じ値になる', () => {
    const timed = { ...row, all_day: false, starts_at: '2027-10-14T04:00:00+00:00', ends_at: '2027-10-14T06:30:00+00:00', note: 'メモ' };
    const v = eventFormValuesOf(timed);
    expect([v.allDay, v.start, v.end, v.startDate, v.note]).toEqual([false, '2027-10-14T13:00', '2027-10-14T15:30', '', 'メモ']);
    expect(eventFormValuesOf({ ...timed, ends_at: null }).end).toBe('');
    const w = ok(v);
    expect([Date.parse(w.starts_at), Date.parse(w.ends_at!)]).toEqual([Date.parse(timed.starts_at), Date.parse(timed.ends_at)]);
  });

  it('終日を入れる：開始・終わりの日時の日付を日付・最後の日に（同じ日なら最後の日は空）。時刻の欄は空に', () => {
    expect(toggleAllDay(form({ start: '2027-10-14T13:00', end: '2027-10-16T10:00' }), true)).toMatchObject({
      allDay: true,
      startDate: '2027-10-14',
      endDate: '2027-10-16',
      start: '',
      end: '',
    });
    expect(toggleAllDay(form({ start: '2027-10-14T13:00', end: '2027-10-14T15:00' }), true)).toMatchObject({ startDate: '2027-10-14', endDate: '' });
    // 開始がなければ今の日付のまま
    expect(toggleAllDay(form({ start: '', startDate: '' }), true)).toMatchObject({ allDay: true, startDate: '', endDate: '' });
  });

  it('終日を外す：日付の 09:00 を開始に、終わりは空に。日付の欄は空に。同じ値なら何もしない', () => {
    expect(toggleAllDay(allDay({ startDate: '2027-10-16', endDate: '2027-10-17' }), false)).toMatchObject({
      allDay: false,
      start: '2027-10-16T09:00',
      end: '',
      startDate: '',
      endDate: '',
    });
    expect(toggleAllDay(allDay({ startDate: '' }), false)).toMatchObject({ allDay: false, start: '', end: '' });
    const v = allDay();
    expect(toggleAllDay(v, true)).toBe(v);
  });
});
