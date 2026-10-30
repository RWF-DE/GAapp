import loadHighs from 'highs';
import { generate } from '../src/gen.ts';
import { build, solve } from '../src/model2.ts';
const highs = await loadHighs();
const d = generate();
const ex = d.groupByName.get('学科展示')!.id, room = d.roomByName.get('第一多目的室')!.id;
const s = solve(highs, build(d.input, { mode: 'full' }));
const code = new Map(d.input.items.map(i => [i.id, i.code]));
console.log(s.rows.filter(r => r.groupId === ex).map(r => `${d.input.rooms.find(x=>x.id===r.sourceRoomId)!.name} ${code.get(r.requestedItemId)}->${code.get(r.itemId)} ${r.count} keep=${r.isKeep}`));
// pin the merged keep desk row
const kr = s.rows.find(r => r.groupId === ex && r.sourceRoomId === room && code.get(r.itemId) === 'desk')!;
const s2 = solve(highs, build({ ...d.input, fixedRows: [kr] }, { mode: 'full' }));
const tot = s2.rows.filter(r => r.groupId === ex && r.sourceRoomId === room && code.get(r.itemId) === 'desk').reduce((a, r) => a + r.count, 0);
console.log('pinned', kr.count, 'new rows same key', tot, 'fixed+new', kr.count + tot);
