// R8 の元データ（環境変数 R8_SOURCE_DIR のフォルダ。リポジトリの外の非公開フォルダ）から、
// fixtures/r8 の生成ファイル（groups・stocks・requests・consents・reference/）を作る（設計 3.8）。
// 手で書くファイル（rooms.csv・rules.json・distance_overrides.csv・meta.json・manual/）は変えない。
// 使い方：R8_SOURCE_DIR=<フォルダ> pnpm build:r8-fixtures [--out <fixtures/r8>] [--allow-rejected]
// 終了コード：0 成功、1 失敗（元データの値は出さず、行番号と見出しだけを示す）、2 R8_SOURCE_DIR がない。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixturePath } from '@gaapp/shared/testing';
import { BuildError, buildR8Fixtures, formatReport, USAGE } from './r8/build';

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const sourceDir = env.R8_SOURCE_DIR;
  if (!sourceDir || !existsSync(sourceDir)) {
    console.error(USAGE);
    return 2;
  }
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]!) : fixturePath('r8');
  try {
    const { files, report } = buildR8Fixtures({ sourceDir, outDir, allowRejected: argv.includes('--allow-rejected') });
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(outDir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text, 'utf8');
    }
    console.log(`wrote ${Object.keys(files).length} files to ${outDir}`);
    console.log(formatReport(report));
    console.log('\n次に：pnpm test と pnpm check:emails を実行し、README.md の「比較から除いた団体」などをこの出力に合わせて直す');
    return 0;
  } catch (e) {
    // BuildError 以外（想定外の例外）は、値が混ざらないよう名前だけを出す
    console.error(e instanceof BuildError ? e.message : `想定外のエラーです（${e instanceof Error ? e.name : 'unknown'}）。元データの値は出力していません`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
