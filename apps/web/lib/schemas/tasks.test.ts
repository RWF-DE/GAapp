// 作業のダイアログの入力（04「作業一覧」の欄と送る前の確かめ、notes/T20.md「画面の約束」8。T20）：題名の trim（25 文字）・字数（補助面の
// 文字）、説明の null と上限、担当者（uuid か null）、締切の時刻の既定（17:00）と送る値（`+09:00`）、時刻だけは誤り、日付の範囲。
import { describe, expect, it } from 'vitest';
import { checkTaskForm, EMPTY_TASK_FORM, sameTaskWrite, TASK_FORM_MESSAGES, taskFormValuesOf } from './tasks';

const U = '00000000-0000-4000-8000-000000000009';
const v = (over: Partial<typeof EMPTY_TASK_FORM> = {}) => ({ ...EMPTY_TASK_FORM, title: '名札を作る', ...over });

describe('T20 作業の入力（checkTaskForm）', () => {
  it('題名は trim（25 文字）の後に 1〜100 字。説明は空なら null、2000 字まで', () => {
    expect(checkTaskForm(v({ title: '　 名札を作る﻿ ', note: '  ' }))).toEqual({
      ok: true,
      write: { title: '名札を作る', note: null, assignee_id: null, due_at: null },
    });
    expect(checkTaskForm(v({ title: ' 　' }))).toEqual({ ok: false, errors: { title: TASK_FORM_MESSAGES.titleRequired } });
    expect(checkTaskForm(v({ title: '𠮷'.repeat(100) })).ok).toBe(true);
    expect(checkTaskForm(v({ title: '𠮷'.repeat(101) }))).toEqual({ ok: false, errors: { title: TASK_FORM_MESSAGES.titleTooLong } });
    expect(checkTaskForm(v({ note: 'あ'.repeat(2001) }))).toEqual({ ok: false, errors: { note: TASK_FORM_MESSAGES.noteTooLong } });
  });

  it('担当者は uuid か空（担当者なし）', () => {
    expect(checkTaskForm(v({ assigneeId: U }))).toMatchObject({ ok: true, write: { assignee_id: U } });
    expect(checkTaskForm(v({ assigneeId: 'x' }))).toEqual({ ok: false, errors: { assigneeId: TASK_FORM_MESSAGES.assigneeInvalid } });
  });

  it('締切：日付があれば時刻の既定は 17:00、`YYYY-MM-DDTHH:mm:00+09:00` で送る。日付が空なら締切なし、時刻だけは誤り', () => {
    expect(checkTaskForm(v({ dueDate: '2027-10-20' }))).toMatchObject({ ok: true, write: { due_at: '2027-10-20T17:00:00+09:00' } });
    expect(checkTaskForm(v({ dueDate: '2027-10-20', dueTime: '09:30' }))).toMatchObject({ ok: true, write: { due_at: '2027-10-20T09:30:00+09:00' } });
    expect(checkTaskForm(v({ dueTime: '09:30' }))).toEqual({ ok: false, errors: { dueDate: TASK_FORM_MESSAGES.dueDateRequired } });
    expect(checkTaskForm(v({ dueDate: '1999-12-31' }))).toEqual({ ok: false, errors: { dueDate: TASK_FORM_MESSAGES.outOfRange } });
    expect(checkTaskForm(v({ dueDate: '2027-02-30' }))).toEqual({ ok: false, errors: { dueDate: TASK_FORM_MESSAGES.outOfRange } });
    expect(checkTaskForm(v({ dueDate: '2200-12-31', dueTime: '23:59' })).ok).toBe(true);
    expect(checkTaskForm(v({ dueDate: '2027-10-20', dueTime: '25:00' }))).toEqual({ ok: false, errors: { dueTime: TASK_FORM_MESSAGES.dueTimeInvalid } });
  });

  it('編集で開くときの値（締切は Asia/Tokyo の日付と時刻）と、読み直した行との比べ方（締切は同じ時刻で比べる）', () => {
    const row = { title: '名札', note: null, assignee_id: U, due_at: '2027-10-20T08:00:00+00:00' };
    expect(taskFormValuesOf(row)).toEqual({ title: '名札', note: '', assigneeId: U, dueDate: '2027-10-20', dueTime: '17:00' });
    expect(sameTaskWrite(row, { title: '名札', note: null, assignee_id: U, due_at: '2027-10-20T17:00:00+09:00' })).toBe(true);
    expect(sameTaskWrite(row, { title: '名札', note: '', assignee_id: U, due_at: '2027-10-20T17:00:00+09:00' })).toBe(true);
    expect(sameTaskWrite(row, { title: '名札', note: null, assignee_id: null, due_at: '2027-10-20T17:00:00+09:00' })).toBe(false);
    expect(sameTaskWrite({ ...row, due_at: null }, { title: '名札', note: null, assignee_id: U, due_at: null })).toBe(true);
  });
});
