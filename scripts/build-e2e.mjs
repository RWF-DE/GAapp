// E2E 用のビルド：ローカルの Supabase に向け、テスト用ログインを有効にして静的書き出しする（既定は basePath なし → apps/web/out）。
// 本番のビルド（deploy.yml）とは別。ここで作った apps/web/out・apps/web/out-basepath を公開しない。
//
// 引数（T14。画面の設計 7.2・7.6）：
//   --base-path /GAapp   basePath つきで書き出し、apps/web/out-basepath/GAapp/ に移す（basePath のスモーク。e2e/basepath/）。
//                        apps/web/out は残らないので、ふつうの E2E の前に引数なしでもう一度ビルドする。
//   --supabase-url <URL> アプリが呼ぶ Supabase の URL を変える（総務の PC から LAN に配るとき。例 http://192.168.0.10:54321）。
//                        publishable キーはローカルの Supabase（supabase status）のまま。
// 例：pnpm build:e2e -- --base-path /GAapp ／ pnpm build:e2e -- --supabase-url http://192.168.0.10:54321
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localSupabaseEnv } from './local-supabase-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');

/** 引数を読む（pnpm が渡す単独の `--` は飛ばす）。分からない引数は止める */
export function parseArgs(argv) {
  const out = { basePath: '', supabaseUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${key} の値がありません`);
      return v;
    };
    if (key === '--base-path') out.basePath = value();
    else if (key === '--supabase-url') out.supabaseUrl = value();
    else throw new Error(`分からない引数です：${a}（使えるのは --base-path と --supabase-url）`);
  }
  if (out.basePath && !/^\/[A-Za-z0-9._-]+$/.test(out.basePath)) {
    throw new Error('--base-path は /GAapp のように、/ で始まる1段の名前にしてください（末尾の / は付けない）');
  }
  if (out.supabaseUrl) {
    let u;
    try {
      u = new URL(out.supabaseUrl);
    } catch {
      throw new Error('--supabase-url が URL の形ではありません');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('--supabase-url は http:// か https:// にしてください');
    out.supabaseUrl = u.origin;
  }
  return out;
}

function main() {
  const { basePath, supabaseUrl } = parseArgs(process.argv.slice(2));
  const supabase = localSupabaseEnv();
  if (supabaseUrl) supabase.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  const env = { ...process.env, ...supabase, NEXT_PUBLIC_ENABLE_TEST_LOGIN: 'true', NEXT_PUBLIC_BASE_PATH: basePath };
  console.log(`[build:e2e] basePath=${basePath || '（なし）'} Supabase=${supabase.NEXT_PUBLIC_SUPABASE_URL}`);
  execFileSync('pnpm', ['--filter', '@gaapp/web', 'build'], { stdio: 'inherit', env });

  if (basePath) {
    // 静的サーバーで apps/web/out-basepath を根に配ると、/GAapp/… の URL がそのまま当たる（GitHub Pages と同じ形）
    const root = path.join(WEB, 'out-basepath');
    const dest = path.join(root, basePath.slice(1));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    renameSync(path.join(WEB, 'out'), dest);
    if (!existsSync(path.join(dest, 'index.html'))) throw new Error(`${dest}/index.html がありません`);
    console.log(`[build:e2e] basePath つきの書き出しを ${path.relative(ROOT, dest)}/ に置きました（apps/web/out は消えています）`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
