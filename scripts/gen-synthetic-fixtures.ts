// 合成データ fixtures/synthetic/r8like を書く（設計 3.6）。シード 20261029。
// 使い方：pnpm gen:synthetic（書いた結果がコミット済みのファイルと一致することは scripts/gen-synthetic.test.ts が確かめる）
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixturePath, generateSynthetic, SYNTHETIC_SEED, writeFixtureDir } from '@gaapp/shared/testing';

export const SYNTHETIC_DIR = fixturePath('synthetic', 'r8like');

export function main(): void {
  writeFixtureDir(SYNTHETIC_DIR, generateSynthetic(SYNTHETIC_SEED));
  console.log(`wrote ${SYNTHETIC_DIR}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
