import loadHighs from 'highs';
import * as gen from '../src/gen.ts';
import { build, solve } from '../src/model2.ts';
const highs = await loadHighs();
const d = (gen as any).makeInfeasibleS05 ? (gen as any).makeInfeasibleS05(gen.generate(20261029)) : null;
if (!d) { console.log('no makeInfeasibleS05'); process.exit(0); }
const input = d.input ?? d;
for (const dis of [[], ['S05'], ['S06'], ['S08']]) {
  const m = build(input, { mode: 'full', disabledRules: dis });
  // P7: 候補の運び元の S' の合計 < D'
  const short: string[] = [];
  const byDemand = new Map<string, Set<string>>();
  for (const v of m.vars) { const k = `${v.g}|${v.i}`; (byDemand.get(k) ?? byDemand.set(k, new Set()).get(k)!).add(`${v.r}|${v.j}`); }
  for (const [k, set] of byDemand) { const sum = [...set].reduce((a, rj) => a + (m.supply.get(rj) ?? 0), 0); const D = m.demand.get(k)!; if (sum < D) short.push(`${k} D=${D} S=${sum}`); }
  const s = solve(highs, m);
  console.log(JSON.stringify(dis), 'noCand', m.noCandidate.length, 'P7', short.length, short.slice(0, 2), 'status', s.status);
}
