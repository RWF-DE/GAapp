// 変数の候補と、候補が足りない需要（設計 7 章・5 章 P7）
import { giKey, type Shortage } from '@gaapp/shared';
import { rgijKey, rjKey, type Ctx } from './context';
import { distance } from './distance';
import type { Prepared } from './prepare';
import { allowedSources, substituteOptions } from './rules';

export type Candidate = {
  r: string;
  g: string;
  i: string;
  j: string;
  /** 最小変更モードの x̂（前回と同じ組み合わせ。上限つき） */
  hat: boolean;
  /** x̂ の上限（x は null） */
  ub: number | null;
  d: number;
  e: 0 | 1;
  p: 0 | 1;
  cSub: number;
};

export type DemandRow = { key: string; g: string; i: string; demand: number; vars: number[] };
export type SupplyRow = { key: string; r: string; j: string; supply: number; vars: number[] };

export type Candidates = {
  vars: Candidate[];
  demandRows: DemandRow[];
  supplyRows: SupplyRow[];
  /** 変数がない需要と、変数の運び元の S′ の合計が D′ に足りない需要（団体つき） */
  shortages: Shortage[];
};

export function buildCandidates(ctx: Ctx, prepared: Prepared): Candidates {
  const vars: Candidate[] = [];
  const demandRows: DemandRow[] = [];
  const shortages: Shortage[] = [];
  for (const g of ctx.groups) {
    const L = g.locationRoomId === null ? null : ctx.roomById.get(g.locationRoomId)!;
    for (const it of ctx.items) {
      const dk = giKey(g.id, it.id);
      const need = prepared.demand.get(dk) ?? 0;
      if (need <= 0) continue;
      const allowed = allowedSources(ctx, g, it);
      const idx: number[] = [];
      const sources = new Set<string>();
      for (const op of substituteOptions(ctx, g, it)) {
        for (const room of ctx.rooms) {
          const sk = rjKey(room.id, op.j);
          if ((prepared.supply.get(sk) ?? 0) <= 0) continue;
          if (allowed !== null && !allowed.has(room.id)) continue;
          const base = {
            r: room.id,
            g: g.id,
            i: it.id,
            j: op.j,
            d: distance(room, L, ctx.overrides),
            e: (L !== null && room.id === L.id ? 0 : 1) as 0 | 1,
            p: op.p,
            cSub: op.cSub,
          };
          vars.push({ ...base, hat: false, ub: null });
          idx.push(vars.length - 1);
          sources.add(sk);
          const hb = prepared.hatBound.get(rgijKey(room.id, g.id, it.id, op.j));
          if (hb !== undefined && hb > 0) {
            vars.push({ ...base, hat: true, ub: hb });
            idx.push(vars.length - 1);
          }
        }
      }
      const supply = [...sources].reduce((a, k) => a + prepared.supply.get(k)!, 0);
      if (idx.length === 0 || supply < need) {
        shortages.push({ requestedItemId: it.id, groupId: g.id, demand: need, supply });
      }
      demandRows.push({ key: dk, g: g.id, i: it.id, demand: need, vars: idx });
    }
  }
  // 在庫の行：変数が1つ以上あるものだけ。場所 → 品目の順
  const byKey = new Map<string, number[]>();
  vars.forEach((v, n) => {
    const k = rjKey(v.r, v.j);
    const list = byKey.get(k);
    if (list) list.push(n);
    else byKey.set(k, [n]);
  });
  const supplyRows: SupplyRow[] = [];
  for (const room of ctx.rooms) {
    for (const it of ctx.items) {
      const k = rjKey(room.id, it.id);
      const list = byKey.get(k);
      if (list) supplyRows.push({ key: k, r: room.id, j: it.id, supply: prepared.supply.get(k)!, vars: list });
    }
  }
  return { vars, demandRows, supplyRows, shortages };
}
