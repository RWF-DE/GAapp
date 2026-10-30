import loadHighs from 'highs';
import { generate } from './src/gen.ts';
import { buildModel } from './src/lp.ts';
import { check } from './src/analyze.ts';
import { build, solve, diffKeys } from './src/model2.ts';
import type { AllocateInput } from './src/types.ts';
const highs = await loadHighs();
const d = generate();
const m = build(d.input, { mode: 'full' });
const s = solve(highs, m);
const mOld = buildModel(d.input, { costMode: 'integer' });
// keep 行を差し引いて check に渡す
const rows = s.rows.map((r) => ({ ...r }));
for (const k of m.keepRows) { const r = rows.find((x) => x.groupId === k.groupId && x.sourceRoomId === k.sourceRoomId && x.itemId === k.itemId && x.requestedItemId === k.requestedItemId)!; r.count -= k.count; }
console.log('check', check(d.input, mOld, rows.filter((r) => r.count > 0)));
// weighted subs
const cs = new Map(m.vars.map((v) => [`${v.r}|${v.g}|${v.i}|${v.j}`, v.csub]));
const wsub = (rs: typeof rows) => rs.reduce((a, r) => a + r.count * (cs.get(`${r.sourceRoomId}|${r.groupId}|${r.requestedItemId}|${r.itemId}`) ?? 0), 0);
console.log('weighted subs', wsub(s.rows));
for (const seed of [20261029, 100]) {
  const dd = generate(seed);
  const code = new Map(dd.input.items.map((i) => [i.id, i.code]));
  const gname = new Map(dd.input.groups.map((g) => [g.id, g.name]));
  const rname = new Map(dd.input.rooms.map((g) => [g.id, g.name]));
  const s1 = solve(highs, build(dd.input, { mode: 'full' }));
  const mer = dd.roomByName.get('MER')!.id;
  const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === mer ? { ...r, usable: false } : r)) };
  const lost = new Set(s1.rows.filter((r) => r.sourceRoomId === mer).map((r) => `${r.groupId}|${r.requestedItemId}`));
  console.log('seed', seed, 'lost from MER:', s1.rows.filter((r) => r.sourceRoomId === mer).map((r) => `${gname.get(r.groupId)}:${code.get(r.requestedItemId)}->${code.get(r.itemId)}x${r.count}`).join(' '));
  const s2 = solve(highs, build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' }));
  const df = diffKeys(s1.rows, s2.rows);
  const byI = new Map<string, number>();
  for (const c of df.changed) { const [r, g, i, j] = c.k.split('|'); const rel = r === mer || lost.has(`${g}|${i}`); const k = `${code.get(i)}->${code.get(j)} ${rel ? 'related' : 'UNRELATED'}`; byI.set(k, (byI.get(k) ?? 0) + 1);
    if (!rel && code.get(i) !== 'desk') console.log('   unrelated non-desk:', rname.get(r), gname.get(g), code.get(i), code.get(j), c.before, '->', c.after); }
  console.log('  lex changes by requested->item:', JSON.stringify([...byI]));
}
