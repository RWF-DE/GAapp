import { defineConfig, devices } from '@playwright/test';
import { localSupabaseEnv } from './scripts/local-supabase-env.mjs';

// E2E は、テスト用ログインを有効にした静的書き出し（pnpm build:e2e → apps/web/out）を、ローカルの静的サーバーで配って確かめる。
// ローカルの Supabase（supabase start → supabase db reset。seed のテストユーザー）が起動している必要がある。ポートは 3100。
// E2E_PORT はポートを使っているほかのサーバーと避けたいときだけ（既定 3100）
const PORT = Number(process.env.E2E_PORT ?? 3100);

// テスト（e2e/helpers.ts）が Supabase の API を直接呼ぶときの URL と publishable キー
Object.assign(process.env, localSupabaseEnv());

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec serve apps/web/out --listen ${PORT} --no-clipboard`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
