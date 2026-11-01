// シフト表・自分のシフトの読み取りと書き込み（04「シフト表」「自分のシフト」、notes/T20.md「画面の約束」2・3。T20）：読み方（select・
// 絞り込み・並び・埋め込み）、送る値（画面の id・updated_at の文字列のまま・upsert の衝突の列・送らない列）、RPC の引数、0 行の分類、
// invalidate のキー。Supabase は偽のクライアント。
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { MY_SHIFTS_SELECT } from '@/lib/modules/shifts/reads';
import { createFakeSupabase, opArgs, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  addShiftSlots,
  assign,
  deleteDuty,
  deleteNeed,
  insertDuty,
  insertSlot,
  invalidateShifts,
  loadMyShifts,
  loadShiftBoard,
  loadShiftMembers,
  loadSoumuNames,
  moveAssignment,
  newShiftId,
  readSlotsOfDay,
  shiftBoardOptions,
  shiftsInvalidateKeys,
  SHIFT_DUTIES_SELECT,
  SHIFT_SLOTS_SELECT,
  unassign,
  updateBoardCache,
  updateDuty,
  updateSlot,
  upsertNeed,
} from './shifts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const D = uuid(2);
const S = uuid(3);
const U = uuid(4);
const V = '2027-10-01T00:00:00.123456+00:00';

const fake = (result: FakeResult | ((table: string) => FakeResult)) => createFakeSupabase((call) => (typeof result === 'function' ? result(call.table) : result));

describe('T20 シフト表の読み取り', () => {
  it('時間枠（ますと割り当てを埋め込む。開始・id の順）と持ち場を並行に fetchAll', async () => {
    const { client, issued } = fake((t) => ({ data: t === 'shift_slots' ? [{ id: S }] : [{ id: D }] }));
    const b = await loadShiftBoard(Y, client);
    expect(b).toEqual({ slots: [{ id: S }], duties: [{ id: D }] });
    const slots = issued.find((c) => c.table === 'shift_slots')!;
    expect(opArgs(slots, 'select')[0]![0]).toBe(SHIFT_SLOTS_SELECT);
    expect(SHIFT_SLOTS_SELECT).toBe('id, starts_at, ends_at, updated_at, shift_needs(duty_id, required_count, updated_at, shift_assignments(user_id, updated_at))');
    expect(opArgs(slots, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(slots, 'order').map((a) => a[0])).toEqual(['starts_at', 'id']);
    expect(opArgs(slots, 'range')[0]).toEqual([0, 999]);
    const duties = issued.find((c) => c.table === 'shift_duties')!;
    expect(opArgs(duties, 'select')[0]![0]).toBe(SHIFT_DUTIES_SELECT);
    expect(shiftBoardOptions(Y).queryKey).toEqual(['year', Y, 'shifts', 'board']);
  });

  it('自分の割り当て（時間枠・持ち場・同じますの人を埋め込む。year_id と user_id で絞る）・表示名（全部）・ロールの一覧', async () => {
    const { client, issued } = fake({ data: [] });
    await loadMyShifts(Y, client, U);
    await loadSoumuNames(client);
    await loadShiftMembers(Y, client);
    const [mine, names, members] = issued;
    expect(mine!.table).toBe('shift_assignments');
    expect(opArgs(mine!, 'select')[0]![0]).toBe(MY_SHIFTS_SELECT);
    expect(MY_SHIFTS_SELECT).toBe(
      'slot_id, duty_id, updated_at, shift_needs(required_count, shift_slots(id, starts_at, ends_at), shift_duties(id, name, place, note), shift_assignments(user_id))',
    );
    expect(opArgs(mine!, 'eq')).toEqual([
      ['year_id', Y],
      ['user_id', U],
    ]);
    expect(names!.table).toBe('profiles');
    expect(opArgs(names!, 'select')[0]![0]).toBe('user_id, display_name');
    expect(opArgs(names!, 'eq')).toEqual([]);
    expect(members!.table).toBe('year_roles');
    expect(opArgs(members!, 'select')[0]![0]).toBe('user_id, role');
    expect(opArgs(members!, 'eq')).toEqual([['year_id', Y]]);
  });

  it('その日に始まる時間枠（(B2) の確かめ。Asia/Tokyo の 0 時から次の日の 0 時の前まで）', async () => {
    const { client, issued } = fake({ data: [] });
    await readSlotsOfDay(Y, '2027-10-15', client);
    expect(opArgs(issued[0]!, 'gte')).toEqual([['starts_at', '2027-10-15T00:00:00+09:00']]);
    expect(opArgs(issued[0]!, 'lt')).toEqual([['starts_at', '2027-10-16T00:00:00+09:00']]);
  });
});

describe('T20 シフト表の書き込み', () => {
  it('持ち場を足す：画面の id と year_id と送る値だけ（書いた人・日時は送らない）', async () => {
    const { client, issued } = fake({ data: { id: D } });
    await insertDuty(Y, D, { name: '受付', place: null, note: null, sort_order: 1 }, client);
    expect(opArgs(issued[0]!, 'insert')[0]![0]).toEqual({ id: D, year_id: Y, name: '受付', place: null, note: null, sort_order: 1 });
    expect(opArgs(issued[0]!, 'select')[0]![0]).toBe(SHIFT_DUTIES_SELECT);
  });

  it('持ち場・時間枠を直す・消す：読んだときの updated_at の文字列のまま条件に入れる。0 行は読み直して not_found・conflict・forbidden', async () => {
    const ok = fake({ data: { id: D, name: '受付', place: null, note: null, sort_order: 1, updated_at: 'v2', created_at: 'c', year_id: Y } });
    const row = await updateDuty({ id: D, updated_at: V }, { name: '受付', place: null, note: null, sort_order: 1 }, ok.client);
    expect(row).toEqual({ id: D, name: '受付', place: null, note: null, sort_order: 1, updated_at: 'v2' });
    expect(opArgs(ok.issued[0]!, 'eq')).toEqual([['updated_at', V]]);
    expect(opArgs(ok.issued[0]!, 'match')).toEqual([[{ id: D }]]);

    const { client: c2, issued: i2 } = fake({ data: { id: S, starts_at: 'a', ends_at: 'b', updated_at: 'v3', year_id: Y } });
    await updateSlot({ id: S, updated_at: V }, { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' }, c2);
    expect(opArgs(i2[0]!, 'update')[0]![0]).toEqual({ starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' });

    let n = 0;
    const zero = createFakeSupabase(() => (n++ === 0 ? { data: [] } : { data: { updated_at: 'other' } }));
    await expect(deleteDuty({ id: D, updated_at: V }, zero.client)).rejects.toMatchObject({ info: { kind: 'conflict', reason: 'lock_conflict' } });
    let m = 0;
    const gone = createFakeSupabase(() => (m++ === 0 ? { data: [] } : { data: null }));
    await expect(deleteDuty({ id: D, updated_at: V }, gone.client)).rejects.toMatchObject({ info: { kind: 'not_found' } });
  });

  it('時間枠を足す（`+09:00`）。重なりは invalid_input（overlap）の AppError', async () => {
    const { client, issued } = fake({ error: { code: 'P0001', message: 'invalid_input', details: JSON.stringify({ field: 'starts_at', reason: 'overlap', slot_id: S }) }, status: 400 });
    const p = insertSlot(Y, S, { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' }, client);
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ info: { kind: 'input', details: { reason: 'overlap', slot_id: S } } });
    expect(opArgs(issued[0]!, 'insert')[0]![0]).toEqual({ id: S, year_id: Y, starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' });
  });

  it('必要人数：数の絶対値の upsert（slot_id, duty_id の衝突で上書き）。ますを外すのは updated_at を条件に入れた delete', async () => {
    const { client, issued } = fake({ data: { slot_id: S, duty_id: D, required_count: 3, updated_at: 'v' } });
    await upsertNeed(Y, S, D, 3, client);
    expect(opArgs(issued[0]!, 'upsert')[0]).toEqual([{ year_id: Y, slot_id: S, duty_id: D, required_count: 3 }, { onConflict: 'slot_id,duty_id' }]);
    const del = fake({ data: [{ slot_id: S }] });
    await deleteNeed({ slot_id: S, duty_id: D, updated_at: V }, del.client);
    expect(opArgs(del.issued[0]!, 'match')).toEqual([[{ slot_id: S, duty_id: D }]]);
    expect(opArgs(del.issued[0]!, 'eq')).toEqual([['updated_at', V]]);
  });

  it('割り当てる（主キー (slot_id, user_id) の insert）・外す（delete）・移す（duty_id の update 1回）', async () => {
    const a = fake({ data: { slot_id: S, duty_id: D, user_id: U, updated_at: 'v' } });
    await assign(Y, S, D, U, a.client);
    expect(opArgs(a.issued[0]!, 'insert')[0]![0]).toEqual({ year_id: Y, slot_id: S, duty_id: D, user_id: U });
    const un = fake({ data: [{ slot_id: S }] });
    await unassign({ slot_id: S, user_id: U, updated_at: V }, un.client);
    expect(opArgs(un.issued[0]!, 'match')).toEqual([[{ slot_id: S, user_id: U }]]);
    const mv = fake({ data: { slot_id: S, duty_id: uuid(9), user_id: U, updated_at: 'v2', year_id: Y, created_at: 'c' } });
    expect(await moveAssignment({ slot_id: S, user_id: U, updated_at: V }, uuid(9), mv.client)).toEqual({ slot_id: S, duty_id: uuid(9), user_id: U, updated_at: 'v2' });
    expect(opArgs(mv.issued[0]!, 'update')[0]![0]).toEqual({ duty_id: uuid(9) });
  });

  it('1日分は RPC add_shift_slots（p_year_id・p_slots・p_needs）。返り値は作った時間枠', async () => {
    const { client, issued } = fake({ data: [{ id: S, starts_at: 'a', ends_at: 'b', updated_at: 'v', year_id: Y, created_at: 'c' }] });
    const rows = await addShiftSlots(Y, [{ starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' }], [{ duty_id: D, required_count: 1 }], client);
    expect(rows).toEqual([{ id: S, starts_at: 'a', ends_at: 'b', updated_at: 'v' }]);
    expect(issued[0]!.table).toBe('rpc:add_shift_slots');
    expect(issued[0]!.ops[0]!.args[0]).toEqual({
      p_year_id: Y,
      p_slots: [{ starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' }],
      p_needs: [{ duty_id: D, required_count: 1 }],
    });
  });

  it('1日分の送る前の確かめ（オフセットのない日時・97 個は送らない）', async () => {
    const { client, issued } = fake({ data: [] });
    await expect(addShiftSlots(Y, [{ starts_at: '2027-10-15T09:00:00', ends_at: '2027-10-15T10:00:00' }], [], client)).rejects.toMatchObject({ info: { kind: 'input' } });
    const many = Array.from({ length: 97 }, () => ({ starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' }));
    await expect(addShiftSlots(Y, many, [], client)).rejects.toMatchObject({ info: { kind: 'input' } });
    expect(issued).toHaveLength(0);
  });

  it('読み直すキー（シフト・作業の画面とダッシュボードのシフト・作業）と、表のキャッシュの直し方', () => {
    expect(shiftsInvalidateKeys(Y)).toEqual([
      ['year', Y, 'shifts'],
      ['year', Y, 'portal', 'shifts'],
    ]);
    const qc = new QueryClient();
    invalidateShifts(qc, Y);
    updateBoardCache(qc, Y, (b) => b);
    expect(qc.getQueryData(shiftBoardOptions(Y).queryKey)).toBeUndefined();
    qc.setQueryData(shiftBoardOptions(Y).queryKey, { slots: [], duties: [] });
    updateBoardCache(qc, Y, (b) => ({ ...b, duties: [{ id: D, name: 'x', place: null, note: null, sort_order: 0, updated_at: 'v' }] }));
    expect(qc.getQueryData(shiftBoardOptions(Y).queryKey)).toMatchObject({ duties: [{ id: D }] });
  });

  it('画面が作る id は uuid v4（crypto.randomUUID がないときは getRandomValues）', () => {
    expect(newShiftId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const c = globalThis.crypto;
    const orig = c.randomUUID;
    try {
      Object.defineProperty(c, 'randomUUID', { value: undefined, configurable: true });
      expect(newShiftId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(c, 'randomUUID', { value: orig, configurable: true });
    }
  });
});
