// ローカルの Supabase（supabase start）の URL と publishable キーを、Next.js の環境変数の名前で返す。
// E2E 用のビルド（pnpm build:e2e）と Playwright が使う。secret キーは読まない・渡さない。
// localDbUrl は E2E の補助（e2e/support/db.ts）がローカルの DB に pg でつなぐための URL（T09a。D-36）。ビルドには渡さない。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

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
 * 127.0.0.1・localhost・::1 以外を指していれば例外にする（E2E の補助が本番やほかの DB に書かないように）。
 */
export function localDbUrl() {
  const url = process.env.DB_URL || localStatus().DB_URL;
  assertLocalDbUrl(url);
  return url;
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// クエリで許すキー。pg（pg-connection-string）はクエリのキーをそのまま接続の設定にする（host・hostaddr・port で接続先を、
// options などで接続の中身を変えられる）ので、接続先に関わらないものだけを許す
const ALLOWED_QUERY_KEYS = ['application_name', 'connect_timeout'];

// pg が使う pg-connection-string を、pg から解決して読む（ルートの依存に足さずに、pg と同じ版で解く）
const require = createRequire(import.meta.url);
const parsePgConnectionString = createRequire(require.resolve('pg'))('pg-connection-string').parse;

/**
 * DB_URL がローカル（127.0.0.1・localhost・::1）を指していなければ例外。
 * URL の hostname に加えて、クエリのキー（許すものだけ）と、pg と同じ解き方（pg-connection-string）で解いた後の host を確かめる。
 * エラーの文には URL を出さない（パスワードを含むため）。
 */
export function assertLocalDbUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DB_URL が URL の形ではありません');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DB_URL は postgres:// か postgresql:// の URL にしてください');
  }
  const host = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`DB_URL はローカルの DB（127.0.0.1・localhost・::1）だけにしてください（今は ${host || 'ホストなし'}）`);
  }
  const extraKeys = [...new Set(parsed.searchParams.keys())].filter((k) => !ALLOWED_QUERY_KEYS.includes(k));
  if (extraKeys.length > 0) {
    throw new Error(`DB_URL のクエリに ${extraKeys.join('・')} は使えません（接続先を変えられるため。使えるのは ${ALLOWED_QUERY_KEYS.join('・')} だけ）`);
  }
  // 念のため、pg と同じ解き方でも接続先がローカルであることを確かめる
  const config = parsePgConnectionString(url);
  if (!LOCAL_HOSTS.includes(config.host) || config.hostaddr !== undefined) {
    throw new Error('DB_URL を pg で解いた接続先がローカルの DB ではありません');
  }
}
