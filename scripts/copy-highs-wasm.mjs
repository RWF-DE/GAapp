// highs の wasm を apps/web/public/highs.wasm にコピーする（静的ファイルとして公開し、Worker が locateFile で読む）。
// apps/web の predev・prebuild から呼ぶ（pnpm は apps/web をカレントにして流すので、場所は import.meta.url から決める）。
// highs の package.json は exports に "./runtime"（build/highs.wasm）を出しているので、それを require.resolve で引く。
// `highs/package.json` は exports にないので引けない（ERR_PACKAGE_PATH_NOT_EXPORTED。画面の設計 4.1）。
// コピーした highs.wasm は git に入れない（.gitignore）。
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(repoRoot, 'apps', 'web');
const require = createRequire(join(webDir, 'package.json'));

const src = require.resolve('highs/runtime');
const dest = join(webDir, 'public', 'highs.wasm');

const same = existsSync(dest) && readFileSync(dest).equals(readFileSync(src));
if (!same) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
process.stdout.write(
  `highs.wasm: ${relative(repoRoot, src)} → ${relative(repoRoot, dest)}${same ? '（同じなのでそのまま）' : ''}\n`,
);
