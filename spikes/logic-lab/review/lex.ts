import loadHighs from 'highs';
import { generate, makeInfeasibleS05 } from '../src/gen.ts';
import { build, solve, type Model } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
const OPT = { solver: 'simplex', random_seed: 0, time_limit: 60, output_flag: false };
// lex vector of a solution (values per var)
function lexOf(m: Model, val: number[]) {
  let c = 0, h = 0, d = 0, p = 0, e = 0;
  m.vars.forEach((v, k) => { const x = val[k]!; c += v.csub * x; if (v.hat) h += x; d += v.d * x; p += v.p * x; e += v.e * x; });
  return [c, -h, d, -p, e];
}
function staged(m: Model) {
  const lines = m.lp.split('\n');
  const st = lines.indexOf('Subject To'); const bi = lines.findIndex((l) => l === 'Bounds' || l === 'End');
  const cons = lines.slice(st + 1, bi); const tail = lines.slice(bi);
  const coefs: ((v: any) => number)[] = [(v) => v.csub, (v) => (v.hat ? -1 : 0), (v) => v.d, (v) => -v.p, (v) => v.e];
  const fixed: string[] = []; const res: number[] = [];
  for (let L = 0; L < 5; L++) {
    const f = coefs[L]!;
    const terms = m.vars.map((v) => [f(v), v.name] as const).filter(([a]) => a !== 0);
    const obj = terms.length ? terms.map(([a, n]) => `${a < 0 ? '-' : '+'} ${Math.abs(a)} ${n}`).join(' ') : `0 ${m.vars[0]!.name}`;
    const lp = ['Minimize', ' obj: ' + obj, 'Subject To', ...cons, ...fixed, ...tail].join('\n') + '\n';
    const r = highs.solve(lp, OPT);
    if (r.Status !== 'Optimal') throw new Error('stage ' + L + ' ' + r.Status);
    const val = Math.round(r.ObjectiveValue);
    res.push(val);
    if (terms.length) fixed.push(` f${L}: ` + terms.map(([a, n]) => `${a < 0 ? '-' : '+'} ${Math.abs(a)} ${n}`).join(' ') + ` <= ${val}`);
  }
  return res;
}
let bad = 0, n = 0;
for (const seed of [20261029, 100, 101, 102, 103, 104, 105, 106, 107, 108]) {
  const dd = generate(seed);
  const m1 = build(dd.input, { mode: 'full' }); const s1 = solve(highs, m1);
  const r1 = highs.solve(m1.lp, OPT); const v1 = m1.vars.map((v) => r1.Columns[v.name].Primal);
  const a = lexOf(m1, v1), b = staged(m1); n++;
  if (a.join() !== b.join()) { bad++; console.log('full', seed, a, b); }
  for (const roomName of ['MER', 'HI1', 'CI2']) {
    const M = dd.roomByName.get(roomName)!.id;
    const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)) };
    const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows });
    const r2 = highs.solve(m2.lp, OPT); if (r2.Status !== 'Optimal') continue;
    const v2 = m2.vars.map((v) => r2.Columns[v.name].Primal);
    const a2 = lexOf(m2, v2); let b2; try { b2 = staged(m2); } catch (e) { console.log('staged err', e); continue; }
    n++;
    if (a2.join() !== b2.join()) { bad++; console.log('min', seed, roomName, a2, b2); }
  }
}
console.log('checked', n, 'mismatch', bad);
// S05 infeasible: P7 check
const dd = generate(20261029); const inp = makeInfeasibleS05(dd);
const m = build(inp, { mode: 'full' });
const setup = dd.groupByName.get('設営')!.id; const desk = dd.itemByCode.get('desk')!.id;
const sv = m.vars.filter((v) => v.g === setup && v.i === desk);
const sup = new Set(sv.map((v) => `${v.r}|${v.j}`)); let tot = 0; for (const k of sup) tot += m.supply.get(k) ?? 0;
console.log('S05 infeasible: D′', m.demand.get(`${setup}|${desk}`), 'candidate S′ sum', tot, '=> P7 shortage', tot < (m.demand.get(`${setup}|${desk}`) ?? 0));
