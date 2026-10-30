import loadHighs from 'highs';
import { generate as g0 } from '../src/gen.ts';
import { generate as g1 } from './gen.ts';
import { build, solve } from '../src/model2.ts';
import { check } from '../rev3/d08oracle.ts';
const highs = await loadHighs();
type V = { label: string; gen: (seed?: number) => ReturnType<typeof g0> };
const variants: V[] = [
  { label: 'T00', gen: (s) => g0(s) },
  { label: 'burn+extra', gen: (s) => g1(s, { burn: true, extra: true }) },
  { label: 'burn', gen: (s) => g1(s, { burn: true, extra: false }) },
  { label: 'noburn+extra', gen: (s) => g1(s, { burn: false, extra: true }) },
  { label: 'noburn', gen: (s) => g1(s, { burn: false, extra: false }) },
];
const named = (d: ReturnType<typeof g0>, rows: any[]) => {
  const rn = new Map(d.input.rooms.map(r => [r.id, r.name])), gn = new Map(d.input.groups.map(g => [g.id, g.name])), ic = new Map(d.input.items.map(i => [i.id, i.code]));
  return rows.map(r => `${rn.get(r.sourceRoomId)}|${gn.get(r.groupId)}|${ic.get(r.requestedItemId)}|${ic.get(r.itemId)}|${r.count}`).sort().join('\n');
};
let base = '';
for (const v of variants) {
  const d = v.gen();
  const s = solve(highs, build(d.input, { mode: 'full' }));
  const ic = new Map(d.input.items.map(i => [i.id, i.code]));
  const caster = s.rows.filter(r => ic.get(r.requestedItemId) === 'desk' && ic.get(r.itemId) === 'caster_desk').reduce((a, r) => a + r.count, 0);
  const ex = d.groupByName.get('学科展示')!.id, room = d.roomByName.get('第一多目的室')!.id;
  const keep = s.rows.filter(r => r.groupId === ex && r.sourceRoomId === room && ic.get(r.itemId) === 'desk').reduce((a, r) => a + r.count, 0);
  const nm = named(d, s.rows); if (v.label === 'T00') base = nm;
  const mer = check(d.input, d.roomByName.get('MER')!.id, 'MER');
  let opt = 0, tot = 0, good = 0, noneGood = 0;
  for (let seed = 100; seed < 130; seed++) {
    const dd = v.gen(seed);
    for (const n of ['MER', 'HI1', 'CI2']) { tot++; const c: any = check(dd.input, dd.roomByName.get(n)!.id, n); if (c.status === 'Optimal') { opt++; good += c.ok; if (!c.ok) noneGood++; } }
  }
  console.log(v.label, JSON.stringify({ full: s.status, caster, keepDesk: keep, sameAsT00: nm === base, mer, seeds: { tot, opt, good, noneGood } }));
}
