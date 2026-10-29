// P-02 の比較：元の定式化 と 整数化コスト を、シードを変えた 30 通りのダミーで比べる。実行：npm run bench:p02
import loadHighs from 'highs';
import { writeFileSync } from 'node:fs';
import { generate } from './src/gen.ts';
import { buildModel, solveModel, toRows, hashValues } from './src/lp.ts';
import { check, classifyW107, summarize, totalDistance, w107 } from './src/analyze.ts';

const highs = await loadHighs();
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const rows: string[] = [];
const cls = { original: { restricted: 0, strict: 0, tie: 0, blocked: 0 }, integer: { restricted: 0, strict: 0, tie: 0, blocked: 0 } };
const agg = { original: { t: [] as number[], w: [] as number[], dist: [] as number[], caster: [] as number[] }, integer: { t: [] as number[], w: [] as number[], dist: [] as number[], caster: [] as number[] } };
let bad = 0;
const seeds = Array.from({ length: 30 }, (_, k) => 100 + k);
console.log('seed | 元: W107 / 距離計 / 時間ms / キャスター | 整数化: W107 / 距離計 / 時間ms / キャスター');
for (const seed of seeds) {
  const d = generate(seed);
  const cells: string[] = [];
  for (const mode of ['original', 'integer'] as const) {
    const m = buildModel(d.input, { costMode: mode, wrap: 300 });
    const ts: number[] = [];
    let s = solveModel(highs, m);
    ts.push(s.ms);
    for (let k = 0; k < 2; k++) { const s2 = solveModel(highs, m); ts.push(s2.ms); if (hashValues(s2.values) !== hashValues(s.values)) bad++; }
    if (s.status !== 'Optimal' || s.maxFrac > 1e-6) { cells.push(`${s.status}`); bad++; continue; }
    const r = toRows(m, s.values);
    if (check(d.input, m, r).length) bad++;
    const w = w107(d.input, r).length;
    const c = classifyW107(d.input, [...r, ...m.keepRows]);
    cls[mode].restricted += c.restricted; cls[mode].strict += c.strict; cls[mode].tie += c.tie; cls[mode].blocked += c.blocked;
    const dist = totalDistance(d.input, [...r, ...m.keepRows]);
    const caster = summarize(d.input, m, r).subs['desk->caster_desk'] ?? 0;
    agg[mode].t.push(median(ts)); agg[mode].w.push(w); agg[mode].dist.push(dist); agg[mode].caster.push(caster);
    cells.push(`${w} / ${dist} / ${median(ts).toFixed(0)} / ${caster}`);
  }
  rows.push(`${seed} | ${cells.join(' | ')}`);
  console.log(rows.at(-1));
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
for (const mode of ['original', 'integer'] as const) {
  const a = agg[mode];
  console.log(`[${mode}] W107 合計 ${sum(a.w)}（0件のシード ${a.w.filter((x) => x === 0).length}/30、最大 ${Math.max(...a.w)}）、距離計の平均 ${(sum(a.dist) / a.dist.length).toFixed(1)}、時間の中央値 ${median(a.t).toFixed(1)}ms（最大 ${Math.max(...a.t).toFixed(0)}）、キャスター机の平均 ${(sum(a.caster) / a.caster.length).toFixed(1)}`);
}
console.log('W107 の分類（restricted=受け取る側が S05 の制限つき／入れ替えると必ず悪くなる=strict／同点の入れ替えがある=tie／入れ替えると良くなるのに起きている=blocked）', JSON.stringify(cls));
console.log(`解の不一致・非整数・検証エラー: ${bad} 件`);
writeFileSync(new URL('./results/p02.json', import.meta.url), JSON.stringify({ rows, agg, cls, bad }, null, 1));

// ---- K-12 の最小例：同点になる配置を、部屋3つ×団体2つの並び順を全部変えて解く（6×2=12通り）----
console.log('\n## K-12 の最小例（団体 g：1号棟1階の A を使用、h：屋外。A と B(2階) に机5台ずつ、g・h は机5台を申請。A→g と B→h なら W107 なし、B→g と A→h なら W107 あり。どちらも距離計 25 の同点）');
{
  const perms = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]];
  const mini = (p: number[], gFirst: boolean) => {
    const base = generate(1);
    const deskItem = base.itemByCode.get('desk')!;
    const mk = (name: string, o: number, floor: number | null, kind: 'room' | 'outdoor') => ({ id: name, name, kind, building: kind === 'room' ? 'X' : null, floor, extraCost: 0, usable: true, sortOrder: o });
    const A = mk('A', p[0]!, 1, 'room'), B = mk('B', p[1]!, 2, 'room'), O = mk('O', p[2]!, null, 'outdoor');
    const g = { id: 'g', name: 'g', category: 'stall' as const, locationRoomId: 'A', sortOrder: gFirst ? 1 : 2 };
    const h = { id: 'h', name: 'h', category: 'stall' as const, locationRoomId: 'O', sortOrder: gFirst ? 2 : 1 };
    return {
      items: [deskItem], rooms: [A, B, O], groups: [g, h], distanceOverrides: [], rules: [], consents: [], fixedRows: [],
      stocks: [{ roomId: 'A', itemId: deskItem.id, count: 5 }, { roomId: 'B', itemId: deskItem.id, count: 5 }],
      requests: [{ groupId: 'g', itemId: deskItem.id, count: 5 }, { groupId: 'h', itemId: deskItem.id, count: 5 }],
    };
  };
  const cnt = { original: 0, integer: 0 };
  let total = 0;
  for (const p of perms) for (const gFirst of [true, false]) {
    total++;
    for (const mode of ['original', 'integer'] as const) {
      const inp = mini(p, gFirst);
      const m = buildModel(inp, { costMode: mode });
      const r = toRows(m, solveModel(highs, m).values);
      cnt[mode] += w107(inp, r).length;
    }
  }
  console.log(`12通りのうち W107 が出た数：元の定式化 ${cnt.original} / ${total}、整数化 ${cnt.integer} / ${total}`);
}
