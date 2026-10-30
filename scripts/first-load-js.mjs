// ページごとの「最初に読む JS」の量を出す（画面の設計 7.7。T09a が雛形の時点の値を notes/T09a.md に記録し、
// T14 が /stock・/request・/my がその 1.5 倍以内で、ExcelJS・highs のチャンクが入っていないことを確かめる）。
// 使い方：pnpm build の後に node scripts/first-load-js.mjs [書き出したフォルダ（既定 apps/web/out）] [--json]
//   basePath つきの書き出しは NEXT_PUBLIC_BASE_PATH（例 /GAapp）か --base-path /GAapp で、URL の頭を外して読む。
// 数えるもの：各ページの index.html が読む <script src>（noModule の古いブラウザ向けは除く）と
// <link rel="preload" as="script">。大きさは各ファイルを gzip（既定の強さ）にしたものの合計。
// 重い部品の印（目安）：ExcelJS は "xl/workbook.xml"、highs は "Highs_" をチャンクの中に含むかで見分ける。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const json = args.includes('--json');
const bpIndex = args.indexOf('--base-path');
const basePath = (bpIndex >= 0 ? args[bpIndex + 1] : process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
const outDir = args.find((a, i) => !a.startsWith('--') && (bpIndex < 0 || i !== bpIndex + 1)) ?? 'apps/web/out';

if (!existsSync(join(outDir, 'index.html'))) {
  console.error(`${outDir}/index.html がありません。先に pnpm build を実行してください。`);
  process.exit(1);
}

const SKIP_PAGES = new Set(['/404/', '/_not-found/']);
const MARKERS = [
  { name: 'ExcelJS', text: 'xl/workbook.xml' },
  { name: 'highs', text: 'Highs_' },
];

function* htmlPages(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '_next') continue;
      yield* htmlPages(p);
    } else if (name === 'index.html') yield p;
  }
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];

function scriptUrls(html) {
  const urls = new Set();
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = attr(tag, 'src');
    // data: の script（JS より先に Supabase へ送る小さな script。D-45）は HTML の中にあり、ファイルを読まないので数えない
    if (src && !src.startsWith('data:') && !/\snomodule(=|\s|>)/i.test(tag)) urls.add(src);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (attr(tag, 'rel') === 'preload' && attr(tag, 'as') === 'script') {
      const href = attr(tag, 'href');
      if (href) urls.add(href);
    }
  }
  return [...urls];
}

const cache = new Map();
function chunk(url) {
  if (cache.has(url)) return cache.get(url);
  let p = url.split(/[?#]/)[0];
  if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  if (basePath && p.startsWith(`${basePath}/`)) p = p.slice(basePath.length);
  const file = join(outDir, decodeURIComponent(p));
  if (!existsSync(file)) {
    console.error(`${url} のファイル（${file}）がありません。basePath つきの書き出しなら --base-path を渡してください。`);
    process.exit(1);
  }
  const buf = readFileSync(file);
  const text = buf.toString('utf8');
  const info = {
    raw: buf.length,
    gzip: gzipSync(buf).length,
    markers: MARKERS.filter((m) => text.includes(m.text)).map((m) => m.name),
  };
  cache.set(url, info);
  return info;
}

const rows = [];
for (const file of htmlPages(outDir)) {
  const dir = relative(outDir, file).split(sep).slice(0, -1).join('/');
  const page = dir ? `/${dir}/` : '/';
  if (SKIP_PAGES.has(page)) continue;
  const urls = scriptUrls(readFileSync(file, 'utf8'));
  const infos = urls.map(chunk);
  rows.push({
    page,
    scripts: urls.length,
    rawBytes: infos.reduce((s, x) => s + x.raw, 0),
    gzipBytes: infos.reduce((s, x) => s + x.gzip, 0),
    heavy: [...new Set(infos.flatMap((x) => x.markers))],
  });
}
rows.sort((a, b) => a.page.localeCompare(b.page));

if (json) {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else {
  const kb = (n) => (n / 1024).toFixed(1);
  const lines = [
    '| ページ | script の数 | 合計（KB） | gzip の合計（KB） | 重い部品 |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows.map((r) => `| ${r.page} | ${r.scripts} | ${kb(r.rawBytes)} | ${kb(r.gzipBytes)} | ${r.heavy.join('・') || '—'} |`),
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
