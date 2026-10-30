// 振り分け画面の品目タブ（画面の設計 3.9。T13）。純粋関数。
// 並びは R8 のシート（exporter の buildAllocationSheets）と同じ：机(木)（机(木)と不可机）・椅子(木)（椅子(木)と不可椅子）・
// キャスター机・椅子(青)・長机(3人掛)・長机(2人掛)・教卓。これ以外の品目（フェーズ3で足したもの）は後ろに品目の並び順で1つずつ。
// 画面は exporter を静的に import しないので、並びをここに書き、tabs.test.ts で exporter のシート名と同じことを確かめる。
import { compareBySortOrder, type Item } from '@gaapp/shared';

/** R8 様式のシートの品目コード（2つのものは1つのタブ：運ぶ品目と不可の品目） */
export const R8_TAB_CODES: readonly (readonly string[])[] = [
  ['desk', 'desk_ng'],
  ['chair', 'chair_ng'],
  ['caster_desk'],
  ['blue_chair'],
  ['long_desk_3'],
  ['long_desk_2'],
  ['lectern'],
];

export interface ItemTab {
  /** URL の `tab`（最初の品目のコード） */
  key: string;
  /** タブの名前（最初の品目の名前。exporter のシート名と同じ） */
  label: string;
  /** タブの品目（並びのまま。2つなら2列目は不可の品目） */
  items: Pick<Item, 'id' | 'code' | 'name'>[];
}

/**
 * 品目タブを作る。DB にない品目のタブは作らない（不可の品目だけがないときは1品目のタブ）。
 *
 * @example
 * itemTabs(yearData.items).map((t) => t.label) // ['机(木)', '椅子(木)', 'キャスター机', …]
 */
export function itemTabs(items: readonly Pick<Item, 'id' | 'code' | 'name' | 'sortOrder'>[]): ItemTab[] {
  const byCode = new Map(items.map((i) => [i.code, i]));
  const used = new Set<string>();
  const tabs: ItemTab[] = [];
  for (const codes of R8_TAB_CODES) {
    const tabItems = codes.flatMap((c) => {
      const it = byCode.get(c);
      return it ? [it] : [];
    });
    if (!byCode.has(codes[0]!) || tabItems.length === 0) continue;
    for (const it of tabItems) used.add(it.code);
    tabs.push({ key: codes[0]!, label: tabItems[0]!.name, items: tabItems.map(({ id, code, name }) => ({ id, code, name })) });
  }
  for (const it of items.slice().sort(compareBySortOrder)) {
    if (used.has(it.code)) continue;
    tabs.push({ key: it.code, label: it.name, items: [{ id: it.id, code: it.code, name: it.name }] });
  }
  return tabs;
}

/** 品目の id → その品目のタブの key */
export function tabKeyByItem(tabs: readonly ItemTab[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tabs) for (const it of t.items) m.set(it.id, t.key);
  return m;
}
