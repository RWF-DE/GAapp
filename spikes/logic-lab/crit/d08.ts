import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
let solved = 0, infeasible = 0, viol = 0, vacuous = 0; const notes: string[] = [];
for (let seed = 100; seed < 130; seed++) {
  const d = generate(seed);
  const code = new Map(d.input.items.map(i => [i.id, i.code]));
  const m1 = build(d.input, { mode: 'full' });
  const s1 = solve(highs, m1);
  // candidate items per requested item code (any group)
  const cand = new Map<string, Set<string>>();
  for (const it of d.input.items) { const s = new Set([it.id]); for (const r of d.input.rules) if (r.kind === 'substitute' && r.params.from === it.code) s.add(d.itemByCode.get(r.params.to)!.id); cand.set(it.id, s); }
  for (const name of ['MER', 'HI1', 'CI2']) {
    const M = d.roomByName.get(name)!.id;
    const input2: AllocateInput = { ...d.input, rooms: d.input.rooms.map(r => r.id === M ? { ...r, usable: false } : r) };
    const s2 = solve(highs, build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' }));
    if (s2.status !== 'Optimal') { infeasible++; continue; }
    solved++;
    const lostBy = new Map<string, number>(), used = new Map<string, number>(), other = new Map<string, number>();
    for (const r of s1.rows) (r.sourceRoomId === M ? lostBy : used).set(r.itemId, ((r.sourceRoomId === M ? lostBy : used).get(r.itemId) ?? 0) + r.count);
    for (const st of input2.stocks) { const rm = input2.rooms.find(x => x.id === st.roomId)!; if (rm.usable) other.set(st.itemId, (other.get(st.itemId) ?? 0) + st.count); }
    const T = new Set([...lostBy.keys()].filter(j => (other.get(j) ?? 0) - (used.get(j) ?? 0) < lostBy.get(j)!));
    const I1 = new Set([...cand].filter(([, s]) => [...s].some(j => T.has(j))).map(([i]) => i));
    const I = new Set(I1); for (const [i, s] of cand) for (const i1 of I1) if ([...s].some(j => cand.get(i1)!.has(j))) I.add(i);
    const lost = new Set(s1.rows.filter(r => r.sourceRoomId === M).map(r => `${r.groupId}|${r.requestedItemId}`));
    const df = diffKeys(s1.rows, s2.rows);
    let slackItemsChecked = [...new Set(s1.rows.map(r => r.requestedItemId))].filter(i => !I.has(i)).length;
    if (!slackItemsChecked) vacuous++;
    for (const c of df.changed) { const [r, g, i] = c.k.split('|'); if (r === M || lost.has(`${g}|${i}`) || I.has(i!)) continue; viol++; notes.push(`${seed} ${name} ${code.get(i!)} ${c.before}->${c.after}`); }
  }
}
console.log({ solved, infeasible, viol, vacuous }); console.log(notes.slice(0, 20).join('\n'));
