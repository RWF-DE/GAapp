import loadHighs from 'highs';
import { generate } from './src/gen.ts';
import { build, solve, diffKeys } from './src/model2.ts';
import type { AllocateInput } from './src/types.ts';
const highs = await loadHighs();
const tot: Record<string, { tightUnrel: number; slackUnrel: number; changed: number; n: number }> = {};
for (let seed = 100; seed < 130; seed++) {
  const dd = generate(seed);
  const code = new Map(dd.input.items.map((i) => [i.id, i.code]));
  const s1 = solve(highs, build(dd.input, { mode: 'full' }));
  for (const roomName of ['MER', 'HI1', 'CI2']) {
    const M = dd.roomByName.get(roomName)!.id;
    const input2: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)) };
    const lost = new Set(s1.rows.filter((r) => r.sourceRoomId === M).map((r) => `${r.groupId}|${r.requestedItemId}`));
    // 申請品目 i ごとの「きつさ」：i の需要に使える品目 j の余り（M 以外）が、M から失った分以上か。簡易に j=i の余りで判定
    const stockOther = new Map<string, number>(), used = new Map<string, number>(), lostBy = new Map<string, number>();
    for (const st of input2.stocks) { const rm = input2.rooms.find((x) => x.id === st.roomId)!; if (rm.usable) stockOther.set(st.itemId, (stockOther.get(st.itemId) ?? 0) + st.count); }
    for (const r of s1.rows) if (r.sourceRoomId !== M) used.set(r.itemId, (used.get(r.itemId) ?? 0) + r.count); else lostBy.set(r.itemId, (lostBy.get(r.itemId) ?? 0) + r.count);
    const tightJ = new Set([...lostBy.keys()].filter((j) => (stockOther.get(j) ?? 0) - (used.get(j) ?? 0) < lostBy.get(j)!));
    for (const mu of ['unit', 'lex'] as const) {
      const s2 = solve(highs, build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: mu }));
      if (s2.status !== 'Optimal') { console.log(seed, roomName, mu, s2.status); continue; }
      const df = diffKeys(s1.rows, s2.rows);
      const t = (tot[mu] ??= { tightUnrel: 0, slackUnrel: 0, changed: 0, n: 0 });
      t.n++; t.changed += df.changed.length;
      for (const c of df.changed) {
        const [r, g, i, j] = c.k.split('|');
        if (r === M || lost.has(`${g}|${i}`)) continue;
        // 「きつい」品目が関わる連鎖（申請品目 i か品目 j がきつい品目、または i が desk 系の代替）
        const involvesTight = tightJ.has(i!) || tightJ.has(j!) || [...tightJ].some((tj) => s1.rows.some((x) => x.requestedItemId === i && x.itemId === tj));
        if (involvesTight) t.tightUnrel++; else { t.slackUnrel++; if (mu === 'lex') console.log('lex slack-unrelated', seed, roomName, code.get(i!), code.get(j!), c.before, c.after); }
      }
    }
  }
}
console.log(JSON.stringify(tot));
