import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error JS モジュール（型宣言なし）
import { decodeUtf16, findEmails } from './check-emails.mjs';

// 検査スクリプト自身に引っかからないよう、実在しうるドメインは連結して組み立てる
const at = '@';
const realLike = `taro${at}${'gmail'}.com`;
const schoolLike = `x${at}${'kumamoto-nct'}.ac.jp`;

describe('findEmails', () => {
  it('予約ドメインは許可する', () => {
    const text = ['a@example.com', 'b@x.example.org', 'c@foo.test', 'd@bar.invalid', 'e@host.localhost', 'f@x.example'].join(' ');
    expect(findEmails(text)).toEqual([]);
  });
  it('実在しうるドメインは検出する', () => {
    expect(findEmails(realLike)).toEqual([realLike]);
    expect(findEmails(schoolLike)).toHaveLength(1);
  });
  it('メール以外（@scope/pkg）や SSH の URL は検出しない', () => {
    expect(findEmails('@gaapp/web')).toEqual([]);
    expect(findEmails('pnpm@10.28.0 /@types/node@22.20.5(x)')).toEqual([]);
    expect(findEmails(`git${at}github.com:x/y.git`)).toEqual([]);
  });
});

describe('decodeUtf16', () => {
  it('BOM 付きの UTF-16 LE / BE をデコードし、BOM がなければ null を返す', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a b', 'utf16le')]);
    const be = Buffer.from(le.subarray(2)).swap16();
    expect(decodeUtf16(le)).toBe('a b');
    expect(decodeUtf16(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('a b');
    expect(decodeUtf16(Buffer.from('plain'))).toBeNull();
  });
});

describe('check-emails.mjs の実行', () => {
  const script = fileURLToPath(new URL('./check-emails.mjs', import.meta.url));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });

  function run(cwd: string) {
    return spawnSync(process.execPath, [path.join(cwd, 'scripts', 'check-emails.mjs')], { cwd, encoding: 'utf8' });
  }
  function setup(files: Record<string, Buffer | string>) {
    // 空白を含むパスでも動くことを確かめる
    const root = mkdtempSync(path.join(tmpdir(), 'check emails '));
    git(root, 'init', '-q');
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(script, path.join(root, 'scripts', 'check-emails.mjs'));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), content);
    }
    git(root, 'add', '-f', '.');
    return root;
  }

  it('空白を含むパスでも、サブディレクトリから実行しても、ルートの全ファイルを検査する', () => {
    const root = setup({ 'docs/a.txt': `contact: ${realLike}\n` });
    try {
      for (const cwd of [root, path.join(root, 'scripts')]) {
        const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-emails.mjs')], { cwd, encoding: 'utf8' });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('docs/a.txt:1');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('UTF-16 のファイルも検査する', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${realLike}\n`, 'utf16le')]);
    const root = setup({ 'docs/b.tsv': body });
    try {
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('docs/b.tsv:1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fixtures/ の下の検査できないバイナリは失敗させ、それ以外のバイナリは飛ばす', () => {
    const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]);
    const root = setup({ 'fixtures/r8/forms.xlsx': zipLike });
    const ok = setup({ 'public/logo.png': zipLike, 'fixtures/r8/a.csv': 'id,name\n1,x\n' });
    try {
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('fixtures/r8/forms.xlsx');
      expect(run(ok).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(ok, { recursive: true, force: true });
    }
  });
});
