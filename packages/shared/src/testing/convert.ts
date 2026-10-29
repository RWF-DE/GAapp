// fixtures（名前の形）→ YearData・AllocateInput（id の形）。設計 3.4
import { INITIAL_ITEMS, ITEM_CODES } from '../constants';
import {
  allocateInputSchema,
  yearDataSchema,
  type AllocateInput,
  type AllocationRow,
  type Item,
  type StoredAllocationRow,
  type YearData,
} from '../model';
import { ruleSchema, type Rule } from '../rules';
import type { FixtureData, FixtureRule } from './fixtures';
import { fixtureIds } from './uuid';

/** INITIAL_ITEMS に fixtures の id（`item:<code>`）を付けたもの */
export function fixtureItems(): Item[] {
  return INITIAL_ITEMS.map((i) => ({
    id: fixtureIds.item(i.code),
    code: i.code,
    name: i.name,
    requestableCategories: [...i.requestableCategories],
    sortOrder: i.sortOrder,
  }));
}

/** 名前 → id の対応（テストで名前から id を引く） */
export type FixtureIndex = {
  label: string;
  roomId: (name: string) => string;
  groupId: (name: string) => string;
  itemId: (code: string) => string;
  ruleId: (code: string) => string;
  roomName: Map<string, string>;
  groupName: Map<string, string>;
  itemCode: Map<string, string>;
};

export function fixtureIndex(fx: FixtureData): FixtureIndex {
  const label = fx.meta.yearLabel;
  const rooms = new Map(fx.rooms.map((r) => [r.name, fixtureIds.room(r.name)]));
  const groups = new Map(fx.groups.map((g) => [g.name, fixtureIds.group(label, g.name)]));
  const items = new Map(INITIAL_ITEMS.map((i) => [i.code as string, fixtureIds.item(i.code)]));
  const get = (m: Map<string, string>, what: string) => (k: string) => {
    const v = m.get(k);
    if (v === undefined) throw new Error(`${what}「${k}」がありません`);
    return v;
  };
  const inv = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));
  return {
    label,
    roomId: get(rooms, '場所'),
    groupId: get(groups, '団体'),
    itemId: get(items, '品目'),
    ruleId: (code) => fixtureIds.rule(label, code),
    roomName: inv(rooms),
    groupName: inv(groups),
    itemCode: inv(items),
  };
}

function ruleToIds(r: FixtureRule, ix: FixtureIndex): Rule {
  const base = { id: ix.ruleId(r.code), code: r.code };
  let candidate: unknown;
  switch (r.kind) {
    case 'substitute':
      candidate = { ...base, kind: r.kind, params: r.params };
      break;
    case 'source_restrict':
      candidate = {
        ...base,
        kind: r.kind,
        params: { group: ix.groupId(r.params.group), items: r.params.items, rooms: r.params.rooms.map(ix.roomId) },
      };
      break;
    case 'fixed_request':
      candidate = { ...base, kind: r.kind, params: { ...r.params, group: ix.groupId(r.params.group) } };
      break;
    case 'keep':
      candidate = {
        ...base,
        kind: r.kind,
        params: { group: ix.groupId(r.params.group), room: ix.roomId(r.params.room), items: r.params.items },
      };
      break;
  }
  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`rules.json の ${r.code}: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * fixtures を YearData にする。名前を id にし、rules.json の名前を id に置き換えて ruleSchema で確かめる。
 * rules.json の enabled: false のルールは YearData に入れない（DB から組み立てる入力と同じく、有効なルールだけ）。
 * stocks は数えた場所の全品目を行にする（0 も）。requests は 0 の品目を行にしない。
 */
export function toYearData(fx: FixtureData): YearData {
  const ix = fixtureIndex(fx);
  const data: YearData = {
    items: fixtureItems(),
    rooms: fx.rooms.map((r) => ({
      id: ix.roomId(r.name),
      name: r.name,
      kind: r.kind,
      building: r.building,
      floor: r.floor,
      extraCost: r.extraCost,
      isStorage: r.isStorage,
      usable: r.usable,
      sortOrder: r.sortOrder,
    })),
    groups: fx.groups.map((g) => ({
      id: ix.groupId(g.name),
      name: g.name,
      displayName: g.displayName,
      category: g.category,
      locationRoomId: g.location === null ? null : ix.roomId(g.location),
      sortOrder: g.sortOrder,
      submittedAt: g.submittedAt,
    })),
    stocks: fx.stocks.flatMap((s) =>
      ITEM_CODES.map((c) => ({ roomId: ix.roomId(s.room), itemId: ix.itemId(c), count: s.counts[c] })),
    ),
    requests: fx.requests.flatMap((s) =>
      ITEM_CODES.filter((c) => s.counts[c] > 0).map((c) => ({
        groupId: ix.groupId(s.group),
        itemId: ix.itemId(c),
        count: s.counts[c],
      })),
    ),
    rules: fx.rules.filter((r) => r.enabled).map((r) => ruleToIds(r, ix)),
    consents: fx.consents.map((c) => ({
      groupId: ix.groupId(c.group),
      fromItemId: ix.itemId(c.from),
      toItemId: ix.itemId(c.to),
      status: c.status,
      count: c.count,
    })),
    distanceOverrides: fx.distanceOverrides.map((o) => ({ ...o })),
  };
  const parsed = yearDataSchema.safeParse(data);
  if (!parsed.success) throw new Error(`fixtures を YearData にできません: ${parsed.error.message}`);
  return parsed.data;
}

export type ToAllocateInputOptions = {
  mode?: AllocateInput['mode'];
  fixedRows?: StoredAllocationRow[];
  previousRows?: AllocationRow[];
};

export function toAllocateInput(fx: FixtureData, opts: ToAllocateInputOptions = {}): AllocateInput {
  const input: AllocateInput = {
    ...toYearData(fx),
    mode: opts.mode ?? 'full',
    fixedRows: opts.fixedRows ?? [],
    previousRows: opts.previousRows ?? [],
  };
  const parsed = allocateInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`AllocateInput にできません: ${parsed.error.message}`);
  return parsed.data;
}

/** テスト用：AllocationRow を固定行（StoredAllocationRow）にする。id は `row:<n>` の UUIDv5 */
export function toFixedRow(
  row: AllocationRow,
  n: number,
  opts: { origin?: 'auto' | 'manual'; pinned?: boolean; note?: string | null } = {},
): StoredAllocationRow {
  const origin = opts.origin ?? 'auto';
  return {
    ...row,
    id: fixtureIds.row(n),
    origin,
    pinned: opts.pinned ?? origin === 'auto',
    note: opts.note ?? null,
  };
}
