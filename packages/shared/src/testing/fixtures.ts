// fixtures の読み書き（設計 3.1・3.2）。名前で書いた CSV と JSON。各行を zod の strictObject で確かめ、
// 知らない列があれば失敗にする（個人情報の列を足してしまうのを止める。D-03）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CONSENT_STATUSES,
  GROUP_CATEGORIES,
  ITEM_CODE_PATTERN,
  ITEM_CODES,
  MAX_COUNT,
  MAX_DISTANCE_COST,
  ROOM_KINDS,
} from '../constants';
import { checkGroupNames } from '../groups';
import { fixedRequestParams, substituteParams } from '../rules';
import { formatCsv, readCsvRecords } from './csv';

/** リポジトリのルート（pnpm-workspace.yaml のあるディレクトリ）。cwd に依らない */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error('pnpm-workspace.yaml が見つかりません');
    dir = up;
  }
}

export const fixturePath = (...parts: string[]) => path.join(repoRoot(), 'fixtures', ...parts);

// ---- 型（名前の形） ----

const name = z.string().min(1);
const count0 = z.number().int().min(0).max(MAX_COUNT);
const itemCode = z.string().regex(ITEM_CODE_PATTERN);
const counts = z.strictObject(Object.fromEntries(ITEM_CODES.map((c) => [c, count0])) as Record<(typeof ITEM_CODES)[number], typeof count0>);

export const fixtureMetaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  yearLabel: name,
  kind: z.enum(['r8', 'synthetic']),
});
export const fixtureRoomSchema = z.strictObject({
  name,
  kind: z.enum(ROOM_KINDS),
  building: name.nullable(),
  floor: z.number().int().nullable(),
  isStorage: z.boolean(),
  extraCost: z.number().int().min(0).max(MAX_DISTANCE_COST),
  sortOrder: z.number().int(),
  usable: z.boolean(),
  aliases: z.array(name),
});
export const fixtureGroupSchema = z.strictObject({
  name,
  displayName: name.nullable(),
  category: z.enum(GROUP_CATEGORIES),
  isFood: z.boolean(),
  location: name.nullable(),
  sortOrder: z.number().int(),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  aliases: z.array(name),
});
export const fixtureStockSchema = z.strictObject({ room: name, counts });
export const fixtureRequestSchema = z.strictObject({ group: name, counts });
export const fixtureConsentSchema = z.strictObject({
  group: name,
  from: itemCode,
  to: itemCode,
  status: z.enum(CONSENT_STATUSES),
  count: count0.nullable(),
});
export const fixtureDistanceOverrideSchema = z
  .strictObject({ buildingA: name, buildingB: name, cost: z.number().int().min(0).max(MAX_DISTANCE_COST) })
  .refine((o) => o.buildingA < o.buildingB, { message: 'building_a < building_b にしてください' });

const ruleBase = { code: z.string().trim().min(1).max(50), enabled: z.boolean(), memo: z.string().nullable() };
/** rules.json の1件。団体・場所は名前で書く */
export const fixtureRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...ruleBase, kind: z.literal('substitute'), params: substituteParams }),
  z.strictObject({
    ...ruleBase,
    kind: z.literal('source_restrict'),
    params: z.strictObject({ group: name, items: z.array(itemCode).min(1), rooms: z.array(name).min(1) }),
  }),
  z.strictObject({ ...ruleBase, kind: z.literal('fixed_request'), params: fixedRequestParams.extend({ group: name }) }),
  z.strictObject({
    ...ruleBase,
    kind: z.literal('keep'),
    params: z.strictObject({ group: name, room: name, items: z.record(itemCode, z.number().int().min(1).max(MAX_COUNT)) }),
  }),
]);

export type FixtureMeta = z.output<typeof fixtureMetaSchema>;
export type FixtureRoom = z.output<typeof fixtureRoomSchema>;
export type FixtureGroup = z.output<typeof fixtureGroupSchema>;
export type FixtureStock = z.output<typeof fixtureStockSchema>;
export type FixtureRequest = z.output<typeof fixtureRequestSchema>;
export type FixtureConsent = z.output<typeof fixtureConsentSchema>;
export type FixtureDistanceOverride = z.output<typeof fixtureDistanceOverrideSchema>;
export type FixtureRule = z.input<typeof fixtureRuleSchema>;
export type ItemCounts = FixtureStock['counts'];

export type FixtureData = {
  meta: FixtureMeta;
  rooms: FixtureRoom[];
  groups: FixtureGroup[];
  /** 1行＝数えた場所1つ（横持ち） */
  stocks: FixtureStock[];
  /** DB の requests に入る申請（取り込みの後・代替の前）。0 の品目は持たない行もある */
  requests: FixtureRequest[];
  consents: FixtureConsent[];
  distanceOverrides: FixtureDistanceOverride[];
  rules: FixtureRule[];
};

export const referenceAllocationSchema = z.strictObject({
  item: itemCode,
  source: name,
  group: name,
  requestedItem: itemCode,
  count: z.number().int().min(1).max(MAX_COUNT),
  note: z.string().min(1).nullable(),
});
export const referenceGroupTotalSchema = z.strictObject({ group: name, counts });
export type ReferenceAllocation = z.output<typeof referenceAllocationSchema>;
export type ReferenceGroupTotal = z.output<typeof referenceGroupTotalSchema>;
export type FixtureReference = { allocations: ReferenceAllocation[]; groupTotals: ReferenceGroupTotal[] };

export const emptyCounts = (): ItemCounts =>
  Object.fromEntries(ITEM_CODES.map((c) => [c, 0])) as ItemCounts;

// ---- 列 ----

const COLUMNS = {
  rooms: ['name', 'kind', 'building', 'floor', 'is_storage', 'extra_cost', 'sort_order', 'usable', 'aliases'],
  groups: ['name', 'display_name', 'category', 'is_food', 'location', 'sort_order', 'submitted_at', 'aliases'],
  stocks: ['room', ...ITEM_CODES],
  requests: ['group', ...ITEM_CODES],
  consents: ['group', 'from', 'to', 'status', 'count'],
  distanceOverrides: ['building_a', 'building_b', 'cost'],
  allocations: ['item', 'source', 'group', 'requested_item', 'count', 'note'],
  groupTotals: ['group', ...ITEM_CODES],
} as const;

const FILES = {
  meta: 'meta.json',
  rooms: 'rooms.csv',
  groups: 'groups.csv',
  stocks: 'stocks.csv',
  requests: 'requests.csv',
  consents: 'consents.csv',
  distanceOverrides: 'distance_overrides.csv',
  rules: 'rules.json',
  allocations: path.join('reference', 'allocations.csv'),
  groupTotals: path.join('reference', 'group_totals.csv'),
} as const;

// ---- 文字列 ⇔ 値 ----

const str = {
  nullable: (s: string) => (s === '' ? null : s),
  int: (s: string, where: string) => {
    if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${where}: 整数ではありません（${JSON.stringify(s)}）`);
    return Number(s);
  },
  intOrNull: (s: string, where: string) => (s === '' ? null : str.int(s, where)),
  bool: (s: string, where: string) => {
    if (s !== 'true' && s !== 'false') throw new Error(`${where}: true か false にしてください（${JSON.stringify(s)}）`);
    return s === 'true';
  },
  list: (s: string) => (s === '' ? [] : s.split('|')),
};
const out = {
  nullable: (v: string | null) => v ?? '',
  num: (v: number | null) => (v === null ? '' : String(v)),
  bool: (v: boolean) => (v ? 'true' : 'false'),
  list: (v: readonly string[]) => v.join('|'),
};

function parseWith<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const m = r.error.issues.map((i) => `${i.path.join('.') || '(行)'}: ${i.message}`).join('; ');
    throw new Error(`${where}: ${m}`);
  }
  return r.data;
}

function countsFrom(rec: Record<string, string>, where: string): ItemCounts {
  return Object.fromEntries(ITEM_CODES.map((c) => [c, str.int(rec[c]!, `${where} ${c}`)])) as ItemCounts;
}
const countsTo = (c: ItemCounts) => ITEM_CODES.map((k) => String(c[k]));

function uniqueBy<T>(rows: readonly T[], key: (r: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) throw new Error(`${what} が重複しています：${k}`);
    seen.add(k);
  }
}

// ---- 読み込み ----

export function parseFixtureFiles(files: Record<keyof typeof FILES, string | undefined>, dir = '(fixtures)'): FixtureData {
  const need = (k: keyof typeof FILES) => {
    const t = files[k];
    if (t === undefined) throw new Error(`${dir}/${FILES[k]} がありません`);
    return t;
  };
  const at = (k: keyof typeof FILES, n: number) => `${dir}/${FILES[k]}:${n + 2}`;
  const meta = parseWith(fixtureMetaSchema, JSON.parse(need('meta')), `${dir}/meta.json`);
  const rooms = readCsvRecords(need('rooms'), COLUMNS.rooms, FILES.rooms).map((r, n) =>
    parseWith(
      fixtureRoomSchema,
      {
        name: r.name,
        kind: r.kind,
        building: str.nullable(r.building!),
        floor: str.intOrNull(r.floor!, at('rooms', n)),
        isStorage: str.bool(r.is_storage!, at('rooms', n)),
        extraCost: str.int(r.extra_cost!, at('rooms', n)),
        sortOrder: str.int(r.sort_order!, at('rooms', n)),
        usable: str.bool(r.usable!, at('rooms', n)),
        aliases: str.list(r.aliases!),
      },
      at('rooms', n),
    ),
  );
  const groups = readCsvRecords(need('groups'), COLUMNS.groups, FILES.groups).map((r, n) =>
    parseWith(
      fixtureGroupSchema,
      {
        name: r.name,
        displayName: str.nullable(r.display_name!),
        category: r.category,
        isFood: str.bool(r.is_food!, at('groups', n)),
        location: str.nullable(r.location!),
        sortOrder: str.int(r.sort_order!, at('groups', n)),
        submittedAt: str.nullable(r.submitted_at!),
        aliases: str.list(r.aliases!),
      },
      at('groups', n),
    ),
  );
  const stocks = readCsvRecords(need('stocks'), COLUMNS.stocks, FILES.stocks).map((r, n) =>
    parseWith(fixtureStockSchema, { room: r.room, counts: countsFrom(r, at('stocks', n)) }, at('stocks', n)),
  );
  const requests = readCsvRecords(need('requests'), COLUMNS.requests, FILES.requests).map((r, n) =>
    parseWith(fixtureRequestSchema, { group: r.group, counts: countsFrom(r, at('requests', n)) }, at('requests', n)),
  );
  const consents = readCsvRecords(need('consents'), COLUMNS.consents, FILES.consents).map((r, n) =>
    parseWith(
      fixtureConsentSchema,
      { group: r.group, from: r.from, to: r.to, status: r.status, count: str.intOrNull(r.count!, at('consents', n)) },
      at('consents', n),
    ),
  );
  const distanceOverrides = readCsvRecords(need('distanceOverrides'), COLUMNS.distanceOverrides, FILES.distanceOverrides).map(
    (r, n) =>
      parseWith(
        fixtureDistanceOverrideSchema,
        { buildingA: r.building_a, buildingB: r.building_b, cost: str.int(r.cost!, at('distanceOverrides', n)) },
        at('distanceOverrides', n),
      ),
  );
  const rulesJson: unknown = JSON.parse(need('rules'));
  if (!Array.isArray(rulesJson)) throw new Error(`${dir}/rules.json: 配列ではありません`);
  const rules = rulesJson.map((r, n) => {
    parseWith(fixtureRuleSchema, r, `${dir}/rules.json[${n}]`);
    return r as FixtureRule; // 書いたままの形（既定値を埋めない）で持つ
  });

  uniqueBy(rooms, (r) => r.name, '場所名');
  uniqueBy(groups, (g) => g.name, '団体名');
  uniqueBy(stocks, (s) => s.room, 'stocks.csv の場所');
  uniqueBy(requests, (s) => s.group, 'requests.csv の団体');
  uniqueBy(consents, (c) => `${c.group}|${c.from}|${c.to}`, 'consents.csv の団体・品目');
  uniqueBy(distanceOverrides, (o) => `${o.buildingA}|${o.buildingB}`, 'distance_overrides.csv の建物の組');
  uniqueBy(rules, (r) => r.code, 'rules.json の code');
  const nameErrors = checkGroupNames(groups);
  if (nameErrors.length) throw new Error(`${dir}/groups.csv: ${nameErrors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  return { meta, rooms, groups, stocks, requests, consents, distanceOverrides, rules };
}

export function readFixtureDir(dir: string): FixtureData {
  const read = (k: keyof typeof FILES) => {
    const p = path.join(dir, FILES[k]);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  return parseFixtureFiles(
    Object.fromEntries((Object.keys(FILES) as (keyof typeof FILES)[]).map((k) => [k, read(k)])) as Record<
      keyof typeof FILES,
      string | undefined
    >,
    dir,
  );
}

/** reference/（allocations.csv・group_totals.csv）。なければ null */
export function readReferenceDir(dir: string): FixtureReference | null {
  const pa = path.join(dir, FILES.allocations);
  const pg = path.join(dir, FILES.groupTotals);
  if (!existsSync(pa) || !existsSync(pg)) return null;
  const allocations = readCsvRecords(readFileSync(pa, 'utf8'), COLUMNS.allocations, FILES.allocations).map((r, n) =>
    parseWith(
      referenceAllocationSchema,
      {
        item: r.item,
        source: r.source,
        group: r.group,
        requestedItem: r.requested_item,
        count: str.int(r.count!, `${FILES.allocations}:${n + 2}`),
        note: str.nullable(r.note!),
      },
      `${FILES.allocations}:${n + 2}`,
    ),
  );
  const groupTotals = readCsvRecords(readFileSync(pg, 'utf8'), COLUMNS.groupTotals, FILES.groupTotals).map((r, n) =>
    parseWith(
      referenceGroupTotalSchema,
      { group: r.group, counts: countsFrom(r, `${FILES.groupTotals}:${n + 2}`) },
      `${FILES.groupTotals}:${n + 2}`,
    ),
  );
  return { allocations, groupTotals };
}

// ---- 書き出し ----

/** 書き出すファイルの中身（ファイル名 → 文字列）。writeFixtureDir と、生成し直しの一致テストが使う */
export function formatFixtureFiles(data: FixtureData): Record<string, string> {
  return {
    [FILES.meta]: JSON.stringify(data.meta, null, 2) + '\n',
    [FILES.rooms]: formatCsv(
      COLUMNS.rooms,
      data.rooms.map((r) => [
        r.name,
        r.kind,
        out.nullable(r.building),
        out.num(r.floor),
        out.bool(r.isStorage),
        String(r.extraCost),
        String(r.sortOrder),
        out.bool(r.usable),
        out.list(r.aliases),
      ]),
    ),
    [FILES.groups]: formatCsv(
      COLUMNS.groups,
      data.groups.map((g) => [
        g.name,
        out.nullable(g.displayName),
        g.category,
        out.bool(g.isFood),
        out.nullable(g.location),
        String(g.sortOrder),
        out.nullable(g.submittedAt),
        out.list(g.aliases),
      ]),
    ),
    [FILES.stocks]: formatCsv(COLUMNS.stocks, data.stocks.map((s) => [s.room, ...countsTo(s.counts)])),
    [FILES.requests]: formatCsv(COLUMNS.requests, data.requests.map((s) => [s.group, ...countsTo(s.counts)])),
    [FILES.consents]: formatCsv(
      COLUMNS.consents,
      data.consents.map((c) => [c.group, c.from, c.to, c.status, out.num(c.count)]),
    ),
    [FILES.distanceOverrides]: formatCsv(
      COLUMNS.distanceOverrides,
      data.distanceOverrides.map((o) => [o.buildingA, o.buildingB, String(o.cost)]),
    ),
    [FILES.rules]: JSON.stringify(data.rules, null, 2) + '\n',
  };
}

export function formatReferenceFiles(ref: FixtureReference): Record<string, string> {
  return {
    [FILES.allocations]: formatCsv(
      COLUMNS.allocations,
      ref.allocations.map((a) => [a.item, a.source, a.group, a.requestedItem, String(a.count), out.nullable(a.note)]),
    ),
    [FILES.groupTotals]: formatCsv(COLUMNS.groupTotals, ref.groupTotals.map((g) => [g.group, ...countsTo(g.counts)])),
  };
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
}

export function writeFixtureDir(dir: string, data: FixtureData): void {
  // 書く前に、読み込みと同じ確かめをする（書いたものが読めないことを防ぐ）
  parseFixtureFiles(
    Object.fromEntries(
      (Object.keys(FILES) as (keyof typeof FILES)[]).map((k) => [k, formatFixtureFiles(data)[FILES[k]]]),
    ) as Record<keyof typeof FILES, string | undefined>,
    dir,
  );
  writeFiles(dir, formatFixtureFiles(data));
}

export function writeReferenceDir(dir: string, ref: FixtureReference): void {
  writeFiles(dir, formatReferenceFiles(ref));
}
