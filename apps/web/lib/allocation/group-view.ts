// 団体別の表示（画面の設計 3.9 の「左：団体別」。T13）。純粋関数。
// 団体ごと（並び順）に、申請品目ごとの需要（buildDemand の D。企業以外の長机(3人掛)は長机(2人掛)に、未提出の設営は固定の数に）、
// 振り分け数（申請品目ごとの行の合計。行の申請品目にも読み替えを当てる）、差（不足は E003、多いは W101）、内訳（運ぶ品目と運び元）。
import { buildDemand, compareBySortOrder, giKey, rewriteRequestedItem, type StoredAllocationRow, type YearData } from '@gaapp/shared';
import type { GroupInfo, ViewModel } from './view-model';

export interface GroupItemLine {
  requestedItemId: string;
  requestedName: string;
  demand: number;
  allocated: number;
  /** allocated − demand（負は不足 = E003、正は多い = W101） */
  diff: number;
  /** 運ぶ品目ごと：品目名・数・運び元（「机(木) 10・不可机 2」と運び元） */
  breakdown: { itemId: string; itemName: string; count: number; sources: { roomId: string; roomName: string; count: number }[] }[];
}

export interface GroupView {
  group: GroupInfo;
  lines: GroupItemLine[];
}

/**
 * @param data toYearData の data（需要を作るため。在庫と申請を読める立場だけ）
 */
export function groupViews(vm: ViewModel, data: Pick<YearData, 'items' | 'groups' | 'requests' | 'rules'>, rows: readonly StoredAllocationRow[]): GroupView[] {
  const { demand } = buildDemand(data);
  const itemsForRewrite = data.items;
  const codeById = new Map(data.items.map((i) => [i.id, i.code]));
  const idByCode = new Map(data.items.map((i) => [i.code, i.id]));
  const rewritten = (r: StoredAllocationRow): string => {
    const g = vm.groupById.get(r.groupId);
    const code = codeById.get(r.requestedItemId);
    if (!g || code === undefined) return r.requestedItemId;
    const to = rewriteRequestedItem(code, g.category, itemsForRewrite);
    return to === null ? r.requestedItemId : (idByCode.get(to) ?? r.requestedItemId);
  };

  const rowsByKey = new Map<string, StoredAllocationRow[]>();
  for (const r of rows) {
    const k = giKey(r.groupId, rewritten(r));
    const list = rowsByKey.get(k) ?? [];
    list.push(r);
    rowsByKey.set(k, list);
  }

  const out: GroupView[] = [];
  for (const group of vm.groups) {
    const lines: GroupItemLine[] = [];
    for (const item of vm.items) {
      const k = giKey(group.id, item.id);
      const d = demand.get(k) ?? 0;
      const list = rowsByKey.get(k) ?? [];
      if (d === 0 && list.length === 0) continue;
      const allocated = list.reduce((s, r) => s + r.count, 0);
      const byItem = new Map<string, Map<string, number>>();
      for (const r of list) {
        const m = byItem.get(r.itemId) ?? new Map<string, number>();
        m.set(r.sourceRoomId, (m.get(r.sourceRoomId) ?? 0) + r.count);
        byItem.set(r.itemId, m);
      }
      const breakdown = vm.items
        .filter((it) => byItem.has(it.id))
        .map((it) => {
          const m = byItem.get(it.id)!;
          const sources = [...m.entries()]
            .map(([roomId, count]) => ({ roomId, roomName: vm.roomById.get(roomId)?.name ?? '（不明な場所）', count, room: vm.roomById.get(roomId) }))
            .sort((a, b) => (a.room && b.room ? compareBySortOrder(a.room, b.room) : 0))
            .map(({ roomId, roomName, count }) => ({ roomId, roomName, count }));
          return { itemId: it.id, itemName: it.name, count: sources.reduce((s, x) => s + x.count, 0), sources };
        });
      lines.push({ requestedItemId: item.id, requestedName: item.name, demand: d, allocated, diff: allocated - d, breakdown });
    }
    if (lines.length > 0) out.push({ group, lines });
  }
  return out;
}
