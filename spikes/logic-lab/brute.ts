// 小さな入力で、LP の解が辞書式の最小（代替 → 前回を保つ台数 → 距離 → 休憩所の優先 → 残す）と一致するかを総当たりで確かめる
import loadHighs from 'highs';
import { mulberry32, uuid } from './src/rng.ts';
import { build, solve } from './src/model2.ts';
import type { AllocateInput, AllocationRow, Room, Group, Item } from './src/types.ts';
const highs = await loadHighs();
let checked = 0, mismatch = 0, infeasible = 0, skipped = 0;
for (let seed = 1; seed <= 400; seed++) {
  const r = mulberry32(seed);
  const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const codes = ['desk', 'desk_ng', 'chair', 'chair_ng', 'caster_desk'] as const;
  const items: Item[] = codes.map((c, k) => ({ id: uuid(r), code: c as any, sortOrder: k }));
  const idOf = (c: string) => items.find((x) => x.code === c)!.id;
  const rooms: Room[] = [];
  const nR = ri(2, 4);
  for (let k = 0; k < nR; k++) rooms.push({ id: uuid(r), name: `R${k}`, kind: r() < 0.15 ? 'outdoor' : 'room', building: `B${ri(0, 1)}`, floor: ri(1, 2), extraCost: r() < 0.2 ? 1 : 0, usable: true, sortOrder: k });
  for (const rm of rooms) if (rm.kind === 'outdoor') { rm.building = null; rm.floor = null; }
  const groups: Group[] = [];
  const nG = ri(2, 3);
  const cats = ['stall', 'rest_area', 'department'] as const;
  for (let k = 0; k < nG; k++) groups.push({ id: uuid(r), name: `G${k}`, category: cats[ri(0, 2)]!, locationRoomId: r() < 0.85 ? rooms[ri(0, nR - 1)]!.id : null, sortOrder: k });
  const stocks: AllocateInput['stocks'] = [];
  for (const rm of rooms) for (const it of items) { const n = r() < 0.5 ? 0 : ri(1, 3); if (n) stocks.push({ roomId: rm.id, itemId: it.id, count: n }); }
  const requests: AllocateInput['requests'] = [];
  for (const g of groups) for (const c of ['desk', 'chair']) { const n = r() < 0.4 ? 0 : ri(1, 3); if (n) requests.push({ groupId: g.id, itemId: idOf(c), count: n }); }
  const rules: AllocateInput['rules'] = [
    { code: 'S01', kind: 'substitute', params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0 } },
    { code: 'S02', kind: 'substitute', params: { from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: 0, preferCategory: 'rest_area' } },
    { code: 'S07', kind: 'substitute', params: { from: 'desk', to: 'caster_desk', categories: ['stall'], indoorOnly: true, cost: 3 } },
  ];
  const input: AllocateInput = { items, rooms, stocks, groups, requests, rules, consents: [], fixedRows: [], distanceOverrides: r() < 0.5 ? [{ buildingA: 'B0', buildingB: 'B1', cost: ri(0, 5) }] : [] };
  // 最小変更：ランダムな前回の行
  const mc = seed % 2 === 0;
  const prev: AllocationRow[] = [];
  if (mc) for (let k = 0; k < 3; k++) { const g = groups[ri(0, nG - 1)]!; const it = items[ri(0, 4)]!; const req = it.code.startsWith('desk') || it.code === 'caster_desk' ? idOf('desk') : idOf('chair'); prev.push({ sourceRoomId: rooms[ri(0, nR - 1)]!.id, groupId: g.id, requestedItemId: req, itemId: it.id, count: ri(1, 2), isKeep: false }); }
  const m = build(input, mc ? { mode: 'minimal_change', previousRows: prev, muMode: 'lex' } : { mode: 'full' });
  if (m.noCandidate.length || m.vars.length === 0) { skipped++; continue; }
  if (m.vars.length > 14) { skipped++; continue; }
  const s = solve(highs, m);
  // 総当たり
  const demandRows = new Map<string, number[]>();
  m.vars.forEach((v, n) => { const k = `${v.g}|${v.i}`; (demandRows.get(k) ?? demandRows.set(k, []).get(k)!).push(n); });
  const dr = [...demandRows.entries()];
  const x = new Array(m.vars.length).fill(0);
  const used = new Map<string, number>();
  let best: number[] | null = null;
  const key = () => {
    let cs = 0, hat = 0, d = 0, p = 0, e = 0;
    m.vars.forEach((v, n) => { const q = x[n]; cs += v.csub * q; if (v.hat) hat -= q; d += v.d * q; p -= v.p * q; e += v.e * q; });
    return [cs, hat, d, p, e];
  };
  const less = (a: number[], b: number[]) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! < b[k]!; return false; };
  const rec = (row: number, pos: number, left: number) => {
    if (row === dr.length) { const k = key(); if (!best || less(k, best)) best = k; return; }
    const idx = dr[row]![1];
    if (pos === idx.length - 1) {
      const n = idx[pos]!; const v = m.vars[n]!; const sk = `${v.r}|${v.j}`;
      if (v.ub != null && left > v.ub) return;
      if ((used.get(sk) ?? 0) + left > (m.supply.get(sk) ?? 0)) return;
      x[n] = left; used.set(sk, (used.get(sk) ?? 0) + left);
      const nk = dr[row + 1];
      rec(row + 1, 0, nk ? m.demand.get(nk[0])! : 0);
      used.set(sk, used.get(sk)! - left); x[n] = 0; return;
    }
    const n = idx[pos]!; const v = m.vars[n]!; const sk = `${v.r}|${v.j}`;
    const cap = Math.min(left, v.ub ?? Infinity, (m.supply.get(sk) ?? 0) - (used.get(sk) ?? 0));
    for (let q = 0; q <= cap; q++) { x[n] = q; used.set(sk, (used.get(sk) ?? 0) + q); rec(row, pos + 1, left - q); used.set(sk, used.get(sk)! - q); }
    x[n] = 0;
  };
  rec(0, 0, m.demand.get(dr[0]![0])!);
  if (!best) { if (s.status === 'Optimal') { mismatch++; console.log('LP optimal but brute infeasible', seed); } else infeasible++; continue; }
  if (s.status !== 'Optimal') { mismatch++; console.log('brute feasible but LP', s.status, seed); continue; }
  // LP の解の key
  const res = highs.solve(m.lp, { solver: 'simplex', random_seed: 0, output_flag: false });
  m.vars.forEach((v, n) => (x[n] = Math.round(res.Columns[v.name].Primal)));
  const lk = key();
  checked++;
  if (less(best, lk)) { mismatch++; console.log('MISMATCH seed', seed, 'lp', lk, 'best', best); }
}
console.log({ checked, mismatch, infeasible, skipped });
