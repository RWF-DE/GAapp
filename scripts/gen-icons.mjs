#!/usr/bin/env node
// PWA のアイコン（D-38。T14。T16 で総務アプリの絵〔クリップボードとチェックの印〕に描き直した。D-51）を作る：
// apps/web/app/icon.png（512×512）と apps/web/app/apple-icon.png（180×180）。
// 依存を足さないため、下の SVG を Playwright の Chromium で開いて PNG に撮る（文字は使わない。フォントの有無で絵が変わらないように）。
// 使い方：node scripts/gen-icons.mjs（アイコンの絵を変えたときだけ。できた PNG はコミットする）
//   Chromium がなければ先に pnpm exec playwright install chromium。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/web/app');

/**
 * 総務アプリ（D-51。T16）のアイコン：クリップボード（白い板と上の留め具）と、チェックの印と線を3段。文字は使わない。
 * 512 の座標で描く。背景は theme_color と同じ #1d4ed8、絵は白（板の上の印と線は背景と同じ青）。
 * rounded は角を丸める（ブラウザのタブ・Android 向け）。
 */
function svg({ rounded }) {
  const bg = '#1d4ed8';
  const fg = '#ffffff';
  const clip = '#bfdbfe';
  // チェックの印（左）と線（右）を3段。cy は段の中心
  const rows = [208, 288, 368]
    .map(
      (cy) => `
    <polyline points="166,${cy} 186,${cy + 20} 222,${cy - 18}" fill="none" stroke="${bg}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="244" y="${cy - 9}" width="100" height="18" rx="9" fill="${bg}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 96 : 0}" fill="${bg}"/>
  <!-- 板 -->
  <rect x="128" y="96" width="256" height="344" rx="32" fill="${fg}"/>
  <!-- 留め具（板の上にかぶせる。真ん中に穴） -->
  <rect x="192" y="68" width="128" height="68" rx="20" fill="${clip}" stroke="${bg}" stroke-width="8"/>
  <circle cx="256" cy="94" r="11" fill="${bg}"/>
  <!-- チェックの印と線 -->${rows}
</svg>`;
}

const TARGETS = [
  { file: 'icon.png', size: 512, rounded: true },
  // iOS はホーム画面で自分で角を丸め、透明な所を黒にするので、角を丸めずに塗りつぶす
  { file: 'apple-icon.png', size: 180, rounded: false },
];

mkdirSync(APP, { recursive: true });
const browser = await chromium.launch();
try {
  for (const t of TARGETS) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${t.size}px;height:${t.size}px}</style></head><body>${svg(t)}</body></html>`;
    await page.setContent(html);
    await page.screenshot({ path: path.join(APP, t.file), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
    await page.close();
    console.log(`apps/web/app/${t.file}（${t.size}×${t.size}）を作りました`);
  }
} finally {
  await browser.close();
}
