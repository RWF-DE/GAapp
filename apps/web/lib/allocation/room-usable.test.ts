import { describe, expect, it, vi } from 'vitest';
import { setRoomUsable } from '@/lib/data/room-years';
import { appError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { changeRoomUsable, ROOM_USABLE_CONFLICT, roomUsableBase, type RoomUsableDeps } from './room-usable';

const Y = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
// PostgREST はマイクロ秒まで返す。受け取った文字列のまま渡す
const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';

const ry = (room_id: string, usable: boolean, updated_at: string) => ({ year_id: Y, room_id, usable, note: null, updated_at });

/** 書き込み（update・insert）と、0 行の後の読み直し（select だけ）の応答を分ける */
function fakeSave(write: FakeResult, reread?: FakeResult) {
  const fake = createFakeSupabase((call: FakeCall) => {
    const isWrite = call.ops.some((o) => o.op === 'update' || o.op === 'insert' || o.op === 'upsert');
    if (isWrite) return write;
    if (!reread) throw new Error('読み直さないはず');
    return reread;
  });
  const save: RoomUsableDeps['save'] = (y, r, at, usable, note) => setRoomUsable(y, r, at, usable, note, fake.client);
  return { save, issued: fake.issued };
}

describe('roomUsableBase', () => {
  it('room_years の行の usable と updated_at（受け取った文字列のまま）。行のない部屋は使用可で updatedAt は null', () => {
    const rows = [ry(R, false, T0)];
    expect(roomUsableBase(rows, R)).toEqual({ roomId: R, usable: false, updatedAt: T0 });
    expect(roomUsableBase(rows, R2)).toEqual({ roomId: R2, usable: true, updatedAt: null });
  });
});

describe('changeRoomUsable（部屋の見出しから使用不可にする・使用可に戻す）', () => {
  it('開いたときの room_years.updated_at を条件に update する。成功なら読み直さない（呼ぶ側が知らせと一緒に読み直す）', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1) });
    const reload = vi.fn();
    const out = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: '工事' }, { save, reload });
    expect(out).toEqual({ kind: 'saved' });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['update', 'match', 'eq', 'select', 'maybeSingle']);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', T0]]);
    expect(opArgs(issued[0]!, 'update')).toEqual([[{ usable: false, note: '工事' }]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('行のなかった部屋（updatedAt が null）は insert する', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1) });
    const out = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: null }, usable: false, note: null }, { save, reload: vi.fn() });
    expect(out.kind).toBe('saved');
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['insert', 'select', 'maybeSingle']);
  });

  it('ほかの人が先に変えた（update が 0 行で updated_at が違う）→ 読み直して「ほかの人がこの部屋の使用を変えました」。まだ使用可ならダイアログを残し、読み直した updated_at で押し直せる', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    // ほかの人はメモだけを変えた（使用可のまま）
    const reload = vi.fn(async () => ({ roomYears: [ry(R, true, T1)] }));
    const out = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: '工事' }, { save, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: { roomId: R, usable: true, updatedAt: T1 }, done: false });
    expect(ROOM_USABLE_CONFLICT).toMatch(/^ほかの人がこの部屋の使用を変えました/);
  });

  it('ほかの人がすでに使用不可にしていた → 読み直して知らせ、done（ダイアログを閉じる）', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    const out = await changeRoomUsable(
      { yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: null },
      { save, reload: async () => ({ roomYears: [ry(R, false, T1)] }) },
    );
    expect(out).toMatchObject({ kind: 'conflict', done: true, next: { usable: false, updatedAt: T1 } });
  });

  it('行のなかった部屋にほかの人が先に足した（insert の 23505）→ conflict として読み直す', async () => {
    const { save } = fakeSave({ error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 });
    const out = await changeRoomUsable(
      { yearId: Y, base: { roomId: R, usable: true, updatedAt: null }, usable: false, note: null },
      { save, reload: async () => ({ roomYears: [ry(R, true, T1)] }) },
    );
    expect(out).toMatchObject({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, done: false, next: { updatedAt: T1 } });
  });

  it('行が消えていた（not_found）→ 読み直して conflict と同じに知らせる。行がなくなったので次は insert（updatedAt は null）', async () => {
    const { save } = fakeSave({ data: null }, { data: null });
    const out = await changeRoomUsable(
      { yearId: Y, base: { roomId: R, usable: false, updatedAt: T0 }, usable: true, note: null },
      { save, reload: async () => ({ roomYears: [] }) },
    );
    // 行がない部屋は使用可：使用可に戻したかったので done
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: { roomId: R, usable: true, updatedAt: null }, done: true });
  });

  it('読み直しに失敗したら next は null（呼ぶ側はダイアログを閉じる）', async () => {
    const save = vi.fn(async () => {
      throw appError('conflict', 'lock_conflict');
    });
    const failed = await changeRoomUsable(
      { yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: null },
      {
        save,
        reload: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    expect(failed).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: null, done: false });
    const empty = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: null }, { save, reload: async () => undefined });
    expect(empty).toMatchObject({ kind: 'conflict', next: null, done: false });
  });

  it('conflict・not_found 以外（RLS の forbidden・通信の失敗）は読み直さずに error で返す（呼ぶ側が messageFor・effectOf で分ける）', async () => {
    const reload = vi.fn();
    const rls = fakeSave({ data: null }, { data: { updated_at: T0 } });
    const forbidden = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: null }, { save: rls.save, reload });
    expect(forbidden).toMatchObject({ kind: 'error', error: { kind: 'forbidden', reason: 'lock_unchanged' } });
    const net = fakeSave({ error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 });
    const network = await changeRoomUsable({ yearId: Y, base: { roomId: R, usable: true, updatedAt: T0 }, usable: false, note: null }, { save: net.save, reload });
    expect(network).toMatchObject({ kind: 'error', error: { kind: 'network' } });
    expect(reload).not.toHaveBeenCalled();
  });
});
