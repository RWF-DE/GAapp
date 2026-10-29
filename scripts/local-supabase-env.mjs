// ローカルの Supabase（supabase start）の URL と publishable キーを、Next.js の環境変数の名前で返す。
// E2E 用のビルド（pnpm build:e2e）と Playwright が使う。secret キーは読まない・渡さない。
import { execFileSync } from 'node:child_process';

export function localSupabaseEnv() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    };
  }
  let status;
  try {
    status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    throw new Error('ローカルの Supabase が起動していません。先に supabase start と supabase db reset を実行してください');
  }
  return { NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY };
}
