import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve, diffKeys } from '../src/model2.ts';
import type { AllocateInput } from '../src/types.ts';
const highs = await loadHighs();
for (const seed of [20261029, 100, 101, 102, 103, 104, 105]) {
  const d = generate(seed);
  const setup = d.groupByName.get('設営')!.id;
  const gym = d.roomByName.get('体育館')!.id;
  const desk = d.itemByCode.get('desk')!.id;
  const gymDesk = d.input.stocks.filter(s => s.roomId === gym && s.itemId === desk).reduce((a, s) => a + s.count, 0);
  const s1 = solve(highs, build(d.input, { mode: 'full' }));
  const s2 = solve(highs, build(d.input, { mode: 'full', disabledRules: ['S05'] }));
  const src = (rows: any[]) => JSON.stringify(rows.filter(r => r.groupId === setup && r.requestedItemId === desk).map(r => `${d.input.rooms.find(x=>x.id===r.sourceRoomId)!.name}:${r.count}`).sort());
  const s05Binds = src(s1.rows) !== src(s2.rows);
  // 第一セミナー usable
  const sem = d.roomByName.get('第一セミナー')!.id;
  const inp3: AllocateInput = { ...d.input, rooms: d.input.rooms.map(r => r.id === sem ? { ...r, usable: true } : r) };
  const s3 = solve(highs, build(inp3, { mode: 'full' }));
  const semUsed = s3.rows.filter(r => r.sourceRoomId === sem).reduce((a, r) => a + r.count, 0);
  // S02 preference: chair_ng to rest areas
  const ng = d.itemByCode.get('chair_ng')!.id;
  const rest = new Set(d.input.groups.filter(g => g.category === 'rest_area').map(g => g.id));
  const ngRest = s1.rows.filter(r => r.itemId === ng && rest.has(r.groupId)).reduce((a, r) => a + r.count, 0);
  const ngAll = s1.rows.filter(r => r.itemId === ng).reduce((a, r) => a + r.count, 0);
  // declined group
  const caster = d.itemByCode.get('caster_desk')!.id;
  const declined = d.input.consents.filter(c => c.status === 'declined').map(c => c.groupId);
  const s4 = solve(highs, build({ ...d.input, consents: d.input.consents.map(c => ({ ...c, status: 'not_asked' as const })) }, { mode: 'full' }));
  const declinedWouldGet = s4.rows.filter(r => declined.includes(r.groupId) && r.itemId === caster && r.requestedItemId === desk).reduce((a, r) => a + r.count, 0);
  console.log(seed, { gymDesk, s05Binds, setupSrc: src(s1.rows), semUsedIfUsable: semUsed, chairNg: `${ngRest}/${ngAll} rest`, declinedWouldGetCasterIfNotDeclined: declinedWouldGet });
}
