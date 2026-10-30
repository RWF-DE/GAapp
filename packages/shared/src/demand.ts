// 需要の組み立て（03 前処理1・2、設計 5 章 P1）。allocate・validate・画面の「団体別」が同じ関数を使う
import { REQUEST_REWRITES, type GroupCategory } from './constants';
import type { Group, Item, RequestRow } from './model';
import { compareBySortOrder, compareRules } from './order';
import type { Rule } from './rules';

/**
 * 申請品目の読み替え（S03・D-05）。団体の区分で申請できる品目ならそのまま、申請できず読み替え先があり
 * 読み替え先が申請できればその品目のコード、どちらでもなければ null（E006 の候補）。
 */
export function rewriteRequestedItem(
  itemCode: string,
  category: GroupCategory,
  items: readonly Pick<Item, 'code' | 'requestableCategories'>[],
): string | null {
  const byCode = new Map(items.map((i) => [i.code, i]));
  const item = byCode.get(itemCode);
  if (!item) return null;
  if (item.requestableCategories.includes(category)) return itemCode;
  const to = REQUEST_REWRITES[itemCode];
  if (to === undefined) return null;
  const target = byCode.get(to);
  return target && target.requestableCategories.includes(category) ? to : null;
}

/** 団体・品目のキー */
export const giKey = (groupId: string, itemId: string) => `${groupId}|${itemId}`;

export type DemandData = {
  items: readonly Item[];
  groups: readonly Group[];
  requests: readonly RequestRow[];
  rules: readonly Rule[];
};

export type ExcludedRequest = { groupId: string; itemId: string; count: number };

export type Demand = {
  /** 団体・申請品目（読み替えの後）→ 需要 D。0 のキーは持たない。キーは giKey、並びは団体 → 品目の順 */
  demand: Map<string, number>;
  /** 申請できない品目の申請（E006 の候補）。需要から除いた */
  excluded: ExcludedRequest[];
};

/**
 * 需要 D を作る：申請を団体・品目ごとに合計し（重複行は足す。0 は無視）、申請できない品目は読み替えるか除き、
 * 未提出の団体の fixed_request を当てる（D-05・D-07）。
 * 参照先のない申請は無視する（入力の確かめは allocate の前処理0が行う）。
 */
export function buildDemand(data: DemandData, opts: { disabledRuleCodes?: readonly string[] } = {}): Demand {
  const items = data.items.slice().sort(compareBySortOrder);
  const groups = data.groups.slice().sort(compareBySortOrder);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const itemIdByCode = new Map(items.map((i) => [i.code, i.id]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const raw = new Map<string, number>();
  for (const r of data.requests) {
    if (r.count <= 0 || !itemById.has(r.itemId) || !groupById.has(r.groupId)) continue;
    const k = giKey(r.groupId, r.itemId);
    raw.set(k, (raw.get(k) ?? 0) + r.count);
  }

  const acc = new Map<string, number>();
  const excluded: ExcludedRequest[] = [];
  for (const g of groups) {
    for (const it of items) {
      const n = raw.get(giKey(g.id, it.id));
      if (!n) continue;
      const code = rewriteRequestedItem(it.code, g.category, items);
      if (code === null) {
        excluded.push({ groupId: g.id, itemId: it.id, count: n });
        continue;
      }
      const k = giKey(g.id, itemIdByCode.get(code)!);
      acc.set(k, (acc.get(k) ?? 0) + n);
    }
  }

  const disabled = new Set(opts.disabledRuleCodes ?? []);
  const fixed = data.rules
    .filter((r) => r.kind === 'fixed_request' && !disabled.has(r.code))
    .slice()
    .sort(compareRules);
  for (const r of fixed) {
    if (r.kind !== 'fixed_request') continue;
    const g = groupById.get(r.params.group);
    const itemId = itemIdByCode.get(r.params.item);
    if (!g || !itemId) continue;
    // 提出済みなら何もしない（0 を含めて申請の数を使う。違えば W106）
    if (g.submittedAt === null) acc.set(giKey(g.id, itemId), r.params.count);
  }

  // 団体 → 品目の順に並べ直す
  const demand = new Map<string, number>();
  for (const g of groups) {
    for (const it of items) {
      const v = acc.get(giKey(g.id, it.id));
      if (v && v > 0) demand.set(giKey(g.id, it.id), v);
    }
  }
  return { demand, excluded };
}
