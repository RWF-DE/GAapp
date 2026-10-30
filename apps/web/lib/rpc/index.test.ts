import { describe, expect, it } from 'vitest';
import { AppError, classifyError, messageFor } from '@/lib/errors';
import { createFakeSupabase, type FakeResult } from '@/lib/testing/fake-supabase';
import { callRpc } from './index';
import { allocationChangesPayload, autoRowsPayload, submissionPayload, yearPatchPayload } from './payloads';

const Y = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const G = '33333333-3333-4333-8333-333333333333';
const I = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';

const fake = (result: FakeResult) => createFakeSupabase(() => result);
const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.info;
    throw e;
  }
  throw new Error('投げなかった');
};

describe('callRpc', () => {
  it('引数を確かめてから p_ つきの名前で送り、返り値を返す', async () => {
    const { client, issued } = fake({ data: { allocation_version: 4, deleted: 1, updated: 2, inserted: 3 } });
    const r = await callRpc(
      'save_auto_allocations',
      {
        p_year_id: Y,
        p_rows: [{ sourceRoomId: R, groupId: G, itemId: I, requestedItemId: I, count: 2, isKeep: false }],
        p_mode: 'full',
        p_base_version: 3,
      },
      client,
    );
    expect(r).toEqual({ allocation_version: 4, deleted: 1, updated: 2, inserted: 3 });
    expect(issued[0]!.table).toBe('rpc:save_auto_allocations');
    expect(issued[0]!.ops[0]!.args[0]).toMatchObject({ p_year_id: Y, p_mode: 'full', p_base_version: 3 });
  });

  it('確かめた値（前後の空白を除いた理由など）を送る', async () => {
    const { client, issued } = fake({ data: { allocation_version_before: 1, allocation_version: 2, rows: [] } });
    await callRpc(
      'save_allocation_rows',
      { p_year_id: Y, p_changes: [{ op: 'delete', id: A, updatedAt: 't' }], p_reason: '  団体の希望 ' },
      client,
    );
    expect(issued[0]!.ops[0]!.args[0]).toMatchObject({ p_reason: '団体の希望' });
  });

  it('引数の形が違えば送らずに input（欄の名前つき）', async () => {
    const { client, issued } = fake({ data: null });
    const info = await caught(callRpc('previous_year_stocks', { p_year_id: 'not-a-uuid' }, client));
    expect(issued).toHaveLength(0);
    expect(info).toMatchObject({ kind: 'input', reason: 'client_validation', details: { field: 'year_id' } });
    expect(messageFor(info)).toBe('入力の形が違います（年度）');
  });

  it('理由が空なら送らずに reason', async () => {
    const { client, issued } = fake({ data: null });
    const info = await caught(
      callRpc('save_allocation_rows', { p_year_id: Y, p_changes: [{ op: 'delete', id: A, updatedAt: 't' }], p_reason: ' ' }, client),
    );
    expect(issued).toHaveLength(0);
    expect(info.kind).toBe('reason');
    expect(messageFor(info)).toBe('理由を入力してください');
  });

  it('RPC のエラーは分類して投げる（status も渡す）', async () => {
    const { client } = fake({
      error: { code: 'P0001', message: 'conflict', details: '{"allocation_version": 9}', hint: null },
      status: 400,
    });
    const info = await caught(
      callRpc('save_auto_allocations', { p_year_id: Y, p_rows: [], p_mode: 'full', p_base_version: 3 }, client),
    );
    expect(info).toMatchObject({ kind: 'conflict', status: 400, details: { allocation_version: 9 } });
    expect(classifyError({ code: 'PGRST303', message: 'JWT expired' }, 401).kind).toBe('auth');
  });

  it('jsonb の返り値が合わなければ unexpected_response', async () => {
    const { client } = fake({ data: { invitation_ids: ['x'], applied: 'yes' } });
    const info = await caught(callRpc('invite', { p_year_id: Y, p_email: 'a@example.test', p_role: 'staff' }, client));
    expect(info).toMatchObject({ kind: 'unknown', reason: 'unexpected_response' });
  });

  it('save_allocation_rows の返り値の行（to_jsonb の全列）から使う列を取る', async () => {
    const row = {
      id: A,
      year_id: Y,
      source_room_id: R,
      group_id: G,
      item_id: I,
      requested_item_id: I,
      count: 3,
      is_keep: false,
      origin: 'manual',
      pinned: true,
      note: null,
      created_at: '2026-10-29T00:00:00+00:00',
      updated_at: '2026-10-29T00:00:01.123456+00:00',
    };
    const { client } = fake({
      data: { allocation_version_before: 5, allocation_version: 6, rows: [{ op: 'update', row }, { op: 'delete', id: A }] },
    });
    const r = await callRpc(
      'save_allocation_rows',
      { p_year_id: Y, p_changes: [{ op: 'update', id: A, updatedAt: 't', pinned: true }], p_reason: '固定' },
      client,
    );
    expect(r.rows[0]).toEqual({ op: 'update', row: expect.not.objectContaining({ created_at: expect.anything() }) });
    expect(r.rows[1]).toEqual({ op: 'delete', id: A });
  });
});

describe('payload の zod', () => {
  it('振り分けの変更は 1〜1000 件、同じ行への変更は1つだけ、数は 1〜10000', () => {
    expect(allocationChangesPayload.safeParse([]).success).toBe(false);
    const del = (n: number) => ({ op: 'delete', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, updatedAt: 't' });
    expect(allocationChangesPayload.safeParse(Array.from({ length: 1000 }, (_, i) => del(i))).success).toBe(true);
    expect(allocationChangesPayload.safeParse(Array.from({ length: 1001 }, (_, i) => del(i))).success).toBe(false);
    expect(allocationChangesPayload.safeParse([del(1), del(1)]).success).toBe(false);
    const upd = (count: number) => ({ op: 'update', id: A, updatedAt: 't', count });
    expect(allocationChangesPayload.safeParse([upd(0)]).success).toBe(false);
    expect(allocationChangesPayload.safeParse([upd(10001)]).success).toBe(false);
    expect(allocationChangesPayload.safeParse([{ ...upd(1), note: 'a'.repeat(2001) }]).success).toBe(false);
  });
  it('自動の行は 10000 行まで', () => {
    const row = { sourceRoomId: R, groupId: G, itemId: I, requestedItemId: I, count: 1, isKeep: false };
    expect(autoRowsPayload.safeParse(Array.from({ length: 10001 }, () => row)).success).toBe(false);
  });
  it('提出は submitted が true だけ、submittedAt はオフセットつき', () => {
    expect(submissionPayload.safeParse({ submitted: false }).success).toBe(false);
    expect(submissionPayload.safeParse({ submittedAt: '2026-07-01T12:00:00+09:00', note: null }).success).toBe(true);
    expect(submissionPayload.safeParse({ submittedAt: '2026-07-01T12:00:00' }).success).toBe(false);
  });
  it('年度の patch は知っているキーだけ、空は不可', () => {
    expect(yearPatchPayload.safeParse({}).success).toBe(false);
    expect(yearPatchPayload.safeParse({ status: 'closed' }).success).toBe(false);
    expect(yearPatchPayload.safeParse({ request_close_at: null }).success).toBe(true);
    expect(yearPatchPayload.safeParse({ festival_start: '2201-01-01' }).success).toBe(false);
  });
});
