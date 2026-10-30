// 12.5「増える例」：補えるつながりで、M から受け取っていた (g,i) の前回の行が増える最小の例
import loadHighs from 'highs';
import { build, solve, diffKeys } from '../src/model2.ts';
import { check } from '../rev3/d08oracle.ts';
import type { AllocateInput, Room } from '../src/types.ts';
const highs = await loadHighs();
const items = [{ id: 'i-desk', code: 'desk' as const, sortOrder: 1 }];
const room = (id: string, b: string, f: number, k: number): Room => ({ id, name: id, kind: 'room', building: b, floor: f, extraCost: 0, usable: true, sortOrder: k });
const rooms = [room('M', 'A', 2, 1), room('R', 'A', 1, 2), room('Q', 'C', 1, 3), room('X', 'A', 2, 4), room('Y', 'C', 1, 5)];
const groups = [
  { id: 'gS', name: 'S', category: 'department' as const, locationRoomId: 'X', sortOrder: 1 },
  { id: 'gA', name: 'A', category: 'department' as const, locationRoomId: 'Y', sortOrder: 2 },
];
const input: AllocateInput = { items, rooms, groups, consents: [], fixedRows: [], distanceOverrides: [], rules: [],
  stocks: [{ roomId: 'M', itemId: 'i-desk', count: 1 }, { roomId: 'R', itemId: 'i-desk', count: 2 }, { roomId: 'Q', itemId: 'i-desk', count: 1 }],
  requests: [{ groupId: 'gS', itemId: 'i-desk', count: 2 }, { groupId: 'gA', itemId: 'i-desk', count: 1 }] };
const s1 = solve(highs, build(input, { mode: 'full' }));
console.log('full', s1.rows.map((r) => `${r.sourceRoomId}->${r.groupId}:${r.count}`));
const input2 = { ...input, rooms: rooms.map((r) => (r.id === 'M' ? { ...r, usable: false } : r)) };
const s2 = solve(highs, build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' }));
console.log('mc', s2.status, s2.rows.map((r) => `${r.sourceRoomId}->${r.groupId}:${r.count}`));
console.log(diffKeys(s1.rows, s2.rows).changed);
console.log(check(input, 'M', 'incex'));
