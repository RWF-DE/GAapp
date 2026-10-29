// 総当たりの検算（設計 12.1・12.5）：spikes/logic-lab/brute-lex-1200.ts の生成器と列挙を移したもの。
// 小さな入力の全整数解を列挙し、辞書式の最小（代替 → 前回を保つ台数 → 距離 → 休憩所の優先 → 残す）を求める
import { INITIAL_ITEMS, type AllocateInput, type AllocationRow, type Group, type Item, type Room } from '@gaapp/shared';
import { mulberry32, uuidFromRng, uuidv5 } from '@gaapp/shared/testing';
import type { Candidate, Candidates } from '../candidates';

const CODES = ['desk', 'desk_ng', 'chair', 'chair_ng', 'caster_desk'] as const;

/** brute-lex-1200.ts と同じ乱数の列で入力を作る（id は乱数の UUID、ルールの id だけ UUIDv5） */
export function bruteInput(seed: number): AllocateInput {
  const r = mulberry32(seed);
  const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const items: Item[] = CODES.map((c, k) => {
    const init = INITIAL_ITEMS.find((i) => i.code === c)!;
    return { id: uuidFromRng(r), code: c, name: init.name, requestableCategories: [...init.requestableCategories], sortOrder: k };
  });
  const idOf = (c: string) => items.find((x) => x.code === c)!.id;
  const rooms: Room[] = [];
  const nR = ri(2, 4);
  for (let k = 0; k < nR; k++) {
    const id = uuidFromRng(r);
    const kind = r() < 0.15 ? 'outdoor' : 'room';
    const building = `B${ri(0, 1)}`;
    const floor = ri(1, 2);
    const extraCost = r() < 0.2 ? 1 : 0;
    rooms.push({ id, name: `R${k}`, kind, building, floor, extraCost, isStorage: true, usable: true, sortOrder: k });
  }
  for (const rm of rooms) if (rm.kind === 'outdoor') Object.assign(rm, { building: null, floor: null });
  const groups: Group[] = [];
  const nG = ri(2, 3);
  const cats = ['stall', 'rest_area', 'department'] as const;
  for (let k = 0; k < nG; k++) {
    const id = uuidFromRng(r);
    const category = cats[ri(0, 2)]!;
    const locationRoomId = r() < 0.85 ? rooms[ri(0, nR - 1)]!.id : null;
    groups.push({ id, name: `G${k}`, displayName: null, category, locationRoomId, sortOrder: k, submittedAt: '2026-07-01T12:00:00+09:00' });
  }
  const stocks: AllocateInput['stocks'] = [];
  for (const rm of rooms)
    for (const it of items) {
      const n = r() < 0.5 ? 0 : ri(1, 3);
      if (n) stocks.push({ roomId: rm.id, itemId: it.id, count: n });
    }
  const requests: AllocateInput['requests'] = [];
  for (const g of groups)
    for (const c of ['desk', 'chair']) {
      const n = r() < 0.4 ? 0 : ri(1, 3);
      if (n) requests.push({ groupId: g.id, itemId: idOf(c), count: n });
    }
  const rid = (c: string) => uuidv5(`rule:brute:${c}`);
  const rules: AllocateInput['rules'] = [
    { id: rid('S01'), code: 'S01', kind: 'substitute', params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0, indoorOnly: false, needsConsent: false } },
    { id: rid('S02'), code: 'S02', kind: 'substitute', params: { from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: 0, preferCategory: 'rest_area', indoorOnly: false, needsConsent: false } },
    { id: rid('S07'), code: 'S07', kind: 'substitute', params: { from: 'desk', to: 'caster_desk', categories: ['stall'], indoorOnly: true, cost: 3, needsConsent: false } },
  ];
  const distanceOverrides = r() < 0.5 ? [{ buildingA: 'B0', buildingB: 'B1', cost: ri(0, 5) }] : [];
  // 最小変更：偶数のシードは、ランダムな前回の行3つ
  const mc = seed % 2 === 0;
  const previousRows: AllocationRow[] = [];
  if (mc)
    for (let k = 0; k < 3; k++) {
      const g = groups[ri(0, nG - 1)]!;
      const it = items[ri(0, 4)]!;
      const req = it.code.startsWith('desk') || it.code === 'caster_desk' ? idOf('desk') : idOf('chair');
      previousRows.push({ sourceRoomId: rooms[ri(0, nR - 1)]!.id, groupId: g.id, requestedItemId: req, itemId: it.id, count: ri(1, 2), isKeep: false });
    }
  return { items, rooms, groups, stocks, requests, rules, consents: [], distanceOverrides, mode: mc ? 'minimal_change' : 'full', fixedRows: [], previousRows };
}

/** 解の5段の値：[Σc_sub, −Σx̂, Σd, −Σp, Σe] */
export function lexKey(vars: readonly Candidate[], x: readonly number[]): number[] {
  const k = [0, 0, 0, 0, 0];
  vars.forEach((v, n) => {
    const q = x[n]!;
    k[0]! += v.cSub * q;
    if (v.hat) k[1]! -= q;
    k[2]! += v.d * q;
    k[3]! -= v.p * q;
    k[4]! += v.e * q;
  });
  return k;
}

export const lexLess = (a: readonly number[], b: readonly number[]) => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! < b[k]!;
  return false;
};

/** 全整数解を列挙して辞書式の最小を返す（解がなければ null） */
export function bruteForceLexMin(cands: Candidates): number[] | null {
  const { vars, demandRows } = cands;
  const supply = new Map(cands.supplyRows.map((s) => [s.key, s.supply]));
  const x = new Array<number>(vars.length).fill(0);
  const used = new Map<string, number>();
  let best: number[] | null = null;
  const sk = (v: Candidate) => `${v.r}|${v.j}`;
  const rec = (row: number, pos: number, left: number): void => {
    if (row === demandRows.length) {
      const k = lexKey(vars, x);
      if (!best || lexLess(k, best)) best = k;
      return;
    }
    const idx = demandRows[row]!.vars;
    const n = idx[pos]!;
    const v = vars[n]!;
    const cap = Math.min(left, v.ub ?? Infinity, (supply.get(sk(v)) ?? 0) - (used.get(sk(v)) ?? 0));
    if (pos === idx.length - 1) {
      if (left > cap) return;
      x[n] = left;
      used.set(sk(v), (used.get(sk(v)) ?? 0) + left);
      rec(row + 1, 0, demandRows[row + 1]?.demand ?? 0);
      used.set(sk(v), used.get(sk(v))! - left);
      x[n] = 0;
      return;
    }
    for (let q = 0; q <= cap; q++) {
      x[n] = q;
      used.set(sk(v), (used.get(sk(v)) ?? 0) + q);
      rec(row, pos + 1, left - q);
      used.set(sk(v), used.get(sk(v))! - q);
    }
    x[n] = 0;
  };
  if (demandRows.length > 0) rec(0, 0, demandRows[0]!.demand);
  return best;
}
