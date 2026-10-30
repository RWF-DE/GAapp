import { buildAllocationSheets, SUMMARY_SHEET_NAME } from '@gaapp/exporter';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { toYearData } from '@/lib/data/year-data';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { itemTabs, tabKeyByItem } from './tabs';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const { data } = toYearData(fixtureSnapshot(fx));

describe('itemTabs', () => {
  it('R8 の品目のタブの並びと名前が exporter のシート（団体別集計を除く）と同じ', () => {
    const sheets = buildAllocationSheets({ yearLabel: 'R8', data, rows: [] })
      .map((s) => s.name)
      .filter((n) => n !== SUMMARY_SHEET_NAME);
    expect(itemTabs(data.items).map((t) => t.label)).toEqual(sheets);
  });

  it('机(木)と不可机、椅子(木)と不可椅子は1つのタブ', () => {
    const tabs = itemTabs(data.items);
    expect(tabs[0]!.items.map((i) => i.code)).toEqual(['desk', 'desk_ng']);
    expect(tabs[1]!.items.map((i) => i.code)).toEqual(['chair', 'chair_ng']);
    expect(tabs.map((t) => t.key)).toEqual(['desk', 'chair', 'caster_desk', 'blue_chair', 'long_desk_3', 'long_desk_2', 'lectern']);
  });

  it('R8 様式にない品目（フェーズ3で足したもの）は後ろに品目の並び順で1つずつ', () => {
    const extra = [
      { id: 'x2', code: 'tent', name: 'テント', sortOrder: 200 },
      { id: 'x1', code: 'panel', name: 'パネル', sortOrder: 100 },
    ];
    const tabs = itemTabs([...data.items, ...extra]);
    expect(tabs.slice(-2).map((t) => t.key)).toEqual(['panel', 'tent']);
  });

  it('不可の品目がなければ1品目のタブ。最初の品目がなければタブを作らない', () => {
    const noNg = data.items.filter((i) => i.code !== 'desk_ng' && i.code !== 'chair');
    const tabs = itemTabs(noNg);
    expect(tabs[0]!.items.map((i) => i.code)).toEqual(['desk']);
    // 椅子(木)がないので椅子のタブはなく、不可椅子は後ろに1つのタブとして出る
    expect(tabs.some((t) => t.key === 'chair')).toBe(false);
    expect(tabs.at(-1)!.key).toBe('chair_ng');
  });

  it('品目の id からタブを引ける', () => {
    const tabs = itemTabs(data.items);
    const m = tabKeyByItem(tabs);
    const ng = data.items.find((i) => i.code === 'desk_ng')!;
    expect(m.get(ng.id)).toBe('desk');
  });
});
