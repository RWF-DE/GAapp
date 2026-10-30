import type { AllocateInput, AllocationRow, Group, Item, ItemCode, Room } from './types.ts';

export type CostMode = 'original' | 'integer';
export type BuildOptions = {
  costMode: CostMode;
  /** 最小変更モード：前回の自動行（x̂ を作る） */
  previousRows?: AllocationRow[];
  /** 1行の最大文字数。null なら折り返さない */
  wrap?: number | null;
  /** 解けない入力の診断用：外すルールのコード */
  disabledRules?: string[];
};
export type Var = {
  name: string; roomId: string; groupId: string; itemId: string; requestedItemId: string;
  hat: boolean; cost: number; ub: number | null;
};
export type Model = {
  lp: string; vars: Var[]; supplyRows: number; demandRows: number;
  N: number; dmax: number; W: number; mu: number; unit: number;
  keepRows: AllocationRow[];
  /** 前処理後の需要 D'・在庫 S' */
  demand: Map<string, number>; supply: Map<string, number>;
  stats: { chars: number; maxLine: number; lines: number; vars: number; hatVars: number; rows: number; nonzeros: number };
};

const byOrder = <T extends { sortOrder: number; id: string }>(name: (x: T) => string) => (a: T, b: T) =>
  a.sortOrder - b.sortOrder || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 距離コスト d(r,g)。表は 03「距離コスト」。屋外・その他の運び元などは 03 に書かれていないので、ここで仮に決めた（notes/T00.md 参照）。 */
export function distance(room: Room, loc: Room | null, overrides: Map<string, number>): number {
  if (!loc) return 4 + room.extraCost; // 使用場所がない団体
  if (room.id === loc.id) return 0; // 残す（extra_cost は足さない）
  let d: number;
  if (loc.kind === 'outdoor') d = room.floor == null || room.floor <= 1 ? 3 : 5;
  else {
    const ov = room.building && loc.building ? overrides.get(`${room.building}|${loc.building}`) ?? overrides.get(`${loc.building}|${room.building}`) : undefined;
    if (ov != null) d = ov;
    else if (room.building && room.building === loc.building) d = room.floor === loc.floor ? 1 : 2;
    else d = 4;
  }
  return d + room.extraCost;
}

export function buildModel(inputRaw: AllocateInput, opt: BuildOptions): Model {
  // ---- 並べ直し：sort_order → 名前 → id ----
  const items: Item[] = inputRaw.items.slice().sort(byOrder<Item>((x) => x.code));
  const rooms: Room[] = inputRaw.rooms.slice().sort(byOrder<Room>((x) => x.name));
  const groups: Group[] = inputRaw.groups.slice().sort(byOrder<Group>((x) => x.name));
  const rules = inputRaw.rules.filter((r) => !opt.disabledRules?.includes(r.code)).slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  const itemById = new Map(items.map((x) => [x.id, x]));
  const roomById = new Map(rooms.map((x) => [x.id, x]));
  const code = (id: string) => itemById.get(id)!.code;
  const idOf = new Map<ItemCode, string>(items.map((x) => [x.code, x.id]));
  const overrides = new Map<string, number>();
  for (const o of inputRaw.distanceOverrides) overrides.set(`${o.buildingA}|${o.buildingB}`, o.cost);

  // ---- 前処理 ----
  // 需要 D(g,i)
  const demand = new Map<string, number>();
  const key2 = (a: string, b: string) => `${a}|${b}`;
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  for (const rq of inputRaw.requests) {
    let itemId = rq.itemId;
    // 1. S03：企業以外の長机(3人掛) → 長机(2人掛)
    if (code(itemId) === 'long_desk_3' && groupById.get(rq.groupId)!.category !== 'company') itemId = idOf.get('long_desk_2')!;
    add(demand, key2(rq.groupId, itemId), rq.count);
  }
  // 2. S06 fixed_request（申請がなければ。スパイクでは申請があるので使わない）
  for (const r of rules) if (r.kind === 'fixed_request') {
    const k = key2(r.params.group, idOf.get(r.params.item)!);
    if (!demand.has(k)) demand.set(k, r.params.count);
  }
  const N = [...demand.values()].reduce((a, b) => a + b, 0);
  // 在庫 S(r,j)
  const supply = new Map<string, number>();
  for (const s of inputRaw.stocks) add(supply, key2(s.roomId, s.itemId), s.count);
  // 3. keep → 固定行
  const keepRows: AllocationRow[] = [];
  for (const r of rules) if (r.kind === 'keep') {
    for (const [c, n] of Object.entries(r.params.items as Record<string, number>)) {
      const itemId = idOf.get(c as ItemCode)!;
      keepRows.push({ sourceRoomId: r.params.room, groupId: r.params.group, itemId, requestedItemId: itemId, count: n, isKeep: true });
    }
  }
  // 4. 固定行を差し引く
  for (const f of [...inputRaw.fixedRows, ...keepRows]) {
    add(demand, key2(f.groupId, f.requestedItemId), -f.count);
    add(supply, key2(f.sourceRoomId, f.itemId), -f.count);
  }
  for (const [k, v] of demand) if (v < 0) demand.set(k, 0); // W101 相当
  for (const [k, v] of supply) if (v < 0) throw new Error(`E001 ${k}`);
  // 5. 使用不可の部屋は S' = 0
  for (const rm of rooms) if (!rm.usable) for (const it of items) supply.delete(key2(rm.id, it.id));

  // ---- コスト ----
  let dmaxTable = 5;
  for (const o of inputRaw.distanceOverrides) dmaxTable = Math.max(dmaxTable, o.cost);
  const dmax = dmaxTable + Math.max(0, ...rooms.map((r) => r.extraCost));
  const integer = opt.costMode === 'integer';
  // 単位：original は 0.1 刻み（δ = -0.1）を整数で持つため unit = 10。integer は 1。
  const unit = integer ? 1 : 10;
  const dUnit = (d: number, r: Room, loc: Room | null) => (integer ? 100 * d + (loc && r.id === loc.id ? 0 : 1) : unit * d);
  const dmaxU = integer ? 100 * dmax + 1 : dmax;
  const W = 10 * dmaxU * N; // 単位前（original は 10×d_max×N、integer は 10×d'_max×N）
  const mu = dmaxU + 1;
  const delta = integer ? -10 : -1; // 単位つき（original: -0.1 × 10 = -1）
  const Wu = W * unit;
  const muU = mu * unit;

  // ---- 変数 ----
  const subRules = rules.filter((r) => r.kind === 'substitute').map((r) => r.params);
  const restrict = rules.filter((r) => r.kind === 'source_restrict').map((r) => r.params);
  const consentStatus = new Map(inputRaw.consents.map((c) => [`${c.groupId}|${c.fromItemId}|${c.toItemId}`, c.status]));
  const prev = new Map<string, number>();
  for (const p of opt.previousRows ?? []) add(prev, [p.sourceRoomId, p.groupId, p.requestedItemId, p.itemId].join('|'), p.count);

  const vars: Var[] = [];
  const supplyTerms = new Map<string, number[]>(); // (r,j) → 変数番号
  const demandTerms = new Map<string, number[]>(); // (g,i) → 変数番号
  const demandOrder: string[] = [];
  for (const g of groups) {
    const loc = g.locationRoomId ? roomById.get(g.locationRoomId)! : null;
    for (const it of items) {
      const dk = key2(g.id, it.id);
      if ((demand.get(dk) ?? 0) <= 0) continue;
      demandOrder.push(dk);
      // j の候補：自分自身 + 代替
      const options: { j: ItemCode; csub: number; prefer: boolean }[] = [{ j: it.code, csub: 0, prefer: false }];
      for (const p of subRules) {
        if (p.from !== it.code || !p.categories.includes(g.category)) continue;
        if (p.indoorOnly && loc?.kind !== 'room') continue;
        const st = consentStatus.get(`${g.id}|${it.id}|${idOf.get(p.to)}`);
        if (p.needsConsent && st === 'declined') continue;
        options.push({ j: p.to, csub: p.cost, prefer: p.preferCategory === g.category });
      }
      const limit = restrict.find((p) => p.group === g.id && p.items.includes(it.code));
      for (const o of options) {
        const jId = idOf.get(o.j)!;
        for (const rm of rooms) {
          const s = supply.get(key2(rm.id, jId)) ?? 0;
          if (s <= 0) continue;
          if (limit && !limit.rooms.includes(rm.id)) continue;
          const cost = Wu * o.csub + dUnit(distance(rm, loc, overrides), rm, loc) + (o.prefer ? delta : 0);
          const mk = (hat: boolean, ub: number | null, c: number) => {
            const v: Var = { name: `x${vars.length + 1}`, roomId: rm.id, groupId: g.id, itemId: jId, requestedItemId: it.id, hat, cost: c, ub };
            vars.push(v);
            const idx = vars.length - 1;
            (supplyTerms.get(key2(rm.id, jId)) ?? supplyTerms.set(key2(rm.id, jId), []).get(key2(rm.id, jId))!).push(idx);
            (demandTerms.get(dk) ?? demandTerms.set(dk, []).get(dk)!).push(idx);
          };
          mk(false, null, cost);
          const pv = prev.get([rm.id, g.id, it.id, jId].join('|'));
          if (pv && pv > 0) mk(true, pv, cost - muU);
        }
      }
    }
  }

  // ---- LP 文字列 ----
  const fmt = (c: number) => (unit === 10 ? (Number.isInteger(c / 10) ? String(c / 10) : (c / 10).toFixed(1)) : String(c));
  const lines: string[] = [];
  const wrapLine = (head: string, terms: string[], tail: string) => {
    if (!opt.wrap) { lines.push(`${head}${terms.join(' ')}${tail}`); return; }
    let cur = head;
    for (const t of terms) {
      if (cur.length + t.length + 1 > opt.wrap && cur.trim() !== head.trim()) { lines.push(cur); cur = '   '; }
      cur += (cur.endsWith(' ') ? '' : ' ') + t;
    }
    lines.push(cur + tail);
  };
  lines.push('Minimize');
  wrapLine(' obj:', vars.map((v) => `${v.cost < 0 ? '-' : '+'} ${fmt(Math.abs(v.cost))} ${v.name}`), '');
  lines.push('Subject To');
  let nz = 0;
  let sRows = 0, dRows = 0;
  for (const [k, idxs] of supplyTerms) {
    sRows++; nz += idxs.length;
    wrapLine(` s${sRows}:`, idxs.map((i) => `+ ${vars[i]!.name}`), ` <= ${supply.get(k)}`);
  }
  for (const dk of demandOrder) {
    const idxs = demandTerms.get(dk);
    if (!idxs) continue; // 候補がない（= 確実に解けない）。診断側で扱う
    dRows++; nz += idxs.length;
    wrapLine(` d${dRows}:`, idxs.map((i) => `+ ${vars[i]!.name}`), ` = ${demand.get(dk)}`);
  }
  const hats = vars.filter((v) => v.ub != null);
  if (hats.length) { lines.push('Bounds'); for (const v of hats) lines.push(` ${v.name} <= ${v.ub}`); }
  lines.push('End');
  const lp = lines.join('\n') + '\n';
  const maxLine = lines.reduce((a, l) => Math.max(a, l.length), 0);
  return {
    lp, vars, supplyRows: sRows, demandRows: dRows, N, dmax: dmaxU, W, mu, unit, keepRows, demand, supply,
    stats: { chars: lp.length, maxLine, lines: lines.length, vars: vars.length, hatVars: hats.length, rows: sRows + dRows, nonzeros: nz },
  };
}

// ---- 解くとき ----
export const HIGHS_OPTIONS = { solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false } as const;

export type SolveOut = { status: string; ms: number; values: number[]; objective: number; maxFrac: number };

export function solveModel(highs: { solve(p: string, o?: any): any }, m: Model): SolveOut {
  const t0 = performance.now();
  const res = highs.solve(m.lp, HIGHS_OPTIONS);
  const ms = performance.now() - t0;
  if (res.Status !== 'Optimal') return { status: res.Status, ms, values: [], objective: NaN, maxFrac: NaN };
  const values = m.vars.map((v) => res.Columns[v.name].Primal as number);
  const maxFrac = values.reduce((a, x) => Math.max(a, Math.abs(x - Math.round(x))), 0);
  return { status: res.Status, ms, values, objective: res.ObjectiveValue, maxFrac };
}

/** 03 の「四捨五入して差が 1e-6 を超えたらエラー」 */
export function toRows(m: Model, values: number[]): AllocationRow[] {
  const acc = new Map<string, AllocationRow>();
  m.vars.forEach((v, i) => {
    const x = values[i]!;
    if (Math.abs(x - Math.round(x)) > 1e-6) throw new Error(`non-integer ${v.name}=${x}`);
    const n = Math.round(x);
    if (n <= 0) return;
    const k = [v.roomId, v.groupId, v.requestedItemId, v.itemId].join('|');
    const cur = acc.get(k);
    if (cur) cur.count += n;
    else acc.set(k, { sourceRoomId: v.roomId, groupId: v.groupId, itemId: v.itemId, requestedItemId: v.requestedItemId, count: n, isKeep: false });
  });
  return [...acc.values()];
}

/** 単純なハッシュ（Node とブラウザで同じ関数を使う）。cyrb53 */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
export const hashValues = (values: number[]) => hash53(values.join(','));
