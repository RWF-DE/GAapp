// テント等の貸し出しの数え方（T21・D-57。04「テント等の貸し出し」、notes/T21.md「画面の約束」3）。純粋関数。
// 備品と割り当て（/lending）・受け渡し・返却（/lending/records）・申請のテント等のタブ・ダッシュボード（/）が同じ関数で数える
// （数が画面とダッシュボードで食い違わないように。判断したことの 3）。時計を読まない（now を受け取る）。
// import は型と packages/shared の並べ方・日付の小さな関数だけ（ダッシュボードのプロバイダが読むので、画面の部品・lib/data を読まない）。
import { compareStrings, GROUP_CATEGORIES, type GroupCategory } from '@gaapp/shared';
import { addDays, tokyoStartOfDay } from '@/lib/datetime';
import type { YearRow } from '@/lib/db/types';
import type { RecordState } from './labels';

// ---------------------------------------------------------------- 並べ方

/** 備品の並べ方に要る列 */
export interface LendingItemKey {
  id: string;
  name: string;
  sort_order: number;
}

/** 備品の並び：並び（sort_order）→ 名前（コードポイントの順。DB の確定の detail と同じ）→ id */
export function compareLendingItems(a: LendingItemKey, b: LendingItemKey): number {
  return a.sort_order - b.sort_order || compareStrings(a.name, b.name) || compareStrings(a.id, b.id);
}

/** 備品を並べた新しい配列（元の配列は変えない） */
export function sortLendingItems<T extends LendingItemKey>(rows: readonly T[]): T[] {
  return [...rows].sort(compareLendingItems);
}

/** 団体の並べ方に要る列 */
export interface LendingGroupKey {
  id: string;
  name: string;
  category: GroupCategory;
  sort_order: number;
}

const categoryIndex = (c: GroupCategory): number => {
  const k = (GROUP_CATEGORIES as readonly string[]).indexOf(c);
  return k < 0 ? GROUP_CATEGORIES.length : k;
};

/** 団体の並び：区分（模擬店 → 部門 → 企業 → 休憩所）→ 並び → 名前 → id（04「テント等の貸し出し」の言葉） */
export function compareLendingGroups(a: LendingGroupKey, b: LendingGroupKey): number {
  return (
    categoryIndex(a.category) - categoryIndex(b.category) ||
    a.sort_order - b.sort_order ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.id, b.id)
  );
}

/** 団体を並べた新しい配列 */
export function sortLendingGroups<T extends LendingGroupKey>(rows: readonly T[]): T[] {
  return [...rows].sort(compareLendingGroups);
}

/** 団体と備品の組のキー（未保存の変更・行の引き方） */
export function cellKey(groupId: string, itemId: string): string {
  return `${groupId}:${itemId}`;
}

// ---------------------------------------------------------------- 備品ごとの合計

/** 申請・割り当ての行（団体×備品の数） */
export interface LendingCountRow {
  group_id: string;
  lending_item_id: string;
  count: number;
}

/** 受け渡し・返却の記録の数 */
export interface LendingRecordCounts {
  group_id: string;
  lending_item_id: string;
  lent_count: number;
  returned_count: number;
  damaged_count?: number;
}

/** 備品ごとの合計（lendingTotals） */
export interface LendingItemTotal {
  itemId: string;
  stock: number;
  /** 申請合計 */
  requested: number;
  /** 割り当て合計 */
  assigned: number;
  /** 未入力の組（申請が1以上で割り当ての行がない）の申請の合計 */
  unassignedRequested: number;
  lent: number;
  returned: number;
  damaged: number;
  /** 残り（在庫 − 割り当て合計。超えていれば負） */
  remaining: number;
}

/**
 * 備品ごとの合計（備品の並び）。備品にない行は数えない。未入力の組は、割り当ての行がない組（行があれば 0 でも入力済み）。
 *
 * @example
 * lendingTotals(items, requests, assignments, records).find((t) => t.itemId === tent)?.remaining
 */
export function lendingTotals(
  items: readonly (LendingItemKey & { stock: number })[],
  requests: readonly LendingCountRow[],
  assignments: readonly LendingCountRow[],
  records: readonly LendingRecordCounts[],
): LendingItemTotal[] {
  const assigned = new Set(assignments.map((a) => cellKey(a.group_id, a.lending_item_id)));
  const by = new Map<string, LendingItemTotal>();
  for (const i of items) {
    by.set(i.id, { itemId: i.id, stock: i.stock, requested: 0, assigned: 0, unassignedRequested: 0, lent: 0, returned: 0, damaged: 0, remaining: 0 });
  }
  for (const r of requests) {
    const t = by.get(r.lending_item_id);
    if (!t) continue;
    t.requested += r.count;
    if (r.count > 0 && !assigned.has(cellKey(r.group_id, r.lending_item_id))) t.unassignedRequested += r.count;
  }
  for (const a of assignments) {
    const t = by.get(a.lending_item_id);
    if (t) t.assigned += a.count;
  }
  for (const rec of records) {
    const t = by.get(rec.lending_item_id);
    if (!t) continue;
    t.lent += rec.lent_count;
    t.returned += rec.returned_count;
    t.damaged += rec.damaged_count ?? 0;
  }
  return sortLendingItems(items).map((i) => {
    const t = by.get(i.id)!;
    return { ...t, remaining: t.stock - t.assigned };
  });
}

/** 団体と備品の組（未入力・未保存の変更の一覧） */
export interface LendingPair {
  groupId: string;
  itemId: string;
  /** 申請の数（未入力の組） */
  count: number;
}

/** 未入力の組：申請が1以上で、その団体・備品の割り当ての行がない（申請の並びのまま） */
export function unassignedPairs(requests: readonly LendingCountRow[], assignments: readonly LendingCountRow[]): LendingPair[] {
  const assigned = new Set(assignments.map((a) => cellKey(a.group_id, a.lending_item_id)));
  return requests
    .filter((r) => r.count > 0 && !assigned.has(cellKey(r.group_id, r.lending_item_id)))
    .map((r) => ({ groupId: r.group_id, itemId: r.lending_item_id, count: r.count }));
}

/** 在庫超過（確定を止める。DB の over_stock と同じ）：割り当て合計 > 在庫。備品の並び */
export function overStockItemIds(totals: readonly LendingItemTotal[]): string[] {
  return totals.filter((t) => t.assigned > t.stock).map((t) => t.itemId);
}

/** 直していない在庫超過（ダッシュボード。判断したことの 7）：割り当て合計＋未入力の組の申請の合計 > 在庫 */
export function unresolvedOverStockItemIds(totals: readonly LendingItemTotal[]): string[] {
  return totals.filter((t) => t.assigned + t.unassignedRequested > t.stock).map((t) => t.itemId);
}

/** 申請が在庫を超える（/lending の印）：申請合計 > 在庫 */
export function requestOverStockItemIds(totals: readonly LendingItemTotal[]): string[] {
  return totals.filter((t) => t.requested > t.stock).map((t) => t.itemId);
}

// ---------------------------------------------------------------- 締切・確定

/**
 * 受付の締切の後か（DB の before_deadline の逆。判断したことの 6）：受付中で締切を過ぎた（締切ちょうどは過ぎた側）、または
 * 振り分け中・確定。準備中は締切の日時によらず前、終了は偽（終了は別に止める）。
 */
export function requestsClosed(year: Pick<YearRow, 'status' | 'request_close_at'>, now: number): boolean {
  if (year.status === 'allocating' || year.status === 'confirmed') return true;
  if (year.status !== 'requesting' || !year.request_close_at) return false;
  const close = Date.parse(year.request_close_at);
  return !Number.isNaN(close) && now >= close;
}

/** 確定を押せない理由（04「備品と割り当て」の確定。この順に出す） */
export type ConfirmBlocker =
  | { kind: 'before_deadline' }
  | { kind: 'over_stock'; itemIds: string[] }
  /** 未入力の組のある備品と、その団体の数（備品の並び） */
  | { kind: 'unassigned'; items: { itemId: string; groups: number }[] }
  | { kind: 'unsaved'; count: number };

/**
 * 確定を押せない理由：締切の前 → 在庫超過（備品）→ 未入力（備品と団体の数）→ 保存していない変更 の順（終了・確定中は画面が別に出す）。
 * 空なら押せる。
 */
export function confirmBlockers(input: {
  year: Pick<YearRow, 'status' | 'request_close_at'>;
  now: number;
  totals: readonly LendingItemTotal[];
  unassigned: readonly LendingPair[];
  /** 保存していない変更の数 */
  unsaved: number;
}): ConfirmBlocker[] {
  const out: ConfirmBlocker[] = [];
  if (!requestsClosed(input.year, input.now)) out.push({ kind: 'before_deadline' });
  const over = overStockItemIds(input.totals);
  if (over.length > 0) out.push({ kind: 'over_stock', itemIds: over });
  if (input.unassigned.length > 0) {
    const groups = new Map<string, Set<string>>();
    for (const p of input.unassigned) {
      const set = groups.get(p.itemId) ?? new Set<string>();
      set.add(p.groupId);
      groups.set(p.itemId, set);
    }
    const items = input.totals.filter((t) => groups.has(t.itemId)).map((t) => ({ itemId: t.itemId, groups: groups.get(t.itemId)!.size }));
    if (items.length > 0) out.push({ kind: 'unassigned', items });
  }
  if (input.unsaved > 0) out.push({ kind: 'unsaved', count: input.unsaved });
  return out;
}

/**
 * 「申請どおりに入れる」（その備品の列）で入れるセル：割り当ての行がなく、未保存の変更もない（edited にない）セルのうち申請が1以上の
 * もの（申請の数を未保存の変更として入れる）。groupIds を渡すと、その団体だけ（年度にある団体）。申請の並びのまま。
 */
export function fillRequested(
  itemId: string,
  requests: readonly LendingCountRow[],
  assignments: readonly LendingCountRow[],
  edited: ReadonlySet<string>,
  groupIds?: ReadonlySet<string>,
): LendingPair[] {
  const assigned = new Set(assignments.filter((a) => a.lending_item_id === itemId).map((a) => a.group_id));
  const out: LendingPair[] = [];
  const seen = new Set<string>();
  for (const r of requests) {
    if (r.lending_item_id !== itemId || r.count < 1 || assigned.has(r.group_id)) continue;
    if (groupIds && !groupIds.has(r.group_id)) continue;
    const key = cellKey(r.group_id, itemId);
    if (edited.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ groupId: r.group_id, itemId, count: r.count });
  }
  return out;
}

// ---------------------------------------------------------------- 祭の日と受け渡し・返却の状態

/** 2日目（1日目の翌日の 0 時、Asia/Tokyo）を過ぎたか。1日目が読めなければ偽 */
export function festivalDay2Started(year: Pick<YearRow, 'festival_start'>, now: number): boolean {
  const day2 = addDays(year.festival_start, 1);
  return day2 !== '' && now >= Date.parse(tokyoStartOfDay(day2));
}

/** 祭が終わったか（1日目の2日後の 0 時、Asia/Tokyo。机椅子の「祭が終わった」と同じ）。1日目が読めなければ偽 */
export function festivalOver(year: Pick<YearRow, 'festival_start'>, now: number): boolean {
  const next = addDays(year.festival_start, 2);
  return next !== '' && now >= Date.parse(tokyoStartOfDay(next));
}

/**
 * 1つの団体の受け渡し・返却の状態（01 の用語集）：
 * - before（渡す前）：渡した数がすべて 0 か、記録がない
 * - returned（返却済み）：どの備品も渡した数 = 返った数で、渡した数が1以上の備品がある
 * - unreturned（未返却）：渡した数 > 返った数の備品があり、2日目から
 * - lent（貸し出し中）：同じで、2日目の前
 */
export function recordState(
  records: readonly Pick<LendingRecordCounts, 'lent_count' | 'returned_count'>[],
  year: Pick<YearRow, 'festival_start'>,
  now: number,
): RecordState {
  if (!records.some((r) => r.lent_count > 0)) return 'before';
  if (!records.some((r) => r.lent_count > r.returned_count)) return 'returned';
  return festivalDay2Started(year, now) ? 'unreturned' : 'lent';
}

/** 渡した数 > 返った数の備品がある団体の id（未返却・貸し出し中の団体） */
export function outstandingGroupIds(records: readonly LendingRecordCounts[]): Set<string> {
  return new Set(records.filter((r) => r.lent_count > r.returned_count).map((r) => r.group_id));
}

/**
 * 要約の文（「テント 2・重し 8」）：数が1以上の備品を備品の並びで「{名前} {数}」にし、「・」でつなぐ（0 は出さない。なければ空文字）。
 * 単位つきの「テント 1 張」は申請のタブの割り当ての行だけ。
 */
export function lendingSummaryLine(items: readonly LendingItemKey[], countOf: (itemId: string) => number): string {
  return sortLendingItems(items)
    .flatMap((i) => {
      const n = countOf(i.id);
      return n > 0 ? [`${i.name} ${n}`] : [];
    })
    .join('・');
}

/** 数の表（団体×備品のキー → 数）。同じ組が2回あれば足す */
export function countMap(rows: readonly LendingCountRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = cellKey(r.group_id, r.lending_item_id);
    out.set(k, (out.get(k) ?? 0) + r.count);
  }
  return out;
}

// ---------------------------------------------------------------- 団体の数（ダッシュボードのカード）

/** ダッシュボードのカードの団体の数（04「ダッシュボードに出すもの」） */
export interface LendingGroupCounts {
  /** 申請が1以上の備品がある団体 */
  requested: number;
  /** 割り当てが1以上の備品がある団体（「渡した N／M 団体」の M） */
  assigned: number;
  /** 割り当てのある団体のうち、渡した数が1以上の備品がある団体（N） */
  lent: number;
  /** 渡した数 > 返った数の備品がある団体（K。割り当てによらない） */
  unreturned: number;
}

export function lendingGroupCounts(
  requests: readonly LendingCountRow[],
  assignments: readonly LendingCountRow[],
  records: readonly LendingRecordCounts[],
): LendingGroupCounts {
  const requested = new Set(requests.filter((r) => r.count > 0).map((r) => r.group_id));
  const assigned = new Set(assignments.filter((a) => a.count > 0).map((a) => a.group_id));
  const lentGroups = new Set(records.filter((r) => r.lent_count > 0).map((r) => r.group_id));
  let lent = 0;
  for (const g of assigned) if (lentGroups.has(g)) lent++;
  return { requested: requested.size, assigned: assigned.size, lent, unreturned: outstandingGroupIds(records).size };
}
