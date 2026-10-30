import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys } from '../src/model2.ts';
const highs = await loadHighs();
const d = generate(); const M = d.roomByName.get('MER')!.id;
const name = new Map([...d.input.rooms.map(r => [r.id, r.name] as const), ...d.input.groups.map(g => [g.id, g.name] as const), ...d.input.items.map(i => [i.id, i.code] as const)]);
const s1 = solve(highs, build(d.input, { mode: 'full' }));
const input2 = { ...d.input, rooms: d.input.rooms.map(r => r.id === M ? { ...r, usable: false } : r) };
const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
const s2 = solve(highs, m2);
const df = diffKeys(s1.rows, s2.rows);
for (const c of df.changed) console.log(c.k.split('|').map(x => name.get(x) ?? x).join(' '), c.before, '->', c.after);
console.log('hat total', m2.vars.filter(v => v.hat).reduce((a, v) => a + (v.ub ?? 0), 0), 'mu', m2.mu, 'W', m2.W, 'K', m2.K);
// component check
const parent = new Map<string, string>();
const find = (x: string): string => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
const uni = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const v of m2.vars) uni(`D|${v.g}|${v.i}`, `S|${v.r}|${v.j}`);
const comp = (g: string, i: string) => find(`D|${g}|${i}`);
const fromM = s1.rows.filter(r => r.sourceRoomId === M);
const comps = new Set(fromM.map(r => comp(r.groupId, r.requestedItemId)));
const csubOf = (r: any) => { if (r.itemId === r.requestedItemId) return 0; const g = m2.groups.find(x => x.id === r.groupId)!, it = m2.items.find(x => x.id === r.requestedItemId)!; const o = m2.options(g, it).find(x => x.j === r.itemId); return o ? o.csub : NaN; };
for (const c of comps) {
  const inC = (r: any) => comp(r.groupId, r.requestedItemId) === c;
  const fixed = s1.rows.filter(r => r.sourceRoomId !== M && inC(r));
  const aux = solve(highs, build({ ...input2, fixedRows: fixed }, { mode: 'full' }));
  const before = s1.rows.filter(inC).reduce((a, r) => a + csubOf(r) * r.count, 0);
  const after = [...fixed, ...aux.rows.filter(inC)].reduce((a, r) => a + csubOf(r) * r.count, 0);
  const s2c = s2.rows.filter(inC).reduce((a, r) => a + csubOf(r) * r.count, 0);
  console.log(c.split('|').map(x => name.get(x) ?? x).join(' '), aux.status, 'before', before, 'aux', after, 's2', s2c, 'fixed', fixed.length, 'auxrows', aux.rows.filter(inC).length);
}
