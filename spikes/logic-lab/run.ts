import loadHighs from 'highs';
import { generate, shuffleInput } from './src/gen.ts';
import { buildModel, solveModel, toRows } from './src/lp.ts';
import { check, summarize, totalDistance } from './src/analyze.ts';
import { build, solve, w107, diffKeys, distance2 } from './src/model2.ts';
import type { AllocationRow, AllocateInput } from './src/types.ts';

const highs = await loadHighs();
const out: string[] = [];
const log = (...a: unknown[]) => { const s = a.map(String).join(' '); out.push(s); console.log(s); };

function dist2Total(input: AllocateInput, rows: AllocationRow[]) {
  const room = new Map(input.rooms.map((x) => [x.id, x]));
  const group = new Map(input.groups.map((g) => [g.id, g]));
  const ov = new Map(input.distanceOverrides.map((o) => [o.buildingA < o.buildingB ? `${o.buildingA}|${o.buildingB}` : `${o.buildingB}|${o.buildingA}`, o.cost]));
  return rows.reduce((a, r) => { const g = group.get(r.groupId)!; return a + r.count * distance2(room.get(r.sourceRoomId)!, g.locationRoomId ? room.get(g.locationRoomId)! : null, ov); }, 0);
}

// ---- 1. 基本（seed 20261029）----
const d = generate();
const m = build(d.input, { mode: 'full' });
const s = solve(highs, m);
log('== 1 base full');
log('status', s.status, 'ms', s.ms.toFixed(1), 'vars', m.vars.length, 'K', m.K, 'P', m.P, 'dmax', m.dmax, 'A', m.A, 'B', m.B, 'W', m.W, 'maxCoef', Math.max(...m.vars.map((v) => Math.abs(v.cost))), 'obj', s.obj, 'maxFrac', s.maxFrac);
const mOld = buildModel(d.input, { costMode: 'integer' });
const sOld = solveModel(highs, mOld);
const rowsOld = [...toRows(mOld, sOld.values), ...mOld.keepRows];
log('summary new', JSON.stringify(summarize(d.input, mOld, s.rows.filter(() => true)).subs), 'old', JSON.stringify(summarize(d.input, mOld, toRows(mOld, sOld.values)).subs));
log('distance new', dist2Total(d.input, s.rows), 'old(T00 int)', totalDistance(d.input, rowsOld));
log('check issues new', check(d.input, mOld, s.rows.filter((r) => !m.keepRows.includes(r))).length);
log('w107 new', JSON.stringify(w107(d.input, m, s.rows)));
// 5回同じか
const h0 = JSON.stringify(s.rows);
let same = 0; for (let k = 0; k < 5; k++) if (JSON.stringify(solve(highs, build(d.input, { mode: 'full' })).rows) === h0) same++;
log('repeat same', same, '/5');
// 並べ替え
let lpSame = 0; for (let k = 1; k <= 5; k++) if (build(shuffleInput(d.input, k), { mode: 'full' }).lp === m.lp) lpSame++;
log('shuffled LP identical', lpSame, '/5');

// ---- 2. 30 通り ----
log('== 2 seeds 100..129');
let agg = { subsEq: 0, distEq: 0, w107o: 0, w107r: 0, nonOpt: 0, frac: 0, issues: 0, msNew: [] as number[], maxCoef: 0 };
const refinedDetails: string[] = [];
for (let seed = 100; seed < 130; seed++) {
  const dd = generate(seed);
  const mm = build(dd.input, { mode: 'full' });
  const ss = solve(highs, mm);
  if (ss.status !== 'Optimal') { agg.nonOpt++; continue; }
  agg.msNew.push(ss.ms);
  agg.maxCoef = Math.max(agg.maxCoef, ...mm.vars.map((v) => Math.abs(v.cost)));
  if (ss.maxFrac > 1e-9) agg.frac++;
  const mo = buildModel(dd.input, { costMode: 'integer' });
  const so = solveModel(highs, mo);
  const ro = [...toRows(mo, so.values), ...mo.keepRows];
  const sn = JSON.stringify(summarize(dd.input, mo, ss.rows).subs);
  const sO = JSON.stringify(summarize(dd.input, mo, ro).subs);
  if (sn === sO) agg.subsEq++;
  if (dist2Total(dd.input, ss.rows) === totalDistance(dd.input, ro)) agg.distEq++;
  const w = w107(dd.input, mm, ss.rows);
  agg.w107o += w.orig; agg.w107r += w.refined;
  if (w.refined) refinedDetails.push(`${seed}:${w.details.join(',')}`);
  agg.issues += check(dd.input, mo, ss.rows.filter((r) => !mm.keepRows.some((k) => k.groupId === r.groupId && k.sourceRoomId === r.sourceRoomId && k.itemId === r.itemId))).filter((x) => !x.startsWith('E003') && !x.startsWith('W101')).length;
}
agg.msNew.sort((a, b) => a - b);
log(JSON.stringify({ ...agg, msNew: undefined, msMedian: agg.msNew[15]?.toFixed(1), msMax: agg.msNew.at(-1)?.toFixed(1) }));
log('refined W107 details', refinedDetails.join(' | '));

// ---- 3. 最小変更（MER を使用不可）----
log('== 3 minimal change: MER unusable');
for (const seed of [20261029, 100, 101, 102, 103]) {
  const dd = generate(seed);
  const m1 = build(dd.input, { mode: 'full' });
  const s1 = solve(highs, m1);
  const mer = dd.roomByName.get('MER')!.id;
  const prevRows = s1.rows; // keep 行を含む（D-06 で auto として保存される）
  const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === mer ? { ...r, usable: false } : r)) };
  const lost = new Set(prevRows.filter((r) => r.sourceRoomId === mer).map((r) => `${r.groupId}|${r.requestedItemId}`));
  const lostItems = new Set(prevRows.filter((r) => r.sourceRoomId === mer).map((r) => r.itemId));
  // 品目ごとの余り（MER 以外、前回の使用後）
  const used = new Map<string, number>();
  for (const r of prevRows) used.set(r.itemId, (used.get(r.itemId) ?? 0) + (r.sourceRoomId === mer ? 0 : r.count));
  const stockOther = new Map<string, number>();
  for (const st of dd.input.stocks) { const rm = dd.input.rooms.find((x) => x.id === st.roomId)!; if (rm.usable && st.roomId !== mer) stockOther.set(st.itemId, (stockOther.get(st.itemId) ?? 0) + st.count); }
  const lostBy = new Map<string, number>();
  for (const r of prevRows) if (r.sourceRoomId === mer) lostBy.set(r.itemId, (lostBy.get(r.itemId) ?? 0) + r.count);
  const slackOk = new Set([...lostItems].filter((j) => (stockOther.get(j) ?? 0) - (used.get(j) ?? 0) >= (lostBy.get(j) ?? 0)));
  const codeOf = new Map(dd.input.items.map((i) => [i.id, i.code]));
  const res: string[] = [];
  for (const mu of ['unit', 'lex'] as const) {
    const m2 = build(input2, { mode: 'minimal_change', previousRows: prevRows, muMode: mu });
    const s2 = solve(highs, m2);
    if (s2.status !== 'Optimal') { res.push(`${mu}:${s2.status}`); continue; }
    const df = diffKeys(prevRows, s2.rows);
    const unrelated = df.changed.filter((c) => { const [r, g, i] = c.k.split('|'); return r !== mer && !lost.has(`${g}|${i}`); });
    const unrelatedSlack = unrelated.filter((c) => slackOk.has(c.k.split('|')[3]!));
    const subs = JSON.stringify(summarize(dd.input, buildModel(dd.input, { costMode: 'integer' }), s2.rows).subs);
    res.push(`${mu}: changed=${df.changed.length}/${df.total} unrelated=${unrelated.length} unrelatedSlackItems=${unrelatedSlack.length} maxCoef=${Math.max(...m2.vars.map((v) => Math.abs(v.cost)))} ms=${s2.ms.toFixed(1)} frac=${s2.maxFrac} dist=${dist2Total(input2, s2.rows)} subs=${subs}`);
  }
  const m3 = build(input2, { mode: 'full' });
  const s3 = solve(highs, m3);
  res.push(`full-resolve: changed=${diffKeys(prevRows, s3.rows).changed.length} dist=${dist2Total(input2, s3.rows)}`);
  log(`seed ${seed} lostItems=${[...lostItems].map((j) => codeOf.get(j) + (slackOk.has(j) ? '(slack)' : '(tight)')).join(',')}`);
  for (const r of res) log('   ' + r);
}

import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./results-run.txt', import.meta.url), out.join('\n') + '\n');
