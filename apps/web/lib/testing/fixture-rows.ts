// テスト専用：合成データ（fixtures の名前の形）を DB の行の形（YearTables・Snapshot）にする。
// toYearData（lib/data/year-data.ts）が shared/testing の toYearData と同じ YearData を作ることを確かめるのに使う。
import { INITIAL_ITEMS, ITEM_CODES, type Json } from '@gaapp/shared';
import { fixtureIds, fixtureIndex, type FixtureData, type FixtureRule } from '@gaapp/shared/testing';
import type { Snapshot } from '@/lib/data/snapshot';
import type { YearRow, YearStatus, YearTables } from '@/lib/db/types';

export const FIXTURE_UPDATED_AT = '2026-10-29T00:00:00.123456+00:00';
const T = FIXTURE_UPDATED_AT;

function ruleParams(r: FixtureRule, fx: FixtureData): NonNullable<Json> {
  const ix = fixtureIndex(fx);
  switch (r.kind) {
    case 'substitute':
      return r.params as unknown as NonNullable<Json>;
    case 'source_restrict':
      return { group: ix.groupId(r.params.group), items: r.params.items, rooms: r.params.rooms.map(ix.roomId) };
    case 'fixed_request':
      return { ...r.params, group: ix.groupId(r.params.group) };
    case 'keep':
      return { group: ix.groupId(r.params.group), room: ix.roomId(r.params.room), items: r.params.items };
  }
}

/** fixtures → DB の行（allocations は空）。並びは shared/testing の toYearData と同じにする */
export function fixtureToTables(fx: FixtureData, yearId = fixtureIds.group(fx.meta.yearLabel, '__year__')): YearTables {
  const ix = fixtureIndex(fx);
  return {
    items: INITIAL_ITEMS.map((i) => ({
      id: fixtureIds.item(i.code),
      code: i.code,
      name: i.name,
      aliases: [...i.aliases],
      requestable_categories: [...i.requestableCategories],
      sort_order: i.sortOrder,
      updated_at: T,
    })),
    rooms: fx.rooms.map((r) => ({
      id: ix.roomId(r.name),
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
    // 使用不可の場所だけ行を作る（行がなければ使用可）。使用可の行も1つ入れて、行があっても読めることを確かめる
    roomYears: fx.rooms
      .filter((r, k) => !r.usable || k === 0)
      .map((r) => ({ year_id: yearId, room_id: ix.roomId(r.name), usable: r.usable, note: r.usable ? null : '使用不可', updated_at: T })),
    groups: fx.groups.map((g) => ({
      id: ix.groupId(g.name),
      year_id: yearId,
      name: g.name,
      display_name: g.displayName,
      aliases: [...g.aliases],
      category: g.category,
      is_food: g.isFood,
      location_room_id: g.location === null ? null : ix.roomId(g.location),
      sort_order: g.sortOrder,
      updated_at: T,
    })),
    submissions: fx.groups
      .filter((g) => g.submittedAt !== null)
      .map((g) => ({ group_id: ix.groupId(g.name), submitted_at: g.submittedAt, note: null, updated_at: T })),
    stocks: fx.stocks.flatMap((s) =>
      ITEM_CODES.map((c) => ({
        year_id: yearId,
        room_id: ix.roomId(s.room),
        item_id: ix.itemId(c),
        count: s.counts[c],
        counted_at: T,
        counted_by: null,
        updated_at: T,
      })),
    ),
    requests: fx.requests.flatMap((s) =>
      ITEM_CODES.filter((c) => s.counts[c] > 0).map((c) => ({
        group_id: ix.groupId(s.group),
        item_id: ix.itemId(c),
        count: s.counts[c],
        updated_at: T,
      })),
    ),
    rules: fx.rules.map((r) => ({
      id: ix.ruleId(r.code),
      year_id: yearId,
      code: r.code,
      kind: r.kind,
      params: ruleParams(r, fx),
      enabled: r.enabled,
      memo: r.memo ?? null,
      updated_at: T,
    })),
    consents: fx.consents.map((c) => ({
      group_id: ix.groupId(c.group),
      from_item_id: ix.itemId(c.from),
      to_item_id: ix.itemId(c.to),
      status: c.status,
      count: c.count,
      note: null,
      updated_at: T,
    })),
    distanceOverrides: fx.distanceOverrides.map((o) => ({ building_a: o.buildingA, building_b: o.buildingB, cost: o.cost, updated_at: T })),
    allocations: [],
  };
}

/** fixtures → スナップショット（part = full） */
export function fixtureSnapshot(fx: FixtureData, opts: { status?: YearStatus; version?: number; tables?: Partial<YearTables> } = {}): Snapshot {
  const yearId = fixtureIds.group(fx.meta.yearLabel, '__year__');
  const year: YearRow = {
    id: yearId,
    label: fx.meta.yearLabel,
    status: opts.status ?? 'allocating',
    allocation_version: opts.version ?? 1,
    auto_allocated_at: null,
    festival_start: '2026-10-17',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: null,
    updated_at: T,
  };
  return {
    part: 'full',
    year,
    version: year.allocation_version,
    loadedAt: '2026-10-29T00:00:00.000Z',
    ...fixtureToTables(fx, yearId),
    ...opts.tables,
  };
}
