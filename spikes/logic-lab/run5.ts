import loadHighs from 'highs';
import { generate } from './src/gen.ts';
import { build, solve } from './src/model2.ts';
const highs = await loadHighs();
const kinds: Record<string, number> = {};
for (let seed = 100; seed < 130; seed++) {
  const dd = generate(seed);
  const m = build(dd.input, { mode: 'full' }); const s = solve(highs, m);
  const setup = dd.groupByName.get('設営')!.id;
  const s05 = new Set(['1-1','1-2','1-3','2-1','2-2','2-3'].map((n) => dd.roomByName.get(n)!.id));
  const group = new Map(m.groups.map((g) => [g.id, g]));
  for (const g of m.groups) {
    const L = g.locationRoomId; if (!L) continue;
    const recv = s.rows.filter((r) => r.groupId === g.id && r.sourceRoomId !== L);
    const outs = s.rows.filter((r) => r.sourceRoomId === L && group.get(r.groupId)!.locationRoomId !== L);
    for (const j of new Set(recv.map((r) => r.itemId))) {
      const oj = outs.filter((r) => r.itemId === j); if (!oj.length) continue;
      const k = g.id === setup ? 'g=設営(体育館の机が外へ)' : oj.every((o) => o.groupId === setup) && s05.has(L) ? 'S05の部屋の団体(机が設営へ)' : 'other';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
  }
}
console.log(kinds);
