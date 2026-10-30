// 距離 d(r, g)（03「距離コスト」、設計 6.1）。上から順に、最初に当てはまるもの。階が null の部屋は1階として扱う
import type { Room } from '@gaapp/shared';
import { pairKey } from './context';

type DistRoom = Pick<Room, 'id' | 'kind' | 'building' | 'floor' | 'extraCost'>;

const floorOf = (r: DistRoom) => r.floor ?? 1;

/**
 * 保管場所 r から使用場所 L への距離（整数）。L が null は使用場所のない団体（校内分散）。
 * overrides は建物の無向の組（pairKey）→ コスト。上書きは「別の建物」の 4 だけを置き換える。
 */
export function distance(r: DistRoom, L: DistRoom | null, overrides: ReadonlyMap<string, number>): number {
  if (L === null) return 4 + r.extraCost; // 1：使用場所がない
  if (r.id === L.id) return 0; // 2：残す（追加コストは足さない）
  let base: number;
  if (L.kind === 'outdoor') {
    base = r.kind === 'outdoor' || floorOf(r) <= 1 ? 3 : 5; // 3：屋外の使用場所へ
  } else if (r.kind === 'outdoor') {
    base = floorOf(L) <= 1 ? 3 : 5; // 4：屋外の保管場所から建物の使用場所へ
  } else if (r.building !== null && r.building === L.building) {
    base = floorOf(r) === floorOf(L) ? 1 : 2; // 5：同じ建物
  } else {
    // 6：別の建物（building が null のものを含む）
    const o = r.building !== null && L.building !== null ? overrides.get(pairKey(r.building, L.building)) : undefined;
    base = o ?? 4;
  }
  return base + r.extraCost;
}
