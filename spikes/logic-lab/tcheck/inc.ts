import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys, type Model } from '../src/model2.ts';
import type { AllocateInput, AllocationRow } from '../src/types.ts';
const highs = await loadHighs();
function components(m: Model) {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
  const uni = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const v of m.vars) uni(`D|${v.g}|${v.i}`, `S|${v.r}|${v.j}`);
  return (g: string, i: string) => find(`D|${g}|${i}`);
}
function csubOf(m: Model, r: AllocationRow) {
  if (r.itemId === r.requestedItemId) return 0;
  const g = m.groups.find(x => x.id === r.groupId)!, it = m.items.find(x => x.id === r.requestedItemId)!;
  const o = m.options(g, it).find(x => x.j === r.itemId);
  return o ? o.csub : NaN;
}
let inc = 0, incComps = 0, goodComps = 0;
for (let seed = 100; seed < 130; seed++) {
  const d = generate(seed);
  for (const name of ['MER','HI1','CI2']) {
    const input = d.input; const M = d.roomByName.get(name)!.id;
    const s1 = solve(highs, build(input, { mode: 'full' }));
    const input2: AllocateInput = { ...input, rooms: input.rooms.map(r => r.id === M ? { ...r, usable: false } : r) };
    const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
    const s2 = solve(highs, m2);
    if (s2.status !== 'Optimal') continue;
    const comp = components(m2);
    const prevNonM = s1.rows.filter(r => r.sourceRoomId !== M);
    const fromM = s1.rows.filter(r => r.sourceRoomId === M);
    const comps = new Set(fromM.map(r => comp(r.groupId, r.requestedItemId)));
    const df = diffKeys(s1.rows, s2.rows);
    for (const c of comps) {
      const fixed = prevNonM.filter(r => comp(r.groupId, r.requestedItemId) === c);
      const auxM = build({ ...input2, fixedRows: fixed }, { mode: 'full' });
      const aux = solve(highs, auxM);
      if (!(aux.status === 'Optimal' && auxM.noCandidate.length === 0)) continue;
      const inC = (r: AllocationRow) => comp(r.groupId, r.requestedItemId) === c;
      const before = s1.rows.filter(inC).reduce((a, r) => a + csubOf(m2, r) * r.count, 0);
      const after = [...fixed, ...aux.rows.filter(inC)].reduce((a, r) => a + csubOf(m2, r) * r.count, 0);
      if (before !== after) continue;
      goodComps++;
      let here = 0;
      for (const ch of df.changed) {
        const [r, g, i] = ch.k.split('|');
        if (comp(g!, i!) !== c) continue;
        if (r !== M && ch.before > 0 && ch.after > ch.before) here++;
      }
      inc += here; if (here) incComps++;
    }
  }
}
console.log({ goodComps, incComps, increasedPrevNonMRows: inc });
