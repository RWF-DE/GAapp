// 品目別の表示（画面の設計 3.9 の「左：品目別」。T13）。純粋関数。
// 各タブは運び元（場所の並び順）ごとのまとまり。まとまりの見出しに部屋名・在庫・使用不可の印、最後に余りの行
// （在庫 − その部屋のその品目の行の合計。使用不可の部屋は「使用不可（在庫 n）」で余りに数えない。マイナスは E001 の印）。
import { compareBySortOrder, type StoredAllocationRow } from '@gaapp/shared';
import type { ItemTab } from './tabs';
import { roomItemKey, type GroupInfo, type RoomInfo, type ViewModel } from './view-model';

export const KEEP_DEST = '残す';

export interface ItemRowView {
  row: StoredAllocationRow;
  /** 運び先（残すの行は「残す」、使用場所のない団体は ''） */
  dest: string;
  group: GroupInfo | undefined;
  /** 品目の名前（2品目のタブだけ使う） */
  itemName: string;
  /** 申請品目の名前（品目と違うときだけ。「机(木)の代わり」） */
  requestedName: string | null;
}

export interface StockCell {
  itemId: string;
  name: string;
  /** 在庫（読めない立場は null） */
  stock: number | null;
  /** その部屋のその品目の行の合計 */
  allocated: number;
  /** 在庫 − 合計（読めない立場・使用不可の部屋は null） */
  surplus: number | null;
}

export interface RoomBlock {
  room: RoomInfo;
  cells: StockCell[];
  rows: ItemRowView[];
}

function destOf(row: StoredAllocationRow, group: GroupInfo | undefined, vm: ViewModel): { dest: string; rank: number; room?: RoomInfo } {
  if (row.isKeep) return { dest: KEEP_DEST, rank: -1 };
  const loc = group?.locationRoomId ? vm.roomById.get(group.locationRoomId) : undefined;
  return loc ? { dest: loc.name, rank: 0, room: loc } : { dest: '', rank: 1 };
}

/**
 * タブのまとまり。在庫か行のある部屋だけ（場所の並び順）。行の並びは exporter と同じ向き：
 * 残す → 運び先（場所の並び順）→ 団体（並び順）→ 品目（タブの中の並び）→ id。
 */
export function itemTabBlocks(vm: ViewModel, rows: readonly StoredAllocationRow[], tab: ItemTab): RoomBlock[] {
  const itemIds = tab.items.map((i) => i.id);
  const itemRank = new Map(itemIds.map((id, k) => [id, k]));
  const tabRows = rows.filter((r) => itemRank.has(r.itemId));
  const bySource = new Map<string, StoredAllocationRow[]>();
  for (const r of tabRows) {
    const list = bySource.get(r.sourceRoomId) ?? [];
    list.push(r);
    bySource.set(r.sourceRoomId, list);
  }

  const blocks: RoomBlock[] = [];
  const rooms = [...vm.rooms];
  // スナップショットにない部屋の行（起きないはず）も落とさない
  for (const id of bySource.keys()) {
    if (!vm.roomById.has(id)) rooms.push({ id, name: '（不明な場所）', sortOrder: Number.MAX_SAFE_INTEGER, isStorage: false, usable: true });
  }
  for (const room of rooms) {
    const list = bySource.get(room.id) ?? [];
    const stocks = tab.items.map((it) => (vm.hasStock ? (vm.stock.get(roomItemKey(room.id, it.id)) ?? 0) : null));
    if (list.length === 0 && stocks.every((n) => !n)) continue;

    const views = list
      .map((row) => {
        const group = vm.groupById.get(row.groupId);
        const d = destOf(row, group, vm);
        const requested = row.requestedItemId !== row.itemId ? (vm.itemById.get(row.requestedItemId)?.name ?? '（不明な品目）') : null;
        return {
          view: {
            row,
            dest: d.dest,
            group,
            itemName: vm.itemById.get(row.itemId)?.name ?? '（不明な品目）',
            requestedName: requested,
          },
          d,
        };
      })
      .sort(
        (a, b) =>
          a.d.rank - b.d.rank ||
          (a.d.room && b.d.room ? compareBySortOrder(a.d.room, b.d.room) : 0) ||
          (a.view.group && b.view.group ? compareBySortOrder(a.view.group, b.view.group) : 0) ||
          (itemRank.get(a.view.row.itemId)! - itemRank.get(b.view.row.itemId)!) ||
          (a.view.row.id < b.view.row.id ? -1 : a.view.row.id > b.view.row.id ? 1 : 0),
      )
      .map((x) => x.view);

    const cells = tab.items.map((it, k) => {
      const allocated = list.filter((r) => r.itemId === it.id).reduce((s, r) => s + r.count, 0);
      const stock = stocks[k] ?? null;
      return { itemId: it.id, name: it.name, stock, allocated, surplus: stock === null || !room.usable ? null : stock - allocated };
    });
    blocks.push({ room, cells, rows: views });
  }
  return blocks;
}
