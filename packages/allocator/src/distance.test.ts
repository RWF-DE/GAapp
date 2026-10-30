import { describe, expect, it } from 'vitest';
import type { Room } from '@gaapp/shared';
import { pairKey } from './context';
import { distance } from './distance';

let n = 0;
const room = (o: Partial<Room>): Room => ({
  id: `r${n++}`, name: 'x', kind: 'room', building: 'A', floor: 1, extraCost: 0, isStorage: true, usable: true, sortOrder: 0, ...o,
});
const none = new Map<string, number>();

describe('distance（設計 6.1 の表）', () => {
  const L1 = room({ building: 'A', floor: 1 });
  const L2 = room({ building: 'A', floor: 2 });
  const out = room({ kind: 'outdoor', building: null, floor: null });
  it.each([
    ['1 使用場所なし', room({ extraCost: 2 }), null, 6],
    ['2 残す（extra は足さない）', L1, L1, 0],
    ['3 屋外へ・1階から', room({ building: 'B', floor: 1 }), out, 3],
    ['3 屋外へ・2階から', room({ building: 'B', floor: 2 }), out, 5],
    ['3 屋外へ・屋外から', room({ kind: 'outdoor', building: null, floor: null }), out, 3],
    ['3 屋外へ・階 null は1階', room({ kind: 'gym', building: '体育館', floor: null }), out, 3],
    ['4 屋外から1階へ', out, L1, 3],
    ['4 屋外から2階へ', out, L2, 5],
    ['5 同じ建物・同じ階', room({ building: 'A', floor: 2 }), L2, 1],
    ['5 同じ建物・別の階', room({ building: 'A', floor: 1 }), L2, 2],
    ['5 階 null と 1 は同じ階', room({ building: 'A', floor: null }), L1, 1],
    ['6 別の建物', room({ building: 'B' }), L1, 4],
    ['6 building null', room({ kind: 'other', building: null }), L1, 4],
    ['extra を足す', room({ building: 'B', extraCost: 3 }), L1, 7],
  ] as const)('%s', (_label, r, L, d) => {
    expect(distance(r, L, none)).toBe(d);
  });

  it('上書きは別の建物の 4 だけを置き換え、向きを問わない', () => {
    const ov = new Map([[pairKey('A', 'B'), 1]]);
    expect(distance(room({ building: 'B' }), L1, ov)).toBe(1);
    expect(distance(room({ building: 'A' }), room({ building: 'B' }), ov)).toBe(1);
    expect(distance(room({ building: 'B', extraCost: 2 }), L1, ov)).toBe(3);
    // 同じ建物・屋外には効かない
    expect(distance(room({ building: 'A', floor: 2 }), L1, new Map([[pairKey('A', 'A'), 0]]))).toBe(2);
    expect(distance(room({ building: 'B', floor: 1 }), out, ov)).toBe(3);
    // building が null の部屋には効かない
    expect(distance(room({ building: null }), L1, ov)).toBe(4);
  });

  it('上書きがなければ三角不等式 d(r,h) ≤ d(r,L) ＋ d(L,h) を満たす（設計 6.1。92 部屋の全組）', () => {
    const rooms: Room[] = [];
    for (const kind of ['room', 'gym', 'outdoor', 'other'] as const)
      for (const b of ['X', 'Y', null])
        for (const f of [null, 0, 1, 2, 3])
          for (const x of [0, 2]) {
            if (kind === 'outdoor' && (b !== null || f !== null)) continue;
            rooms.push(room({ kind, building: b, floor: f, extraCost: x }));
          }
    expect(rooms).toHaveLength(92);
    let bad = 0;
    let total = 0;
    for (const r of rooms)
      for (const L of rooms)
        for (const H of [...rooms, null]) {
          if (r.id === L.id) continue;
          total++;
          if (distance(r, H, none) > distance(r, L, none) + distance(L, H, none)) bad++;
        }
    expect(total).toBe(778596);
    expect(bad).toBe(0);
  });
});
