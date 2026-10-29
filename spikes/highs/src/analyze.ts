import type { AllocateInput, AllocationRow, ItemCode } from './types.ts';
import type { Model } from './lp.ts';

/** W107：団体の使用場所から同じ品目が（他の団体へ）外へ出ているのに、その団体が他の場所から受け取っている (団体, 品目) の組。 */
export function w107(input: AllocateInput, rows: AllocationRow[]) {
  const group = new Map(input.groups.map((g) => [g.id, g]));
  const res: { group: string; item: string; out: number; recv: number; groupRestricted: boolean }[] = [];
  const itemCode = new Map(input.items.map((i) => [i.id, i.code]));
  const restrictedGroups = new Set(input.rules.filter((r) => r.kind === 'source_restrict').map((r) => r.params.group as string));
  for (const g of input.groups) {
    if (!g.locationRoomId) continue;
    const L = g.locationRoomId;
    const recvBy = new Map<string, number>();
    for (const r of rows) if (r.groupId === g.id && r.sourceRoomId !== L) recvBy.set(r.itemId, (recvBy.get(r.itemId) ?? 0) + r.count);
    for (const [item, recv] of recvBy) {
      // 「外へ出る」：同じ部屋を使う別の団体へ渡すのは、部屋の外へ出ていないので数えない
      const outRows = rows.filter((r) => r.sourceRoomId === L && r.groupId !== g.id && r.itemId === item && group.get(r.groupId)!.locationRoomId !== L);
      const out = outRows.reduce((a, r) => a + r.count, 0);
      if (out > 0) res.push({
        group: group.get(g.id)!.name, item: itemCode.get(item)!, out, recv,
        groupRestricted: restrictedGroups.has(g.id),
      });
    }
  }
  return res;
}

/** LP とは独立に、結果が仕様どおりかを確かめる（E001・E003・E004 相当）。問題の一覧を返す（空なら OK）。 */
export function check(input: AllocateInput, m: Model, rows: AllocationRow[]): string[] {
  const issues: string[] = [];
  const all = [...rows, ...m.keepRows];
  const code = new Map(input.items.map((i) => [i.id, i.code as ItemCode]));
  const group = new Map(input.groups.map((g) => [g.id, g]));
  const room = new Map(input.rooms.map((x) => [x.id, x]));
  const used = new Map<string, number>();
  const got = new Map<string, number>();
  for (const r of all) {
    used.set(`${r.sourceRoomId}|${r.itemId}`, (used.get(`${r.sourceRoomId}|${r.itemId}`) ?? 0) + r.count);
    got.set(`${r.groupId}|${r.requestedItemId}`, (got.get(`${r.groupId}|${r.requestedItemId}`) ?? 0) + r.count);
    if (!room.get(r.sourceRoomId)!.usable) issues.push(`E002 ${room.get(r.sourceRoomId)!.name}`);
    const g = group.get(r.groupId)!;
    const i = code.get(r.requestedItemId)!, j = code.get(r.itemId)!;
    if (j === 'desk_ng' && g.category !== 'stall') issues.push(`E004 S01 ${g.name}`);
    if (j === 'chair_ng' && g.category !== 'stall' && g.category !== 'rest_area') issues.push(`E004 S02 ${g.name}`);
    if (j === 'long_desk_3' && g.category !== 'company') issues.push(`E004 S03 ${g.name}`);
    if (j === 'caster_desk' && i === 'desk') {
      const loc = g.locationRoomId ? room.get(g.locationRoomId) : null;
      if (g.category !== 'stall' || loc?.kind !== 'room') issues.push(`E004 S07 ${g.name}`);
      const c = input.consents.find((x) => x.groupId === g.id && x.fromItemId === r.requestedItemId && x.toItemId === r.itemId);
      if (c?.status === 'declined') issues.push(`E004 S07 declined ${g.name}`);
    }
    if (j !== i && !(j === 'desk_ng' || j === 'chair_ng' || j === 'caster_desk' || (i === 'long_desk_3' && j === 'long_desk_2'))) issues.push(`E004 sub ${i}->${j}`);
    for (const rule of input.rules) if (rule.kind === 'source_restrict' && rule.params.group === g.id && rule.params.items.includes(i) && !rule.params.rooms.includes(r.sourceRoomId)) issues.push(`E004 S05 ${room.get(r.sourceRoomId)!.name}`);
    if (r.isKeep && g.locationRoomId !== r.sourceRoomId) issues.push('E005');
  }
  const stock = new Map<string, number>();
  for (const s of input.stocks) stock.set(`${s.roomId}|${s.itemId}`, (stock.get(`${s.roomId}|${s.itemId}`) ?? 0) + s.count);
  for (const [k, n] of used) if (n > (stock.get(k) ?? 0)) issues.push(`E001 ${k}`);
  // E003：正規化した申請（S03 後、S06 込み）と等しいか
  const need = new Map<string, number>();
  for (const [k, v] of m.demand) need.set(k, v);
  for (const f of [...input.fixedRows, ...m.keepRows]) need.set(`${f.groupId}|${f.requestedItemId}`, (need.get(`${f.groupId}|${f.requestedItemId}`) ?? 0) + f.count);
  for (const [k, n] of need) if ((got.get(k) ?? 0) !== n) issues.push(`E003 ${k} need ${n} got ${got.get(k) ?? 0}`);
  for (const [k, n] of got) if (!need.has(k)) issues.push(`W101 ${k} got ${n}`);
  return issues;
}

/** 品目ごとの使用数と代替の数 */
export function summarize(input: AllocateInput, m: Model, rows: AllocationRow[]) {
  const code = new Map(input.items.map((i) => [i.id, i.code]));
  const byItem: Record<string, number> = {};
  const subs: Record<string, number> = {};
  for (const r of [...rows, ...m.keepRows]) {
    const j = code.get(r.itemId)!, i = code.get(r.requestedItemId)!;
    byItem[j] = (byItem[j] ?? 0) + r.count;
    if (i !== j) subs[`${i}->${j}`] = (subs[`${i}->${j}`] ?? 0) + r.count;
  }
  return { byItem, subs };
}

/** 変わった件数：（運び元・団体・申請品目・品目）ごとの数が違うもの */
export function diffRows(a: AllocationRow[], b: AllocationRow[]) {
  const key = (r: AllocationRow) => [r.sourceRoomId, r.groupId, r.requestedItemId, r.itemId].join('|');
  const ma = new Map<string, number>(), mb = new Map<string, number>();
  for (const r of a) ma.set(key(r), (ma.get(key(r)) ?? 0) + r.count);
  for (const r of b) mb.set(key(r), (mb.get(key(r)) ?? 0) + r.count);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  let changed = 0, units = 0;
  const changedKeys: string[] = [];
  for (const k of keys) {
    const x = ma.get(k) ?? 0, y = mb.get(k) ?? 0;
    if (x !== y) { changed++; units += Math.abs(x - y); changedKeys.push(k); }
  }
  return { changed, units, total: keys.size, changedKeys };
}

import { distance } from './lp.ts';
/** 実際の距離コストの合計 Σ d(r,g)·count（extra_cost 込み。代替の重み・δ は含まない） */
export function totalDistance(input: AllocateInput, rows: AllocationRow[]): number {
  const room = new Map(input.rooms.map((x) => [x.id, x]));
  const group = new Map(input.groups.map((g) => [g.id, g]));
  const ov = new Map(input.distanceOverrides.map((o) => [`${o.buildingA}|${o.buildingB}`, o.cost]));
  return rows.reduce((a, r) => {
    const g = group.get(r.groupId)!;
    return a + r.count * distance(room.get(r.sourceRoomId)!, g.locationRoomId ? room.get(g.locationRoomId)! : null, ov);
  }, 0);
}

/** W107 の各パターンについて、1台入れ替える（g が自室 L から取り、h が r から取る）と距離が何増減するかの最小値で分類する。
 *  strict：入れ替えると必ず悪くなる（距離だけで見て最適な形）／tie：同点の入れ替えがある／blocked：入れ替えると良くなるのに起きている（ルールで禁止されている等） */
export function classifyW107(input: AllocateInput, rows: AllocationRow[]) {
  const room = new Map(input.rooms.map((x) => [x.id, x]));
  const group = new Map(input.groups.map((g) => [g.id, g]));
  const ov = new Map(input.distanceOverrides.map((o) => [`${o.buildingA}|${o.buildingB}`, o.cost]));
  const d = (rId: string, gId: string) => {
    const g = group.get(gId)!;
    return distance(room.get(rId)!, g.locationRoomId ? room.get(g.locationRoomId)! : null, ov);
  };
  const out = { restricted: 0, strict: 0, tie: 0, blocked: 0 };
  const restrictedGroups = new Set(input.rules.filter((r) => r.kind === 'source_restrict').map((r) => r.params.group as string));
  for (const g of input.groups) {
    if (!g.locationRoomId) continue;
    const L = g.locationRoomId;
    for (const item of new Set(rows.filter((r) => r.groupId === g.id && r.sourceRoomId !== L).map((r) => r.itemId))) {
      const recvs = rows.filter((r) => r.groupId === g.id && r.sourceRoomId !== L && r.itemId === item);
      const outs = rows.filter((r) => r.sourceRoomId === L && r.groupId !== g.id && r.itemId === item && group.get(r.groupId)!.locationRoomId !== L);
      if (!outs.length) continue;
      if (restrictedGroups.has(g.id)) { out.restricted++; continue; }
      let min = Infinity;
      for (const recv of recvs) for (const o of outs) min = Math.min(min, d(recv.sourceRoomId, o.groupId) - d(L, o.groupId) - d(recv.sourceRoomId, g.id));
      if (min > 0) out.strict++; else if (min === 0) out.tie++; else out.blocked++;
    }
  }
  return out;
}
