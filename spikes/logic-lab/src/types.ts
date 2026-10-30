// 03_allocation.md「入力と出力」の型のうち、スパイクで使う部分だけ。
export type ItemCode =
  | 'desk' | 'desk_ng' | 'chair' | 'chair_ng' | 'caster_desk'
  | 'chair_blue' | 'long_desk_3' | 'long_desk_2' | 'lectern';

export type Item = { id: string; code: ItemCode; sortOrder: number };
export type Room = {
  id: string; name: string; kind: 'room' | 'gym' | 'outdoor' | 'other';
  building: string | null; floor: number | null; extraCost: number;
  usable: boolean; sortOrder: number;
};
export type Group = {
  id: string; name: string;
  category: 'stall' | 'department' | 'company' | 'rest_area';
  locationRoomId: string | null; sortOrder: number;
};
export type Rule = { code: string; kind: 'substitute' | 'source_restrict' | 'fixed_request' | 'keep'; params: any };
export type Consent = { groupId: string; fromItemId: string; toItemId: string; status: 'not_asked' | 'asked' | 'accepted' | 'declined' };
export type AllocationRow = {
  sourceRoomId: string; groupId: string; itemId: string; requestedItemId: string; count: number; isKeep: boolean;
};
export type AllocateInput = {
  items: Item[]; rooms: Room[];
  distanceOverrides: { buildingA: string; buildingB: string; cost: number }[];
  stocks: { roomId: string; itemId: string; count: number }[];
  groups: Group[];
  requests: { groupId: string; itemId: string; count: number }[];
  rules: Rule[]; consents: Consent[];
  fixedRows: AllocationRow[];
};
