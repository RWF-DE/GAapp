import { describe, expect, it } from 'vitest';
import type { ItemRow, RoomRow, RoomYearRow, StockDbRow } from '@/lib/db/types';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  buildStockMatrix,
  countedByRoom,
  countsFromRows,
  detectOtherSave,
  fetchPreviousYearStocks,
  fetchProfileNames,
  fetchRoomAllocated,
  formatCell,
  formatDiff,
  groupByBuilding,
  latestCounted,
  nextUncountedRoom,
  placeOf,
  sameCounts,
  saveRoomStocks,
  shortfallMessage,
  shortfalls,
  stockAccess,
  stockPath,
  storageRooms,
  stockUrl,
  STAFF_ALLOCATING_MESSAGE,
  toUpsertRows,
  uncountedRooms,
} from './stocks';

const Y = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const room = (n: number, o: Partial<RoomRow> = {}): RoomRow => ({
  id: id(n),
  name: `部屋${n}`,
  aliases: [],
  kind: 'room',
  building: '1号棟',
  floor: 1,
  extra_cost: 0,
  is_storage: true,
  sort_order: n,
  updated_at: 't',
  ...o,
});
const item = (n: number, name: string): ItemRow => ({
  id: id(100 + n),
  code: `i${n}`,
  name,
  aliases: [],
  requestable_categories: ['stall'],
  sort_order: n,
  updated_at: 't',
});
const stock = (r: number, i: number, count: number, o: Partial<StockDbRow> = {}): StockDbRow => ({
  year_id: Y,
  room_id: id(r),
  item_id: id(100 + i),
  count,
  counted_at: '2026-10-05T09:01:00+00:00',
  counted_by: null,
  updated_at: `u-${r}-${i}`,
  ...o,
});

const DESK = item(1, '机(木)');
const CHAIR = item(2, '椅子(木)');
const ITEMS = [DESK, CHAIR];

describe('storageRooms・groupByBuilding・placeOf', () => {
  it('保管場所だけを sort_order → 名前 → id の順に。使用不可は room_years の行で（行がなければ使用可）。メモは使用不可のときだけ', () => {
    const rooms = [
      room(3, { sort_order: 1, name: 'B' }),
      room(2, { sort_order: 1, name: 'A' }),
      room(1, { sort_order: 5 }),
      room(4, { is_storage: false, sort_order: 0 }),
    ];
    const ry: RoomYearRow[] = [
      { year_id: Y, room_id: id(1), usable: false, note: '  工事のため ', updated_at: 't' },
      { year_id: Y, room_id: id(3), usable: true, note: 'メモ', updated_at: 't' },
    ];
    const list = storageRooms(rooms, ry);
    expect(list.map((s) => s.room.name)).toEqual(['A', 'B', '部屋1']);
    expect(list.map((s) => [s.usable, s.note])).toEqual([
      [true, null],
      [true, null],
      [false, '工事のため'],
    ]);
  });

  it('建物ごとに、並び順で最初に出た順の見出し。建物がなければ場所の種類', () => {
    const list = storageRooms(
      [room(1, { building: 'E棟' }), room(2, { building: null, kind: 'outdoor', floor: null }), room(3, { building: 'E棟' }), room(4, { building: '  ' })],
      [],
    );
    expect(groupByBuilding(list).map((g) => [g.building, g.rooms.map((s) => s.room.id)])).toEqual([
      ['E棟', [id(1), id(3)]],
      ['屋外', [id(2)]],
      ['部屋', [id(4)]],
    ]);
    expect(placeOf(room(1, { building: 'E棟', floor: 2 }))).toBe('E棟 2階');
    expect(placeOf(room(1, { building: null, kind: 'outdoor', floor: null }))).toBe('屋外');
  });
});

describe('数と数えた記録', () => {
  it('countsFromRows は行のない品目を 0 にする。sameCounts は items の品目だけを比べる', () => {
    const c = countsFromRows(ITEMS, [stock(1, 1, 5)]);
    expect(c).toEqual({ [DESK.id]: 5, [CHAIR.id]: 0 });
    expect(sameCounts(ITEMS, c, { [DESK.id]: 5 })).toBe(true);
    expect(sameCounts(ITEMS, c, { [DESK.id]: 5, [CHAIR.id]: 1 })).toBe(false);
  });

  it('latestCounted は counted_at が最も新しい行の人と日時（counted_at のない行は見ない）', () => {
    expect(latestCounted([])).toBeNull();
    const rows = [
      stock(1, 1, 1, { counted_at: '2026-10-05T09:00:00+00:00', counted_by: 'a' }),
      stock(1, 2, 1, { counted_at: '2026-10-05T10:00:00+00:00', counted_by: 'b' }),
      stock(1, 2, 1, { counted_at: null, counted_by: 'c' }),
    ];
    expect(latestCounted(rows)).toEqual({ countedAt: '2026-10-05T10:00:00+00:00', countedBy: 'b' });
    expect(countedByRoom(rows).get(id(1))).toEqual({ countedAt: '2026-10-05T10:00:00+00:00', countedBy: 'b' });
  });

  it('まだ数えていない場所（W104 と同じ。使用不可を除く）と「次の部屋へ」（後ろ → 前の順、今の部屋は除く）', () => {
    const list = storageRooms([room(1), room(2), room(3), room(4)], [{ year_id: Y, room_id: id(3), usable: false, note: null, updated_at: 't' }]);
    const counted = new Set([id(2)]);
    expect(uncountedRooms(list, counted).map((s) => s.room.id)).toEqual([id(1), id(4)]);
    expect(nextUncountedRoom(list, new Set([id(2)]), id(2))?.room.id).toBe(id(4));
    expect(nextUncountedRoom(list, new Set([id(4)]), id(4))?.room.id).toBe(id(1));
    expect(nextUncountedRoom(list, new Set([id(1), id(2), id(4)]), id(1))).toBeNull();
    // 今の部屋がまだ数えていない扱いでも、今の部屋は出さない
    expect(nextUncountedRoom(list, new Set(), id(1))?.room.id).toBe(id(2));
  });
});

describe('stockAccess（設計 3.3 の表。RLS の can_write_stocks と同じ）', () => {
  it('部員は preparing・requesting だけ書け、振り分け中は「総務管理者だけが直せます」、確定・終了は読み取り', () => {
    expect(stockAccess('preparing', 'staff')).toEqual({ writable: true, readOnlyMessage: null, shortfall: 'none' });
    expect(stockAccess('requesting', 'staff').writable).toBe(true);
    expect(stockAccess('allocating', 'staff')).toEqual({ writable: false, readOnlyMessage: STAFF_ALLOCATING_MESSAGE, shortfall: 'none' });
    expect(stockAccess('confirmed', 'staff')).toEqual({ writable: false, readOnlyMessage: null, shortfall: 'none' });
    expect(stockAccess('closed', 'staff').writable).toBe(false);
  });

  it('管理者は closed 以外で書け、振り分け中は確かめ、確定中は止める', () => {
    expect(stockAccess('requesting', 'admin').shortfall).toBe('none');
    expect(stockAccess('allocating', 'admin')).toEqual({ writable: true, readOnlyMessage: null, shortfall: 'confirm' });
    expect(stockAccess('confirmed', 'admin')).toEqual({ writable: true, readOnlyMessage: null, shortfall: 'block' });
    expect(stockAccess('closed', 'admin').writable).toBe(false);
  });

  it('ロールがなければ書けない', () => {
    expect(stockAccess('requesting', null).writable).toBe(false);
    expect(stockAccess('requesting', 'viewer').writable).toBe(false);
  });
});

describe('shortfalls（振り分けの合計より少なくなる品目）', () => {
  it('入れた数 < 振り分けの合計の品目だけ。同じなら出さない', () => {
    const allocated = new Map([
      [DESK.id, 5],
      [CHAIR.id, 3],
    ]);
    expect(shortfalls(ITEMS, { [DESK.id]: 4, [CHAIR.id]: 3 }, allocated)).toEqual([{ itemId: DESK.id, itemName: '机(木)', count: 4, allocated: 5 }]);
    expect(shortfalls(ITEMS, { [DESK.id]: 5, [CHAIR.id]: 9 }, allocated)).toEqual([]);
    expect(shortfalls(ITEMS, {}, new Map())).toEqual([]);
  });

  it('文言：振り分け中は E001 の確かめ、確定中は「確定を解除してから」', () => {
    const list = [{ itemId: DESK.id, itemName: '机(木)', count: 4, allocated: 5 }];
    expect(shortfallMessage('confirm', list)).toBe(
      '振り分けの合計より少なくなります（机(木)：入力 4、振り分けの合計 5台）。保存すると振り分けに在庫超過（E001）が出ます。振り分け画面で直してください',
    );
    expect(shortfallMessage('block', list)).toBe('確定中は振り分けの合計より少なくできません（机(木)：入力 4、振り分けの合計 5台）。確定を解除してから直してください');
  });
});

describe('detectOtherSave（読み込んだ後のほかの人の保存）', () => {
  const by = { counted_by: 'other', counted_at: '2026-10-05T10:00:00+00:00' };
  it('updated_at が同じなら null', () => {
    const rows = [stock(1, 1, 5), stock(1, 2, 3)];
    expect(detectOtherSave(rows, rows.map((r) => ({ ...r })))).toBeNull();
    expect(detectOtherSave([], [])).toBeNull();
  });

  it('updated_at が違う・行が増えた・消えた品目を出し、変えた人と日時を返す', () => {
    const loaded = [stock(1, 1, 5)];
    expect(detectOtherSave(loaded, [stock(1, 1, 7, { updated_at: 'u-new', ...by })])).toEqual({
      changedItemIds: [DESK.id],
      by: { countedBy: 'other', countedAt: by.counted_at },
    });
    expect(detectOtherSave([], [stock(1, 1, 7, by), stock(1, 2, 2, by)])?.changedItemIds).toEqual([DESK.id, CHAIR.id]);
    expect(detectOtherSave(loaded, [])).toEqual({ changedItemIds: [DESK.id], by: null });
  });
});

describe('保存（部屋の全品目を1回の upsert）', () => {
  it('全品目（0 を含む）を year_id・room_id・item_id・count だけで送る（counted_by・counted_at は送らない）', async () => {
    expect(toUpsertRows(Y, id(1), ITEMS, { [DESK.id]: 3 })).toEqual([
      { year_id: Y, room_id: id(1), item_id: DESK.id, count: 3 },
      { year_id: Y, room_id: id(1), item_id: CHAIR.id, count: 0 },
    ]);
    const saved = [stock(1, 1, 3), stock(1, 2, 0)];
    const { client, issued } = createFakeSupabase(() => ({ data: saved }));
    await expect(saveRoomStocks(Y, id(1), ITEMS, { [DESK.id]: 3 }, client)).resolves.toEqual(saved);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.table).toBe('stocks');
    const [rows, opts] = opArgs(issued[0]!, 'upsert')[0]!;
    expect(opts).toEqual({ onConflict: 'year_id,room_id,item_id' });
    expect((rows as object[]).every((r) => !('counted_by' in r) && !('counted_at' in r))).toBe(true);
    expect(opArgs(issued[0]!, 'select')).toHaveLength(1);
  });

  it('RLS の拒否は forbidden、確定中の守り（invalid_state・E001）は state のエラーにする', async () => {
    const denied = createFakeSupabase(() => ({ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }));
    await expect(saveRoomStocks(Y, id(1), ITEMS, {}, denied.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
    const guard = createFakeSupabase(() => ({
      error: {
        code: 'P0001',
        message: 'invalid_state',
        details: JSON.stringify({ status: 'confirmed', code: 'E001', room_id: id(1), item_id: DESK.id, allocated: 5, stock: 4 }),
      },
      status: 400,
    }));
    await expect(saveRoomStocks(Y, id(1), ITEMS, {}, guard.client)).rejects.toMatchObject({ info: { kind: 'state', reason: 'invalid_state' } });
  });

  it('返った行が少なければ forbidden（黙って保存したことにしない）', async () => {
    const { client } = createFakeSupabase(() => ({ data: [stock(1, 1, 3)] }));
    await expect(saveRoomStocks(Y, id(1), ITEMS, {}, client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });
});

describe('読む', () => {
  it('前年の数は previous_year_stocks を range で分けて読む。年度の id の形が違えば送らない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [{ room_id: id(1), item_id: DESK.id, count: 8 }] }));
    await expect(fetchPreviousYearStocks(Y, client)).resolves.toEqual([{ room_id: id(1), item_id: DESK.id, count: 8 }]);
    expect(issued[0]!.table).toBe('rpc:previous_year_stocks');
    expect(opArgs(issued[0]!, 'range')).toEqual([[0, 999]]);
    const bad = createFakeSupabase(() => ({ data: [] }));
    await expect(fetchPreviousYearStocks('x', bad.client)).rejects.toMatchObject({ info: { kind: 'input' } });
    expect(bad.issued).toHaveLength(0);
  });

  it('振り分けの合計はその部屋からの allocations を品目ごとに足す（使用不可の部屋も。DB の守りと同じ）', async () => {
    const { client, issued } = createFakeSupabase(() => ({
      data: [
        { id: 'a', item_id: DESK.id, count: 2 },
        { id: 'b', item_id: DESK.id, count: 3 },
        { id: 'c', item_id: CHAIR.id, count: 1 },
      ],
    }));
    const m = await fetchRoomAllocated(Y, id(1), client);
    expect([...m]).toEqual([
      [DESK.id, 5],
      [CHAIR.id, 1],
    ]);
    expect(issued[0]!.table).toBe('allocations');
    expect(opArgs(issued[0]!, 'eq')).toEqual([
      ['year_id', Y],
      ['source_room_id', id(1)],
    ]);
  });

  it('表示名は読めた人だけ（重複と形の違う id は送らない）。id がなければ問い合わせない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [{ user_id: id(9), display_name: 'テスト部員' }] }));
    const m = await fetchProfileNames([id(9), id(9), 'x', id(8)], client);
    expect(m.get(id(9))).toBe('テスト部員');
    expect(m.has(id(8))).toBe(false);
    expect(opArgs(issued[0]!, 'in')).toEqual([['user_id', [id(8), id(9)]]]);
    const none = createFakeSupabase(() => ({ data: [] }));
    await fetchProfileNames([], none.client);
    expect(none.issued).toHaveLength(0);
  });
});

describe('buildStockMatrix（在庫一覧の表。設計 3.4）', () => {
  const list = storageRooms([room(1), room(2), room(3)], [{ year_id: Y, room_id: id(3), usable: false, note: null, updated_at: 't' }]);
  const stocks = [stock(1, 1, 12), stock(1, 2, 20), stock(3, 1, 4)];

  it('前年度がないとき：差は null、数えていない部屋は「まだ」、合計は使用不可を除くものと全部', () => {
    const m = buildStockMatrix({ storage: list, items: ITEMS, stocks, prev: null });
    expect(m.hasPrev).toBe(false);
    expect(m.rows.map((r) => [r.storage.room.id, r.counted, r.total.count])).toEqual([
      [id(1), true, 32],
      [id(2), false, null],
      [id(3), true, 4],
    ]);
    expect(formatCell(m.rows[0]!.cells[DESK.id]!, true)).toBe('12');
    expect(formatCell(m.rows[1]!.cells[DESK.id]!, false)).toBe('まだ');
    expect(formatCell(m.rows[2]!.cells[CHAIR.id]!, true)).toBe('—');
    expect(m.usableTotals.cells[DESK.id]).toEqual({ count: 12, prev: null, diff: null });
    expect(m.allTotals.cells[DESK.id]).toEqual({ count: 16, prev: null, diff: null });
    expect(m.usableTotals.total.count).toBe(32);
    expect(m.allTotals.total.count).toBe(36);
  });

  it('前年度があるとき：セルは「12（+2）」、前年の行がなければ差を出さない。合計の差は前年の合計との差', () => {
    const prev = [
      { room_id: id(1), item_id: DESK.id, count: 10 },
      { room_id: id(1), item_id: CHAIR.id, count: 21 },
      { room_id: id(2), item_id: DESK.id, count: 3 },
      { room_id: id(3), item_id: DESK.id, count: 4 },
    ];
    const m = buildStockMatrix({ storage: list, items: ITEMS, stocks: [...stocks, stock(2, 1, 0)], prev });
    expect(m.hasPrev).toBe(true);
    expect(formatCell(m.rows[0]!.cells[DESK.id]!, true)).toBe('12（+2）');
    expect(formatCell(m.rows[0]!.cells[CHAIR.id]!, true)).toBe('20（−1）');
    expect(formatCell(m.rows[2]!.cells[DESK.id]!, true)).toBe('4（±0）');
    expect(m.rows[1]!.cells[CHAIR.id]).toEqual({ count: null, prev: null, diff: null });
    expect(m.rows[0]!.total).toEqual({ count: 32, prev: 31, diff: 1 });
    expect(m.usableTotals.cells[DESK.id]).toEqual({ count: 12, prev: 13, diff: -1 });
    expect(m.allTotals.cells[DESK.id]).toEqual({ count: 16, prev: 17, diff: -1 });
    expect(m.allTotals.total).toEqual({ count: 36, prev: 38, diff: -2 });
  });

  it('在庫が1件もなければ表は出し、すべて「まだ」', () => {
    const m = buildStockMatrix({ storage: list, items: ITEMS, stocks: [], prev: [] });
    expect(m.rows.every((r) => !r.counted)).toBe(true);
    expect(m.allTotals.total.count).toBe(0);
  });

  it('formatDiff', () => {
    expect([formatDiff(2), formatDiff(-3), formatDiff(0)]).toEqual(['+2', '−3', '±0']);
  });
});

describe('stockUrl・stockPath（QR の URL。設計 3.4・6 章）', () => {
  const R = '22222222-2222-4222-8222-222222222222';
  it('basePath なし：`${origin}/stock/?room=<id>`（末尾のスラッシュつき。年度を入れない）', () => {
    expect(stockUrl(R, 'http://localhost:3240', '')).toBe(`http://localhost:3240/stock/?room=${R}`);
    expect(stockUrl(R, 'http://localhost:3240/', '')).toBe(`http://localhost:3240/stock/?room=${R}`);
  });

  it('basePath あり：`${origin}/GAapp/stock/?room=<id>`（前後のスラッシュをそろえる）', () => {
    expect(stockUrl(R, 'https://example.org', '/GAapp')).toBe(`https://example.org/GAapp/stock/?room=${R}`);
    expect(stockUrl(R, 'https://example.org', '/GAapp/')).toBe(`https://example.org/GAapp/stock/?room=${R}`);
    expect(stockUrl(R, 'https://example.org', 'GAapp')).toBe(`https://example.org/GAapp/stock/?room=${R}`);
  });

  it('アプリの中のリンクは basePath も末尾のスラッシュも付けない（Next.js が付ける）', () => {
    expect(stockPath(R)).toBe(`/stock?room=${R}`);
  });
});
