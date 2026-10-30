// 12.3 の「足りない申請品目」の定義で、無関係な行の変化が本当に0か（M を S05 の部屋などにも広げる）
import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
const tot: Record<string, { cases: number; infeasible: number; bad: number }> = {};
const samples: string[] = [];
for (let seed = 100; seed < 130; seed++) {
  const dd = generate(seed);
  const code = new Map(dd.input.items.map((i) => [i.id, i.code]));
  const gname = new Map(dd.input.groups.map((g) => [g.id, g.name]));
  const rname = new Map(dd.input.rooms.map((g) => [g.id, g.name]));
  const s1 = solve(highs, build(dd.input, { mode: 'full' }));
  // 候補の品目（申請品目 -> 候補）
  const cand = new Map<string, Set<string>>();
  for (const it of dd.input.items) cand.set(it.code, new Set([it.code]));
  for (const r of dd.input.rules) if (r.kind === 'substitute') cand.get(r.params.from)!.add(r.params.to);
  for (const name of ['MER', 'HI1', 'CI2', '1-1', '1-2', '2-1', '2-3', '体育館', '食堂', '倉庫1', '第一多目的室']) {
    const Mr = dd.roomByName.get(name); if (!Mr) continue;
    const M = Mr.id;
    const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)) };
    const t = (tot[name] ??= { cases: 0, infeasible: 0, bad: 0 });
    t.cases++;
    const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
    if (m2.noCandidate.length) { t.infeasible++; continue; }
    const s2 = solve(highs, m2);
    if (s2.status !== 'Optimal') { t.infeasible++; continue; }
    const lost = new Set(s1.rows.filter((r) => r.sourceRoomId === M).map((r) => `${r.groupId}|${r.requestedItemId}`));
    const stockOther = new Map<string, number>(), used = new Map<string, number>(), lostBy = new Map<string, number>();
    for (const st of input2.stocks) { const rm = input2.rooms.find((x) => x.id === st.roomId)!; if (rm.usable) stockOther.set(st.itemId, (stockOther.get(st.itemId) ?? 0) + st.count); }
    for (const r of s1.rows) if (r.sourceRoomId !== M) used.set(r.itemId, (used.get(r.itemId) ?? 0) + r.count); else lostBy.set(r.itemId, (lostBy.get(r.itemId) ?? 0) + r.count);
    const T = new Set([...lostBy.keys()].filter((j) => (stockOther.get(j) ?? 0) - (used.get(j) ?? 0) < lostBy.get(j)!).map((j) => code.get(j)!));
    const short = new Set<string>();
    for (const [i, c] of cand) if ([...c].some((j) => T.has(j))) short.add(i);
    for (const [i, c] of cand) for (const s of [...short]) if ([...c].some((j) => cand.get(s)!.has(j))) short.add(i);
    const df = diffKeys(s1.rows, s2.rows);
    for (const c of df.changed) {
      const [r, g, i, j] = c.k.split('|');
      if (r === M || lost.has(`${g}|${i}`)) continue;
      if (short.has(code.get(i!)!)) continue;
      t.bad++;
      if (samples.length < 12) samples.push(`seed ${seed} M=${name} T=${[...T]} : ${rname.get(r!)} -> ${gname.get(g!)} ${code.get(i!)}->${code.get(j!)} ${c.before}->${c.after}`);
    }
  }
}
console.log(JSON.stringify(tot, null, 0));
console.log(samples.join('\n'));
