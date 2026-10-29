// 本番向けのビルド（NEXT_PUBLIC_ENABLE_TEST_LOGIN なし）に、ローカル専用のテスト用ログインのコードが入っていないことを確かめる。
// 使い方：pnpm build の後に node scripts/check-no-test-login.mjs [出力のフォルダ（既定 apps/web/out）]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'apps/web/out';
// test-login-form.tsx の文言と、フォームの印
const markers = ['テスト用ログイン（ローカル専用）', 'テスト用ユーザーでログイン', 'test-login-form'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|html|txt|json)$/.test(name)) yield p;
  }
}

const hits = [];
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8');
  for (const m of markers) if (text.includes(m)) hits.push(`${file}: ${m}`);
}
if (hits.length > 0) {
  console.error('本番向けのビルドにテスト用ログインが含まれています:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`テスト用ログインは含まれていません（${root}）。`);
