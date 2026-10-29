import { validate } from '@gaapp/allocator';
import { fixturePath, readFixtureDir, toYearData as fixtureToYearData } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import type { YearTables } from '@/lib/db/types';
import { runValidation } from './validation';
import { blankToNull, toStoredRows, toYearData } from './year-data';

const r8like = readFixtureDir(fixturePath('synthetic', 'r8like'));
const tables = (): YearTables => structuredClone(fixtureToTables(r8like));
const MISSING = '99999999-9999-4999-8999-999999999999';

describe('toYearData：合成データ r8like', () => {
  it('DB の行の形から作った YearData が shared/testing の toYearData と同じになる', () => {
    const r = toYearData(tables());
    expect(r.problems).toEqual([]);
    expect(r.validatable).toBe(true);
    expect(r.data).toEqual(fixtureToYearData(r8like));
  });

  it('無効なルールは入れず、使用不可は room_years から、提出日時は request_submissions から', () => {
    const t = tables();
    const r = toYearData(t);
    expect(r.data.rules.map((x) => x.code)).toEqual(r8like.rules.filter((x) => x.enabled).map((x) => x.code));
    const unusable = r8like.rooms.filter((x) => !x.usable).map((x) => x.name);
    expect(unusable.length).toBeGreaterThan(0);
    expect(r.data.rooms.filter((x) => !x.usable).map((x) => x.name)).toEqual(unusable);
    expect(r.data.groups.filter((g) => g.submittedAt === null).length).toBe(r8like.groups.filter((g) => g.submittedAt === null).length);
  });
});

describe('toYearData：空文字と壊れた行', () => {
  it("建物・表示名の '' と空白だけを null にそろえる", () => {
    const t = tables();
    t.rooms[0]!.building = '';
    t.rooms[1]!.building = '   ';
    t.groups[0]!.display_name = '';
    t.groups[1]!.display_name = ' \t';
    const r = toYearData(t);
    expect(r.problems).toEqual([]);
    expect(r.data.rooms[0]!.building).toBeNull();
    expect(r.data.rooms[1]!.building).toBeNull();
    expect(r.data.groups[0]!.displayName).toBeNull();
    expect(r.data.groups[1]!.displayName).toBeNull();
    expect(blankToNull(' 1号棟 ')).toBe(' 1号棟 ');
    expect(blankToNull(undefined)).toBeNull();
  });

  it('yearDataSchema に合わない行は入れずに problems（場所の名前と項目）', () => {
    const t = tables();
    const name = t.rooms[2]!.name;
    t.rooms[2]!.extra_cost = 99;
    const r = toYearData(t);
    expect(r.data.rooms.some((x) => x.name === name)).toBe(false);
    expect(r.problems[0]).toEqual({ path: 'rooms.2', message: `場所 ${name} の extraCost が正しくありません` });
  });

  it('設定の壊れたルールは入れずに problems（ruleCode つき）。無効なルールは見ない', () => {
    const t = tables();
    const enabled = t.rules.find((x) => x.enabled)!;
    enabled.params = { from: 'desk' };
    const disabled = t.rules.find((x) => !x.enabled);
    if (disabled) disabled.params = { broken: true };
    const r = toYearData(t);
    expect(r.data.rules.some((x) => x.code === enabled.code)).toBe(false);
    expect(r.problems).toEqual([
      {
        path: `rules.${enabled.code}`,
        message: `ルール ${enabled.code} の設定が壊れています（ルール画面で直してください）`,
        ruleCode: enabled.code,
      },
    ]);
    expect(r.validatable).toBe(true);
  });

  it('距離の上書きで建物が空の行は入れずに problems', () => {
    const t = tables();
    t.distanceOverrides.push({ building_a: ' ', building_b: '管理棟', cost: 3, updated_at: FIXTURE_UPDATED_AT });
    const r = toYearData(t);
    expect(r.data.distanceOverrides).toHaveLength(t.distanceOverrides.length - 1);
    expect(r.problems.map((p) => p.message)).toEqual(['距離の上書き（（空）・管理棟）の建物が空です']);
  });
});

describe('toYearData：参照の確かめ（createContext）', () => {
  const addRule = (t: YearTables, code: string, kind: 'keep' | 'source_restrict' | 'substitute', params: unknown) =>
    t.rules.push({
      id: `0000000${t.rules.length % 10}-0000-4000-8000-0000000000${String(t.rules.length).padStart(2, '0')}`,
      year_id: t.groups[0]!.year_id,
      code,
      kind,
      params: params as never,
      enabled: true,
      memo: null,
      updated_at: FIXTURE_UPDATED_AT,
    });

  it('参照の切れたルール（消した団体を指す keep・消した場所を指す source_restrict）は外して problems に ruleCode、validate は例外を投げない', () => {
    const t = tables();
    const room = t.rooms.find((x) => x.is_storage)!.id;
    addRule(t, 'ZK1', 'keep', { group: MISSING, room, items: { desk: 1 } });
    addRule(t, 'ZS1', 'source_restrict', { group: t.groups[0]!.id, items: ['desk'], rooms: [MISSING] });
    const r = toYearData(t);
    expect(r.validatable).toBe(true);
    expect(r.data.rules.map((x) => x.code)).not.toContain('ZK1');
    expect(r.data.rules.map((x) => x.code)).not.toContain('ZS1');
    expect(r.problems.map((p) => p.ruleCode)).toEqual(expect.arrayContaining(['ZK1', 'ZS1']));
    const keep = r.problems.find((p) => p.ruleCode === 'ZK1')!;
    expect(keep.path).toBe('rules.ZK1.params.group');
    expect(keep.message).toBe('ルール ZK1：団体がありません（ルール画面で直すか無効にしてください）');
    // 外したルール以外で validate が回る
    expect(() => validate(r.data, [])).not.toThrow();
    expect(runValidation(r, []).status).toBe('ok');
  });

  it('createContext を当てなければ validate は例外を投げる（確かめが要る理由）', () => {
    const t = tables();
    addRule(t, 'ZK1', 'keep', { group: MISSING, room: t.rooms[0]!.id, items: { desk: 1 } });
    const r = toYearData(t);
    const keep = { id: t.rules.at(-1)!.id, code: 'ZK1', kind: 'keep' as const, params: { group: MISSING, room: t.rooms[0]!.id, items: { desk: 1 } } };
    expect(() => validate({ ...r.data, rules: [...r.data.rules, keep] }, [])).toThrow();
  });

  it('ルールどうしの重なり（同じ代替で区分が重なる）は両方を外す', () => {
    const t = tables();
    addRule(t, 'ZD1', 'substitute', { from: 'blue_chair', to: 'chair', categories: ['stall'], cost: 1 });
    addRule(t, 'ZD2', 'substitute', { from: 'blue_chair', to: 'chair', categories: ['stall', 'company'], cost: 2 });
    const r = toYearData(t);
    expect(r.validatable).toBe(true);
    expect(new Set(r.problems.map((p) => p.ruleCode))).toEqual(new Set(['ZD1', 'ZD2']));
    expect(r.data.rules.map((x) => x.code)).not.toEqual(expect.arrayContaining(['ZD1']));
  });

  it('ruleCode のない参照の誤り（消した場所を使用場所にした団体）は validatable が偽', () => {
    const t = tables();
    t.groups[0]!.location_room_id = MISSING;
    const r = toYearData(t);
    expect(r.validatable).toBe(false);
    expect(r.problems).toEqual([{ path: 'groups.0.locationRoomId', message: '場所がありません' }]);
    const v = runValidation(r, []);
    expect(v.status).toBe('unavailable');
    expect(v.problems).toEqual(r.problems);
  });
});

describe('toStoredRows', () => {
  it('allocations → StoredAllocationRow。updated_at は受け取った文字列のまま別の Map に', () => {
    const t = tables();
    const row = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      year_id: t.groups[0]!.year_id,
      source_room_id: t.rooms[0]!.id,
      group_id: t.groups[0]!.id,
      item_id: t.items[0]!.id,
      requested_item_id: t.items[0]!.id,
      count: 3,
      is_keep: false,
      origin: 'manual' as const,
      pinned: true,
      note: '団体の希望',
      updated_at: '2026-10-29T01:02:03.123456+00:00',
    };
    const r = toStoredRows({ allocations: [row] });
    expect(r.rows).toEqual([
      {
        id: row.id,
        sourceRoomId: row.source_room_id,
        groupId: row.group_id,
        itemId: row.item_id,
        requestedItemId: row.requested_item_id,
        count: 3,
        isKeep: false,
        origin: 'manual',
        pinned: true,
        note: '団体の希望',
      },
    ]);
    expect(r.updatedAt.get(row.id)).toBe('2026-10-29T01:02:03.123456+00:00');
  });
});
