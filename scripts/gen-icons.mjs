#!/usr/bin/env node
// PWA のアイコン（D-38。T14）を作る：apps/web/app/icon.png（512×512）と apps/web/app/apple-icon.png（180×180）。
// 依存を足さないため、下の SVG を Playwright の Chromium で開いて PNG に撮る（文字は使わない。フォントの有無で絵が変わらないように）。
// 使い方：node scripts/gen-icons.mjs（アイコンの絵を変えたときだけ。できた PNG はコミットする）
//   Chromium がなければ先に pnpm exec playwright install chromium。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/web/app');

/** 机（天板と脚）と椅子（背もたれ・座面・脚）。512 の座標で描く。rounded は角を丸める（ブラウザのタブ・Android 向け） */
function svg({ rounded }) {
  const bg = '#1d4ed8';
  const fg = '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 96 : 0}" fill="${bg}"/>
  <g fill="${fg}">
    <!-- 机 -->
    <rect x="72" y="214" width="240" height="30" rx="8"/>
    <rect x="92" y="244" width="24" height="148" rx="6"/>
    <rect x="268" y="244" width="24" height="148" rx="6"/>
    <rect x="92" y="300" width="200" height="16" rx="6" opacity="0.55"/>
    <!-- 椅子 -->
    <rect x="404" y="148" width="26" height="244" rx="8"/>
    <rect x="336" y="272" width="94" height="26" rx="8"/>
    <rect x="340" y="298" width="22" height="94" rx="6"/>
  </g>
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
