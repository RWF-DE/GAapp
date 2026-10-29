// シナリオの年度に入れる行を作る純粋な部分（画面の設計 7.2。T09a）。DB にはつながない。
// db.ts の createScenario がこの結果を pg で入れる。e2e-support の Vitest（scenario-rows.test.ts）がここを確かめる。
// 年度の表だけを作る（rooms・items・distance_overrides は作らない。場所は名前で、品目は code で、DB の id を引く）。
import { ITEM_CODES, type Json } from '@gaapp/shared';
import type { FixtureData, FixtureReference, FixtureRule } from '@gaapp/shared/testing';
import type { YearTables } from '../../apps/web/lib/db/types';

/** DB の場所（年度をまたぐ表）。名前で引く */
export interface DbRoom {
  id: string;
  name: string;
}
/** DB の品目。code で引く */
export interface DbItem {
  id: string;
  code: string;
}

export type GroupCategory = 'stall' | 'department' | 'company' | 'rest_area';

/** 取り込みのテストなどで足す団体（申請・提出はない） */
export interface ExtraGroup {
  name: string;
  category: GroupCategory;
  locationRoomName?: string;
  aliases?: string[];
}

export interface ScenarioRowsInput {
  yearId: string;
  fx: FixtureData;
  /** DB にある場所のすべて（データセットにない場所は使用不可の room_years にする） */
  rooms: readonly DbRoom[];
  items: readonly DbItem[];
  rules?: 'dataset' | 'none';
  allocations?: 'none' | 'reference';
  /** allocations: 'reference' のときの行（r8like の reference/allocations.csv） */
  reference?: FixtureReference;
  extraGroups?: readonly ExtraGroup[];
  /** 場所の名前 → 今年の使用（データセットの usable を上書きする） */
  usable?: Readonly<Record<string, boolean>>;
  /** 新しい id（団体・ルール・振り分けの行）。テストでは決まった列を渡す */
  newId: () => string;
  /** stocks.counted_at に入れる日時 */
  countedAt: string;
}

/** データセットにない場所の room_years の note */
export const UNUSED_ROOM_NOTE = 'E2E：このシナリオでは使わない';
/** データセットで使用不可の場所の note */
export const DATASET_UNUSABLE_NOTE = 'E2E：データセットで使用不可';

export interface ScenarioRows {
  roomYears: { year_id: string; room_id: string; usable: boolean; note: string | null }[];
  groups: {
    id: string;
    year_id: string;
    name: string;
    display_name: string | null;
    aliases: string[];
    category: GroupCategory;
    is_food: boolean;
    location_room_id: string | null;
    sort_order: number;
  }[];
  submissions: { group_id: string; submitted_at: string | null; note: string | null }[];
  stocks: { year_id: string; room_id: string; item_id: string; count: number; counted_at: string }[];
  requests: { group_id: string; item_id: string; count: number }[];
  rules: { id: string; year_id: string; code: string; kind: FixtureRule['kind']; params: NonNullable<Json>; enabled: boolean; memo: string | null }[];
  consents: { group_id: string; from_item_id: string; to_item_id: string; status: string; count: number | null }[];
  allocations: {
    id: string;
    year_id: string;
    source_room_id: string;
    group_id: string;
    item_id: string;
    requested_item_id: string;
    count: number;
    is_keep: boolean;
    pinned: boolean;
    origin: 'auto' | 'manual';
    note: string | null;
  }[];
  /** 名前 → id（テストが画面・API の期待値を作るのに使う） */
  ids: {
    groups: Record<string, string>;
    rooms: Record<string, string>;
    items: Record<string, string>;
    rules: Record<string, string>;
  };
}

function lookup(map: Map<string, string>, what: string) {
  return (k: string): string => {
    const v = map.get(k);
    if (v === undefined) throw new Error(`${what}「${k}」が DB にありません（db-setup が年度をまたぐ表を入れたか確かめてください）`);
    return v;
  };
}

/** ルールの params の名前を id に付け替える（UUIDv5 のままだと並行のシナリオで主キーがぶつかる。設計 7.2） */
export function remapRuleParams(r: FixtureRule, groupId: (n: string) => string, roomId: (n: string) => string): NonNullable<Json> {
  switch (r.kind) {
    case 'substitute':
      return r.params as unknown as NonNullable<Json>;
    case 'source_restrict':
      return { group: groupId(r.params.group), items: [...r.params.items], rooms: r.params.rooms.map(roomId) };
    case 'fixed_request':
      return { ...r.params, group: groupId(r.params.group) } as NonNullable<Json>;
    case 'keep':
      return { group: groupId(r.params.group), room: roomId(r.params.room), items: { ...r.params.items } } as NonNullable<Json>;
  }
}

/** シナリオの年度の行（年度の表だけ） */
export function buildScenarioRows(input: ScenarioRowsInput): ScenarioRows {
  const { yearId, fx, newId } = input;
  const roomIds = new Map(input.rooms.map((r) => [r.name, r.id]));
  const itemIds = new Map(input.items.map((i) => [i.code, i.id]));
  const roomId = lookup(roomIds, '場所');
  const itemId = lookup(itemIds, '品目');

  // 今年の使用：データセットの場所はデータセットの usable（usable で上書き）、ほかの場所は使用不可（W104 などをシナリオの場所だけにする）
  const inDataset = new Map(fx.rooms.map((r) => [r.name, r]));
  for (const name of Object.keys(input.usable ?? {})) {
    if (!inDataset.has(name)) throw new Error(`usable の場所「${name}」はデータセットにありません`);
  }
  const roomYears: ScenarioRows['roomYears'] = [];
  for (const r of input.rooms) {
    const ds = inDataset.get(r.name);
    if (!ds) {
      roomYears.push({ year_id: yearId, room_id: r.id, usable: false, note: UNUSED_ROOM_NOTE });
      continue;
    }
    const override = input.usable?.[r.name];
    const usable = override ?? ds.usable;
    if (!usable) roomYears.push({ year_id: yearId, room_id: r.id, usable: false, note: DATASET_UNUSABLE_NOTE });
    else if (override !== undefined) roomYears.push({ year_id: yearId, room_id: r.id, usable: true, note: null });
  }
  // データセットの場所がすべて DB にあること（なければ例外）
  for (const r of fx.rooms) roomId(r.name);

  const groupIds = new Map<string, string>();
  const groups: ScenarioRows['groups'] = fx.groups.map((g) => {
    const id = newId();
    groupIds.set(g.name, id);
    return {
      id,
      year_id: yearId,
      name: g.name,
      display_name: g.displayName,
      aliases: [...g.aliases],
      category: g.category,
      is_food: g.isFood,
      location_room_id: g.location === null ? null : roomId(g.location),
      sort_order: g.sortOrder,
    };
  });
  const maxSort = groups.reduce((m, g) => Math.max(m, g.sort_order), 0);
  (input.extraGroups ?? []).forEach((g, k) => {
    if (groupIds.has(g.name)) throw new Error(`extraGroups の団体「${g.name}」はデータセットにあります`);
    const id = newId();
    groupIds.set(g.name, id);
    groups.push({
      id,
      year_id: yearId,
      name: g.name,
      display_name: null,
      aliases: [...(g.aliases ?? [])],
      category: g.category,
      is_food: false,
      location_room_id: g.locationRoomName ? roomId(g.locationRoomName) : null,
      sort_order: maxSort + 1 + k,
    });
  });
  const groupId = lookup(groupIds, '団体');

  const submissions = fx.groups
    .filter((g) => g.submittedAt !== null)
    .map((g) => ({ group_id: groupId(g.name), submitted_at: g.submittedAt, note: null }));

  const stocks = fx.stocks.flatMap((s) =>
    ITEM_CODES.map((c) => ({ year_id: yearId, room_id: roomId(s.room), item_id: itemId(c), count: s.counts[c], counted_at: input.countedAt })),
  );
  const requests = fx.requests.flatMap((s) =>
    ITEM_CODES.filter((c) => s.counts[c] > 0).map((c) => ({ group_id: groupId(s.group), item_id: itemId(c), count: s.counts[c] })),
  );

  const ruleIds: Record<string, string> = {};
  const rules: ScenarioRows['rules'] =
    (input.rules ?? 'dataset') === 'none'
      ? []
      : fx.rules.map((r) => {
          const id = newId();
          ruleIds[r.code] = id;
          return {
            id,
            year_id: yearId,
            code: r.code,
            kind: r.kind,
            params: remapRuleParams(r, groupId, roomId),
            enabled: r.enabled,
            memo: r.memo ?? null,
          };
        });

  const consents = fx.consents.map((c) => ({
    group_id: groupId(c.group),
    from_item_id: itemId(c.from),
    to_item_id: itemId(c.to),
    status: c.status,
    count: c.count,
  }));

  const allocations: ScenarioRows['allocations'] = [];
  if ((input.allocations ?? 'none') === 'reference') {
    if (!input.reference) throw new Error("allocations: 'reference' には reference の行が要ります");
    const location = new Map(groups.map((g) => [g.id, g.location_room_id]));
    for (const a of input.reference.allocations) {
      const gid = groupId(a.group);
      const source = roomId(a.source);
      allocations.push({
        id: newId(),
        year_id: yearId,
        source_room_id: source,
        group_id: gid,
        item_id: itemId(a.item),
        requested_item_id: itemId(a.requestedItem),
        count: a.count,
        // reference/allocations.csv には isKeep の列がない。allocator の rows.ts・save_allocation_rows と同じ式で決める（設計 7.2）
        is_keep: isKeep(source, location.get(gid) ?? null),
        pinned: false,
        origin: 'auto',
        note: a.note,
      });
    }
  }

  return {
    roomYears,
    groups,
    submissions,
    stocks,
    requests,
    rules,
    consents,
    allocations,
    ids: {
      groups: Object.fromEntries(groupIds),
      rooms: Object.fromEntries(fx.rooms.map((r) => [r.name, roomId(r.name)])),
      items: Object.fromEntries(input.items.map((i) => [i.code, i.id])),
      rules: ruleIds,
    },
  };
}

/** is_keep = 運び元が団体の使用場所（allocator の rows.ts と同じ定義） */
export function isKeep(sourceRoomId: string, locationRoomId: string | null): boolean {
  return locationRoomId !== null && sourceRoomId === locationRoomId;
}

/** DB の場所・品目の行（年度をまたぐ表の全体。YearTables に入れる形） */
export type DbRoomRow = YearTables['rooms'][number];
export type DbItemRow = YearTables['items'][number];

/**
 * シナリオの行を、画面のスナップショットと同じ形（YearTables）にする。
 * DB から読み直したときに画面の toYearData が受け取る形と同じ（updated_at は決まった値）。Vitest で validate に通すのに使う。
 */
export function scenarioYearTables(
  rows: ScenarioRows,
  rooms: readonly DbRoomRow[],
  items: readonly DbItemRow[],
  updatedAt: string,
  distanceOverrides: readonly { building_a: string; building_b: string; cost: number }[] = [],
): YearTables {
  const u = { updated_at: updatedAt };
  return {
    items: [...items],
    rooms: [...rooms],
    roomYears: rows.roomYears.map((r) => ({ ...r, ...u })),
    groups: rows.groups.map((g) => ({ ...g, ...u })),
    submissions: rows.submissions.map((s) => ({ ...s, ...u })),
    stocks: rows.stocks.map((s) => ({ ...s, counted_by: null, ...u })),
    requests: rows.requests.map((r) => ({ ...r, ...u })),
    rules: rows.rules.map((r) => ({ ...r, ...u })),
    consents: rows.consents.map((c) => ({ ...c, status: c.status as YearTables['consents'][number]['status'], note: null, ...u })),
    distanceOverrides: distanceOverrides.map((o) => ({ ...o, ...u })),
    allocations: rows.allocations.map((a) => ({ ...a, ...u })),
  };
}
