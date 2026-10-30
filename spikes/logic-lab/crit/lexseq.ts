import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, HIGHS_OPTIONS } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
const levels = (v: any) => [v.csub, v.hat ? -1 : 0, v.d, -v.p, v.e];
let ok = 0, bad = 0;
for (const seed of [20261029, 100, 101, 103, 104]) {
  const d = generate(seed);
  const s1 = solve(highs, build(d.input, { mode: 'full' }));
  for (const [mode, inp] of [['full', d.input], ['mc', { ...d.input, rooms: d.input.rooms.map(r => r.name === 'MER' ? { ...r, usable: false } : r) }]] as const) {
    const m = build(inp as AllocateInput, mode === 'full' ? { mode: 'full' } : { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
    const s = solve(highs, m); if (s.status !== 'Optimal') { console.log(seed, mode, s.status); continue; }
    const res = highs.solve(m.lp, HIGHS_OPTIONS);
    const xv = m.vars.map(v => Math.round(res.Columns[v.name].Primal));
    const lpKey = [0,1,2,3,4].map(k => m.vars.reduce((a, v, n) => a + levels(v)[k] * xv[n], 0));
    // sequential
    const body = m.lp.split('\n'); const st = body.indexOf('Subject To'); const bd = body.indexOf('Bounds') >= 0 ? body.indexOf('Bounds') : body.indexOf('End');
    const cons = body.slice(st + 1, bd); const tail = body.slice(bd);
    const extra: string[] = []; const best: number[] = [];
    for (let k = 0; k < 5; k++) {
      const terms = m.vars.map(v => [levels(v)[k], v.name] as const).filter(([c]) => c !== 0);
      if (!terms.length) { best.push(0); continue; }
      const obj = terms.map(([c, n]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${n}`).join(' ');
      const lp = ['Minimize', ' obj: ' + obj, 'Subject To', ...cons, ...extra, ...tail].join('\n') + '\n';
      const r = highs.solve(lp, HIGHS_OPTIONS);
      if (r.Status !== 'Optimal') { console.log('seq fail', r.Status); break; }
      const val = Math.round(r.ObjectiveValue); best.push(val);
      extra.push(` l${k}: ${obj} <= ${val}`);
    }
    const same = JSON.stringify(best) === JSON.stringify(lpKey);
    same ? ok++ : bad++;
    console.log(seed, mode, 'lp', JSON.stringify(lpKey), 'seq', JSON.stringify(best), same ? 'OK' : 'DIFF');
  }
}
console.log({ ok, bad });
