// 作業一覧の読み取りと書き込み（04「作業一覧」、notes/T20.md「画面の約束」2・3。T20）：読み方（列・絞り込み・並び・fetchAll）、作る
// （画面の id・状態と書いた人は送らない）、直す・消す（updated_at の文字列のまま）、状態の RPC（p_base_updated_at）、キャッシュと読み直すキー。
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  deleteTask,
  dropTaskFromCache,
  insertTask,
  loadTasks,
  putTaskInCache,
  readTask,
  setTaskStatus,
  TASKS_SELECT,
  tasksInvalidateKeys,
  tasksOptions,
  updateTask,
  type TaskRow,
} from './tasks';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const T1 = uuid(2);
const U = uuid(3);
const V = '2027-10-01T00:00:00.123456+00:00';
const row = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: '名札',
  note: null,
  assignee_id: null,
  due_at: null,
  status: 'todo',
  created_by: null,
  updated_by: null,
  created_at: V,
  updated_at: V,
  ...over,
});

describe('T20 作業の読み書き', () => {
  it('読む：その年度の全部（題名・説明・担当者・締切・状態・作った人・直した人と日時）を id の順に fetchAll。キー', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [row(T1)] }));
    expect(await loadTasks(Y, client)).toEqual([row(T1)]);
    expect(TASKS_SELECT).toBe('id, title, note, assignee_id, due_at, status, created_by, updated_by, created_at, updated_at');
    expect(opArgs(issued[0]!, 'select')[0]![0]).toBe(TASKS_SELECT);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(issued[0]!, 'order').map((a) => a[0])).toEqual(['id']);
    expect(tasksOptions(Y).queryKey).toEqual(['year', Y, 'shifts', 'tasks']);
    const one = createFakeSupabase(() => ({ data: null }));
    expect(await readTask(T1, one.client)).toBeNull();
  });

  it('作る：画面の id・year_id・題名・説明・担当者・締切だけ（状態・書いた人・日時は送らない）', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: row(T1) }));
    await insertTask(Y, T1, { title: '名札', note: null, assignee_id: U, due_at: '2027-10-20T17:00:00+09:00' }, client);
    expect(opArgs(issued[0]!, 'insert')[0]![0]).toEqual({ id: T1, year_id: Y, title: '名札', note: null, assignee_id: U, due_at: '2027-10-20T17:00:00+09:00' });
  });

  it('直す・消す：読んだときの updated_at の文字列のまま。返り値は一覧の列にそろえる', async () => {
    const extra = { ...row(T1, { updated_at: 'v2' }), year_id: Y } as TaskRow & { year_id: string };
    const { client, issued } = createFakeSupabase(() => ({ data: extra }));
    expect(await updateTask({ id: T1, updated_at: V }, { title: 'x', note: null, assignee_id: null, due_at: null }, client)).toEqual(row(T1, { updated_at: 'v2' }));
    expect(opArgs(issued[0]!, 'update')[0]![0]).toEqual({ title: 'x', note: null, assignee_id: null, due_at: null });
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', V]]);
    const del = createFakeSupabase(() => ({ data: [extra] }));
    expect(await deleteTask({ id: T1, updated_at: V }, del.client)).toEqual(row(T1, { updated_at: 'v2' }));
  });

  it('状態：RPC set_task_status（p_task_id・p_status・p_base_updated_at は読んだときの文字列）。conflict は AppError', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: { ...row(T1, { status: 'doing', updated_at: 'v2' }), year_id: Y } }));
    expect(await setTaskStatus({ id: T1, updated_at: V }, 'doing', client)).toEqual(row(T1, { status: 'doing', updated_at: 'v2' }));
    expect(issued[0]!.table).toBe('rpc:set_task_status');
    expect(issued[0]!.ops[0]!.args[0]).toEqual({ p_task_id: T1, p_status: 'doing', p_base_updated_at: V });
    const c = createFakeSupabase(() => ({ error: { code: 'P0001', message: 'conflict', details: JSON.stringify({ id: T1 }) }, status: 400 }));
    await expect(setTaskStatus({ id: T1, updated_at: V }, 'done', c.client)).rejects.toMatchObject({ info: { kind: 'conflict', details: { id: T1 } } });
  });

  it('キャッシュ（入れる・外す）と読み直すキー（作業の一覧とダッシュボードのシフト・作業）', () => {
    const qc = new QueryClient();
    putTaskInCache(qc, Y, row(T1));
    expect(qc.getQueryData(tasksOptions(Y).queryKey)).toBeUndefined();
    qc.setQueryData(tasksOptions(Y).queryKey, [row(uuid(9)), row(T1)]);
    putTaskInCache(qc, Y, row(T1, { title: '直した' }));
    expect(qc.getQueryData<TaskRow[]>(tasksOptions(Y).queryKey)!.map((t) => [t.id, t.title])).toEqual([
      [T1, '直した'],
      [uuid(9), '名札'],
    ]);
    dropTaskFromCache(qc, Y, T1);
    expect(qc.getQueryData<TaskRow[]>(tasksOptions(Y).queryKey)!.map((t) => t.id)).toEqual([uuid(9)]);
    expect(tasksInvalidateKeys(Y)).toEqual([
      ['year', Y, 'shifts', 'tasks'],
      ['year', Y, 'portal', 'shifts'],
    ]);
  });
});
