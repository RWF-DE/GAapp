// スクリーンショット（画面の設計 7.4。T09a）。`notes/<チケット>/<name>.png` に保存する。
// 各チケットは e2e/shots/<チケット>.shots.ts を書き、`pnpm e2e:shots --grep <チケット>` で撮る（CI では流さない）。
// テストの名前はチケット ID で始める（--grep はテストの名前で絞るため）。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const PC = { width: 1280, height: 800 } as const;
export const MOBILE = { width: 390, height: 844 } as const;

const NOTES_DIR = fileURLToPath(new URL('../../notes/', import.meta.url));

/**
 * 今のページを notes/<ticket>/<name>.png に保存する（fullPage は既定で偽）。
 *
 * @example
 * await page.setViewportSize(MOBILE);
 * await shoot(page, 'T10', 'stock-mobile');
 */
export async function shoot(page: Page, ticket: string, name: string, opts: { fullPage?: boolean } = {}): Promise<string> {
  if (!/^T\d+[a-z]?$/.test(ticket)) throw new Error(`チケット ID の形ではありません：${ticket}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`ファイル名は英小文字・数字・- にしてください：${name}`);
  const dir = path.join(NOTES_DIR, ticket);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  // 点滅するカーソル・アニメーションで絵が揺れないようにする
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false, animations: 'disabled', caret: 'hide' });
  return file;
}
