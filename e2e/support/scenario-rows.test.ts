// e2e-support の Vitest（画面の設計 7.2。T09a）：createScenario の行の作り方のうち DB につながない部分と、データセットの中身。
import { allocate, validate } from '@gaapp/allocator';
import { getHighs } from '@gaapp/allocator/testing';
import { INITIAL_ITEMS } from '@gaapp/shared';
import { fixtureIds, toAllocateInput } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { toStoredRows, toYearData } from '../../apps/web/lib/data/year-data';
import {
  dataset,
  globalDistanceOverrides,
  globalRooms,
  roomAttributeDiff,
  SMALL,
  smallDataset,
  syntheticDataset,
  syntheticInfeasibleS05,
  syntheticReference,
} from './datasets';
import {
  buildScenarioRows,
  DATASET_UNUSABLE_NOTE,
  isKeep,
  scenarioYearTables,
  UNUSED_ROOM_NOTE,
  type DbItemRow,
  type DbRoomRow,
  type ScenarioRowsInput,
} from './scenario-rows';

const T = '2026-10-29T00:00:00.000000+00:00';

/** 決まった列の id（DB が作る id の代わり） */
function idGen(prefix: string) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n.toString(16).padStart(12, '0')}`;
  };
}

// DB の年度をまたぐ表の代わり：seed のテスト用の場所4つ＋全データセットの場所（id は UUIDv5 ではない別の値にする）
const SEED_ROOMS = ['テスト用保管場所1', 'テスト用保管場所2', 'テスト用使用場所1', 'テスト用屋外1'];
const roomId = idGen('00000000-0000-4000-8000-');
const DB_ROOMS: DbRoomRow[] = [
  ...SEED_ROOMS.map((name, k) => ({
    id: roomId(),
    name,
    aliases: [],
    kind: 'room' as const,
    building: '1号棟',
    floor: 1,
    extra_cost: 0,
    is_storage: k < 2,
    sort_order: k + 1,
    updated_at: T,
  })),
  ...globalRooms().map((r) => ({
    id: roomId(),
    name: r.name,
    aliases: [...r.aliases],
    kind: r.kind,
    building: r.building,
    floor: r.floor,
    extra_cost: r.extraCost,
    is_storage: r.isStorage,
    sort_order: r.sortOrder,
    updated_at: T,
  })),
];
const itemId = idGen('00000000-0000-4000-9000-');
const DB_ITEMS: DbItemRow[] = INITIAL_ITEMS.map((i) => ({
  id: itemId(),
  code: i.code,
  name: i.name,
  aliases: [...i.aliases],
  requestable_categories: [...i.requestableCategories],
  sort_order: i.sortOrder,
  updated_at: T,
}));
const DISTANCE = globalDistanceOverrides().map((o) => ({ building_a: o.buildingA, building_b: o.buildingB, cost: o.cost }));

function rowsFor(over: Partial<ScenarioRowsInput> = {}) {
  return buildScenarioRows({
    yearId: '00000000-0000-4000-a000-000000000001',
    fx: smallDataset(),
    rooms: DB_ROOMS,
    items: DB_ITEMS,
    newId: idGen('00000000-0000-4000-b000-'),
    countedAt: T,
    ...over,
  });
}

describe('データセット', () => {
  it('年度をまたぐ表に入れる場所は、small と r8like の場所（名前で一意・属性の食い違いなし）', () => {
    const rooms = globalRooms();
    expect(rooms).toHaveLength(smallDataset().rooms.length + syntheticDataset().rooms.length);
    expect(rooms.map((r) => r.name)).toContain(SMALL.rooms.storageA);
    expect(rooms.map((r) => r.name)).toContain('第一セミナー');
    expect(globalDistanceOverrides()).toEqual(syntheticDataset().distanceOverrides);
  });

  it('roomAttributeDiff は違う属性だけを出す', () => {
    const a = { kind: 'room', building: 'E2E棟', floor: 1, isStorage: true, extraCost: 0 };
    expect(roomAttributeDiff(a, { ...a })).toEqual([]);
    expect(roomAttributeDiff(a, { ...a, floor: 2, isStorage: false })).toEqual(['floor：1 ≠ 2', 'isStorage：true ≠ false']);
  });

  it('small は解けて、在庫に余りがある', async () => {
    const fx = smallDataset();
    const res = allocate(toAllocateInput(fx), await getHighs());
    if (!res.ok) throw new Error(`small が解けません：${res.message}`);
    const allocated = res.rows.reduce((a, r) => a + r.count, 0);
    const stock = fx.stocks.reduce((a, s) => a + Object.values(s.counts).reduce((x, y) => x + y, 0), 0);
    expect(allocated).toBeGreaterThan(0);
    expect(stock).toBeGreaterThan(allocated);
  });

  it('synthetic-infeasible-s05 は解けず、causes に S05 が出る（設営の机(木)だけを増やした）', async () => {
    const base = syntheticDataset();
    const fx = syntheticInfeasibleS05();
    const req = (f: typeof fx) => f.requests.find((r) => r.group === '設営')!.counts;
    expect(req(fx).desk).toBeGreaterThan(req(base).desk);
    expect({ ...req(fx), desk: 0 }).toEqual({ ...req(base), desk: 0 });
    const res = allocate(toAllocateInput(fx), await getHighs());
    if (res.ok) throw new Error('解けてしまいました');
    expect(res.reason).toBe('infeasible');
    expect(res.causes.map((c) => c.ruleCode)).toContain('S05');
  });

  it('empty は場所も団体もない', () => {
    const fx = dataset('empty');
    expect(fx.rooms).toEqual([]);
    expect(fx.groups).toEqual([]);
  });
});

describe('buildScenarioRows', () => {
  it('データセットにない場所は、その年度で使用不可（note つき）。データセットの場所は行を作らない', () => {
    const rows = rowsFor();
    const small = new Set(smallDataset().rooms.map((r) => r.name));
    const byRoom = new Map(rows.roomYears.map((r) => [r.room_id, r]));
    for (const room of DB_ROOMS) {
      const ry = byRoom.get(room.id);
      if (small.has(room.name)) expect(ry).toBeUndefined();
      else expect(ry).toMatchObject({ usable: false, note: UNUSED_ROOM_NOTE });
    }
    expect(rows.roomYears).toHaveLength(DB_ROOMS.length - small.size);
  });

  it('データセットで使用不可の場所は使用不可、usable で上書きできる。データセットにない名前は例外', () => {
    const fx = syntheticDataset();
    const sem = DB_ROOMS.find((r) => r.name === '第一セミナー')!;
    const unusable = rowsFor({ fx }).roomYears.find((r) => r.room_id === sem.id);
    expect(unusable).toMatchObject({ usable: false, note: DATASET_UNUSABLE_NOTE });
    const usable = rowsFor({ fx, usable: { 第一セミナー: true } }).roomYears.find((r) => r.room_id === sem.id);
    expect(usable).toMatchObject({ usable: true, note: null });
    expect(() => rowsFor({ usable: { どこにもない部屋: true } })).toThrow(/データセットにありません/);
  });

  it('ルールの params の団体・場所は、シナリオの団体の id と DB の場所の id に付け替える（UUIDv5 のままにしない）', () => {
    const fx = syntheticDataset();
    const a = rowsFor({ fx, newId: idGen('00000000-0000-4000-c000-') });
    const b = rowsFor({ fx, newId: idGen('00000000-0000-4000-d000-') });
    const s05 = a.rules.find((r) => r.code === 'S05')!;
    const params = s05.params as { group: string; rooms: string[]; items: string[] };
    expect(params.group).toBe(a.ids.groups['設営']);
    expect(params.rooms).toEqual(['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'].map((n) => a.ids.rooms[n]));
    expect(params.group).not.toBe(fixtureIds.group('r8like', '設営'));
    const s08 = a.rules.find((r) => r.code === 'S08')!.params as { group: string; room: string };
    expect(s08).toMatchObject({ group: a.ids.groups['学科展示'], room: a.ids.rooms['第一多目的室'] });
    // 並行のシナリオで主キーがぶつからない
    expect(new Set([...a.rules, ...b.rules].map((r) => r.id)).size).toBe(a.rules.length + b.rules.length);
    expect(new Set([...a.groups, ...b.groups].map((g) => g.id)).size).toBe(a.groups.length + b.groups.length);
    expect(rowsFor({ fx, rules: 'none' }).rules).toEqual([]);
  });

  it('reference の行の is_keep は「運び元 = 団体の使用場所」', () => {
    const fx = syntheticDataset();
    const rows = rowsFor({ fx, allocations: 'reference', reference: syntheticReference() });
    expect(rows.allocations).toHaveLength(syntheticReference().allocations.length);
    const loc = new Map(rows.groups.map((g) => [g.id, g.location_room_id]));
    for (const a of rows.allocations) expect(a.is_keep).toBe(a.source_room_id === loc.get(a.group_id));
    const keep = rows.allocations.find(
      (a) => a.group_id === rows.ids.groups['学科展示'] && a.source_room_id === rows.ids.rooms['第一多目的室'] && a.item_id === rows.ids.items['desk'],
    );
    expect(keep).toMatchObject({ is_keep: true, count: 18, origin: 'auto', pinned: false });
    expect(isKeep('a', null)).toBe(false);
    expect(() => rowsFor({ fx, allocations: 'reference' })).toThrow(/reference の行が要ります/);
  });

  it('reference を入れた年度の行を YearData にして validate すると error 0（is_keep を false で入れると E005）', () => {
    const fx = syntheticDataset();
    const rows = rowsFor({ fx, allocations: 'reference', reference: syntheticReference() });
    const tables = scenarioYearTables(rows, DB_ROOMS, DB_ITEMS, T, DISTANCE);
    const { data, problems, validatable } = toYearData(tables);
    expect(problems).toEqual([]);
    expect(validatable).toBe(true);
    const issues = validate(data, toStoredRows(tables).rows);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);

    const noKeep = { ...tables, allocations: tables.allocations.map((a) => ({ ...a, is_keep: false })) };
    const bad = validate(data, toStoredRows(noKeep).rows).filter((i) => i.severity === 'error');
    expect(bad.map((i) => i.code)).toContain('E005');
  });

  it('extraGroups は申請なしで足し、sort_order はデータセットの後。名前が重なれば例外', () => {
    const rows = rowsFor({ extraGroups: [{ name: '模擬店甲', category: 'stall', locationRoomName: SMALL.rooms.class1, aliases: ['甲'] }] });
    const g = rows.groups.find((x) => x.name === '模擬店甲')!;
    expect(g).toMatchObject({ category: 'stall', aliases: ['甲'], location_room_id: rows.ids.rooms[SMALL.rooms.class1] });
    expect(g.sort_order).toBeGreaterThan(Math.max(...rows.groups.filter((x) => x !== g).map((x) => x.sort_order)));
    expect(rows.requests.some((r) => r.group_id === g.id)).toBe(false);
    expect(() => rowsFor({ extraGroups: [{ name: SMALL.groups.stall, category: 'stall' }] })).toThrow(/データセットにあります/);
  });

  it('DB にない場所・品目を使うデータセットは、どれがないかを出して止まる', () => {
    expect(() => rowsFor({ rooms: DB_ROOMS.filter((r) => r.name !== SMALL.rooms.storageA) })).toThrow(/場所「E2E倉庫A」が DB にありません/);
    expect(() => rowsFor({ items: DB_ITEMS.filter((i) => i.code !== 'desk') })).toThrow(/品目「desk」が DB にありません/);
  });

  it('small の行：在庫は数えた場所の全品目（0 を含む）、申請は 0 を除く、提出日時あり', () => {
    const rows = rowsFor();
    expect(rows.stocks).toHaveLength(3 * INITIAL_ITEMS.length);
    expect(rows.requests.every((r) => r.count > 0)).toBe(true);
    expect(rows.submissions).toHaveLength(3);
    expect(rows.rules.map((r) => r.code)).toEqual([SMALL.substituteRule]);
  });
});
