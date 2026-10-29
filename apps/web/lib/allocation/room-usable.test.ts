import { describe, expect, it, vi } from 'vitest';
import { setRoomUsable } from '@/lib/data/room-years';
import { appError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  changeRoomUsable,
  checkRoomUsable,
  ROOM_USABLE_CONFLICT,
  ROOM_USABLE_CONFLICT_UNREAD,
  ROOM_USABLE_NOT_SAVED,
  ROOM_USABLE_UNVERIFIED,
  roomUsableBase,
  type RoomUsableBase,
  type RoomUsableDeps,
} from './room-usable';

const Y = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
// PostgREST はマイクロ秒まで返す。受け取った文字列のまま渡す
const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';
const T2 = '2026-10-29T01:02:05.000001+00:00';

const ry = (room_id: string, usable: boolean, updated_at: string, note: string | null = null) => ({ year_id: Y, room_id, usable, note, updated_at });
const base = (p: Partial<RoomUsableBase> = {}): RoomUsableBase => ({ roomId: R, usable: true, note: null, updatedAt: T0, maybeSaved: false, ...p });

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

/** 応答が届かなかった（supabase-js は通信の失敗を code '' と status 0 で返す） */
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
/** コードのない 5xx（ゲートウェイの時間切れなど）。保存されたかは分からない */
const GATEWAY: FakeResult = { error: { message: 'Service Unavailable' }, status: 503 };

const failingReload = async () => {
  throw new TypeError('Failed to fetch');
};

describe('roomUsableBase', () => {
  it('room_years の行の usable・note と updated_at（受け取った文字列のまま）。行のない部屋は使用可で updatedAt は null', () => {
    const rows = [ry(R, false, T0, '工事')];
    expect(roomUsableBase(rows, R)).toEqual({ roomId: R, usable: false, note: '工事', updatedAt: T0, maybeSaved: false });
    expect(roomUsableBase(rows, R2)).toEqual({ roomId: R2, usable: true, note: null, updatedAt: null, maybeSaved: false });
  });
});

describe('changeRoomUsable（部屋の見出しから使用不可にする・使用可に戻す）', () => {
  it('開いたときの room_years.updated_at を条件に update する。成功なら読み直さない（呼ぶ側が知らせと一緒に読み直す）', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1, '工事') });
    const reload = vi.fn();
    const out = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: '工事' }, { save, reload });
    expect(out).toEqual({ kind: 'saved', recovered: false });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['update', 'match', 'eq', 'select', 'maybeSingle']);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', T0]]);
    expect(opArgs(issued[0]!, 'update')).toEqual([[{ usable: false, note: '工事' }]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('行のなかった部屋（updatedAt が null）は insert する', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1) });
    const out = await changeRoomUsable({ yearId: Y, base: base({ updatedAt: null }), usable: false, note: null }, { save, reload: vi.fn() });
    expect(out.kind).toBe('saved');
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['insert', 'select', 'maybeSingle']);
  });

  it('ほかの人が先に変えた（update が 0 行で updated_at が違う）→ 読み直して「ほかの人がこの部屋の使用を変えました」。まだ使用可ならダイアログを残し、読み直した updated_at で押し直せる', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    // ほかの人はメモだけを変えた（使用可のまま）
    const reload = vi.fn(async () => ({ roomYears: [ry(R, true, T1, '別のメモ')] }));
    const out = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: '工事' }, { save, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1 }), done: false });
    expect(ROOM_USABLE_CONFLICT).toMatch(/^ほかの人がこの部屋の使用を変えました/);
  });

  it('ほかの人がすでに使用不可にしていた → 読み直して知らせ、done（ダイアログを閉じる）。値が送ったものと同じでも、応答の届かない送信がなければほかの人の変更', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    const other = await changeRoomUsable(
      { yearId: Y, base: base(), usable: false, note: '工事' },
      { save, reload: async () => ({ roomYears: [ry(R, false, T1, 'ほかの人のメモ')] }) },
    );
    expect(other).toMatchObject({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, done: true, next: { usable: false, updatedAt: T1 } });
    const same = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: null }, { save, reload: async () => ({ roomYears: [ry(R, false, T1)] }) });
    expect(same).toMatchObject({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, done: true });
  });

  it('行のなかった部屋にほかの人が先に足した（insert の 23505）→ conflict として読み直す', async () => {
    const { save } = fakeSave({ error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 });
    const out = await changeRoomUsable(
      { yearId: Y, base: base({ updatedAt: null }), usable: false, note: null },
      { save, reload: async () => ({ roomYears: [ry(R, true, T1)] }) },
    );
    expect(out).toMatchObject({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, done: false, next: { updatedAt: T1 } });
  });

  it('行が消えていた（not_found）→ 読み直して conflict と同じに知らせる。行がなくなったので次は insert（updatedAt は null）', async () => {
    const { save } = fakeSave({ data: null }, { data: null });
    const out = await changeRoomUsable({ yearId: Y, base: base({ usable: false }), usable: true, note: null }, { save, reload: async () => ({ roomYears: [] }) });
    // 行がない部屋は使用可：使用可に戻したかったので done
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ updatedAt: null }), done: true });
  });

  it('conflict の後の読み直しに失敗したら「読み直しました」と言わない。ダイアログ（メモ）は残し、確かめるまで押させない（unchecked）', async () => {
    const save = vi.fn(async () => {
      throw appError('conflict', 'lock_conflict');
    });
    const b = base();
    const failed = await changeRoomUsable({ yearId: Y, base: b, usable: false, note: '工事' }, { save, reload: failingReload });
    expect(failed).toEqual({ kind: 'unchecked', after: 'conflict', message: ROOM_USABLE_CONFLICT_UNREAD, base: b });
    expect(ROOM_USABLE_CONFLICT_UNREAD).toMatch(/^ほかの人がこの部屋の使用を変えました。読み直せませんでした/);
    expect(ROOM_USABLE_CONFLICT_UNREAD).not.toContain('読み直しました');
    // react-query の refetch が失敗を返した（undefined）ときも同じ
    const empty = await changeRoomUsable({ yearId: Y, base: b, usable: false, note: '工事' }, { save, reload: async () => undefined });
    expect(empty).toMatchObject({ kind: 'unchecked', after: 'conflict' });
    // 通信が戻って「確かめる」：読み直せたら、いつもの conflict（読み直しました）
    const checked = await checkRoomUsable(
      { base: b, usable: false, note: '工事', after: 'conflict' },
      { reload: async () => ({ roomYears: [ry(R, true, T1, '別のメモ')] }) },
    );
    expect(checked).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1 }), done: false });
  });

  it('conflict・not_found・応答の届かない失敗以外（RLS の forbidden など）は読み直さずに error で返す（呼ぶ側が messageFor・effectOf で分ける）', async () => {
    const reload = vi.fn();
    const rls = fakeSave({ data: null }, { data: { updated_at: T0 } });
    const forbidden = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: null }, { save: rls.save, reload });
    expect(forbidden).toMatchObject({ kind: 'error', error: { kind: 'forbidden', reason: 'lock_unchanged' } });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('changeRoomUsable：応答が届かなかったとき（network・コードのない 5xx。送り直す前に読み直して確かめる。2.6）', () => {
  it('update が通っていた（読み直した行が送った usable と note〔前後の空白を除く〕と同じ）→ 保存されていました（recovered）', async () => {
    const { save } = fakeSave(NETWORK);
    const reload = vi.fn(async () => ({ roomYears: [ry(R, false, T1, '工事')] }));
    const out = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: '  工事 ' }, { save, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'saved', recovered: true });
  });

  it('insert が通っていなかった（コードのない 503。読み直しても行がなく updated_at は開いたときのまま）→ not-saved。同じ base で押し直してよい', async () => {
    const { save } = fakeSave(GATEWAY);
    const out = await changeRoomUsable({ yearId: Y, base: base({ updatedAt: null }), usable: false, note: '工事' }, { save, reload: async () => ({ roomYears: [] }) });
    expect(out).toEqual({ kind: 'not-saved', message: ROOM_USABLE_NOT_SAVED, next: base({ updatedAt: null, maybeSaved: true }) });
  });

  it('読み直すと、ほかの人の変更（自分の値でなく updated_at が進んでいる）→ conflict。読み直した updated_at に当て直す', async () => {
    const { save } = fakeSave(NETWORK);
    const out = await changeRoomUsable(
      { yearId: Y, base: base(), usable: false, note: '工事' },
      { save, reload: async () => ({ roomYears: [ry(R, true, T1, '別のメモ')] }) },
    );
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1, maybeSaved: true }), done: false });
  });

  it('読み直しも失敗 → unchecked（「保存できたか確かめられません…『確かめる』」）。base に maybeSaved を付け、確かめて自分の値なら保存されていました', async () => {
    const { save } = fakeSave(NETWORK);
    const out = await changeRoomUsable({ yearId: Y, base: base(), usable: false, note: '工事' }, { save, reload: failingReload });
    expect(out).toEqual({ kind: 'unchecked', after: 'unknown', message: ROOM_USABLE_UNVERIFIED, base: base({ maybeSaved: true }) });
    expect(ROOM_USABLE_UNVERIFIED).toBe('保存できたか確かめられません。通信が戻ったら『確かめる』を押してください');
    // まだ読めないまま「確かめる」を押した
    const again = await checkRoomUsable({ base: base({ maybeSaved: true }), usable: false, note: '工事', after: 'unknown' }, { reload: failingReload });
    expect(again).toMatchObject({ kind: 'unchecked', after: 'unknown', message: ROOM_USABLE_UNVERIFIED });
    // 通信が戻って「確かめる」
    const checked = await checkRoomUsable(
      { base: base({ maybeSaved: true }), usable: false, note: '工事', after: 'unknown' },
      { reload: async () => ({ roomYears: [ry(R, false, T1, '工事')] }) },
    );
    expect(checked).toEqual({ kind: 'saved', recovered: true });
  });

  it('応答の届かない送信の後、押し直すと conflict（先の送信が後から通っていた）で、読み直した行が自分の値 → ほかの人のせいにせず、保存されていました', async () => {
    // 1回目：応答が届かず、読み直した時点ではまだ反映されていなかった（not-saved。base は maybeSaved のまま）
    const first = await changeRoomUsable(
      { yearId: Y, base: base(), usable: false, note: '工事' },
      { save: fakeSave(NETWORK).save, reload: async () => ({ roomYears: [ry(R, true, T0)] }) },
    );
    expect(first.kind).toBe('not-saved');
    const next = first.kind === 'not-saved' ? first.next : base();
    expect(next.maybeSaved).toBe(true);
    // 2回目：1回目が通って updated_at が進んでいたので 0 行（conflict）。読み直すと自分の値
    const second = await changeRoomUsable(
      { yearId: Y, base: next, usable: false, note: '工事' },
      { save: fakeSave({ data: null }, { data: { updated_at: T2 } }).save, reload: async () => ({ roomYears: [ry(R, false, T2, '工事')] }) },
    );
    expect(second).toEqual({ kind: 'saved', recovered: true });
    // insert（行のなかった部屋）の 23505 でも同じ
    const viaInsert = await changeRoomUsable(
      { yearId: Y, base: base({ updatedAt: null, maybeSaved: true }), usable: false, note: null },
      { save: fakeSave({ error: { code: '23505', message: 'duplicate key' }, status: 409 }).save, reload: async () => ({ roomYears: [ry(R, false, T2)] }) },
    );
    expect(viaInsert).toEqual({ kind: 'saved', recovered: true });
  });

  it('応答の届かない送信の後の conflict でも、usable だけ同じでメモが違えば、ほかの人の変更（done で閉じる）', async () => {
    const out = await changeRoomUsable(
      { yearId: Y, base: base({ maybeSaved: true }), usable: false, note: '工事' },
      { save: fakeSave({ data: null }, { data: { updated_at: T2 } }).save, reload: async () => ({ roomYears: [ry(R, false, T2, 'ほかの人のメモ')] }) },
    );
    expect(out).toMatchObject({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, done: true });
  });
});
