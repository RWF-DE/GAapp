import { describe, expect, it, vi } from 'vitest';
import { setRoomUsable } from '@/lib/data/room-years';
import { appError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  changeRoomUsable,
  ROOM_USABLE_CONFLICT,
  ROOM_USABLE_UNREAD,
  roomDialogAfter,
  roomUsableBase,
  roomUsableUnknownMessage,
  settleRoomUsable,
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
const base = (p: Partial<RoomUsableBase> = {}): RoomUsableBase => ({ roomId: R, usable: true, note: null, updatedAt: T0, ...p });
const args = (p: { base?: RoomUsableBase; usable?: boolean; note?: string | null } = {}) => ({
  yearId: Y,
  base: p.base ?? base(),
  usable: p.usable ?? false,
  note: p.note === undefined ? '工事' : p.note,
  roomName: 'MER',
});
/** 読み直したスナップショット（room_years だけ） */
const reloadTo = (...rows: ReturnType<typeof ry>[]) => vi.fn(async () => ({ roomYears: rows }));
/** 23505（行のなかった部屋の insert に、ほかの人が先に行を足した） */
const DUP: FakeResult = { error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 };

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
    expect(roomUsableBase(rows, R)).toEqual({ roomId: R, usable: false, note: '工事', updatedAt: T0 });
    expect(roomUsableBase(rows, R2)).toEqual({ roomId: R2, usable: true, note: null, updatedAt: null });
  });
});

describe('changeRoomUsable（部屋の見出しから使用不可にする・使用可に戻す）', () => {
  it('開いたときの room_years.updated_at を条件に update する。成功なら読み直さない（呼ぶ側が知らせと一緒に読み直す）', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1, '工事') });
    const reload = vi.fn();
    const out = await changeRoomUsable(args(), { save, reload });
    expect(out).toEqual({ kind: 'saved', recovered: false });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['update', 'match', 'eq', 'select', 'maybeSingle']);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', T0]]);
    expect(opArgs(issued[0]!, 'update')).toEqual([[{ usable: false, note: '工事' }]]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('行のなかった部屋（updatedAt が null）は insert する', async () => {
    const { save, issued } = fakeSave({ data: ry(R, false, T1) });
    const out = await changeRoomUsable(args({ base: base({ updatedAt: null }), note: null }), { save, reload: vi.fn() });
    expect(out.kind).toBe('saved');
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['insert', 'select', 'maybeSingle']);
  });

  it('conflict・not_found・応答の届かない失敗以外（RLS の forbidden など）は読み直さずに error で返す（呼ぶ側が messageFor・effectOf で分ける）', async () => {
    const reload = vi.fn();
    const rls = fakeSave({ data: null }, { data: { updated_at: T0 } });
    const forbidden = await changeRoomUsable(args({ note: null }), { save: rls.save, reload });
    expect(forbidden).toMatchObject({ kind: 'error', error: { kind: 'forbidden', reason: 'lock_unchanged' } });
    // コードつきで返った失敗（statement timeout など）は届いた失敗（何も保存されていない）
    const timeout = fakeSave({ error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 });
    expect(await changeRoomUsable(args(), { save: timeout.save, reload })).toMatchObject({ kind: 'error' });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('changeRoomUsable：conflict・not_found・23505 で止められたとき（読み直して settleLockedWrite。2.6 の (B1) の 3）', () => {
  it('changed：ほかの人がメモだけを変えた（使用可のまま）→「ほかの人がこの部屋の使用を変えました。読み直しました」。読み直した行を次の base にする', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    const reload = reloadTo(ry(R, true, T1, '別のメモ'));
    const out = await changeRoomUsable(args(), { save, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1 }) });
  });

  it('saved：読み直した行が送った usable と note（前後の空白を除く）と同じ → 保存されていました（自分の前の送信が後から通っていた。ほかの人のせいにしない）', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T2 } });
    const out = await changeRoomUsable(args({ note: '  工事 ' }), { save, reload: reloadTo(ry(R, false, T2, '工事')) });
    expect(out).toEqual({ kind: 'saved', recovered: true });
  });

  it('メモだけ違う done：ほかの人がすでに使用不可にしていた → 「ほかの人がすでにMERを使用不可にしていました（入れたメモは保存していません）」で閉じる（already）', async () => {
    const { save } = fakeSave({ data: null }, { data: { updated_at: T1 } });
    const out = await changeRoomUsable(args(), { save, reload: reloadTo(ry(R, false, T1, 'ほかの人のメモ')) });
    expect(out).toEqual({ kind: 'already', message: 'ほかの人がすでにMERを使用不可にしていました（入れたメモは保存していません）' });
    // メモを入れていなければ、メモのことは言わない
    const noNote = await changeRoomUsable(args({ note: '  ' }), { save, reload: reloadTo(ry(R, false, T1, 'ほかの人のメモ')) });
    expect(noNote).toEqual({ kind: 'already', message: 'ほかの人がすでにMERを使用不可にしていました' });
  });

  it('使用可に戻すも同じ形：行が消えていた（not_found）→ 行のない部屋は使用可なので already（「ほかの人がすでにMERを使用可に戻していました」）', async () => {
    const { save } = fakeSave({ data: null }, { data: null });
    const out = await changeRoomUsable(args({ base: base({ usable: false }), usable: true, note: null }), { save, reload: reloadTo() });
    expect(out).toEqual({ kind: 'already', message: 'ほかの人がすでにMERを使用可に戻していました' });
  });

  it('not_found で、ほかの人が消した後に使用不可にしたかった → conflict。行がなくなったので次は insert（updatedAt は null）', async () => {
    const { save } = fakeSave({ data: null }, { data: null });
    const out = await changeRoomUsable(args({ base: base({ usable: true, note: 'メモ' }) }), { save, reload: reloadTo() });
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ updatedAt: null }) });
  });

  it('23505（行のなかった部屋に、ほかの人が先に足した）→ 読み直して conflict。自分の値なら saved', async () => {
    const other = await changeRoomUsable(args({ base: base({ updatedAt: null }), note: null }), { save: fakeSave(DUP).save, reload: reloadTo(ry(R, true, T1)) });
    expect(other).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ updatedAt: T1 }) });
    // 前の送信（応答が届かなかった insert）が後から通っていた
    const mine = await changeRoomUsable(args({ base: base({ updatedAt: null }), note: null }), { save: fakeSave(DUP).save, reload: reloadTo(ry(R, false, T2)) });
    expect(mine).toEqual({ kind: 'saved', recovered: true });
  });

  it('not-saved（止められたのに版が開いたときのまま）も conflict の扱い', async () => {
    const save = vi.fn(async () => {
      throw appError('conflict', 'lock_conflict');
    });
    const out = await changeRoomUsable(args(), { save, reload: reloadTo(ry(R, true, T0, null)) });
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base() });
  });

  it('unread：読み直しに失敗したら「読み直しました」と言わず、「読み直す」を押してもらう（ダイアログとメモは残す）', async () => {
    const save = vi.fn(async () => {
      throw appError('conflict', 'lock_conflict');
    });
    const failed = await changeRoomUsable(args(), { save, reload: failingReload });
    expect(failed).toEqual({ kind: 'unread', message: ROOM_USABLE_UNREAD });
    expect(ROOM_USABLE_UNREAD).toContain('読み直せませんでした');
    expect(ROOM_USABLE_UNREAD).toContain('「読み直す」を押してください');
    expect(ROOM_USABLE_UNREAD).not.toContain('読み直しました');
    // react-query の refetch が失敗を返した（undefined）ときも同じ
    expect(await changeRoomUsable(args(), { save, reload: async () => undefined })).toEqual({ kind: 'unread', message: ROOM_USABLE_UNREAD });
    // 次の保存もまた同じ道を通る（確かめる状態は持たない）：読み直せたら、いつもの conflict
    const again = await changeRoomUsable(args(), { save, reload: reloadTo(ry(R, true, T1, '別のメモ')) });
    expect(again).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1 }) });
  });
});

describe('changeRoomUsable：応答が届かなかったとき（network・コードのない 5xx。その場で1回読み直す。2.6 の (B1) の 1）', () => {
  it('saved：update が通っていた（読み直した行が送った usable と note と同じ）→ 保存されていました', async () => {
    const { save } = fakeSave(NETWORK);
    const reload = reloadTo(ry(R, false, T1, '工事'));
    const out = await changeRoomUsable(args({ note: '  工事 ' }), { save, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: 'saved', recovered: true });
  });

  it('not-saved：insert が通っていなかった（コードのない 503。読み直しても行がなく、版は開いたときのまま）→ 押したボタンに合う「…できたか分かりません」', async () => {
    const { save } = fakeSave(GATEWAY);
    const out = await changeRoomUsable(args({ base: base({ updatedAt: null }) }), { save, reload: reloadTo() });
    expect(out).toEqual({ kind: 'unknown', message: roomUsableUnknownMessage(false) });
  });

  it('unread：読み直しも失敗 → 押したボタンに合う「…できたか分かりません」（確かめるボタンは出さず、次はふつうに送る）', async () => {
    const { save } = fakeSave(NETWORK);
    const out = await changeRoomUsable(args(), { save, reload: failingReload });
    expect(out).toEqual({ kind: 'unknown', message: roomUsableUnknownMessage(false) });
  });

  it('changed：読み直すと、ほかの人の変更（自分の値でなく版が進んでいる）→ conflict。読み直した updated_at に当て直す', async () => {
    const { save } = fakeSave(NETWORK);
    const out = await changeRoomUsable(args(), { save, reload: reloadTo(ry(R, true, T1, '別のメモ')) });
    expect(out).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: '別のメモ', updatedAt: T1 }) });
  });

  it('changed で、ほかの人がすでに使用不可にしていた（メモだけ違う）→ already で閉じる', async () => {
    const { save } = fakeSave(NETWORK);
    const out = await changeRoomUsable(args(), { save, reload: reloadTo(ry(R, false, T1, 'ほかの人のメモ')) });
    expect(out).toEqual({ kind: 'already', message: 'ほかの人がすでにMERを使用不可にしていました（入れたメモは保存していません）' });
  });

  it('応答の届かない送信の後、同じ base で押し直すと、先の送信が後から通っていれば DB が止め（conflict）、読み直して自分の値なら保存されていました', async () => {
    // 1回目：応答が届かず、読み直した時点ではまだ反映されていなかった（unknown。base はそのまま）
    const first = await changeRoomUsable(args(), { save: fakeSave(NETWORK).save, reload: reloadTo(ry(R, true, T0)) });
    expect(first).toEqual({ kind: 'unknown', message: roomUsableUnknownMessage(false) });
    // 2回目：1回目が通って updated_at が進んでいたので 0 行（conflict）。何も上書きされず、読み直すと自分の値
    const second = await changeRoomUsable(args(), {
      save: fakeSave({ data: null }, { data: { updated_at: T2 } }).save,
      reload: reloadTo(ry(R, false, T2, '工事')),
    });
    expect(second).toEqual({ kind: 'saved', recovered: true });
  });
});

describe('部屋のダイアログで応答が届かなかったときの文（ボタンの名前に合わせる）', () => {
  it('使用不可にする・使用可に戻すのボタンの名前で言う（「保存」とは言わない）', () => {
    expect(roomUsableUnknownMessage(false)).toBe('使用不可にできたか分かりません。もう一度「使用不可にする」を押すと、確かめてから送ります');
    expect(roomUsableUnknownMessage(true)).toBe('使用可に戻せたか分かりません。もう一度「使用可に戻す」を押すと、確かめてから送ります');
  });

  it('changeRoomUsable の unknown は押したボタンに合う文', async () => {
    const off = await changeRoomUsable(args(), { save: fakeSave(NETWORK).save, reload: failingReload });
    expect(off).toEqual({ kind: 'unknown', message: roomUsableUnknownMessage(false) });
    const on = await changeRoomUsable(args({ base: base({ usable: false }), usable: true, note: null }), { save: fakeSave(GATEWAY).save, reload: reloadTo(ry(R, false, T0)) });
    expect(on).toEqual({ kind: 'unknown', message: roomUsableUnknownMessage(true) });
    expect(on.kind === 'unknown' && on.message).not.toContain('「保存」');
  });
});

describe('roomDialogAfter（結果が出るたびに、前の結果の知らせを消してから今の結果の知らせを出す）', () => {
  const prevUnread = { base: base(), unread: ROOM_USABLE_UNREAD };

  it('止められて読み直せなかった後、次の押下がほかの失敗（forbidden・state・deadlock など）で終わったら、古い「読み直せませんでした」を消す', () => {
    for (const err of [appError('forbidden', 'lock_unchanged'), appError('state', 'year_not_allocating'), appError('deadlock', '40P01')]) {
      const out = { kind: 'error' as const, error: err.info };
      expect(roomDialogAfter(prevUnread, out)).toEqual({ base: base(), unread: null });
    }
  });

  it('応答が届かなかった（unknown）・conflict でも古い知らせを消す。conflict だけ入力の元を付け替える', () => {
    expect(roomDialogAfter(prevUnread, { kind: 'unknown', message: roomUsableUnknownMessage(false) })).toEqual({ base: base(), unread: null });
    const next = base({ note: '別のメモ', updatedAt: T1 });
    expect(roomDialogAfter(prevUnread, { kind: 'conflict', message: ROOM_USABLE_CONFLICT, next })).toEqual({ base: next, unread: null });
  });

  it('今の結果が unread のときだけ知らせを出す。saved・already は閉じる', () => {
    expect(roomDialogAfter({ base: base(), unread: null }, { kind: 'unread', message: ROOM_USABLE_UNREAD })).toEqual({ base: base(), unread: ROOM_USABLE_UNREAD });
    expect(roomDialogAfter(prevUnread, { kind: 'saved', recovered: true })).toBeNull();
    expect(roomDialogAfter(prevUnread, { kind: 'already', message: 'x' })).toBeNull();
  });
});

describe('settleRoomUsable（「読み直す」も、止められた後と同じ判定を通す）', () => {
  const settle = (reload: RoomUsableDeps['reload'], p: { usable?: boolean; note?: string | null } = {}) =>
    settleRoomUsable({ base: base(), usable: p.usable ?? false, note: p.note === undefined ? '工事' : p.note, roomName: 'MER', unknown: false }, reload);

  it('読み直した行が今の入力と同じ → saved（保存されていました）', async () => {
    expect(await settle(reloadTo(ry(R, false, T1, '工事')), { note: ' 工事 ' })).toEqual({ kind: 'saved', recovered: true });
  });

  it('ほかの人が変えていた（版が進んだ）→ conflict。読み直した行を入力の元にする', async () => {
    expect(await settle(reloadTo(ry(R, true, T1, 'E2E')))).toEqual({ kind: 'conflict', message: ROOM_USABLE_CONFLICT, next: base({ note: 'E2E', updatedAt: T1 }) });
  });

  it('ほかの人がすでに望んだ状態にしていた（メモだけ違う）→ already', async () => {
    expect(await settle(reloadTo(ry(R, false, T1, 'ほかの人のメモ')))).toEqual({
      kind: 'already',
      message: 'ほかの人がすでにMERを使用不可にしていました（入れたメモは保存していません）',
    });
  });

  it('また読み直せなかった → unread（知らせを残す）', async () => {
    expect(await settle(failingReload)).toEqual({ kind: 'unread', message: ROOM_USABLE_UNREAD });
  });
});
