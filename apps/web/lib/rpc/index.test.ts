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

describe('T17 save_notice・delete_notice の引数（RPC_ARGS）', () => {
  const N = '66666666-6666-4666-8666-666666666666';
  const row = { id: N, year_id: Y, audience: 'soumu', title: 'お知らせ', body: null, pinned: false, created_by: null, created_at: 't', updated_by: null, updated_at: 't' };

  it('出す：題名は前後の空白（全角を含む）を除いて送る。本文・団体・版を省ける。返り値はお知らせの行', async () => {
    const { client, issued } = fake({ data: row });
    const r = await callRpc('save_notice', { p_year_id: Y, p_audience: 'soumu', p_title: '\u3000お知らせ\t', p_pinned: false, p_group_ids: [] }, client);
    expect(r).toEqual(row);
    expect(issued[0]!.table).toBe('rpc:save_notice');
    expect(issued[0]!.ops[0]!.args[0]).toEqual({ p_year_id: Y, p_audience: 'soumu', p_title: 'お知らせ', p_pinned: false, p_group_ids: [] });
  });

  it('直す：notice_id と base_updated_at（文字列のまま）を送る。本文の前後の空白と改行は残す', async () => {
    const { client, issued } = fake({ data: row });
    await callRpc(
      'save_notice',
      { p_year_id: Y, p_audience: 'groups', p_title: '団体へ', p_body: '  本文\n', p_pinned: true, p_group_ids: [G], p_notice_id: N, p_base_updated_at: '2026-10-01T00:00:00.123456+00:00' },
      client,
    );
    expect(issued[0]!.ops[0]!.args[0]).toMatchObject({ p_body: '  本文\n', p_notice_id: N, p_base_updated_at: '2026-10-01T00:00:00.123456+00:00', p_group_ids: [G] });
  });

  it('送る前の確かめに落ちたら送らず、field は p_ を除いた引数の名前（title・body・group_ids。欄の下に DB と同じ文言）', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ p_title: ' \u3000' }, 'title', '題名は、前後の空白を除いて 1〜100 字にしてください'],
      [{ p_title: 'あ'.repeat(101) }, 'title', '題名は、前後の空白を除いて 1〜100 字にしてください'],
      [{ p_body: 'あ'.repeat(4001) }, 'body', '本文は 4000 字までです'],
      [{ p_group_ids: ['not-a-uuid'] }, 'group_ids', '入力の形が違います（宛先の団体）'],
      [{ p_group_ids: Array.from({ length: 1001 }, () => G) }, 'group_ids', '入力の形が違います（宛先の団体）'],
      [{ p_audience: 'everyone' }, 'audience', '入力の形が違います（宛先）'],
      [{ p_notice_id: 'x' }, 'notice_id', '入力の形が違います'],
    ];
    for (const [over, field, message] of cases) {
      const { client, issued } = fake({ data: row });
      const info = await caught(callRpc('save_notice', { p_year_id: Y, p_audience: 'soumu', p_title: '題名', ...over } as never, client));
      expect(issued, field).toHaveLength(0);
      expect(info.details, field).toEqual({ field });
      expect(messageFor(info, { rpc: 'save_notice' }), field).toBe(message);
    }
  });

  it('本文は補助面の文字も1字と数える（4000 字の絵文字は送れる）', async () => {
    const { client, issued } = fake({ data: row });
    await callRpc('save_notice', { p_year_id: Y, p_audience: 'soumu', p_title: '題名', p_body: '😀'.repeat(4000) }, client);
    expect(issued).toHaveLength(1);
  });

  it('delete_notice：notice_id と base_updated_at が要る', async () => {
    const { client, issued } = fake({ data: null });
    await callRpc('delete_notice', { p_notice_id: N, p_base_updated_at: 't' }, client);
    expect(issued[0]!.ops[0]!.args[0]).toEqual({ p_notice_id: N, p_base_updated_at: 't' });
    const info = await caught(callRpc('delete_notice', { p_notice_id: N, p_base_updated_at: '' }, client));
    expect(info.details).toEqual({ field: 'base_updated_at' });
    expect(messageFor(info)).toBe('入力の形が違います（お知らせの版）');
  });

  it('DB のエラー（conflict の details は id）は分類して投げる', async () => {
    const { client } = fake({ error: { code: 'P0001', message: 'conflict', details: JSON.stringify({ id: N }) }, status: 400 });
    const info = await caught(callRpc('delete_notice', { p_notice_id: N, p_base_updated_at: 't' }, client));
    expect(info.kind).toBe('conflict');
    expect(messageFor(info, { rpc: 'delete_notice' })).toBe('ほかの人がこのお知らせを先に変えました。読み直しました');
  });
});

describe('T20 set_task_status・add_shift_slots の引数（RPC_ARGS）', () => {
  const T = '77777777-7777-4777-8777-777777777777';
  const D = '88888888-8888-4888-8888-888888888888';
  const slot = { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' };

  it('set_task_status：作業の id・状態・読んだときの updated_at（文字列のまま）。状態は task_status の値だけ', async () => {
    const { client, issued } = fake({ data: { id: T } });
    await callRpc('set_task_status', { p_task_id: T, p_status: 'doing', p_base_updated_at: '2027-10-01T00:00:00.123456+00:00' }, client);
    expect(issued[0]!.ops[0]!.args[0]).toEqual({ p_task_id: T, p_status: 'doing', p_base_updated_at: '2027-10-01T00:00:00.123456+00:00' });
    const bad = await caught(callRpc('set_task_status', { p_task_id: T, p_status: 'waiting' as never, p_base_updated_at: 't' }, client));
    expect(bad.details).toEqual({ field: 'status' });
    expect(messageFor(bad, { rpc: 'set_task_status' })).toBe('入力の形が違います（状態）');
    const noVersion = await caught(callRpc('set_task_status', { p_task_id: T, p_status: 'done', p_base_updated_at: '' }, client));
    expect(noVersion.details).toEqual({ field: 'base_updated_at' });
  });

  it('add_shift_slots：時間枠は 1〜96 個（オフセットつきの日時）、ますは 0〜100 個（必要人数 0〜100 の整数）', async () => {
    const { client, issued } = fake({ data: [] });
    await callRpc('add_shift_slots', { p_year_id: Y, p_slots: [slot], p_needs: [{ duty_id: D, required_count: 0 }] }, client);
    expect(issued).toHaveLength(1);
    const cases: [Record<string, unknown>, string][] = [
      [{ p_slots: [] }, 'slots'],
      [{ p_slots: Array.from({ length: 97 }, () => slot) }, 'slots'],
      [{ p_slots: [{ starts_at: '2027-10-15T09:00:00', ends_at: '2027-10-15T10:00:00' }] }, 'slots'],
      [{ p_needs: [{ duty_id: D, required_count: 101 }] }, 'needs'],
      [{ p_needs: [{ duty_id: D, required_count: 1.5 }] }, 'needs'],
      [{ p_needs: [{ duty_id: 'x', required_count: 1 }] }, 'needs'],
      [{ p_needs: Array.from({ length: 101 }, () => ({ duty_id: D, required_count: 1 })) }, 'needs'],
    ];
    for (const [over, field] of cases) {
      const f = fake({ data: [] });
      const info = await caught(callRpc('add_shift_slots', { p_year_id: Y, p_slots: [slot], p_needs: [], ...over } as never, f.client));
      expect(f.issued, field).toHaveLength(0);
      expect(info.details, JSON.stringify(over).slice(0, 40)).toEqual({ field });
    }
    const ok96 = fake({ data: [] });
    await callRpc('add_shift_slots', { p_year_id: Y, p_slots: Array.from({ length: 96 }, () => slot), p_needs: [] }, ok96.client);
    expect(ok96.issued).toHaveLength(1);
  });
});
