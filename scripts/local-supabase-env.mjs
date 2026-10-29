// ローカルの Supabase（supabase start）の URL と publishable キーを、Next.js の環境変数の名前で返す。
// E2E 用のビルド（pnpm build:e2e）と Playwright が使う。secret キーは読まない・渡さない。
// localDbUrl は E2E の補助（e2e/support/db.ts）がローカルの DB に pg でつなぐための URL（T09a。D-36）。ビルドには渡さない。
import { execFileSync } from 'node:child_process';

let cachedStatus;

/** `supabase status -o json` の結果（1回だけ読む） */
function localStatus() {
  if (cachedStatus) return cachedStatus;
  try {
    cachedStatus = JSON.parse(
      execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    throw new Error('ローカルの Supabase が起動していません。先に supabase start と supabase db reset を実行してください');
  }
  return cachedStatus;
}

export function localSupabaseEnv() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    };
  }
  const status = localStatus();
  return { NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY };
}

/**
 * ローカルの DB の URL（環境変数 DB_URL か `supabase status` の DB_URL）。
 * 127.0.0.1・localhost 以外を指していれば例外にする（E2E の補助が本番やほかの DB に書かないように）。
 */
export function localDbUrl() {
  const url = process.env.DB_URL || localStatus().DB_URL;
  assertLocalDbUrl(url);
  return url;
}

/** DB_URL がローカル（127.0.0.1・localhost・::1）を指していなければ例外 */
export function assertLocalDbUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DB_URL が URL の形ではありません');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`DB_URL はローカルの DB（127.0.0.1・localhost）だけにしてください（今は ${host}）`);
  }
}
