// 自団体の振り分け /my のデータ（画面の設計 3.11、04「自団体の振り分け」、D-39 の Q4。T13）。
// 団体代表が自団体の分だけを読む。振り分けの行（allocations）は確定後にしか RLS で返らないので、確定前は読みに行かない。
// 読む順と読み方（loadMyData）は、ページを開いたときの先読みのために lib/data/screen-queries.ts に置く（D-45。同じ名前で re-export）。
import { compareBySortOrder, type ConsentStatus } from '@gaapp/shared';
import { useQuery } from '@tanstack/react-query';
import type { ConsentDbRow } from '@/lib/db/types';
import { callRpc } from '@/lib/rpc';
import { myDataOptions, type MyData } from './screen-queries';

export { loadMyData, myDataOptions, pickMyGroup, planMyPrefetch, type MyData } from './screen-queries';

/** クエリ（キーは `['year', yearId, 'my', groupId]`。年度の状態の遷移で queryKeys.year を invalidate すると読み直す） */
export function useMyData(yearId: string | null | undefined, groupId: string | null | undefined) {
  return useQuery(myDataOptions(yearId, groupId));
}

const bySort = <T extends { id: string; name: string; sort_order: number }>(rows: readonly T[]) =>
  new Map(
    rows
      .map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }))
      .sort(compareBySortOrder)
      .map((r, k) => [r.id, k] as const),
  );

export interface MyRequestLine {
  itemId: string;
  itemName: string;
  count: number;
}

/** 申請の内容（数が 1 以上の品目。品目の並び） */
export function myRequestLines(d: Pick<MyData, 'items' | 'requests'>): MyRequestLine[] {
  const order = bySort(d.items);
  const name = new Map(d.items.map((i) => [i.id, i.name]));
  return d.requests
    .filter((r) => r.count > 0)
    .map((r) => ({ itemId: r.item_id, itemName: name.get(r.item_id) ?? '（不明な品目）', count: r.count }))
    .sort((a, b) => (order.get(a.itemId) ?? 1e9) - (order.get(b.itemId) ?? 1e9) || (a.itemId < b.itemId ? -1 : 1));
}

export interface MyConsent {
  fromItemId: string;
  toItemId: string;
  fromName: string;
  toName: string;
  status: Exclude<ConsentStatus, 'not_asked'>;
  /** 依頼した台数（総務が依頼しないで記録した了承では null） */
  count: number | null;
  note: string | null;
  updatedAt: string;
}

/** 交換の依頼と回答（未依頼の行は出さない。元の品目 → 先の品目の並び） */
export function myConsents(d: Pick<MyData, 'items' | 'consents'>): MyConsent[] {
  const order = bySort(d.items);
  const name = new Map(d.items.map((i) => [i.id, i.name]));
  const rank = (id: string) => order.get(id) ?? 1e9;
  return d.consents
    .filter((c): c is ConsentDbRow & { status: MyConsent['status'] } => c.status !== 'not_asked')
    .map((c) => ({
      fromItemId: c.from_item_id,
      toItemId: c.to_item_id,
      fromName: name.get(c.from_item_id) ?? '（不明な品目）',
      toName: name.get(c.to_item_id) ?? '（不明な品目）',
      status: c.status,
      count: c.count,
      note: c.note,
      updatedAt: c.updated_at,
    }))
    .sort((a, b) => rank(a.fromItemId) - rank(b.fromItemId) || rank(a.toItemId) - rank(b.toItemId));
}

/** 依頼の文（「机(木) 6 台をキャスター机に交換してほしいという依頼があります」） */
export function consentRequestText(c: Pick<MyConsent, 'fromName' | 'toName' | 'count'>): string {
  return c.count === null
    ? `${c.fromName}を${c.toName}に交換してほしいという依頼があります`
    :`${c.fromName} ${c.count} 台を${c.toName}に交換してほしいという依頼があります`;
}

export interface MySource {
  roomId: string;
  roomName: string;
  count: number;
  isKeep: boolean;
}

export interface MyAllocationLine {
  key: string;
  itemId: string;
  itemName: string;
  /** 代替のとき、申請した品目の名前（「机(木)の代わりにキャスター机」）。代替でなければ null */
  insteadOf: string | null;
  total: number;
  sources: MySource[];
}

/**
 * 確定後の振り分け（品目ごとの数と運び元）。（申請品目・品目）ごとにまとめ、申請品目の並び → 代替でない行を先 → 品目の並び。
 * 運び元は 残す → 場所の並び。
 */
export function myAllocationLines(d: Pick<MyData, 'items' | 'rooms' | 'allocations'>): MyAllocationLine[] {
  const itemOrder = bySort(d.items);
  const roomOrder = bySort(d.rooms);
  const itemName = new Map(d.items.map((i) => [i.id, i.name]));
  const roomName = new Map(d.rooms.map((r) => [r.id, r.name]));
  const lines = new Map<string, MyAllocationLine & { requestedItemId: string }>();
  for (const a of d.allocations ?? []) {
    if (a.count <= 0) continue;
    const key = `${a.requested_item_id}|${a.item_id}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        key,
        itemId: a.item_id,
        requestedItemId: a.requested_item_id,
        itemName: itemName.get(a.item_id) ?? '（不明な品目）',
        insteadOf: a.requested_item_id === a.item_id ? null : (itemName.get(a.requested_item_id) ?? '（不明な品目）'),
        total: 0,
        sources: [],
      };
      lines.set(key, line);
    }
    line.total += a.count;
    const src = line.sources.find((s) => s.roomId === a.source_room_id && s.isKeep === a.is_keep);
    if (src) src.count += a.count;
    else line.sources.push({ roomId: a.source_room_id, roomName: roomName.get(a.source_room_id) ?? '（不明な場所）', count: a.count, isKeep: a.is_keep });
  }
  const rank = (m: Map<string, number>, id: string) => m.get(id) ?? 1e9;
  for (const l of lines.values()) {
    l.sources.sort((a, b) => Number(b.isKeep) - Number(a.isKeep) || rank(roomOrder, a.roomId) - rank(roomOrder, b.roomId) || (a.roomId < b.roomId ? -1 : 1));
  }
  return [...lines.values()]
    .sort(
      (a, b) =>
        rank(itemOrder, a.requestedItemId) - rank(itemOrder, b.requestedItemId) ||
        Number(a.insteadOf !== null) - Number(b.insteadOf !== null) ||
        rank(itemOrder, a.itemId) - rank(itemOrder, b.itemId),
    )
    .map(({ requestedItemId: _r, ...l }) => {
      void _r;
      return l;
    });
}

export const KEEP_TEXT = '使用場所にあるものを使う（残す）';

/** 運び元の1つの文（「1-1 から 8台」・「使用場所にあるものを使う（残す）8台」） */
export function sourceText(s: MySource): string {
  return s.isKeep ? `${KEEP_TEXT} ${s.count}台` : `${s.roomName} から ${s.count}台`;
}

/**
 * 1行の文。運び元が1つで残すでなければ「机(木) 12台（1-1 から）」、ほかは「机(木) 12台：1-1 から 8台、1-2 から 4台」。
 * 代替は「机(木)の代わりにキャスター机 6台（2-3 から）」。
 */
export function allocationLineText(l: MyAllocationLine): string {
  const head = `${l.insteadOf ? `${l.insteadOf}の代わりに${l.itemName}` : l.itemName} ${l.total}台`;
  const only = l.sources.length === 1 ? l.sources[0]! : null;
  if (only && !only.isKeep) return `${head}（${only.roomName} から）`;
  if (only && only.isKeep) return `${head}：${KEEP_TEXT}`;
  return `${head}：${l.sources.map(sourceText).join('、')}`;
}

/** 回答を記録する（set_consent の accepted・declined。団体代表は依頼の後だけ、振り分け中だけ答えられる） */
export async function answerConsent(args: {
  groupId: string;
  fromItemId: string;
  toItemId: string;
  status: 'accepted' | 'declined';
  note?: string | null;
}): Promise<ConsentDbRow> {
  const note = args.note?.trim();
  const res = await callRpc('set_consent', {
    p_group_id: args.groupId,
    p_from_item: args.fromItemId,
    p_to_item: args.toItemId,
    p_status: args.status,
    ...(note ? { p_note: note } : {}),
  });
  return res as unknown as ConsentDbRow;
}
