import { defineConfig, devices, type Project } from '@playwright/test';
import { localDbUrl, localSupabaseEnv } from './scripts/local-supabase-env.mjs';

// E2E は、テスト用ログインを有効にした静的書き出し（pnpm build:e2e → apps/web/out）を、ローカルの静的サーバーで配って確かめる。
// ローカルの Supabase（supabase start → supabase db reset。seed のテストユーザー）が起動している必要がある。ポートは 3100。
// E2E_PORT はポートを使っているほかのサーバーと避けたいときだけ（既定 3100）
const PORT = Number(process.env.E2E_PORT ?? 3100);
// basePath のスモーク（T14。E2E_BASEPATH=1 のときだけ）：pnpm build:e2e -- --base-path /GAapp の書き出し（apps/web/out-basepath）を
// 別のポートで配る。E2E_BASEPATH_PORT はポートを避けたいときだけ（既定 3101）
const BASEPATH_PORT = Number(process.env.E2E_BASEPATH_PORT ?? 3101);

// テスト（e2e/helpers.ts）が Supabase の API を直接呼ぶときの URL と publishable キー
Object.assign(process.env, localSupabaseEnv());
// E2E の補助（e2e/support/db.ts）がシナリオの年度を作るローカルの DB（127.0.0.1・localhost 以外なら例外。D-36）
process.env.DB_URL = localDbUrl();

// pnpm e2e（scripts/e2e.mjs）は chromium と serial を別の回に流す。回ごとにレポートと結果のフォルダを分ける（設計 7.2）
const RUN = process.env.E2E_RUN?.replace(/[^a-z0-9-]/g, '') || 'default';

const desktop = devices['Desktop Chrome'];

// spec だけを拾う（e2e-support の Vitest のテスト〔*.test.ts〕は Playwright の既定の testMatch に当たるため）
const SPEC = '**/*.spec.ts';
const NOT_PARALLEL = ['**/serial/**', '**/manual/**', '**/perf.spec.ts', '**/setup/**', '**/shots/**', '**/basepath/**'];

const projects: Project[] = [
  // 年度をまたぐ表の準備（前の実行の残り物を消してから1回だけ入れる）
  { name: 'db-setup', testMatch: /setup\/global\.setup\.ts$/ },
  // seed の admin・head・staff・viewer・rep の storageState
  { name: 'auth-setup', testMatch: /setup\/auth\.setup\.ts$/, dependencies: ['db-setup'], use: { ...desktop } },
  // シナリオの年度で閉じたテスト（並行）
  {
    name: 'chromium',
    testMatch: SPEC,
    testIgnore: NOT_PARALLEL,
    fullyParallel: true,
    dependencies: ['auth-setup'],
    use: { ...desktop },
  },
  // 年度の作成・年度をまたぐ表の編集・通しの流れ（1つずつ。chromium には依存させない。pnpm e2e が後に別に流す）
  {
    name: 'serial',
    testDir: './e2e/serial',
    testMatch: SPEC,
    fullyParallel: false,
    workers: 1,
    dependencies: ['auth-setup'],
    use: { ...desktop },
  },
];
// スクリーンショット・手での確かめの年度・4G の速さは、環境変数のときだけ（CI では流さない。設計 7.2・7.4・7.6・7.7）
if (process.env.E2E_SHOTS) {
  projects.push({ name: 'shots', testMatch: '**/*.shots.ts', dependencies: ['auth-setup'], workers: 1, use: { ...desktop } });
}
if (process.env.E2E_MANUAL) {
  projects.push({ name: 'manual', testDir: './e2e/manual', testMatch: SPEC, dependencies: ['auth-setup'], workers: 1, use: { ...desktop } });
}
if (process.env.E2E_BASEPATH) {
  // ログインは basePath の下のテスト用ログインで行う（storageState は E2E_PORT の origin のものなので使えない）。
  // シナリオの年度と年度をまたぐ表は db-setup に頼る
  projects.push({
    name: 'basepath',
    testDir: './e2e/basepath',
    testMatch: SPEC,
    dependencies: ['db-setup'],
    workers: 1,
    use: { ...desktop, baseURL: `http://localhost:${BASEPATH_PORT}` },
  });
}
if (process.env.E2E_PERF) {
  projects.push({ name: 'perf', testMatch: /e2e\/perf\.spec\.ts$/, dependencies: ['auth-setup'], workers: 1, use: { ...desktop } });
}

export default defineConfig({
  testDir: './e2e',
  outputDir: `test-results/${RUN}`,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${RUN}` }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Chromium は LANG が空（C・POSIX）だと、ダウンロードの日本語のファイル名（Content-Disposition・a[download]）を
    // 「download」に置き換える。コンテナや CI の LANG によらず名前を確かめられるよう、UTF-8 のロケールで起こす
    launchOptions: { env: { ...process.env, LANG: 'C.UTF-8' } },
  },
  projects,
  webServer: [
    {
      command: `pnpm exec serve apps/web/out --listen ${PORT} --no-clipboard`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    // apps/web/out-basepath を根に配る（/GAapp/… がそのまま当たる。GitHub Pages と同じ形）
    ...(process.env.E2E_BASEPATH
      ? [
          {
            command: `pnpm exec serve apps/web/out-basepath --listen ${BASEPATH_PORT} --no-clipboard`,
            url: `http://localhost:${BASEPATH_PORT}/GAapp/`,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]
      : []),
  ],
});
