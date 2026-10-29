import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import { fixedRowsFrom, opsBeforeUnusable, setRoomUsable } from './room-years';

const Y = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';

describe('setRoomUsable', () => {
  it('(year_id, room_id) で upsert し、メモは前後の空白を除いて空なら null', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: { year_id: Y, room_id: R, usable: false, note: '工事', updated_at: 't' } }));
    const row = await setRoomUsable(Y, R, false, '  工事 ', client);
    expect(row.usable).toBe(false);
    const call = issued[0]!;
    expect(call.table).toBe('room_years');
    expect(opArgs(call, 'upsert')).toEqual([[{ year_id: Y, room_id: R, usable: false, note: '工事' }, { onConflict: 'year_id,room_id' }]]);
    await setRoomUsable(Y, R, true, '   ', client);
    expect(opArgs(issued[1]!, 'upsert')[0]![0]).toMatchObject({ usable: true, note: null });
  });

  it('RLS で書けなければ forbidden（エラーでも 0 行でも）', async () => {
    const denied = createFakeSupabase(() => ({ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }));
    await expect(setRoomUsable(Y, R, false, null, denied.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
    const empty = createFakeSupabase(() => ({ data: null }));
    await expect(setRoomUsable(Y, R, false, null, empty.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });

  it('id の形が違えば送らない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: null }));
    await expect(setRoomUsable('x', R, false, null, client)).rejects.toBeInstanceOf(AppError);
    expect(issued).toHaveLength(0);
  });
});

describe('fixedRowsFrom と opsBeforeUnusable（使用不可にする前に直す行。3.9）', () => {
  const rows = [
    { id: 'a', sourceRoomId: R, origin: 'auto' as const, pinned: false },
    { id: 'b', sourceRoomId: R, origin: 'auto' as const, pinned: true },
    { id: 'c', sourceRoomId: R, origin: 'manual' as const, pinned: false },
    { id: 'd', sourceRoomId: R, origin: 'manual' as const, pinned: true },
    { id: 'e', sourceRoomId: R2, origin: 'manual' as const, pinned: true },
  ];

  it('その部屋からの固定・手動の行だけ（未固定の自動の行は再実行で動くので含めない）', () => {
    expect(fixedRowsFrom(rows, R).map((r) => r.id)).toEqual(['b', 'c', 'd']);
    expect(fixedRowsFrom(rows, 'none')).toEqual([]);
  });

  it('固定の自動の行は「固定を外す」も出し、手動の行は「運び元を変える」「削除」だけ', () => {
    expect(opsBeforeUnusable(rows[1]!)).toEqual(['unpin', 'change_source', 'delete']);
    expect(opsBeforeUnusable(rows[2]!)).toEqual(['change_source', 'delete']);
    expect(opsBeforeUnusable(rows[3]!)).toEqual(['change_source', 'delete']);
  });
});
