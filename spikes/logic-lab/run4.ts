import loadHighs from 'highs';
import { generate } from './src/gen.ts';
import { buildModel, solveModel, toRows } from './src/lp.ts';
import { build, solve } from './src/model2.ts';
const highs = await loadHighs();
let eq = 0, chairNgDiff: string[] = [];
for (let seed = 100; seed < 130; seed++) {
  const dd = generate(seed);
  const m = build(dd.input, { mode: 'full' }); const s = solve(highs, m);
  const mo = buildModel(dd.input, { costMode: 'integer' }); const so = solveModel(highs, mo); const ro = [...toRows(mo, so.values), ...mo.keepRows];
  const cs = new Map(m.vars.map((v) => [`${v.r}|${v.g}|${v.i}|${v.j}`, v.csub]));
  const w = (rs: any[]) => rs.reduce((a, r) => a + r.count * (cs.get(`${r.sourceRoomId}|${r.groupId}|${r.requestedItemId}|${r.itemId}`) ?? 0), 0);
  if (w(s.rows) === w(ro)) eq++;
  const ng = dd.itemByCode.get('chair_ng')!.id;
  const rest = new Set(dd.input.groups.filter((g) => g.category === 'rest_area').map((g) => g.id));
  const c = (rs: any[]) => [rs.filter((r) => r.itemId === ng).reduce((a, r) => a + r.count, 0), rs.filter((r) => r.itemId === ng && rest.has(r.groupId)).reduce((a, r) => a + r.count, 0)];
  const a = c(s.rows), b = c(ro);
  if (a.join() !== b.join()) chairNgDiff.push(`${seed}: new(total,rest)=${a} old=${b}`);
}
console.log('weighted subs equal', eq, '/30'); console.log(chairNgDiff.join('\n'));
