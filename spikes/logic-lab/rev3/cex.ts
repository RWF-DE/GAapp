import { check } from './d08oracle.ts';
import type { AllocateInput, Room } from '../src/types.ts';
const items = [{ id: 'i-desk', code: 'desk' as const, sortOrder: 1 }];
const room = (id: string, b: string, k = 1): Room => ({ id, name: id, kind: 'room', building: b, floor: 1, extraCost: 0, usable: true, sortOrder: k });
const rooms = [{ ...room('M', 'A', 1), floor: 2 }, room('R2', 'A', 2), room('R3', 'C', 3), { ...room('X', 'A', 4), floor: 2 }, room('Y', 'A', 5)];
const groups = [
  { id: 'gS', name: 'S', category: 'department' as const, locationRoomId: 'X', sortOrder: 1 },
  { id: 'gA', name: 'A', category: 'department' as const, locationRoomId: 'Y', sortOrder: 2 },
];
const input: AllocateInput = {
  items, rooms, groups, consents: [], fixedRows: [], distanceOverrides: [],
  stocks: [{ roomId: 'M', itemId: 'i-desk', count: 1 }, { roomId: 'R2', itemId: 'i-desk', count: 2 }, { roomId: 'R3', itemId: 'i-desk', count: 5 }],
  requests: [{ groupId: 'gS', itemId: 'i-desk', count: 2 }, { groupId: 'gA', itemId: 'i-desk', count: 1 }],
  rules: [{ code: 'S05', kind: 'source_restrict', params: { group: 'gS', items: ['desk'], rooms: ['M', 'R2'] } }],
};
console.log(check(input, 'M', 'cex-s05'));
