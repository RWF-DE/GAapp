// R8 規模で、重みつき LP の解が辞書式の最小（逐次 LP）と一致するかを確かめる
import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, type Model } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
const OPT = { solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false };
const tiers = (m: Model) => [
  (v: any) => v.csub, (v: any) => (v.hat ? -1 : 0), (v: any) => v.d, (v: any) => -v.p, (v: any) => v.e,
];
function lexSeq(m: Model) {
  const [head, rest] = m.lp.split('Subject To\n');
  const extra: string[] = [];
  const vals: number[] = [];
  for (const [k, f] of tiers(m).entries()) {
    const terms = m.vars.map((v) => [f(v), v.name] as const).filter(([c]) => c !== 0);
    const expr = terms.length ? terms.map(([c, n]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${n}`).join(' ') : '0 x1';
    const lp = `Minimize\n obj: ${expr}\nSubject To\n${extra.join('')}${rest}`;
    const r = highs.solve(lp, OPT);
    if (r.Status !== 'Optimal') return { status: r.Status };
    const val = Math.round(r.ObjectiveValue);
    vals.push(val);
    if (terms.length) extra.push(` t${k}: ${expr} <= ${val}\n`);
  }
  return { status: 'Optimal', vals };
}
function lexOf(m: Model, res: any) {
  return tiers(m).map((f) => m.vars.reduce((a, v) => a + f(v) * Math.round(res.Columns[v.name].Primal), 0));
}
let n = 0, bad = 0;
for (const seed of [20261029, ...Array.from({ length: 30 }, (_, k) => 100 + k)]) {
  const dd = generate(seed);
  const m1 = build(dd.input, { mode: 'full' });
  const s1 = solve(highs, m1);
  const cases: [string, Model][] = [['full', m1]];
  for (const name of ['MER', 'HI1', 'CI2', '1-1', '体育館']) {
    const M = dd.roomByName.get(name)!.id;
    const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)) };
    cases.push([`mc-${name}`, build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' })]);
  }
  for (const [label, m] of cases) {
    const r = highs.solve(m.lp, OPT);
    if (r.Status !== 'Optimal') continue;
    const a = lexOf(m, r);
    const b = lexSeq(m);
    n++;
    if (b.status !== 'Optimal' || a.join() !== b.vals!.join()) { bad++; console.log('MISMATCH', seed, label, a, b); }
  }
}
console.log({ n, bad });
