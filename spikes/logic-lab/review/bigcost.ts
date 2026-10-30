import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
for (const ec of [2, 100, 1000, 10000, 32767]) {
  for (const seed of [20261029, 101, 105]) {
    const dd = generate(seed);
    const ci5 = dd.roomByName.get('CI5') ?? dd.input.rooms.find(r=>r.extraCost>0)!;
    const input: AllocateInput = { ...dd.input, rooms: dd.input.rooms.map(r => r.id === ci5.id ? { ...r, extraCost: ec } : r) };
    const m1 = build(input, { mode: 'full' });
    const s1 = solve(highs, m1);
    const M = dd.roomByName.get('HI1')!.id;
    const input2: AllocateInput = { ...input, rooms: input.rooms.map(r => r.id === M ? { ...r, usable: false } : r) };
    const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
    const s2 = m2.noCandidate.length ? { status: 'noCand', maxFrac: NaN, rows: [] } as any : solve(highs, m2);
    const maxc = Math.max(...m2.vars.map(v => Math.abs(v.cost)));
    // retained count of previous rows (non-M)
    let lost = 0; const prev = new Map(s1.rows.filter(r=>r.sourceRoomId!==M).map(r=>[`${r.sourceRoomId}|${r.groupId}|${r.requestedItemId}|${r.itemId}`, r.count]));
    for (const r of s2.rows) { const k=`${r.sourceRoomId}|${r.groupId}|${r.requestedItemId}|${r.itemId}`; if (prev.has(k)) prev.set(k, Math.max(0, prev.get(k)! - r.count)); }
    for (const v of prev.values()) lost += v;
    console.log('ec', ec, 'seed', seed, 's1', s1.status, 'frac1', s1.maxFrac, 's2', s2.status, 'frac2', s2.maxFrac, 'maxCoef', maxc.toExponential(2), 'maxCoef*N', (maxc*1295).toExponential(2), 'lostPrev', lost, 'changed', s2.rows.length ? diffKeys(s1.rows, s2.rows).changed.length : '-');
  }
}
