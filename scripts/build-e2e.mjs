// E2E 用のビルド：ローカルの Supabase に向け、テスト用ログインを有効にして静的書き出しする（basePath なし）。
// 本番のビルド（deploy.yml）とは別。ここで作った apps/web/out を公開しない。
import { execFileSync } from 'node:child_process';
import { localSupabaseEnv } from './local-supabase-env.mjs';

const env = { ...process.env, ...localSupabaseEnv(), NEXT_PUBLIC_ENABLE_TEST_LOGIN: 'true', NEXT_PUBLIC_BASE_PATH: '' };
execFileSync('pnpm', ['--filter', '@gaapp/web', 'build'], { stdio: 'inherit', env });
