import loadHighs from 'highs';
import { generate as g0 } from '../src/gen.ts';
import { generate as g1 } from './gen.ts';
import { build, solve } from '../src/model2.ts';
const highs = await loadHighs();
const key = (d: any, rows: any[]) => { const rn = new Map(d.input.rooms.map((r: any) => [r.id, r.name])), gi = new Map(d.input.groups.map((g: any, k: number) => [g.id, k])), ic = new Map(d.input.items.map((i: any) => [i.id, i.code]));
  return new Set(rows.map(r => `${rn.get(r.sourceRoomId)}|${gi.get(r.groupId)}|${ic.get(r.requestedItemId)}|${ic.get(r.itemId)}|${r.count}`)); };
for (const seed of [20261029, 100, 101, 102]) {
  const a = g0(seed), b = g1(seed, { burn: true, extra: false }), c = g1(seed, { burn: false, extra: false });
  const ka = key(a, solve(highs, build(a.input, { mode: 'full' })).rows), kb = key(b, solve(highs, build(b.input, { mode: 'full' })).rows), kc = key(c, solve(highs, build(c.input, { mode: 'full' })).rows);
  const sameStocks = JSON.stringify(a.input.stocks.map(s => s.count)) === JSON.stringify(b.input.stocks.map(s => s.count));
  const sameReq = JSON.stringify(a.input.requests.map(s => s.count)) === JSON.stringify(b.input.requests.map(s => s.count));
  const sameStocksNoburn = JSON.stringify(a.input.stocks.map(s => s.count)) === JSON.stringify(c.input.stocks.map(s => s.count));
  console.log(seed, { burnRowsDiff: [...ka].filter(x => !kb.has(x)).length, of: ka.size, sameStocks, sameReq, noburnRowsDiff: [...ka].filter(x => !kc.has(x)).length, sameStocksNoburn });
}
