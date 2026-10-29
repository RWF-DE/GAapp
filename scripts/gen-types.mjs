// supabase gen types の出力を packages/shared/src/database.types.ts に書く。
//   pnpm gen:types           書き換える（ローカルの DB が起動していて、マイグレーションが当たっていること）
//   pnpm gen:types --check   書き換えず、今のファイルと一致しなければ終了コード 1（CI・完了前の確認用）
// 出力は oxfmt で整形する（CLI が整形していない形で出すため）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'packages/shared/src/database.types.ts');
const check = process.argv.includes('--check');

const raw = execFileSync('supabase', ['gen', 'types', 'typescript', '--local', '--schema', 'public'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const dir = mkdtempSync(join(tmpdir(), 'gaapp-types-'));
try {
  const tmp = join(dir, 'database.types.ts');
  writeFileSync(tmp, raw);
  execFileSync('pnpm', ['exec', 'oxfmt', tmp], { cwd: root, stdio: 'inherit' });
  const formatted = readFileSync(tmp, 'utf8');
  if (check) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // ファイルがなければ不一致
    }
    if (current !== formatted) {
      console.error('packages/shared/src/database.types.ts が DB と一致しません。pnpm gen:types で作り直してください。');
      process.exit(1);
    }
    console.log('database.types.ts は DB と一致しています。');
  } else {
    writeFileSync(target, formatted);
    console.log(`書き込みました: ${target}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
