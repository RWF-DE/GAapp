// 設計案（logic-design.md）の検証用。前処理・距離・変数・重み・LP・後処理。
import type { AllocateInput, AllocationRow, Group, Item, ItemCode, Room } from './types.ts';

export type MuMode = 'lex' | 'unit';
export type Opts = {
  mode: 'full' | 'minimal_change';
  previousRows?: AllocationRow[];
  muMode?: MuMode;
  disabledRules?: string[];
};
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byOrder = <T extends { sortOrder: number; id: string }>(name: (x: T) => string) => (a: T, b: T) =>
  a.sortOrder - b.sortOrder || cmpStr(name(a), name(b)) || cmpStr(a.id, b.id);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function distance2(r: Room, L: Room | null, ov: Map<string, number>): number {
  if (!L) return 4 + r.extraCost;
  if (r.id === L.id) return 0;
  const fl = (x: Room) => x.floor ?? 1;
  let base: number;
  if (L.kind === 'outdoor') base = r.kind === 'outdoor' || fl(r) <= 1 ? 3 : 5;
  else if (r.kind === 'outdoor') base = fl(L) <= 1 ? 3 : 5;
  else if (r.building != null && r.building === L.building) base = fl(r) === fl(L) ? 1 : 2;
  else {
    const o = r.building != null && L.building != null ? ov.get(pairKey(r.building, L.building)) : undefined;
    base = o ?? 4;
  }
  return base + r.extraCost;
}

export type Opt = { j: string; csub: number; p: 0 | 1; rule: string | null };
export type Var = {
  name: string; r: string; g: string; i: string; j: string; hat: boolean;
  d: number; e: 0 | 1; p: 0 | 1; csub: number; ub: number | null; cost: number;
};
export type Model = {
  lp: string; vars: Var[]; K: number; P: number; dmax: number; A: number; B: number; U: number; mu: number; W: number;
  keepRows: AllocationRow[]; demand0: Map<string, number>; demand: Map<string, number>; supply: Map<string, number>;
  noCandidate: string[];
  options: (g: Group, i: Item) => Opt[]; allowedRooms: (g: Group, i: Item) => Set<string> | null;
  groups: Group[]; rooms: Room[]; items: Item[];
};

export function build(input: AllocateInput, o: Opts): Model {
  const items = input.items.slice().sort(byOrder<Item>((x) => x.code));
  const rooms = input.rooms.slice().sort(byOrder<Room>((x) => x.name));
  const groups = input.groups.slice().sort(byOrder<Group>((x) => x.name));
  const rules = input.rules.filter((r) => !o.disabledRules?.includes(r.code)).slice().sort((a, b) => cmpStr(a.code, b.code));
  const itemById = new Map(items.map((x) => [x.id, x]));
  const roomById = new Map(rooms.map((x) => [x.id, x]));
  const groupById = new Map(groups.map((x) => [x.id, x]));
  const idOf = new Map<string, string>(items.map((x) => [x.code, x.id]));
  const ov = new Map<string, number>();
  for (const x of input.distanceOverrides) ov.set(pairKey(x.buildingA, x.buildingB), x.cost);
  const k2 = (a: string, b: string) => `${a}|${b}`;
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  // P1 申請（S03 読み替え）
  const reqAgg = new Map<string, number>();
  for (const rq of input.requests) add(reqAgg, k2(rq.groupId, rq.itemId), rq.count);
  const demand0 = new Map<string, number>();
  for (const g of groups) for (const it of items) {
    const n = reqAgg.get(k2(g.id, it.id)) ?? 0;
    if (n <= 0) continue;
    let i = it.id;
    if (it.code === 'long_desk_3' && g.category !== 'company') i = idOf.get('long_desk_2')!;
    add(demand0, k2(g.id, i), n);
  }
  // P2 fixed_request（スパイクのデータは提出済みなので、申請がないときだけ）
  for (const r of rules) if (r.kind === 'fixed_request') {
    const k = k2(r.params.group, idOf.get(r.params.item)!);
    if (!demand0.has(k)) demand0.set(k, r.params.count);
  }
  // 在庫
  const supply = new Map<string, number>();
  for (const s of input.stocks) add(supply, k2(s.roomId, s.itemId), s.count);
  // P3 keep
  const fixedByKey = new Map<string, number>();
  const rk = (r: string, g: string, i: string, j: string) => `${r}|${g}|${i}|${j}`;
  for (const f of input.fixedRows) add(fixedByKey, rk(f.sourceRoomId, f.groupId, f.requestedItemId, f.itemId), f.count);
  const keepRows: AllocationRow[] = [];
  for (const r of rules) if (r.kind === 'keep') {
    for (const it of items) {
      const n = (r.params.items as Record<string, number>)[it.code];
      if (!n) continue;
      const already = fixedByKey.get(rk(r.params.room, r.params.group, it.id, it.id)) ?? 0;
      const m = n - already;
      if (m > 0) keepRows.push({ sourceRoomId: r.params.room, groupId: r.params.group, itemId: it.id, requestedItemId: it.id, count: m, isKeep: true });
    }
  }
  // P4 差し引き
  const demand = new Map(demand0);
  for (const f of [...input.fixedRows, ...keepRows]) {
    add(demand, k2(f.groupId, f.requestedItemId), -f.count);
    add(supply, k2(f.sourceRoomId, f.itemId), -f.count);
  }
  for (const [k, v] of demand) if (v < 0) demand.set(k, 0);
  for (const [k, v] of supply) if (v < 0) throw new Error(`E001 ${k}`);
  // P5 使用不可
  for (const rm of rooms) if (!rm.usable) for (const it of items) supply.delete(k2(rm.id, it.id));

  // 変数の規則
  const subRules = rules.filter((r) => r.kind === 'substitute');
  const restrict = rules.filter((r) => r.kind === 'source_restrict');
  const consent = new Map(input.consents.map((c) => [`${c.groupId}|${c.fromItemId}|${c.toItemId}`, c.status]));
  const options = (g: Group, it: Item): Opt[] => {
    const loc = g.locationRoomId ? roomById.get(g.locationRoomId)! : null;
    const res: Opt[] = [{ j: it.id, csub: 0, p: 0, rule: null }];
    for (const s of subRules) {
      const p = s.params;
      if (p.from !== it.code || !p.categories.includes(g.category)) continue;
      if (p.indoorOnly && loc?.kind !== 'room') continue;
      const to = idOf.get(p.to)!;
      if (p.needsConsent && consent.get(`${g.id}|${it.id}|${to}`) === 'declined') continue;
      const ex = res.find((x) => x.j === to);
      const cand: Opt = { j: to, csub: p.cost, p: p.preferCategory === g.category ? 1 : 0, rule: s.code };
      if (!ex) res.push(cand);
      else if (cand.csub < ex.csub) Object.assign(ex, cand);
    }
    return res;
  };
  const allowedRooms = (g: Group, it: Item): Set<string> | null => {
    let set: Set<string> | null = null;
    for (const s of restrict) {
      if (s.params.group !== g.id || !s.params.items.includes(it.code)) continue;
      const rs = new Set<string>(s.params.rooms);
      set = set ? new Set([...set].filter((x) => rs.has(x))) : rs;
    }
    return set;
  };
  const prev = new Map<string, number>();
  if (o.mode === 'minimal_change') {
    for (const p of o.previousRows ?? []) add(prev, rk(p.sourceRoomId, p.groupId, p.requestedItemId, p.itemId), p.count);
    for (const kr of keepRows) add(prev, rk(kr.sourceRoomId, kr.groupId, kr.requestedItemId, kr.itemId), -kr.count);
  }

  type Pre = Omit<Var, 'name' | 'cost'>;
  const pre: Pre[] = [];
  const demandRows: { key: string; idx: number[] }[] = [];
  const noCandidate: string[] = [];
  let P = 0;
  for (const g of groups) {
    const loc = g.locationRoomId ? roomById.get(g.locationRoomId)! : null;
    for (const it of items) {
      const dk = k2(g.id, it.id);
      if ((demand.get(dk) ?? 0) <= 0) continue;
      const allow = allowedRooms(g, it);
      const idx: number[] = [];
      let hasP = false;
      for (const op of options(g, it)) {
        for (const rm of rooms) {
          if ((supply.get(k2(rm.id, op.j)) ?? 0) <= 0) continue;
          if (allow && !allow.has(rm.id)) continue;
          const d = distance2(rm, loc, ov);
          const e: 0 | 1 = loc && rm.id === loc.id ? 0 : 1;
          const base = { r: rm.id, g: g.id, i: it.id, j: op.j, d, e, p: op.p, csub: op.csub };
          pre.push({ ...base, hat: false, ub: null }); idx.push(pre.length - 1);
          const pv = prev.get(rk(rm.id, g.id, it.id, op.j)) ?? 0;
          if (pv > 0) { pre.push({ ...base, hat: true, ub: pv }); idx.push(pre.length - 1); }
          if (op.p) hasP = true;
        }
      }
      if (!idx.length) { noCandidate.push(dk); continue; }
      if (hasP) P++;
      demandRows.push({ key: dk, idx });
    }
  }
  const K = demandRows.length;
  const dmax = Math.max(1, ...pre.map((v) => v.d));
  const B = K + 1;
  const A = B * P + K + 1;
  const U = A * dmax + B + 1;
  const mu = o.mode === 'minimal_change' ? (o.muMode === 'unit' ? A * dmax + B + 2 : K * U + 1) : 0;
  const W = K * (U + mu) + 1;
  const vars: Var[] = pre.map((v, n) => ({
    ...v, name: `x${n + 1}`,
    cost: W * v.csub + A * v.d + v.e - B * v.p - (v.hat ? mu : 0),
  }));
  // LP
  const lines: string[] = ['Minimize'];
  lines.push(' obj: ' + vars.map((v) => `${v.cost < 0 ? '-' : '+'} ${Math.abs(v.cost)} ${v.name}`).join(' '));
  lines.push('Subject To');
  const supplyTerms = new Map<string, number[]>();
  vars.forEach((v, n) => { const k = k2(v.r, v.j); (supplyTerms.get(k) ?? supplyTerms.set(k, []).get(k)!).push(n); });
  let s = 0;
  for (const rm of rooms) for (const it of items) {
    const k = k2(rm.id, it.id);
    const t = supplyTerms.get(k);
    if (!t) continue;
    lines.push(` s${++s}: ` + t.map((n) => `+ ${vars[n]!.name}`).join(' ') + ` <= ${supply.get(k)}`);
  }
  let d = 0;
  for (const dr of demandRows) lines.push(` d${++d}: ` + dr.idx.map((n) => `+ ${vars[n]!.name}`).join(' ') + ` = ${demand.get(dr.key)}`);
  const hats = vars.filter((v) => v.ub != null);
  if (hats.length) { lines.push('Bounds'); for (const v of hats) lines.push(` ${v.name} <= ${v.ub}`); }
  lines.push('End');
  return {
    lp: lines.join('\n') + '\n', vars, K, P, dmax, A, B, U, mu, W, keepRows, demand0, demand, supply, noCandidate,
    options, allowedRooms, groups, rooms, items,
  };
}

export const HIGHS_OPTIONS = { solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false } as const;

export function solve(highs: any, m: Model) {
  const t0 = performance.now();
  const res = highs.solve(m.lp, HIGHS_OPTIONS);
  const ms = performance.now() - t0;
  if (res.Status !== 'Optimal') return { status: res.Status as string, ms, rows: [] as AllocationRow[], maxFrac: NaN, obj: NaN };
  let maxFrac = 0;
  const acc = new Map<string, AllocationRow>();
  const groupLoc = new Map(m.groups.map((g) => [g.id, g.locationRoomId]));
  const put = (r: string, g: string, i: string, j: string, n: number) => {
    const k = `${r}|${g}|${i}|${j}`;
    const cur = acc.get(k);
    if (cur) cur.count += n;
    else acc.set(k, { sourceRoomId: r, groupId: g, itemId: j, requestedItemId: i, count: n, isKeep: groupLoc.get(g) === r });
  };
  for (const v of m.vars) {
    const x = res.Columns[v.name].Primal as number;
    maxFrac = Math.max(maxFrac, Math.abs(x - Math.round(x)));
    const n = Math.round(x);
    if (n > 0) put(v.r, v.g, v.i, v.j, n);
  }
  for (const kr of m.keepRows) put(kr.sourceRoomId, kr.groupId, kr.requestedItemId, kr.itemId, kr.count);
  return { status: res.Status as string, ms, rows: [...acc.values()], maxFrac, obj: res.ObjectiveValue as number };
}

/** W107（T00 の定義）と、入れ替えがルール上できるものだけに絞った定義 */
export function w107(input: AllocateInput, m: Model, rows: AllocationRow[]) {
  const group = new Map(m.groups.map((g) => [g.id, g]));
  const item = new Map(m.items.map((x) => [x.id, x]));
  const usable = new Map(m.rooms.map((r) => [r.id, r.usable]));
  const canTake = (g: Group, i: string, j: string, r: string) => {
    if (!usable.get(r)) return false;
    const it = item.get(i)!;
    if (!m.options(g, it).some((o) => o.j === j)) return false;
    const al = m.allowedRooms(g, it);
    return !al || al.has(r);
  };
  let orig = 0, refined = 0;
  const details: string[] = [];
  for (const g of m.groups) {
    const L = g.locationRoomId;
    if (!L) continue;
    const recv = rows.filter((r) => r.groupId === g.id && r.sourceRoomId !== L);
    const outs = rows.filter((r) => r.sourceRoomId === L && group.get(r.groupId)!.locationRoomId !== L);
    const js = new Set(recv.map((r) => r.itemId));
    for (const j of js) {
      const rj = recv.filter((r) => r.itemId === j);
      const oj = outs.filter((r) => r.itemId === j);
      if (!oj.length) continue;
      orig++;
      let ok = false;
      for (const a of rj) for (const b of oj) {
        if (canTake(g, a.requestedItemId, j, L) && canTake(group.get(b.groupId)!, b.requestedItemId, j, a.sourceRoomId)) ok = true;
      }
      if (ok) { refined++; details.push(`${g.name}:${item.get(j)!.code}`); }
    }
  }
  return { orig, refined, details };
}

export function diffKeys(a: AllocationRow[], b: AllocationRow[]) {
  const key = (r: AllocationRow) => [r.sourceRoomId, r.groupId, r.requestedItemId, r.itemId].join('|');
  const ma = new Map<string, number>(), mb = new Map<string, number>();
  for (const r of a) ma.set(key(r), (ma.get(key(r)) ?? 0) + r.count);
  for (const r of b) mb.set(key(r), (mb.get(key(r)) ?? 0) + r.count);
  const changed: { k: string; before: number; after: number }[] = [];
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    const x = ma.get(k) ?? 0, y = mb.get(k) ?? 0;
    if (x !== y) changed.push({ k, before: x, after: y });
  }
  return { changed, total: new Set([...ma.keys(), ...mb.keys()]).size };
}
