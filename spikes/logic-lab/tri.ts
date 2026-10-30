import { distance2 } from './src/model2.ts';
import type { Room } from './src/types.ts';
const rooms: Room[] = []; let n = 0;
const kinds = ['room', 'gym', 'outdoor', 'other'] as const;
for (const kind of kinds) for (const b of ['X', 'Y', null]) for (const f of [null, 0, 1, 2, 3]) for (const x of [0, 2]) {
  if (kind === 'outdoor' && (b !== null || f !== null)) continue;
  rooms.push({ id: `r${n++}`, name: '', kind, building: b, floor: f, extraCost: x, usable: true, sortOrder: 0 });
}
const ov = new Map<string, number>();
let bad = 0, total = 0;
for (const r of rooms) for (const L of rooms) for (const H of [...rooms, null]) {
  if (r.id === L.id) continue;
  total++;
  const lhs = distance2(r, H, ov), rhs = distance2(r, L, ov) + distance2(L, H, ov);
  if (lhs > rhs) { bad++; if (bad < 5) console.log('violation', r, L, H, lhs, rhs); }
}
console.log({ rooms: rooms.length, total, bad });
