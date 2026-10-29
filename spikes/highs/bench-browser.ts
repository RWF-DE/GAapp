// Playwright の Chromium で、vite build した dist を GitHub Pages と同じ /GAapp/ の下で配信して測る。
// 実行：npm run build && npm run bench:browser
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { startServer } from './src/serve.ts';

const PORT = 5199;
const BASE = '/GAapp/'; // GitHub Pages のプロジェクトサイト（組織名.github.io/リポジトリ名/）を模す
const DIST = new URL('./dist/', import.meta.url).pathname;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const f = (x: number) => x.toFixed(1);

const { server, reqLog } = await startServer(DIST, BASE, PORT);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
console.log('chromium', browser.version());
const out: Record<string, any> = { chromium: browser.version() };

async function runPage(query: string, throttle?: { down: number; up: number; latency: number }, timeout = 120_000) {
  const ctx = await browser.newContext(); // 毎回まっさらな context = HTTP キャッシュなし
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: throttle.down, uploadThroughput: throttle.up, latency: throttle.latency });
  }
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}${BASE}${query}`);
  let result: any;
  try {
    await page.waitForFunction(() => (window as any).__result != null, null, { timeout });
    result = await page.evaluate(() => (window as any).__result);
  } catch (e) {
    result = { error: `timeout (${timeout}ms): ページから結果が返らない。console: ${errs.join(' | ').slice(0, 300)}` };
  }
  const wall = Date.now() - t0;
  await ctx.close();
  return { result, wall, errs };
}

// ---- 1. wasm の読み込み方の確認（locateFile あり / なし / basePath 無視）----
console.log('\n## wasm の読み込み方');
out.locate = {};
for (const locate of ['base', 'none', 'root']) {
  reqLog.length = 0;
  const { result, errs } = await runPage(`?locate=${locate}&full=0`, undefined, 30_000);
  const wasmReqs = reqLog.filter((r) => r.url.endsWith('.wasm'));
  const ok = !result.error;
  console.log(`locate=${locate}: ${ok ? `成功 loadCold=${f(result.loadColdMs)}ms wasm=${result.wasmUrl}` : `失敗 ${result.error.split('\n')[0]!.slice(0, 200)}`}`);
  console.log(`   wasm へのリクエスト: ${JSON.stringify(wasmReqs)}`);
  out.locate[locate] = { ok, error: result.error?.split('\n')[0], wasmReqs, wasmUrl: result.wasmUrl, errs: errs.slice(0, 2) };
}

// ---- 2. 本測定：まっさらな context で5回開き、毎回 読み込み1回＋解く5回 ----
console.log('\n## 本測定（5回開く。毎回キャッシュなし。localhost、gzip 配信）');
const pages: any[] = [];
for (let k = 0; k < 5; k++) { reqLog.length = 0; const r = await runPage('?full=' + (k === 0 ? '1' : '0')); if (r.result.error) throw new Error(r.result.error); pages.push({ ...r.result, wall: r.wall }); }
const p0 = pages[0];
console.log(`UA ${p0.userAgent}`);
console.log(`highs ${p0.highsVersion}`);
console.log(`変数 ${p0.stats.original.vars}、制約 ${p0.stats.original.rows}、LP ${p0.stats.original.chars} 文字、LP 作成(buildModel) ${f(p0.buildMs)}ms`);
const loadCold = pages.map((p) => p.loadColdMs);
console.log(`wasm 読み込み(初回 = fetch+compile+instantiate、5ページ): ${loadCold.map(f).join(', ')}  中央値 ${f(median(loadCold))}ms`);
console.log(`  内訳(ページ1): fetch ${f(p0.split.fetchMs)}ms（2回目の取得なのでキャッシュ込み）, compile ${f(p0.split.compileMs)}ms, instantiate ${f(p0.split.instantiateMs)}ms  (${p0.split.bytes} B)`);
console.log(`  転送量(ページ1): ${JSON.stringify(p0.wasmResource.map((e: any) => ({ transferSize: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize })))}`);
console.log(`  読み込み直し(キャッシュ後、ページ1の5回): ${p0.loadWarmMs.map(f).join(', ')} 中央値 ${f(p0.loadWarmMedian)}ms`);
for (const mode of ['original', 'integer']) {
  const med = pages.map((p) => p[mode].median);
  const first = pages.map((p) => p[mode].times[0]);
  const all = pages.flatMap((p) => p[mode].times);
  console.log(`[${mode}] 解く: ページ1の5回 ${p0[mode].times.map(f).join(', ')} → 中央値 ${f(p0[mode].median)}ms。5ページの5回中央値の中央値 ${f(median(med))}ms、全25回の中央値 ${f(median(all))}ms、1回目だけ(5ページ)の中央値 ${f(median(first))}ms`);
  console.log(`   status=${p0[mode].status} 整数のずれ max=${Math.max(...pages.map((p) => p[mode].maxFrac))} 5回とも同じ解=${pages.every((p) => p[mode].sameAll)} 独立検証の問題=${p0[mode].issues}件 W107=${p0[mode].w107}`);
}
console.log(`並べ替えても同じ解: ${pages.every((p) => p.shuffledSame)}  解けない入力の Status: ${p0.infeasibleStatus}`);
console.log(`20回: 使い回し 1回目 ${f(p0.reuse.first)}ms 2〜20回の中央値 ${f(p0.reuse.medianRest)}ms 同じ解=${p0.reuse.sameAll} wasmメモリ ${p0.reuse.mem0}→${p0.reuse.mem1}`);
console.log(`20回: 毎回作り直し(instantiateWasm で Module 共有) load 中央値 ${f(p0.recreate.loadMedian)}ms(最大 ${f(p0.recreate.loadMax)}) solve 中央値 ${f(p0.recreate.solveMedian)}ms 同じ解=${p0.recreate.sameAll}`);
// Node の解と同じか
const nodeJson = JSON.parse(readFileSync(new URL('./results/node.json', import.meta.url), 'utf8'));
console.log(`Node の解のハッシュと同じ: original=${nodeJson.five_original.hashes[0] === p0.original.hashes[0]}、integer=${nodeJson.five_integer.hashes[0] === p0.integer.hashes[0]}`);
out.pages = pages.map((p) => ({ loadColdMs: p.loadColdMs, wall: p.wall, original: p.original, integer: p.integer, shuffledSame: p.shuffledSame }));
out.page0 = p0;

// ---- 3. 回線を絞った場合の読み込み（wasm 1.2MB gzip）----
console.log('\n## 回線を絞った場合の wasm 読み込み（CDP の Network.emulateNetworkConditions。キャッシュなし）');
out.throttle = {};
for (const [name, t] of [['Fast 4G 相当 9Mbps/170ms', { down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8, latency: 170 }], ['Slow 4G 相当 1.6Mbps/150ms', { down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, latency: 150 }]] as const) {
  const r = await runPage('?full=0', t);
  console.log(`${name}: wasm 読み込み(初回) ${f(r.result.loadColdMs)}ms、ページを開いてから結果が出るまで ${r.wall}ms`);
  out.throttle[name] = { loadColdMs: r.result.loadColdMs, wall: r.wall };
}

await browser.close();
server.close();
writeFileSync(new URL('./results/browser.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('\n結果を results/browser.json に書いた');
