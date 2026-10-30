import { describe, expect, it } from 'vitest';
import { buildDemand, giKey, rewriteRequestedItem } from './demand';
import { INITIAL_ITEMS } from './constants';
import { FixtureBuilder, RULES } from './testing';

describe('rewriteRequestedItem（S03・D-05）', () => {
  it('企業以外の長机(3人掛)は長机(2人掛)、企業はそのまま、不可机は null', () => {
    expect(rewriteRequestedItem('long_desk_3', 'stall', INITIAL_ITEMS)).toBe('long_desk_2');
    expect(rewriteRequestedItem('long_desk_3', 'company', INITIAL_ITEMS)).toBe('long_desk_3');
    expect(rewriteRequestedItem('desk_ng', 'stall', INITIAL_ITEMS)).toBeNull();
    expect(rewriteRequestedItem('desk', 'rest_area', INITIAL_ITEMS)).toBe('desk');
    expect(rewriteRequestedItem('unknown', 'stall', INITIAL_ITEMS)).toBeNull();
  });
});

describe('buildDemand', () => {
  const b = new FixtureBuilder('demand')
    .room('X')
    .group('模擬店', 'stall', 'X')
    .group('企業', 'company', 'X')
    .group('設営', 'department', 'X', { submittedAt: null })
    .group('提出済み', 'department', 'X')
    .request('模擬店', { long_desk_3: 2, long_desk_2: 1, desk_ng: 3, desk: 4 })
    .request('企業', { long_desk_3: 4 })
    .request('設営', { desk: 100, chair: 5 })
    .rule(RULES.fixed('S06', '設営', 'desk', 241), RULES.fixed('S09', '提出済み', 'desk', 7));
  const ix = b.ids();
  const data = b.yearData();

  it('読み替え・除外・未提出の固定数・提出済みは申請のまま', () => {
    const { demand, excluded } = buildDemand(data);
    expect(demand.get(giKey(ix.groupId('模擬店'), ix.itemId('long_desk_2')))).toBe(3);
    expect(demand.has(giKey(ix.groupId('模擬店'), ix.itemId('long_desk_3')))).toBe(false);
    expect(demand.get(giKey(ix.groupId('企業'), ix.itemId('long_desk_3')))).toBe(4);
    expect(excluded).toEqual([{ groupId: ix.groupId('模擬店'), itemId: ix.itemId('desk_ng'), count: 3 }]);
    // 未提出で申請の行があっても固定数
    expect(demand.get(giKey(ix.groupId('設営'), ix.itemId('desk')))).toBe(241);
    expect(demand.get(giKey(ix.groupId('設営'), ix.itemId('chair')))).toBe(5);
    // 提出済みの 0 は 0（固定数を使わない）
    expect(demand.has(giKey(ix.groupId('提出済み'), ix.itemId('desk')))).toBe(false);
  });

  it('重複行は足し、0 は無視し、disabledRuleCodes の固定数は使わない', () => {
    const d2 = { ...data, requests: [...data.requests, { groupId: ix.groupId('模擬店'), itemId: ix.itemId('desk'), count: 1 }, { groupId: ix.groupId('企業'), itemId: ix.itemId('desk'), count: 0 }] };
    const { demand } = buildDemand(d2, { disabledRuleCodes: ['S06'] });
    expect(demand.get(giKey(ix.groupId('模擬店'), ix.itemId('desk')))).toBe(5);
    expect(demand.has(giKey(ix.groupId('企業'), ix.itemId('desk')))).toBe(false);
    expect(demand.get(giKey(ix.groupId('設営'), ix.itemId('desk')))).toBe(100);
  });

  it('並びは団体 → 品目の順（入力の順に依らない）', () => {
    const d3 = { ...data, requests: data.requests.slice().reverse(), groups: data.groups.slice().reverse() };
    expect([...buildDemand(d3).demand.keys()]).toEqual([...buildDemand(data).demand.keys()]);
  });
});
