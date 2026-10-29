// validate() と、LP と独立に書いた checkInvariants の結果が一致することを確かめる（設計 14 章 T07）
import { beforeAll, describe, expect, it } from 'vitest';
import type { AllocationRow } from '@gaapp/shared';
import { allocate } from './allocate';
import { checkInvariants } from './testing/checkInvariants';
import { expectedDemand, hasR8, loadSet, type FixtureSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';
import { validate } from './validate';

const sets: FixtureSet[] = [loadSet('r8like'), ...(hasR8() ? [loadSet('r8')] : [])];
const COMPARED = ['E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'W101'] as const;

describe.each(sets)('validate と checkInvariants：$label', (set) => {
  const { input, fx, ix } = set;
  const demand = expectedDemand(fx);
  let rows: AllocationRow[];
  beforeAll(async () => {
    const res = allocate(input, await getHighs());
    if (!res.ok) throw new Error(res.reason);
    rows = res.rows;
  });

  const both = (rs: AllocationRow[]) => {
    const v = validate(input, rs);
    const inv = checkInvariants(input, rs, demand);
    const pick = (codes: readonly string[]) => [...new Set(codes.filter((c) => (COMPARED as readonly string[]).includes(c)))].sort();
    return { v, vc: pick(v.map((i) => i.code)), ic: pick(inv.map((i) => i.code)), inv };
  };

  it('allocate の結果：error・W101・W107 が0件で、checkInvariants も0件', () => {
    const { v, ic } = both(rows);
    expect(ic).toEqual([]);
    expect(v.filter((i) => i.severity === 'error' || i.code === 'W101' || i.code === 'W107')).toEqual([]);
  });

  const g = () => input.groups.find((x) => x.submittedAt !== null && x.category !== 'stall' && rows.some((r) => r.groupId === x.id && !r.isKeep && r.itemId === ix.itemId('desk')))!;
  const perturb: [string, (rs: AllocationRow[]) => AllocationRow[]][] = [
    ['行を1つ消す（E003）', (rs) => rs.slice(1)],
    ['行を1台増やす（E001・W101）', (rs) => rs.map((r, n) => (n === 0 ? { ...r, count: r.count + 1 } : r))],
    ['運び元を使用不可の部屋にする（E002）', (rs) => {
      const bad = input.rooms.find((r) => !r.usable);
      return bad ? rs.map((r, n) => (n === 0 ? { ...r, sourceRoomId: bad.id } : r)) : rs;
    }],
    ['isKeep を反転（E005）', (rs) => rs.map((r, n) => (n === 0 ? { ...r, isKeep: !r.isKeep } : r))],
    ['品目を不可机にする（E004）', (rs) => rs.map((r) => (r.groupId === g().id && !r.isKeep && r.itemId === ix.itemId('desk') ? { ...r, itemId: ix.itemId('desk_ng') } : r))],
    ['何も足さない行を別の団体へ（E003・W101）', (rs) => {
      const other = input.groups.find((x) => x.submittedAt !== null && x.id !== rs[0]!.groupId)!;
      return rs.map((r, n) => (n === 0 ? { ...r, groupId: other.id } : r));
    }],
  ];
  it.each(perturb)('壊した行でも同じコードが出る：%s', (_name, f) => {
    const rs = f(rows);
    const { vc, ic } = both(rs);
    expect(vc).toEqual(ic);
  });

  // 件数：E001・E003・W101・E006 はキーごと、E004・E005 は行ごとに1件ずつ数えて、validate と checkInvariants で同じ
  const COUNTED = ['E001', 'E003', 'W101', 'E006', 'E004', 'E005'] as const;
  const counts = (rs: AllocationRow[]) => {
    const { v, inv } = both(rs);
    const n = (xs: readonly { code: string }[]) => Object.fromEntries(COUNTED.map((c) => [c, xs.filter((i) => i.code === c).length]));
    return { validate: n(v), invariants: n(inv) };
  };
  it('件数が同じ：壊していない結果', () => {
    const c = counts(rows);
    expect(c.validate).toEqual(c.invariants);
  });
  it.each(perturb)('件数が同じ：壊した行 %s', (_name, f) => {
    const c = counts(f(rows));
    expect(c.validate).toEqual(c.invariants);
  });
  it('壊した行で件数が 0 でないコードがある（件数の比較が空振りでない）', () => {
    const total = perturb.map(([, f]) => Object.values(counts(f(rows)).validate).reduce((a, b) => a + b, 0));
    expect(total.filter((n) => n > 0).length).toBeGreaterThanOrEqual(4);
  });

  it('壊した行のうち少なくとも4通りは何かのコードが出る（テスト自体が空でない）', () => {
    const n = perturb.filter(([, f]) => both(f(rows)).ic.length > 0).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it('計算時間：validate は Node で 2 秒未満', () => {
    const t = performance.now();
    validate(input, rows);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
