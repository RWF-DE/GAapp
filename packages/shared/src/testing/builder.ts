// テスト用の小さな入力の組み立て（名前で書き、fixtures と同じ規則で id を付ける）
import type { GroupCategory, KnownItemCode, RoomKind } from '../constants';
import type { AllocateInput, YearData } from '../model';
import { fixtureIndex, toAllocateInput, toYearData, type FixtureIndex, type ToAllocateInputOptions } from './convert';
import {
  emptyCounts,
  type FixtureConsent,
  type FixtureData,
  type FixtureGroup,
  type FixtureRoom,
  type FixtureRule,
} from './fixtures';

export type RoomOptions = Partial<Omit<FixtureRoom, 'name'>>;
export type GroupOptions = Partial<Omit<FixtureGroup, 'name' | 'category' | 'location'>>;
type Counts = Partial<Record<KnownItemCode, number>>;

export const DEFAULT_SUBMITTED_AT = '2026-07-01T12:00:00+09:00';

/** よく使うルール（R8 の初期値の形） */
export const RULES = {
  S01: (): FixtureRule => ({ code: 'S01', kind: 'substitute', enabled: true, memo: null,
    params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0 } }),
  S02: (): FixtureRule => ({ code: 'S02', kind: 'substitute', enabled: true, memo: null,
    params: { from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: 0, preferCategory: 'rest_area' } }),
  S04: (): FixtureRule => ({ code: 'S04', kind: 'substitute', enabled: true, memo: null,
    params: { from: 'long_desk_3', to: 'long_desk_2', categories: ['company'], cost: 1 } }),
  S07: (): FixtureRule => ({ code: 'S07', kind: 'substitute', enabled: true, memo: null,
    params: { from: 'desk', to: 'caster_desk', categories: ['stall'], indoorOnly: true, cost: 3, needsConsent: true } }),
  restrict: (code: string, group: string, items: string[], rooms: string[]): FixtureRule => ({
    code, kind: 'source_restrict', enabled: true, memo: null, params: { group, items, rooms } }),
  fixed: (code: string, group: string, item: string, count: number): FixtureRule => ({
    code, kind: 'fixed_request', enabled: true, memo: null, params: { group, item, count } }),
  keep: (code: string, group: string, room: string, items: Record<string, number>): FixtureRule => ({
    code, kind: 'keep', enabled: true, memo: null, params: { group, room, items } }),
};

export class FixtureBuilder {
  private data: FixtureData;

  constructor(label = 'test') {
    this.data = {
      meta: { schemaVersion: 1, yearLabel: label, kind: 'synthetic' },
      rooms: [],
      groups: [],
      stocks: [],
      requests: [],
      consents: [],
      distanceOverrides: [],
      rules: [],
    };
  }

  room(name: string, opts: RoomOptions = {}): this {
    const kind: RoomKind = opts.kind ?? 'room';
    this.data.rooms.push({
      name,
      kind,
      building: opts.building !== undefined ? opts.building : kind === 'outdoor' ? null : 'A',
      floor: opts.floor !== undefined ? opts.floor : kind === 'outdoor' ? null : 1,
      isStorage: opts.isStorage ?? kind !== 'outdoor',
      extraCost: opts.extraCost ?? 0,
      sortOrder: opts.sortOrder ?? this.data.rooms.length + 1,
      usable: opts.usable ?? true,
      aliases: opts.aliases ?? [],
    });
    return this;
  }

  group(name: string, category: GroupCategory, location: string | null, opts: GroupOptions = {}): this {
    this.data.groups.push({
      name,
      displayName: opts.displayName ?? null,
      category,
      isFood: opts.isFood ?? false,
      location,
      sortOrder: opts.sortOrder ?? this.data.groups.length + 1,
      submittedAt: opts.submittedAt !== undefined ? opts.submittedAt : DEFAULT_SUBMITTED_AT,
      aliases: opts.aliases ?? [],
    });
    return this;
  }

  /** 場所の在庫（同じ場所を2回書くと足す） */
  stock(room: string, counts: Counts): this {
    let row = this.data.stocks.find((s) => s.room === room);
    if (!row) this.data.stocks.push((row = { room, counts: emptyCounts() }));
    for (const [c, n] of Object.entries(counts)) row.counts[c as KnownItemCode] += n!;
    return this;
  }

  request(group: string, counts: Counts): this {
    let row = this.data.requests.find((s) => s.group === group);
    if (!row) this.data.requests.push((row = { group, counts: emptyCounts() }));
    for (const [c, n] of Object.entries(counts)) row.counts[c as KnownItemCode] += n!;
    return this;
  }

  rule(...rules: FixtureRule[]): this {
    this.data.rules.push(...rules);
    return this;
  }

  consent(group: string, from: string, to: string, status: FixtureConsent['status'], count: number | null = null): this {
    this.data.consents.push({ group, from, to, status, count });
    return this;
  }

  override(a: string, b: string, cost: number): this {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.data.distanceOverrides.push({ buildingA: x, buildingB: y, cost });
    return this;
  }

  fixture(): FixtureData {
    return structuredClone(this.data);
  }

  ids(): FixtureIndex {
    return fixtureIndex(this.data);
  }

  yearData(): YearData {
    return toYearData(this.fixture());
  }

  input(opts: ToAllocateInputOptions = {}): AllocateInput {
    return toAllocateInput(this.fixture(), opts);
  }
}
