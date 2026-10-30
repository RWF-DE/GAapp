// D-08 の確かめ方の改訂案：候補のつながり（連結成分）ごとに、前回の M 以外の行を固定して full で解き、
// 代替の重さの合計が前回と同じなら「補える」とし、その成分では前回の M 以外の行がすべて保たれることを確かめる。
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
export function check(input: AllocateInput, M: string, label: string) {
  const s1 = solve(highs, build(input, { mode: 'full' }));
  const input2: AllocateInput = { ...input, rooms: input.rooms.map(r => r.id === M ? { ...r, usable: false } : r) };
  const m2 = build(input2, { mode: 'minimal_change', previousRows: s1.rows, muMode: 'lex' });
  const s2 = solve(highs, m2);
  if (s2.status !== 'Optimal') return { label, status: s2.status };
  const comp = components(m2);
  const prevNonM = s1.rows.filter(r => r.sourceRoomId !== M);
  const fromM = s1.rows.filter(r => r.sourceRoomId === M);
  const comps = new Set(fromM.map(r => comp(r.groupId, r.requestedItemId)));
  let ok = 0, ng = 0, viol = 0, checkedRows = 0, changedInNg = 0;
  const df = diffKeys(s1.rows, s2.rows);
  const lostGi = new Set(fromM.map(r => `${r.groupId}|${r.requestedItemId}`));
  for (const c of comps) {
    const fixed = prevNonM.filter(r => comp(r.groupId, r.requestedItemId) === c);
    const auxM = build({ ...input2, fixedRows: fixed }, { mode: 'full' });
    const aux = solve(highs, auxM);
    let good = false;
    if (aux.status === 'Optimal' && auxM.noCandidate.length === 0) {
      const inC = (r: AllocationRow) => comp(r.groupId, r.requestedItemId) === c;
      const before = s1.rows.filter(inC).reduce((a, r) => a + csubOf(m2, r) * r.count, 0);
      const after = [...fixed, ...aux.rows.filter(inC)].reduce((a, r) => a + csubOf(m2, r) * r.count, 0);
      good = before === after;
    }
    for (const ch of df.changed) {
      const [r, g, i] = ch.k.split('|');
      if (comp(g!, i!) !== c) continue;
      const unrelated = r !== M && !lostGi.has(`${g}|${i}`);
      if (good) { if (r !== M && ch.before > 0 && ch.after < ch.before) viol++; if (unrelated) viol++; }
      else if (unrelated) changedInNg++;
    }
    if (good) { ok++; checkedRows += fixed.length; } else ng++;
  }
  // 成分に M の行がない申請品目は、そもそも前回とまったく同じか
  let untouched = 0;
  for (const ch of df.changed) { const [, g, i] = ch.k.split('|'); if (!comps.has(comp(g!, i!))) untouched++; }
  return { label, status: 'Optimal', comps: comps.size, ok, ng, viol, untouched, checkedRows, changedInNg, fromM: fromM.length };
}
if (process.argv[2] !== 'lib') {
  const out: any[] = [];
  for (let seed = 100; seed < 130; seed++) {
    const d = generate(seed);
    for (const name of ['MER', 'HI1', 'CI2']) out.push(check(d.input, d.roomByName.get(name)!.id, `${seed}:${name}`));
  }
  const d0 = generate(); out.push(check(d0.input, d0.roomByName.get('MER')!.id, '20261029:MER'));
  const opt = out.filter(o => o.status === 'Optimal');
  console.log({ total: out.length, optimal: opt.length, viol: opt.reduce((a, o) => a + o.viol, 0), untouched: opt.reduce((a, o) => a + o.untouched, 0),
    compsOk: opt.reduce((a, o) => a + o.ok, 0), compsNg: opt.reduce((a, o) => a + o.ng, 0), changedInNg: opt.reduce((a, o) => a + o.changedInNg, 0),
    noneChecked: opt.filter(o => o.ok === 0).length, minFromM: Math.min(...opt.map(o => o.fromM)) });
  console.log(out.find(o => o.label === '20261029:MER'));
}
