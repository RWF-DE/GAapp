// 作業の書き込みの決め方（2.6 の (B1)。04「作業一覧」のエラーと読み直し。T20）：作る・直すの 23505・conflict・not_found・応答なし、
// 読み直せなかった後の「読み直す」、消す、状態のボタン（conflict で同じ状態なら保存されていた、応答なしで版が同じなら分からない）。
import { describe, expect, it } from 'vitest';
import type { TaskRow } from '@/lib/data/tasks';
import { appError, AppError } from '@/lib/errors';
import { sameTaskWrite } from '@/lib/schemas/tasks';
import { rereadRejectedTaskSave, runTaskDelete, runTaskSave, runTaskStatus } from './task-write';

const NETWORK = { code: '', message: 'TypeError: Failed to fetch' };
const pg = (code: string) => new AppError({ kind: code === '23505' ? 'conflict' : 'forbidden', code, reason: null, details: null, issues: [], status: 400 });
const noAuth = async () => 'other' as const;
const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1',
  title: '名札',
  note: null,
  assignee_id: null,
  due_at: null,
  status: 'todo',
  created_by: null,
  updated_by: null,
  created_at: 'c',
  updated_at: 'v1',
  ...over,
});
const write = { title: '名札', note: null, assignee_id: null, due_at: null };
const matches = (r: TaskRow) => sameTaskWrite(r, write);
const fail = (e: unknown) => () => Promise.reject(e);

describe('T20 runTaskSave（作る・直す）', () => {
  it('送れたら saved。応答なしで読み直すと入力と同じなら saved（before）', async () => {
    expect(await runTaskSave({ baseVersion: null, matches, send: async () => row(), reread: async () => null }, noAuth)).toEqual({ type: 'saved', row: row(), before: false });
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(NETWORK), reread: async () => row({ updated_at: 'v2' }) }, noAuth)).toEqual({
      type: 'saved',
      row: row({ updated_at: 'v2' }),
      before: true,
    });
  });

  it('作る：23505 で中身が違えば conflict（編集に切り替える）、行がなければ・応答なしで行がなければ unknown', async () => {
    const other = row({ title: '別の題名' });
    expect(await runTaskSave({ baseVersion: null, matches, send: fail(pg('23505')), reread: async () => other }, noAuth)).toEqual({ type: 'conflict', row: other });
    expect(await runTaskSave({ baseVersion: null, matches, send: fail(NETWORK), reread: async () => null }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('直す：conflict は読み直した行で conflict、なければ missing、読み直せなければ unread。応答なしで版が同じなら unknown', async () => {
    const lock = appError('conflict', 'lock_conflict');
    const changed = row({ title: '別', updated_at: 'v2' });
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(lock), reread: async () => changed }, noAuth)).toEqual({ type: 'conflict', row: changed });
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(appError('not_found', 'lock_missing')), reread: async () => null }, noAuth)).toEqual({ type: 'missing' });
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(lock), reread: fail(NETWORK) }, noAuth)).toEqual({ type: 'unread' });
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(NETWORK), reread: async () => row({ title: '別' }) }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('forbidden・not_soumu などはそのまま failed（読み直さない）', async () => {
    const forbidden = pg('42501');
    expect(await runTaskSave({ baseVersion: 'v1', matches, send: fail(forbidden), reread: async () => row() }, noAuth)).toEqual({ type: 'failed', error: forbidden });
  });

  it('止められた後の「読み直す」：入力と同じなら saved、違えば conflict、なければ missing、読めなければ unread', async () => {
    expect(await rereadRejectedTaskSave({ baseVersion: 'v1', matches, reread: async () => row({ updated_at: 'v2' }) })).toMatchObject({ type: 'saved', before: true });
    expect(await rereadRejectedTaskSave({ baseVersion: 'v1', matches, reread: async () => row({ title: '別' }) })).toMatchObject({ type: 'conflict' });
    expect(await rereadRejectedTaskSave({ baseVersion: 'v1', matches, reread: async () => null })).toEqual({ type: 'missing' });
    expect(await rereadRejectedTaskSave({ baseVersion: 'v1', matches, reread: fail(NETWORK) })).toEqual({ type: 'unread' });
  });
});

describe('T20 runTaskDelete・runTaskStatus', () => {
  it('消す：not_found は deleted（before）、conflict は changed、応答なしで読み直すとない・版が違う・同じ', async () => {
    expect(await runTaskDelete({ send: fail(appError('not_found', 'lock_missing')), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'deleted', before: true });
    expect(await runTaskDelete({ send: fail(appError('conflict', 'lock_conflict')), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'changed' });
    expect(await runTaskDelete({ send: fail(NETWORK), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'deleted', before: false });
    expect(await runTaskDelete({ send: fail(NETWORK), reread: async () => row({ updated_at: 'v2' }), baseVersion: 'v1' }, noAuth)).toEqual({ type: 'changed' });
    expect(await runTaskDelete({ send: fail(NETWORK), reread: async () => row(), baseVersion: 'v1' }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('状態：conflict で読み直すと押した状態なら saved（before）、違えば conflict（今の行）。not_found は missing', async () => {
    const conflict = new AppError({ kind: 'conflict', code: 'P0001', reason: 'conflict', details: { id: 't1' }, issues: [], status: 400 });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(conflict), reread: async () => row({ status: 'doing', updated_at: 'v2' }) }, noAuth)).toMatchObject({
      type: 'saved',
      before: true,
    });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(conflict), reread: async () => row({ status: 'done', updated_at: 'v2' }) }, noAuth)).toMatchObject({
      type: 'conflict',
      row: { status: 'done' },
    });
    const notFound = new AppError({ kind: 'not_found', code: 'P0001', reason: 'not_found', details: null, issues: [], status: 400 });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(notFound), reread: async () => null }, noAuth)).toEqual({ type: 'missing' });
  });

  it('状態：応答なしで版が同じなら unknown、違えば conflict、読み直せなければ unknown。forbidden は failed', async () => {
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(NETWORK), reread: async () => row() }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(NETWORK), reread: async () => row({ updated_at: 'v2' }) }, noAuth)).toMatchObject({ type: 'conflict' });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(NETWORK), reread: fail(NETWORK) }, noAuth)).toEqual({ type: 'unknown' });
    const forbidden = new AppError({ kind: 'forbidden', code: 'P0001', reason: 'forbidden', details: null, issues: [], status: 400 });
    expect(await runTaskStatus({ status: 'doing', baseVersion: 'v1', send: fail(forbidden), reread: async () => row() }, noAuth)).toEqual({ type: 'failed', error: forbidden });
  });

  it('401 は1回だけセッションを更新して送り直す', async () => {
    let n = 0;
    const auth = new AppError({ kind: 'auth', code: 'PGRST303', reason: null, details: null, issues: [], status: 401 });
    const r = await runTaskStatus(
      {
        status: 'done',
        baseVersion: 'v1',
        send: async () => {
          if (n++ === 0) throw auth;
          return row({ status: 'done' });
        },
        reread: async () => null,
      },
      async () => 'retry',
    );
    expect(r).toMatchObject({ type: 'saved', before: false });
    expect(n).toBe(2);
  });
});
