// E2E のシナリオの年度に入れるデータセット（画面の設計 7.2。T09a）。名前の形（fixtures と同じ FixtureData）で持つ。
// DB には依存しない（e2e-support の Vitest で、small が解けること・synthetic-infeasible-s05 が S05 で解けないことを確かめる）。
// 個人情報は入れない（団体名・場所名は E2E 用の名前か、合成データ r8like の名前）。
import { ITEM_CODES } from '@gaapp/shared';
import {
  emptyCounts,
  fixturePath,
  readFixtureDir,
  readReferenceDir,
  S05_ROOMS,
  type FixtureData,
  type FixtureReference,
  type FixtureRoom,
  type ItemCounts,
} from '@gaapp/shared/testing';

export type DatasetName = 'empty' | 'small' | 'synthetic' | 'synthetic-infeasible-s05';
export const DATASET_NAMES: readonly DatasetName[] = ['empty', 'small', 'synthetic', 'synthetic-infeasible-s05'];

const counts = (c: Partial<ItemCounts>): ItemCounts => ({ ...emptyCounts(), ...c });

/** small の名前（テストから名前で引く） */
export const SMALL = {
  rooms: { storageA: 'E2E倉庫A', storageB: 'E2E倉庫B', class1: 'E2E教室1', class2: 'E2E教室2', outdoor: 'E2E屋外' },
  groups: { stall: 'E2E模擬店1', department: 'E2E部門1', company: 'E2E企業1' },
  building: 'E2E棟',
  /** 代替のルール（机(木) → キャスター机、模擬店だけ、了承が要る） */
  substituteRule: 'E2E-S1',
} as const;

/**
 * small：解けて余りがある小さな入力（設計 7.2 の表）。場所は E2E 用の名前で、年度をまたぐ表に setup が1回だけ入れる。
 * sort_order は r8like の場所（1〜56）より後にする。
 */
export function smallDataset(): FixtureData {
  const R = SMALL.rooms;
  const G = SMALL.groups;
  const room = (name: string, o: Partial<FixtureRoom>): FixtureRoom => ({
    name,
    kind: 'room',
    building: SMALL.building,
    floor: 1,
    isStorage: false,
    extraCost: 0,
    sortOrder: 0,
    usable: true,
    aliases: [],
    ...o,
  });
  const storage = counts({ desk: 10, chair: 20, caster_desk: 4, long_desk_2: 4 });
  const request = counts({ desk: 3, chair: 6, long_desk_2: 1 });
  return {
    meta: { schemaVersion: 1, yearLabel: 'small', kind: 'synthetic' },
    rooms: [
      room(R.storageA, { floor: 1, isStorage: true, sortOrder: 9001 }),
      room(R.storageB, { floor: 2, isStorage: true, sortOrder: 9002 }),
      room(R.class1, { floor: 1, sortOrder: 9003 }),
      room(R.class2, { floor: 2, sortOrder: 9004 }),
      room(R.outdoor, { kind: 'outdoor', building: null, floor: null, isStorage: true, sortOrder: 9005 }),
    ],
    groups: [
      { name: G.stall, displayName: null, category: 'stall', isFood: false, location: R.class1, sortOrder: 1, submittedAt: '2001-07-01T12:00:00+09:00', aliases: [] },
      { name: G.department, displayName: null, category: 'department', isFood: false, location: R.class2, sortOrder: 2, submittedAt: '2001-07-01T12:01:00+09:00', aliases: [] },
      { name: G.company, displayName: null, category: 'company', isFood: false, location: null, sortOrder: 3, submittedAt: '2001-07-01T12:02:00+09:00', aliases: [] },
    ],
    stocks: [
      { room: R.storageA, counts: { ...storage, long_desk_3: 2 } },
      { room: R.storageB, counts: storage },
      { room: R.outdoor, counts: counts({ chair: 10 }) },
    ],
    requests: [
      { group: G.stall, counts: request },
      { group: G.department, counts: request },
      { group: G.company, counts: counts({ desk: 3, chair: 6, long_desk_3: 1 }) },
    ],
    consents: [],
    distanceOverrides: [],
    rules: [
      {
        code: SMALL.substituteRule,
        kind: 'substitute',
        enabled: true,
        memo: 'E2E：机(木)の代わりにキャスター机（模擬店だけ、了承が要る）',
        params: { from: 'desk', to: 'caster_desk', categories: ['stall'], cost: 3, needsConsent: true },
      },
    ],
  };
}

/** empty：場所・団体なし（年度だけ） */
export function emptyDataset(): FixtureData {
  return {
    meta: { schemaVersion: 1, yearLabel: 'empty', kind: 'synthetic' },
    rooms: [],
    groups: [],
    stocks: [],
    requests: [],
    consents: [],
    distanceOverrides: [],
    rules: [],
  };
}

const R8LIKE_DIR = () => fixturePath('synthetic', 'r8like');
let r8likeCache: FixtureData | null = null;

/** synthetic：合成データ r8like（fixtures/synthetic/r8like） */
export function syntheticDataset(): FixtureData {
  r8likeCache ??= readFixtureDir(R8LIKE_DIR());
  return structuredClone(r8likeCache);
}

/** r8like の reference/allocations.csv（allocations: 'reference' で入れる行） */
export function syntheticReference(): FixtureReference {
  const ref = readReferenceDir(R8LIKE_DIR());
  if (!ref) throw new Error('fixtures/synthetic/r8like/reference がありません');
  return ref;
}

/** S05 の対象の団体（r8like の rules.json の S05 の group） */
export const S05_GROUP = '設営';

/**
 * synthetic-infeasible-s05：synthetic の設営の机(木)の申請を、S05 の運び元（1-1〜2-3）の机(木)の在庫合計より 10 多くする。
 * ほかは同じ。解けず、causes に S05 が出る（設計 7.2）。
 */
export function syntheticInfeasibleS05(): FixtureData {
  const fx = syntheticDataset();
  const s05 = new Set<string>(S05_ROOMS);
  const supply = fx.stocks.filter((s) => s05.has(s.room)).reduce((a, s) => a + s.counts.desk, 0);
  const req = fx.requests.find((r) => r.group === S05_GROUP);
  if (!req) throw new Error(`r8like に ${S05_GROUP} の申請がありません`);
  req.counts.desk = supply + 10;
  return fx;
}

export function dataset(name: DatasetName): FixtureData {
  switch (name) {
    case 'empty':
      return emptyDataset();
    case 'small':
      return smallDataset();
    case 'synthetic':
      return syntheticDataset();
    case 'synthetic-infeasible-s05':
      return syntheticInfeasibleS05();
  }
}

/** 年度をまたぐ表に入れるデータセット（infeasible は r8like の場所を使うので除く。empty は場所がない） */
export const GLOBAL_DATASETS: readonly DatasetName[] = ['small', 'synthetic'];

/** setup（db-setup）が入れる全データセットの場所（名前で一意。同じ名前で属性が違えば例外） */
export function globalRooms(): FixtureRoom[] {
  const byName = new Map<string, FixtureRoom>();
  for (const name of GLOBAL_DATASETS) {
    for (const r of dataset(name).rooms) {
      const prev = byName.get(r.name);
      if (prev && roomAttributeDiff(prev, r).length > 0) {
        throw new Error(`データセットどうしで場所「${r.name}」の属性が違います：${roomAttributeDiff(prev, r).join('、')}`);
      }
      byName.set(r.name, r);
    }
  }
  return [...byName.values()];
}

/** setup が入れる距離の上書き（r8like の distance_overrides.csv） */
export function globalDistanceOverrides(): FixtureData['distanceOverrides'] {
  return GLOBAL_DATASETS.flatMap((n) => dataset(n).distanceOverrides);
}

/** 年度をまたぐ表の場所の属性（setup が DB の行と比べるもの） */
export interface RoomAttributes {
  kind: string;
  building: string | null;
  floor: number | null;
  isStorage: boolean;
  extraCost: number;
}

/** 属性の違い（`building：E2E棟 ≠ 教室棟A` の形。同じなら空） */
export function roomAttributeDiff(a: RoomAttributes, b: RoomAttributes): string[] {
  const keys = ['kind', 'building', 'floor', 'isStorage', 'extraCost'] as const;
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k}：${String(a[k])} ≠ ${String(b[k])}`);
}

/** データセットが使う品目のコード（seed の品目にあるかを setup が確かめる） */
export function datasetItemCodes(): string[] {
  const codes = new Set<string>(ITEM_CODES);
  for (const n of GLOBAL_DATASETS) {
    for (const r of dataset(n).rules) {
      if (r.kind === 'substitute') {
        codes.add(r.params.from);
        codes.add(r.params.to);
      }
    }
  }
  return [...codes].sort();
}
