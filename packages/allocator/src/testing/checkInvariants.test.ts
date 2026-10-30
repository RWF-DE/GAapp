import { beforeAll, describe, expect, it } from 'vitest';
import type { AllocationRow } from '@gaapp/shared';
import { allocate } from '../allocate';
import { checkInvariants } from './checkInvariants';
import { expectedDemand, loadSet } from './fixtureSets';
import { getHighs } from './getHighs';

describe('checkInvariants（独立の検算そのもの。設計 12.1）', () => {
  const set = loadSet('r8like');
  const demand = expectedDemand(set.fx);
  let rows: AllocationRow[] = [];
  let keepRows: AllocationRow[] = [];
  beforeAll(async () => {
    const res = allocate(set.input, await getHighs());
    if (!res.ok) throw new Error(res.reason);
    rows = res.rows;
    keepRows = rows.filter((r) => r.isKeep && r.groupId === set.ix.groupId('学科展示'));
  });

  it('残すの行を含む rows をそのまま渡すと 0 件（残すの行を足し直さない）', () => {
    expect(checkInvariants(set.input, rows, demand)).toEqual([]);
  });

  it('残すの行を抜くと E003、二重に足すと W101・E001 が出る', () => {
    expect(keepRows.length).toBeGreaterThan(0);
    const without = rows.filter((r) => !keepRows.includes(r));
    expect(checkInvariants(set.input, without, demand).map((x) => x.code)).toContain('E003');
    const twice = checkInvariants(set.input, [...rows, ...keepRows], demand).map((x) => x.code);
    expect(twice).toContain('W101');
  });

  it('ルール違反・使用不可・isKeep の誤りを見つける', () => {
    const ix = set.ix;
    const bad: AllocationRow[] = [
      { sourceRoomId: ix.roomId('3-1'), groupId: ix.groupId('設営'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 1, isKeep: false },
      { sourceRoomId: ix.roomId('第一セミナー'), groupId: ix.groupId('部門01'), itemId: ix.itemId('desk_ng'), requestedItemId: ix.itemId('desk'), count: 1, isKeep: true },
    ];
    const codes = checkInvariants(set.input, bad, new Map()).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['E004', 'E002', 'E005', 'W101']));
  });
});
