#!/usr/bin/env node
// pnpm e2e（画面の設計 7.2。T09a）：Playwright を2回呼ぶ。
// 1回目は chromium（setup は依存で走る）、2回目は結果によらず serial。どちらかが失敗していれば失敗で終わる。
// serial を chromium の dependencies にすると、chromium のテストが1件落ちただけで serial（通しの流れ・年度の作成）が
// スキップされ、T14 の受け入れの結果が CI に残らないため。レポートは回ごとに別のフォルダ（playwright-report/<回>、
// test-results/<回>）に出す。引数（--grep など）は両方の回に渡す。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);

const RUNS = [
  { run: 'chromium', args: ['--project=chromium'] },
  // T09a の時点では serial のテストはない（T09・T14 が足す）。ないときは成功にする
  { run: 'serial', args: ['--project=serial', '--pass-with-no-tests'] },
];

const results = [];
for (const { run, args } of RUNS) {
  console.log(`\n[e2e] ${run} を流します`);
  const r = spawnSync('pnpm', ['exec', 'playwright', 'test', ...args, ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, E2E_RUN: run },
  });
  const code = r.status ?? 1;
  results.push({ run, code });
  console.log(`[e2e] ${run}：${code === 0 ? '成功' : `失敗（終了コード ${code}）`}（レポート：playwright-report/${run}）`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n[e2e] ${results.map((r) => `${r.run} ${r.code === 0 ? '成功' : '失敗'}`).join('・')}`);
process.exit(failed.length > 0 ? 1 : 0);
