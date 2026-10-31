// 4G での表示の速さ（00「性能と可用性」の「画面はスマホの 4G でも 2 秒以内に開く」。画面の設計 7.7。T14）。
// pnpm e2e:perf（E2E_PERF=1。CI では流さない。機械の速さで結果がぶれるため）。pnpm build:e2e の書き出し（apps/web/out）を使う。
// スマホで使う画面（/stock?room=…・/request・/my と、T16 で足した団体代表の /〔ダッシュボード。代表する団体のカードが出るまで〕）を、
// Chromium の CDP で回線を Fast 4G 相当（下り 9 Mbps・上り 1.5 Mbps・
// 遅延 170 ms。T00 と同じ）に絞り、CPU を 4 倍遅くして、キャッシュなしの新しいコンテキスト（storageState でログイン済み）で
// page.goto から画面の主な内容が見えるまでを3回ずつ計る。中央値と内訳を annotations・console・test-results/perf/perf.json に出し、
// notes/T14.md に写す。2 秒を超えても失敗にはしない（記録して原因を調べる。設計 7.7）。
//
// 配り方は2つ計る：
// - http1：E2E と同じ静的サーバー（serve。HTTP/1.1）。ブラウザは1つのホストに6本までしかつながないので、20 本ほどのチャンクが
//   列に並ぶ（本番より遅く出る）。
// - h2：この spec が立てる HTTP/2 の静的サーバー（TLS の自己署名。gzip）。本番の GitHub Pages と同じく1本の接続で多重化する。
//   ポートは E2E_PERF_H2_PORT（既定 3102）。openssl がなければ飛ばす。
// どちらも Supabase（ローカル。HTTP/1.1）への往復は同じ。本番の DNS・TCP・TLS の初回の往復はどちらにも入っていない。
// PERF_CPU_RATE で CPU の倍率を変えられる（原因を分けるとき。記録は既定の 4 倍で取る）。
// PERF_TRACE=1 で Supabase へのリクエストの並び（失敗したリクエストも）、PERF_TRACE=all で静的ファイルも並べて出す（1回目）。
// PERF_DEBUG=1 でページの console も並べる。
// 開き方は2つ計る（D-45）：
// - first：初めて開いた（先読みのために覚えた id〔localStorage の gaapp:prefetch:<user_id>〕がない）。
// - again：前に開いたことがある（同じ画面を一度開いて覚えた id とリクエストを、計る前のコンテキストの localStorage に入れる。
//   HTTP のキャッシュは使わない）。<head> の script が JS より先に Supabase へ送り、立場の読み込みと同時に画面のデータも読む。
// / は T16 で先読み・記録・先送りの表に入れた（D-45・D-51）ので、again では / も覚えたリクエストを <head> の script が先に送る。
// PERF_VISIT=first・again で片方だけ、PERF_ONLY=stock・request・my・home（カンマ区切り）で画面を絞れる（原因を調べるとき）。
// データはシナリオの年度（合成データ r8like。受付中。部員と団体代表〔模擬店10〕のロール）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import { createScenario, type Scenario } from './support/db';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

const RUNS = 3;
const LIMIT_MS = 2000;
/** Fast 4G 相当（T00 と同じ）。throughput は bytes/秒 */
const FAST_4G = { offline: false, latency: 170, downloadThroughput: (9 * 1000 * 1000) / 8, uploadThroughput: (1.5 * 1000 * 1000) / 8 };
/** CPU を遅くする倍率（既定 4。原因を分けるときだけ PERF_CPU_RATE=1 などで変える） */
const CPU_RATE = Number(process.env.PERF_CPU_RATE ?? 4);
const REP_GROUP = '模擬店10';
const ROOM = '1-1';
const OUT_DIR = fileURLToPath(new URL('../apps/web/out/', import.meta.url));
const H2_PORT = Number(process.env.E2E_PERF_H2_PORT ?? 3102);

interface Target {
  /** PERF_ONLY で選ぶ名前 */
  id: 'stock' | 'request' | 'my' | 'home';
  name: string;
  user: StoredUser;
  /**
   * 開いたときのリクエストを覚える画面か（先読みの表〔lib/data/screen-queries.ts の EARLY_FETCH_PATHS〕にある画面）。
   * 偽なら again の準備で、覚えたリクエスト（`…:requests`）を待たない（今はどの対象も表にある。/ は T16 で入れた）
   */
  records: boolean;
  url: (s: Scenario) => string;
  /** 画面の主な内容が見えた（読み込みが終わった）ことの印（Playwright で確かめる） */
  ready: (page: Page) => Promise<void>;
  /**
   * 同じ印をページの中で確かめる関数（引数は REP_GROUP・ROOM）。毎フレーム（requestAnimationFrame）調べて、最初に真になった
   * performance.now()（ナビゲーションの始まりから）を表示までの時間にする（D-45。expect の再試行の間隔〔100・250・500・1000 ms〕で
   * 測ると、見えてから気づくまでに最大 0.5 秒ほど遅れて出るため）。
   */
  shown: string;
}

/** ページの中の DOM を調べる関数の文字列（ルートの tsconfig は DOM の型を持たないので、文字列で渡す） */
const SHOWN = {
  stock: `(a) => {
    const name = document.querySelector('[data-testid="stock-room-name"]');
    const input = document.querySelector('input[aria-label="机(木)の数"]');
    return !!name && name.textContent.trim() === a.room && !!input && /^\\d+$/.test(input.value);
  }`,
  request: `(a) => {
    const name = document.querySelector('[data-testid="request-group-name"]');
    const button = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('提出') && b.offsetParent !== null);
    return !!name && name.textContent.trim() === a.group && button;
  }`,
  my: `(a) => {
    const g = document.querySelector('[data-testid="my-group"]');
    const p = document.querySelector('[data-testid="my-in-progress"]');
    return !!g && g.textContent.includes(a.group) && !!p && p.textContent.includes('振り分け作業中');
  }`,
  home: `(a) => {
    const card = [...document.querySelectorAll('[data-testid="rep-card"]')].find((c) => c.getAttribute('data-group') === a.group);
    return !!card && card.offsetParent !== null;
  }`,
};

const ALL_TARGETS: Target[] = [
  {
    id: 'stock',
    name: '/stock?room=（部員）',
    user: 'staff',
    records: true,
    url: (s) => `/stock/?room=${s.ids.rooms[ROOM]}`,
    ready: async (page) => {
      await expect(page.getByTestId('stock-room-name')).toHaveText(ROOM, { timeout: 30_000 });
      await expect(page.getByRole('textbox', { name: '机(木)の数' })).toHaveValue(/^\d+$/, { timeout: 30_000 });
    },
    shown: SHOWN.stock,
  },
  {
    id: 'request',
    name: '/request（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/request/',
    ready: async (page) => {
      await expect(page.getByTestId('request-group-name')).toHaveText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: /提出/ }).first()).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.request,
  },
  {
    id: 'my',
    name: '/my（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/my/',
    ready: async (page) => {
      await expect(page.getByTestId('my-group')).toContainText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByTestId('my-in-progress')).toContainText('振り分け作業中', { timeout: 30_000 });
    },
    shown: SHOWN.my,
  },
  // ダッシュボード（T16。D-51）：団体代表の /。表示の印は代表する団体のカード（模擬店10）が見えたこと。先読み・先送りの表にある（D-45）
  {
    id: 'home',
    name: '/（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/',
    ready: async (page) => {
      await expect(page.locator(`[data-testid="rep-card"][data-group="${REP_GROUP}"]`)).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.home,
  },
];

/** 先読みのために覚えた id の localStorage のキー（apps/web/lib/boot/early-load.ts の PREFETCH_HINT_PREFIX と同じ） */
const PREFETCH_HINT_PREFIX = 'gaapp:prefetch:';
type Visit = 'first' | 'again';
const VISITS: Visit[] = process.env.PERF_VISIT === 'first' || process.env.PERF_VISIT === 'again' ? [process.env.PERF_VISIT] : ['first', 'again'];

const ONLY = (process.env.PERF_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const TARGETS = ONLY.length > 0 ? ALL_TARGETS.filter((t) => ONLY.includes(t.id)) : ALL_TARGETS;

interface Run {
  /** ナビゲーションの始まりから、画面の主な内容が見えた最初のフレームまで（ms。ページの中の performance.now()） */
  ms: number;
  /** 前の測り方（page.goto の前から Playwright の expect が通るまで。再試行の間隔のぶん遅く出る。比べるために残す） */
  expectMs: number;
  /** ナビゲーションの DOMContentLoaded（ms） */
  dcl: number;
  /** 同じ origin の script の数と転送量（KB。圧縮後） */
  scripts: number;
  scriptKB: number;
  /** 最後の script の応答が終わった時刻（goto からの ms） */
  lastScriptMs: number;
  /** Supabase へのリクエストの数（auth・rest。CORS の preflight を除く） */
  supabase: number;
  /** リクエストの始まりと終わり（goto からの ms。1回目だけ perf.json に残す。何が直列に待っているかを見るため） */
  waterfall: string[];
}

// ---------------------------------------------------------------- HTTP/2 の静的サーバー（h2 の配り方）

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

/** 自己署名の証明書（localhost）。openssl がなければ null */
function selfSignedCert(dir: string): { key: Buffer; cert: Buffer } | null {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
      { stdio: 'ignore' },
    );
  } catch {
    return null;
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** apps/web/out を HTTP/2 で配る（末尾の / は index.html。テキストは gzip。GitHub Pages に近い形） */
async function startH2(tls: { key: Buffer; cert: Buffer }): Promise<{ origin: string; close: () => Promise<void> }> {
  const gz = new Map<string, Buffer>();
  const server = http2.createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'https://localhost').pathname);
    let file = path.join(OUT_DIR, pathname);
    if (!file.startsWith(OUT_DIR)) {
      res.writeHead(400).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    let status = 200;
    if (!existsSync(file)) {
      status = 404;
      file = path.join(OUT_DIR, '404.html');
    }
    const ext = path.extname(file);
    const type = TYPES[ext] ?? 'application/octet-stream';
    let body: Buffer = readFileSync(file);
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' };
    if (/^(text|application\/(json|manifest))/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      if (!gz.has(file)) gz.set(file, gzipSync(body));
      body = gz.get(file)!;
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(status, headers).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(H2_PORT, 'localhost', resolve);
  });
  return { origin: `https://localhost:${H2_PORT}`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * storageState（ログインのセッション）。先読みのために覚えた id は外す（ログインの準備で画面を開いたときに覚えたもの。
 * 計る開き方は first・again で決める）。origin を渡すと localStorage をその origin（h2 のサーバー）に移す
 * （Supabase のセッションは origin ごとの localStorage にある）。
 */
function storageStateAt(user: StoredUser, origin: string | null) {
  const state = JSON.parse(readFileSync(storageStateFor(user), 'utf8')) as {
    cookies: unknown[];
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  return {
    cookies: origin ? [] : state.cookies,
    origins: state.origins.map((o) => ({
      ...o,
      origin: origin ?? o.origin,
      localStorage: o.localStorage.filter((e) => !e.name.startsWith(PREFETCH_HINT_PREFIX)),
    })),
  };
}

// ---------------------------------------------------------------- 測る

function contextOptions(t: Target, origin: string | null) {
  return {
    storageState: storageStateAt(t.user, origin) as never,
    viewport: MOBILE,
    isMobile: true,
    hasTouch: true,
    ...(origin ? { baseURL: origin, ignoreHTTPSErrors: true } : {}),
  };
}

/** 一度（絞らずに）開いて、アプリが覚えた先読みの id（localStorage）を取り出す */
async function learnHints(browser: Browser, s: Scenario, t: Target, origin: string | null): Promise<[string, string][]> {
  const context = await browser.newContext(contextOptions(t, origin));
  try {
    const page = await context.newPage();
    await pinYear(page, SEED_USER_IDS[t.user], s.yearId);
    await page.goto(t.url(s), { waitUntil: 'commit' });
    await t.ready(page);
    // 開いたときのリクエスト（<head> の script が先に送るもの）は、立場が届いてから少し後に覚える。覚えない画面（records が偽）は、
    // 先読みの id（`gaapp:prefetch:<user_id>`）だけを待つ
    await page.waitForFunction(
      ({ prefix, records }) => {
        const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k?.startsWith(prefix) && (!records || k.endsWith(':requests'))) return true;
        }
        return false;
      },
      { prefix: PREFETCH_HINT_PREFIX, records: t.records },
      { timeout: 15_000 },
    );
    const hints = await page.evaluate((prefix) => {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      const out: [string, string][] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(prefix)) out.push([k, ls.getItem(k) ?? '']);
      }
      return out;
    }, PREFETCH_HINT_PREFIX);
    expect(hints.length, '開いた後に先読みの id を覚えている').toBeGreaterThan(0);
    return hints;
  } finally {
    await context.close();
  }
}

async function measure(browser: Browser, s: Scenario, t: Target, origin: string | null, hints: [string, string][] = []): Promise<Run> {
  const context = await browser.newContext(contextOptions(t, origin));
  try {
    const page = await context.newPage();
    await pinYear(page, SEED_USER_IDS[t.user], s.yearId);
    if (hints.length > 0) {
      await page.addInitScript((entries) => {
        const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
        for (const [k, v] of entries) ls.setItem(k, v);
      }, hints);
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', FAST_4G);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    let supabase = 0;
    let start = 0;
    let lastScriptMs = 0;
    const waterfall: { at: number; line: string }[] = [];
    const isSupabase = (url: string) => /\/(rest|auth)\/v1\//.test(url);
    const traceAll = process.env.PERF_TRACE === 'all';
    page.on('request', (r) => {
      if (isSupabase(r.url())) supabase++;
    });
    page.on('requestfinished', (r) => {
      const t = r.timing();
      const begin = Math.round(t.startTime - start);
      const end = Math.round(t.startTime + t.responseEnd - start);
      if (r.resourceType() === 'script') lastScriptMs = Math.max(lastScriptMs, end);
      if (!isSupabase(r.url()) && !traceAll) return;
      const u = new URL(r.url());
      waterfall.push({ at: begin, line: `${begin}〜${end} ${r.method()} ${u.pathname.replace(/^\/(rest|auth)\/v1\//, '')}${traceAll ? u.search.slice(0, 60) : ''}` });
    });
    page.on('requestfailed', (r) => {
      if (!isSupabase(r.url())) return;
      const at = Date.now() - start;
      waterfall.push({ at, line: `${at}〜 失敗（${r.failure()?.errorText ?? '?'}） ${r.method()} ${new URL(r.url()).pathname.replace(/^\/(rest|auth)\/v1\//, '')}` });
    });
    if (process.env.PERF_DEBUG) page.on('console', (m) => waterfall.push({ at: Date.now() - start, line: `console ${m.text()}` }));
    // 印が真になった最初のフレームの時刻を、ページの中で記録する（読み込みの前から毎フレーム調べる）
    await page.addInitScript(
      ([fn, arg]) => {
        const g = globalThis as unknown as { __perfShownAt?: number; requestAnimationFrame(cb: () => void): void; performance: { now(): number } };
        const check = (0, eval)(fn) as (a: unknown) => boolean;
        const tick = () => {
          try {
            if (check(arg)) {
              g.__perfShownAt = g.performance.now();
              return;
            }
          } catch {
            // まだ DOM がない
          }
          g.requestAnimationFrame(tick);
        };
        g.requestAnimationFrame(tick);
      },
      [t.shown, { room: ROOM, group: REP_GROUP }] as const,
    );
    start = Date.now();
    await page.goto(t.url(s), { waitUntil: 'commit' });
    await t.ready(page);
    const expectMs = Date.now() - start;
    await page.waitForFunction(() => typeof (globalThis as unknown as { __perfShownAt?: number }).__perfShownAt === 'number', null, { timeout: 30_000 });
    const ms = Math.round(await page.evaluate(() => (globalThis as unknown as { __perfShownAt: number }).__perfShownAt));
    // ルートの tsconfig は DOM の型を持たないので、使う形だけを書く
    const nav = await page.evaluate(() => {
      type Entry = { name: string; initiatorType?: string; transferSize?: number; domContentLoadedEventEnd?: number };
      const g = globalThis as unknown as { performance: { getEntriesByType(t: string): Entry[] }; location: { origin: string } };
      const n = g.performance.getEntriesByType('navigation')[0];
      const scripts = g.performance
        .getEntriesByType('resource')
        .filter((e) => e.initiatorType === 'script' && new URL(e.name).origin === g.location.origin);
      return { dcl: n?.domContentLoadedEventEnd ?? 0, scripts: scripts.length, scriptBytes: scripts.reduce((sum, e) => sum + (e.transferSize ?? 0), 0) };
    });
    return {
      ms,
      expectMs,
      dcl: Math.round(nav.dcl),
      scripts: nav.scripts,
      scriptKB: Math.round((nav.scriptBytes / 1024) * 10) / 10,
      lastScriptMs,
      supabase,
      waterfall: waterfall.sort((a, b) => a.at - b.at).map((w) => w.line),
    };
  } finally {
    await context.close();
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('T14 4G での表示の速さ：/stock?room=・/request・/my・団体代表の /（T16）を Fast 4G と CPU 4 倍で3回ずつ', async ({ browser }, testInfo) => {
  test.setTimeout(15 * 60_000);
  const tls = selfSignedCert(path.join(testInfo.outputDir, 'tls'));
  if (!tls) testInfo.annotations.push({ type: '4G の速さ', description: 'openssl がないので h2（HTTP/2）の配り方を飛ばした' });
  const h2 = tls ? await startH2(tls) : null;
  const s = await createScenario({ dataset: 'synthetic', status: 'requesting', roles: { staff: true }, repGroup: REP_GROUP });
  const results: { server: string; visit: Visit; page: string; runs: Run[]; medianMs: number }[] = [];
  try {
    const servers: { name: string; origin: string | null }[] = [{ name: 'http1', origin: null }, ...(h2 ? [{ name: 'h2', origin: h2.origin }] : [])];
    for (const server of servers) {
      for (const visit of VISITS) {
        for (const t of TARGETS) {
          const hints = visit === 'again' ? await learnHints(browser, s, t, server.origin) : [];
          const runs: Run[] = [];
          for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, s, t, server.origin, hints));
          const medianMs = median(runs.map((r) => r.ms));
          const label = `${server.name}・${visit}`;
          results.push({ server: server.name, visit, page: t.name, runs: runs.map((r, i) => (i === 0 ? r : { ...r, waterfall: [] })), medianMs });
          if (process.env.PERF_TRACE) console.log(`[${label}] ${t.name} の1回目：\n  ${runs[0]!.waterfall.join('\n  ')}`);
          const r0 = runs[0]!;
          const line =
            `[${label}] ${t.name}：中央値 ${medianMs} ms（${runs.map((r) => r.ms).join('・')} ms。前の測り方〔expect〕の中央値 ${median(runs.map((r) => r.expectMs))} ms、` +
            `DOMContentLoaded ${runs.map((r) => r.dcl).join('・')} ms、最後の script ${runs.map((r) => r.lastScriptMs).join('・')} ms、` +
            `script ${r0.scripts} 本 ${r0.scriptKB} KB、Supabase ${runs.map((r) => r.supabase).join('・')} 回）${medianMs > LIMIT_MS ? ' ※2 秒を超えた' : ''}`;
          testInfo.annotations.push({ type: '4G の速さ', description: line });
          console.log(line);
        }
      }
    }
  } finally {
    await s.cleanup();
    await h2?.close();
  }
  const out = path.join(testInfo.project.outputDir, 'perf.json');
  mkdirSync(path.dirname(out), { recursive: true });
  const body = JSON.stringify({ at: new Date().toISOString(), network: FAST_4G, cpuRate: CPU_RATE, results }, null, 2);
  writeFileSync(out, body);
  await testInfo.attach('perf.json', { body, contentType: 'application/json' });
  expect(results.length).toBeGreaterThanOrEqual(TARGETS.length * VISITS.length);
});
