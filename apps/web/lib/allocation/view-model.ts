// 振り分け画面の表示のための索引（画面の設計 3.9。T13）。純粋関数。
// viewer（part = public）は toYearData を使えない（在庫・申請を読めない）ので、スナップショットの行から直接作る。
import { compareBySortOrder, type GroupCategory } from '@gaapp/shared';
import type { Snapshot } from '@/lib/data/snapshot';

export interface RoomInfo {
  id: string;
  name: string;
  sortOrder: number;
  isStorage: boolean;
  usable: boolean;
}
export interface GroupInfo {
  id: string;
  name: string;
  displayName: string | null;
  category: GroupCategory;
  locationRoomId: string | null;
  sortOrder: number;
}
export interface ItemInfo {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  requestableCategories: GroupCategory[];
}

export interface ViewModel {
  rooms: RoomInfo[];
  groups: GroupInfo[];
  items: ItemInfo[];
  roomById: Map<string, RoomInfo>;
  groupById: Map<string, GroupInfo>;
  itemById: Map<string, ItemInfo>;
  /** `${roomId}|${itemId}` → 在庫（part = full のときだけ。public は空） */
  stock: Map<string, number>;
  /** 在庫を読めるか（part = full） */
  hasStock: boolean;
}

export const roomItemKey = (roomId: string, itemId: string) => `${roomId}|${itemId}`;

type Source = Pick<Snapshot, 'part' | 'items' | 'rooms' | 'roomYears' | 'groups' | 'stocks'>;

export function buildViewModel(s: Source): ViewModel {
  const usable = new Map(s.roomYears.map((ry) => [ry.room_id, ry.usable]));
  const rooms = s.rooms
    .map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, isStorage: r.is_storage, usable: usable.get(r.id) ?? true }))
    .sort(compareBySortOrder);
  const groups = s.groups
    .map((g) => ({
      id: g.id,
      name: g.name,
      displayName: g.display_name?.trim() ? g.display_name : null,
      category: g.category,
      locationRoomId: g.location_room_id,
      sortOrder: g.sort_order,
    }))
    .sort(compareBySortOrder);
  const items = s.items
    .map((i) => ({ id: i.id, code: i.code, name: i.name, sortOrder: i.sort_order, requestableCategories: [...i.requestable_categories] }))
    .sort(compareBySortOrder);
  const stock = new Map<string, number>();
  for (const st of s.stocks) {
    const k = roomItemKey(st.room_id, st.item_id);
    stock.set(k, (stock.get(k) ?? 0) + st.count);
  }
  return {
    rooms,
    groups,
    items,
    roomById: new Map(rooms.map((r) => [r.id, r])),
    groupById: new Map(groups.map((g) => [g.id, g])),
    itemById: new Map(items.map((i) => [i.id, i])),
    stock,
    hasStock: s.part === 'full',
  };
}

/** 名前の引き方（ErrorBanner・issueMessages に渡す） */
export function namesOf(vm: ViewModel) {
  return {
    room: (id: string) => vm.roomById.get(id)?.name,
    item: (id: string) => vm.itemById.get(id)?.name,
    group: (id: string) => vm.groupById.get(id)?.name,
  };
}
