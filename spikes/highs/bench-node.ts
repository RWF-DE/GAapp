// Node で測る。実行：npm run bench:node
import loadHighs from 'highs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generate, makeInfeasibleLectern, makeInfeasibleS05, shuffleInput } from './src/gen.ts';
import { buildModel, hashValues, hash53, solveModel, toRows, HIGHS_OPTIONS, type CostMode, type Model } from './src/lp.ts';
import { check, diffRows, summarize, w107 } from './src/analyze.ts';

const require = createRequire(import.meta.url);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const f = (x: number) => x.toFixed(1);
const out: Record<string, unknown> = {};
const log = (...a: unknown[]) => console.log(...a);

const d = generate();
const hv = JSON.parse(readFileSync(new URL('./node_modules/highs/package.json', import.meta.url), 'utf8')).version;
log('## 環境');
log(`node ${process.version}, highs(npm) ${hv}, options ${JSON.stringify(HIGHS_OPTIONS)}`);

// ---------- 入力 ----------
log('\n## 入力');
log(`保管場所 ${d.input.rooms.filter((r) => d.input.stocks.some((s) => s.roomId === r.id)).length}（在庫あり。使用不可 1 を含む）、部屋合計 ${d.input.rooms.length}、団体 ${d.input.groups.length}、品目 ${d.input.items.length}、申請行 ${d.input.requests.length}`);
const sumBy = (code: string, arr: { itemId: string; count: number }[]) => arr.filter((x) => d.itemByCode.get(code as any)!.id === x.itemId).reduce((a, b) => a + b.count, 0);
log('在庫合計', Object.fromEntries(d.input.items.map((i) => [i.code, sumBy(i.code, d.input.stocks)])));
log('申請合計(前処理前)', Object.fromEntries(d.input.items.map((i) => [i.code, sumBy(i.code, d.input.requests)])), '合計', d.input.requests.reduce((a, b) => a + b.count, 0));

const highs = await loadHighs();
log('highs.version', JSON.stringify(highs.version), 'memoryBytes', highs.memoryBytes);
out.version = { npm: hv, core: highs.version.string };

// ---------- 5回測定（元の定式化 / 整数化）----------
type Run = { mode: CostMode; m: Model; times: number[]; hashes: string[]; maxFrac: number; objective: number; rows: ReturnType<typeof toRows>; status: string };
async function five(mode: CostMode, input = d.input, wrap: number | null = 300): Promise<Run> {
  const m = buildModel(input, { costMode: mode, wrap });
  const times: number[] = [], hashes: string[] = [];
  let maxFrac = 0, objective = NaN, status = '', rows: Run['rows'] = [];
  for (let k = 0; k < 5; k++) {
    const s = solveModel(highs, m);
    status = s.status; if (s.status !== 'Optimal') break;
    times.push(s.ms); hashes.push(hashValues(s.values)); maxFrac = Math.max(maxFrac, s.maxFrac); objective = s.objective;
    if (k === 0) rows = toRows(m, s.values);
  }
  return { mode, m, times, hashes, maxFrac, objective, rows, status };
}
const runs: Record<string, Run> = {};
log('\n## 5回ずつ解く（同じ Highs インスタンス、折り返しあり 300 字）');
for (const mode of ['original', 'integer'] as const) {
  const r = (runs[mode] = await five(mode));
  const issues = check(d.input, r.m, r.rows);
  log(`[${mode}] status=${r.status} vars=${r.m.stats.vars} rows=${r.m.stats.rows}(供給${r.m.supplyRows}+需要${r.m.demandRows}) nnz=${r.m.stats.nonzeros} N=${r.m.N} W=${r.m.W} dmax=${r.m.dmax} mu=${r.m.mu}`);
  log(`   solve ms: ${r.times.map(f).join(', ')}  中央値 ${f(median(r.times))}  最小 ${f(Math.min(...r.times))}  最大 ${f(Math.max(...r.times))}`);
  log(`   最大の整数からのずれ max|x-round(x)| = ${r.maxFrac}（≤1e-6: ${r.maxFrac <= 1e-6}）  目的関数 ${r.objective}`);
  log(`   5回の解のハッシュ ${r.hashes.join(' ')}  → 全部同じ: ${new Set(r.hashes).size === 1}`);
  log(`   独立した検証（E001〜E005 相当）: ${issues.length === 0 ? '問題なし' : issues.slice(0, 5).join(' / ')}`);
  const sm = summarize(d.input, r.m, r.rows);
  log('   品目別の使用数', JSON.stringify(sm.byItem), '代替', JSON.stringify(sm.subs));
  const w = w107(d.input, r.rows);
  log(`   W107 パターン ${w.length} 件（うち受け取る側が S05 の運び元の制限を受けている団体 ${w.filter((x) => x.groupRestricted).length}）`, JSON.stringify(w.map((x) => `${x.group}/${x.item}(外へ${x.out},受取${x.recv})`)));
  out[`five_${mode}`] = { times: r.times, median: median(r.times), maxFrac: r.maxFrac, hashes: r.hashes, objective: r.objective, w107: w.length, vars: r.m.stats.vars, rows: r.m.stats.rows };
}

// ---------- 並べ替え ----------
log('\n## 入力の配列を並べ替えてから、sort_order → 名前 → id で並べ直す');
const base = runs.original!;
const shuffled: string[] = [];
for (const seed of [1, 2, 3]) {
  const m2 = buildModel(shuffleInput(d.input, seed), { costMode: 'original', wrap: 300 });
  const s2 = solveModel(highs, m2);
  shuffled.push(`seed${seed}: LP同一=${m2.lp === base.m.lp} 解のハッシュ=${hashValues(s2.values)} 同一=${hashValues(s2.values) === base.hashes[0]}`);
}
log(shuffled.join('\n'));
out.shuffled = shuffled;
// ---------- LP の大きさ・折り返し ----------
log('\n## LP 文字列の大きさ（K-23）');
const sizes: Record<string, unknown> = {};
for (const wrap of [null, 1000, 300, 100]) {
  const m = buildModel(d.input, { costMode: 'original', wrap });
  let st = '', ms = NaN, same = false, err = '';
  try { const s = solveModel(highs, m); st = s.status; ms = s.ms; same = hashValues(s.values) === base.hashes[0]; } catch (e) { err = String(e).slice(0, 120); }
  log(`wrap=${wrap ?? 'なし'}: 文字数 ${m.stats.chars} 行数 ${m.stats.lines} 最長行 ${m.stats.maxLine}  → ${err || `status=${st} ${f(ms)}ms 折り返し300と同じ解=${same}`}`);
  sizes[String(wrap)] = { chars: m.stats.chars, lines: m.stats.lines, maxLine: m.stats.maxLine, status: st, err, same };
}
{
  const m = buildModel(d.input, { costMode: 'integer', wrap: null });
  log(`整数化・折り返しなし: 文字数 ${m.stats.chars} 最長行 ${m.stats.maxLine}`);
  const rr = buildModel(d.input, { costMode: 'original', wrap: null });
  const lines = rr.lp.split('\n');
  const longest = lines.map((l, i) => [l.length, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([n, i]) => `${lines[i]!.slice(0, 8)}…=${n}字`);
  log('折り返しなしの長い行', longest.join(', '));
}
out.sizes = sizes;

// ---------- 20回: 使い回し / 作り直し ----------
log('\n## 20回続けて解く（K-23）');
async function reuse(mode: CostMode) {
  const m = buildModel(d.input, { costMode: mode, wrap: 300 });
  const h = await loadHighs();
  const mem0 = h.memoryBytes, rss0 = process.memoryUsage().rss;
  const times: number[] = [], hashes: string[] = [];
  for (let k = 0; k < 20; k++) { const s = solveModel(h, m); times.push(s.ms); hashes.push(hashValues(s.values)); }
  return { times, hashes, mem0, mem1: h.memoryBytes, rssDelta: process.memoryUsage().rss - rss0 };
}
const ru = await reuse('original');
log(`使い回し(同じインスタンス): 1回目 ${f(ru.times[0]!)}ms 2〜20回の中央値 ${f(median(ru.times.slice(1)))}ms 最大 ${f(Math.max(...ru.times))}ms  全部同じ解=${new Set(ru.hashes).size === 1}  wasm メモリ ${ru.mem0}→${ru.mem1} B  rss増 ${(ru.rssDelta / 1e6).toFixed(1)}MB`);
out.reuse = { times: ru.times, same: new Set(ru.hashes).size === 1, mem0: ru.mem0, mem1: ru.mem1 };
{
  const m = buildModel(d.input, { costMode: 'original', wrap: 300 });
  const wasm = readFileSync(require.resolve('highs/runtime'));
  const compiled = await WebAssembly.compile(wasm);
  // highs 1.15.4 は InitOptions.wasmModule / wasmBinary を読まない（型にはあるが build/highs.js に実装がない）。
  // compile を 1 回にするには Emscripten の instantiateWasm フックで共有の Module から instantiate する
  const shareOpts = () => ({ instantiateWasm: (imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance) => void) => { WebAssembly.instantiate(compiled, imports).then(receive); return {}; } });
  try {
    await loadHighs({ wasmModule: compiled, locateFile: () => '/nonexistent/highs.wasm' } as any);
    log('wasmModule の確認: 渡した wasmModule が使われた（locateFile は呼ばれなかった）');
  } catch (e) { log(`wasmModule の確認: wasmModule を渡しても locateFile が呼ばれて失敗した → 1.15.4 では wasmModule は無視される (${String(e).slice(0, 80)})`); }
  for (const variant of ['loadHighs() 毎回（毎回 wasm を読んで compile）', 'instantiateWasm で共有（compile は1回）'] as const) {
    const loadT: number[] = [], solveT: number[] = [], hashes: string[] = [];
    const rss0 = process.memoryUsage().rss;
    let ok = true, err = '';
    try {
      for (let k = 0; k < 20; k++) {
        const t0 = performance.now();
        const h = await loadHighs(variant.startsWith('instantiateWasm') ? (shareOpts() as any) : {});
        loadT.push(performance.now() - t0);
        const s = solveModel(h, m); solveT.push(s.ms); hashes.push(hashValues(s.values));
      }
    } catch (e) { ok = false; err = String(e).slice(0, 200); }
    log(`作り直し ${variant}: ${ok ? '20回完走' : '失敗 ' + err}  load中央値 ${f(median(loadT))}ms solve中央値 ${f(median(solveT))}ms  全部同じ解=${new Set(hashes).size === 1}  rss増 ${((process.memoryUsage().rss - rss0) / 1e6).toFixed(1)}MB`);
    out[`recreate_${variant.slice(0, 8)}`] = { ok, loadMedian: median(loadT), solveMedian: median(solveT), same: new Set(hashes).size === 1 };
  }
}
// 読み込み時間（Node）
{
  const t: number[] = [];
  for (let k = 0; k < 5; k++) { const t0 = performance.now(); await loadHighs(); t.push(performance.now() - t0); }
  log(`loadHighs() の時間(Node, 5回): ${t.map(f).join(', ')} 中央値 ${f(median(t))}ms`);
  out.loadNode = { times: t, median: median(t) };
}

// ---------- 解けない入力 ----------
log('\n## 解けない入力の status');
for (const [name, inp] of [['S05（6部屋の机 235 < 241）', makeInfeasibleS05(d)], ['教卓の在庫 5 < 需要 10', makeInfeasibleLectern(d)]] as const) {
  const m = buildModel(inp, { costMode: 'original', wrap: 300 });
  const s = solveModel(highs, m);
  log(`${name}: Status=${JSON.stringify(s.status)} ${f(s.ms)}ms`);
  out[`infeasible_${name.slice(0, 3)}`] = s.status;
}
{ // 変数が1つもない（候補なし）ケース：需要行が作れない
  const inp = makeInfeasibleLectern(d);
  inp.stocks = inp.stocks.filter((s) => s.itemId !== d.itemByCode.get('lectern')!.id);
  const m = buildModel(inp, { costMode: 'original', wrap: 300 });
  const s = solveModel(highs, m);
  const iss = s.status === 'Optimal' ? check(inp, m, toRows(m, s.values)) : [];
  log(`教卓の在庫が全くない（需要の行に変数が1つもない）: 需要行 ${m.demandRows}（正常時は 169）→ Status=${JSON.stringify(s.status)}、独立した検証 ${iss.length} 件（${iss[0] ?? ''}）。変数がない需要の行は作れず、LP は Optimal を返してしまう。LP を作る前に shortages で返すこと`);
}
{ // time_limit
  const m = buildModel(d.input, { costMode: 'original', wrap: 300 });
  const r = highs.solve(m.lp, { ...HIGHS_OPTIONS, time_limit: 0.0001 });
  log(`time_limit=0.0001: Status=${JSON.stringify(r.Status)} （Optimal 以外は解として使わない）`);
  out.timeLimitStatus = r.Status;
  const bad = highs.solve('Minimize\n obj: + x1\nSubject To\n c1: + x1 >= 1\nBounds\n x1 <= 0\nEnd\n', { output_flag: false });
  log(`参考：矛盾する小さな LP: Status=${JSON.stringify(bad.Status)}`);
}

// ---------- 最小変更モード ----------
log('\n## 最小変更モード（x̂・μ）：MER を使用不可にして解き直す');
for (const mode of ['original', 'integer'] as const) {
  const prevRun = runs[mode]!;
  const mer = d.roomByName.get('MER')!;
  const inp2 = { ...d.input, rooms: d.input.rooms.map((r) => (r.id === mer.id ? { ...r, usable: false } : r)) };
  const prevRows = prevRun.rows; // 自動行（keep は固定行なので含まない）
  const usedMer = prevRows.filter((r) => r.sourceRoomId === mer.id);
  const merUnits = usedMer.reduce((a, r) => a + r.count, 0);
  const mMin = buildModel(inp2, { costMode: mode, wrap: 300, previousRows: prevRows.filter((r) => r.sourceRoomId !== mer.id) });
  const mFull = buildModel(inp2, { costMode: mode, wrap: 300 });
  const sMin = solveModel(highs, mMin), sFull = solveModel(highs, mFull);
  if (sMin.status !== 'Optimal' || sFull.status !== 'Optimal') { log(`[${mode}] status min=${sMin.status} full=${sFull.status}`); continue; }
  const rMin = toRows(mMin, sMin.values), rFull = toRows(mFull, sFull.values);
  const dMin = diffRows(prevRows, rMin), dFull = diffRows(prevRows, rFull);
  const issues = check(inp2, mMin, rMin);
  log(`[${mode}] 前回 MER から運んでいた ${usedMer.length} 行 ${merUnits} 台。変数 ${mMin.stats.vars}（うち x̂ ${mMin.stats.hatVars}）  解く ${f(sMin.ms)}ms（x̂ なし ${f(sFull.ms)}ms）  Status=${sMin.status}`);
  log(`   変わった行（運び元・団体・申請品目・品目）: 最小変更 ${dMin.changed} 件 / ${dMin.units} 台（全 ${dMin.total} キー中）。x̂ なしで解き直した場合 ${dFull.changed} 件 / ${dFull.units} 台`);
  log(`   MER 以外が原因の変更（運び元が MER でなく、前回 MER を使っていた団体・品目でもない行） ${(() => {
    const affected = new Set(usedMer.map((r) => `${r.groupId}|${r.requestedItemId}`));
    return dMin.changedKeys.filter((k) => { const [, g, i] = k.split('|'); return !affected.has(`${g}|${i}`) && !k.startsWith(mer.id); }).length;
  })()} 件  独立した検証 ${issues.length === 0 ? '問題なし' : issues.slice(0, 3).join('/')}  整数からのずれ ${sMin.maxFrac}`);
  out[`minchange_${mode}`] = { merRows: usedMer.length, merUnits, changedMin: dMin.changed, unitsMin: dMin.units, changedFull: dFull.changed, unitsFull: dFull.units, ms: sMin.ms, hat: mMin.stats.hatVars };
}

writeFileSync(new URL('./results/node.json', import.meta.url), JSON.stringify(out, null, 1));
log('\n結果を results/node.json に書いた');
