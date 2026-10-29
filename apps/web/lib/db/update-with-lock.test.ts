import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { deleteChecked } from './delete-checked';
import { updateWithLock } from './update-with-lock';

const ID = '11111111-1111-4111-8111-111111111111';
// PostgREST はマイクロ秒まで返す。受け取った文字列をそのまま比べる（Date に通さない）
const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';

/** 1回目（書き込み）と2回目（読み直し）の応答を決める */
function fake(write: FakeResult, reread?: FakeResult) {
  return createFakeSupabase((call: FakeCall) => {
    const isWrite = call.ops.some((o) => o.op === 'update' || o.op === 'delete');
    if (isWrite) return write;
    if (!reread) throw new Error('読み直さないはず');
    return reread;
  });
}

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return [e.info.kind, e.info.reason];
    throw e;
  }
  return null;
};

describe('updateWithLock', () => {
  it('updated_at を条件に入れて更新し、更新した行を返す', async () => {
    const { client, issued } = fake({ data: { id: ID, name: '新', updated_at: T1 } });
    const row = await updateWithLock(client, 'groups', { id: ID }, T0, { name: '新' });
    expect(row).toMatchObject({ name: '新' });
    expect(issued).toHaveLength(1);
    const call = issued[0]!;
    expect(call.table).toBe('groups');
    expect(opArgs(call, 'update')).toEqual([[{ name: '新' }]]);
    expect(opArgs(call, 'match')).toEqual([[{ id: ID }]]);
    expect(opArgs(call, 'eq')).toEqual([['updated_at', T0]]);
    expect(call.ops.map((o) => o.op)).toEqual(['update', 'match', 'eq', 'select', 'maybeSingle']);
  });

  it('0 行で行がない → not_found（ほかの人が消した）', async () => {
    const { client, issued } = fake({ data: null }, { data: null });
    expect(await reasonOf(updateWithLock(client, 'groups', { id: ID }, T0, { name: 'x' }))).toEqual(['not_found', 'lock_missing']);
    expect(issued[1]!.ops.map((o) => o.op)).toEqual(['select', 'match', 'maybeSingle']);
    expect(opArgs(issued[1]!, 'select')).toEqual([['updated_at']]);
  });

  it('0 行で updated_at が違う → conflict（ほかの人が先に変えた）', async () => {
    const { client } = fake({ data: null }, { data: { updated_at: T1 } });
    expect(await reasonOf(updateWithLock(client, 'groups', { id: ID }, T0, { name: 'x' }))).toEqual(['conflict', 'lock_conflict']);
  });

  it('0 行で updated_at が同じ → forbidden（RLS で拒否：権限か年度の状態が変わった）', async () => {
    const { client } = fake({ data: null }, { data: { updated_at: T0 } });
    expect(await reasonOf(updateWithLock(client, 'groups', { id: ID }, T0, { name: 'x' }))).toEqual(['forbidden', 'lock_unchanged']);
  });

  it('書き込みのエラーは分類して投げる（読み直さない）', async () => {
    const { client, issued } = fake({ error: { code: '23514', message: 'check' }, status: 400 });
    expect(await reasonOf(updateWithLock(client, 'rooms', { id: ID }, T0, { extra_cost: 99 }))).toEqual(['input', null]);
    expect(issued).toHaveLength(1);
  });

  it('読み直しのエラーも分類して投げる', async () => {
    const { client } = fake({ data: null }, { data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 });
    expect(await reasonOf(updateWithLock(client, 'groups', { id: ID }, T0, { name: 'x' }))).toEqual(['network', null]);
  });
});

describe('deleteChecked', () => {
  it('消えた行を受け取る（updated_at を渡せば条件に入れる）', async () => {
    const { client, issued } = fake({ data: [{ id: ID, updated_at: T0 }] });
    const row = await deleteChecked(client, 'rules', { id: ID }, T0);
    expect(row).toMatchObject({ id: ID });
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['delete', 'match', 'eq', 'select']);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', T0]]);
  });

  it('updated_at を渡さなければ条件に入れない', async () => {
    const { client, issued } = fake({ data: [{ room_id: ID }] });
    await deleteChecked(client, 'room_years', { year_id: ID, room_id: ID });
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['delete', 'match', 'select']);
  });

  it('0 行で行がない → not_found（すでに消えていた）', async () => {
    const { client } = fake({ data: [] }, { data: null });
    expect(await reasonOf(deleteChecked(client, 'rules', { id: ID }, T0))).toEqual(['not_found', 'lock_missing']);
  });

  it('0 行で updated_at が違う → conflict', async () => {
    const { client } = fake({ data: [] }, { data: { updated_at: T1 } });
    expect(await reasonOf(deleteChecked(client, 'rules', { id: ID }, T0))).toEqual(['conflict', 'lock_conflict']);
  });

  it('0 行で updated_at が同じ → forbidden（RLS の USING で拒否された delete はエラーにならない）', async () => {
    const { client } = fake({ data: [] }, { data: { updated_at: T0 } });
    expect(await reasonOf(deleteChecked(client, 'rules', { id: ID }, T0))).toEqual(['forbidden', 'lock_unchanged']);
  });

  it('updated_at なしの削除で行が残っている → forbidden', async () => {
    const { client } = fake({ data: [] }, { data: { updated_at: T1 } });
    expect(await reasonOf(deleteChecked(client, 'distance_overrides', { building_a: 'A', building_b: 'B' }))).toEqual([
      'forbidden',
      'lock_unchanged',
    ]);
  });

  it('外部キーで消せない（23503）→ blocked', async () => {
    const { client } = fake({ error: { code: '23503', message: 'fk' }, status: 409 });
    expect(await reasonOf(deleteChecked(client, 'rooms', { id: ID }))).toEqual(['blocked', null]);
  });
});
