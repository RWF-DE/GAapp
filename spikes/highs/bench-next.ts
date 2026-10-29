// Next.js の静的書き出し（output: 'export'、basePath: /GAapp）で wasm をどう読み込めるかを確かめる。
// 実行：(cd next-export && npm run build) && npm run bench:next
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startServer } from './src/serve.ts';

const PORT = 5199, BASE = '/GAapp/';
const { server, reqLog } = await startServer(new URL('./next-export/out/', import.meta.url).pathname, BASE, PORT);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const out: Record<string, unknown> = {};
for (const locate of ['base', 'none', 'root']) {
  reqLog.length = 0;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
  await page.goto(`http://localhost:${PORT}${BASE}?locate=${locate}`);
  let result: any;
  try {
    await page.waitForFunction(() => (window as any).__result != null, null, { timeout: 20_000 });
    result = await page.evaluate(() => (window as any).__result);
  } catch { result = { error: `timeout: ${errs.join('|')}` }; }
  const wasm = reqLog.filter((r) => r.url.endsWith('.wasm'));
  console.log(`locate=${locate}: ${result.error ? '失敗 ' + result.error : `成功 status=${result.status} objective=${result.objective} x=${JSON.stringify(result.x)} load=${result.loadMs.toFixed(0)}ms`}`);
  console.log(`   wasm リクエスト: ${JSON.stringify(wasm)}`);
  out[locate] = { result, wasm };
  await ctx.close();
}
await browser.close(); server.close();
writeFileSync(new URL('./results/next.json', import.meta.url), JSON.stringify(out, null, 1));
