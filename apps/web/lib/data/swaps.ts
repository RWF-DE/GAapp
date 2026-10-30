// キャスター机交換の一覧（画面の設計 3.10・6。T09a）。了承が要る代替（needsConsent）の置き換えと了承の状況を、
// /swaps（T13）とダッシュボードの了承状況（T09）が同じ数え方で使う。純粋関数。
import { compareBySortOrder, ruleSchema, type ConsentStatus } from '@gaapp/shared';
import type { YearTables } from '@/lib/db/types';

/** 注意：reask＝依頼の後に増えた、w102＝了承の後に増えた（W102）、rerun＝拒否されたのに置き換えが残る（最小変更での再実行が要る） */
export type SwapAttention = 'reask' | 'w102' | 'rerun';

export interface SwapRow {
  groupId: string;
  fromItemId: string;
  toItemId: string;
  /** 今の置き換え台数（requestedItemId = 元、itemId = 先 の行の合計。固定・手動・自動を問わない） */
  current: number;
  /** 了承の行がなければ not_asked */
  status: ConsentStatus;
  /** 依頼した台数（asked にした時点の置き換え台数） */
  asked: number | null;
  note: string | null;
  /** 了承の行の updated_at（なければ null） */
  updatedAt: string | null;
  /** 了承の行を必要とする有効なルールのコード（ルールが無効になっても了承の行が残っていれば空） */
  ruleCodes: string[];
  attention: SwapAttention | null;
}

export const SWAP_ATTENTION_MESSAGES: Record<SwapAttention, string> = {
  reask: '依頼の後に増えました。依頼し直してください',
  w102: '了承の後に増えました（W102）。依頼し直してください',
  rerun: '拒否されています。振り分け画面で『最小変更で再実行』が要ります',
};

/**
 * 注意の判定。依頼した台数のない了承（総務が依頼を経ずに記録したもの）は、validate の W102 と同じく増えたと見なさない。
 */
export function swapAttention(status: ConsentStatus, current: number, asked: number | null): SwapAttention | null {
  if (status === 'asked' && asked !== null && current > asked) return 'reask';
  if (status === 'accepted' && asked !== null && current > asked) return 'w102';
  if (status === 'declined' && current > 0) return 'rerun';
  return null;
}

const key = (g: string, f: string, t: string) => `${g}|${f}|${t}`;

/**
 * 対象：有効で needsConsent の代替ルールの（団体、元の品目、先の品目）で、今の置き換え台数が1以上のもの、
 * または了承の行があるもの（ルールを無効にした後に残った了承の行も出す）。
 * 並び：団体（sort_order → 名前 → id）→ 元の品目 → 先の品目（品目の並び）。
 */
export function swapRows(s: Pick<YearTables, 'items' | 'groups' | 'rules' | 'consents' | 'allocations'>): SwapRow[] {
  const itemIdByCode = new Map(s.items.map((i) => [i.code, i.id]));
  const pairs = new Map<string, string[]>(); // `${from}|${to}`（品目 id）→ ルールのコード
  for (const row of s.rules) {
    if (!row.enabled || row.kind !== 'substitute') continue;
    const r = ruleSchema.safeParse({ id: row.id, code: row.code, kind: row.kind, params: row.params });
    if (!r.success || r.data.kind !== 'substitute' || !r.data.params.needsConsent) continue;
    const from = itemIdByCode.get(r.data.params.from);
    const to = itemIdByCode.get(r.data.params.to);
    if (!from || !to) continue;
    const k = `${from}|${to}`;
    pairs.set(k, [...(pairs.get(k) ?? []), r.data.code]);
  }

  const current = new Map<string, number>();
  for (const a of s.allocations) {
    if (!pairs.has(`${a.requested_item_id}|${a.item_id}`)) continue;
    const k = key(a.group_id, a.requested_item_id, a.item_id);
    current.set(k, (current.get(k) ?? 0) + a.count);
  }

  const out = new Map<string, SwapRow>();
  const make = (groupId: string, fromItemId: string, toItemId: string): SwapRow => ({
    groupId,
    fromItemId,
    toItemId,
    current: current.get(key(groupId, fromItemId, toItemId)) ?? 0,
    status: 'not_asked',
    asked: null,
    note: null,
    updatedAt: null,
    ruleCodes: (pairs.get(`${fromItemId}|${toItemId}`) ?? []).slice().sort(),
    attention: null,
  });
  for (const k of current.keys()) {
    const [g, f, t] = k.split('|') as [string, string, string];
    if ((current.get(k) ?? 0) > 0) out.set(k, make(g, f, t));
  }
  for (const c of s.consents) {
    const k = key(c.group_id, c.from_item_id, c.to_item_id);
    const row = out.get(k) ?? make(c.group_id, c.from_item_id, c.to_item_id);
    row.status = c.status;
    row.asked = c.count;
    row.note = c.note;
    row.updatedAt = c.updated_at;
    out.set(k, row);
  }
  for (const row of out.values()) row.attention = swapAttention(row.status, row.current, row.asked);

  const groupOrder = new Map(
    s.groups
      .map((g) => ({ id: g.id, name: g.name, sortOrder: g.sort_order }))
      .sort(compareBySortOrder)
      .map((g, k) => [g.id, k]),
  );
  const itemOrder = new Map(
    s.items
      .map((i) => ({ id: i.id, name: i.name, sortOrder: i.sort_order }))
      .sort(compareBySortOrder)
      .map((i, k) => [i.id, k]),
  );
  const rank = (m: Map<string, number>, id: string) => m.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...out.values()].sort(
    (a, b) =>
      rank(groupOrder, a.groupId) - rank(groupOrder, b.groupId) ||
      rank(itemOrder, a.fromItemId) - rank(itemOrder, b.fromItemId) ||
      rank(itemOrder, a.toItemId) - rank(itemOrder, b.toItemId) ||
      (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0),
  );
}
