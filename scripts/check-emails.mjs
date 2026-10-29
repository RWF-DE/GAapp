#!/usr/bin/env node
// git の追跡ファイル全体からメールアドレスのパターンを探し、見つかったら失敗する。
// RFC 2606 / 6761 の予約ドメインは許可する。公開リポジトリへの個人情報の誤コミットを防ぐ。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// TLD は英字のみ（pnpm@10.28.0 や lockfile の pkg@1.2.3 を除く）
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
const ALLOWED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const ALLOWED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);
// このスクリプト自身のテストは、検出される例として JPRS の例示用ドメイン（許可リストの外）を使う。
// そのファイルの中のこのドメインだけを、実行時の検査から外す（findEmails は検出する）。
const SELF_TEST_FILE = 'scripts/check-emails.test.ts';
const SELF_TEST_DOMAINS = new Set(['example.jp', 'example.ac.jp']);

export function isAllowedDomain(domain) {
  const d = domain.toLowerCase();
  if (ALLOWED_DOMAINS.has(d)) return true;
  for (const allowed of ALLOWED_DOMAINS) if (d.endsWith(`.${allowed}`)) return true;
  return ALLOWED_TLDS.has(d.split('.').at(-1));
}

export function findEmails(text) {
  const found = [];
  for (const m of text.matchAll(EMAIL)) {
    if (m[0] === 'git@github.com') continue; // SSH の clone URL
    if (!isAllowedDomain(m[1])) found.push(m[0]);
  }
  return found;
}

// UTF-16 の BOM があれば utf16le（BE は上下のバイトを入れ替えて）でデコードする。なければ null。
export function decodeUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return null;
}

function main() {
  // cwd に関係なく、リポジトリのルートで追跡ファイル全体を調べる
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);
  let bad = 0;
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(path.join(ROOT, file));
    } catch {
      continue; // 削除済み・ワークツリー上にないファイル
    }
    let text = decodeUtf16(buf);
    if (text === null) {
      if (buf.includes(0)) {
        // xlsx（zip）など、中身を検査できないバイナリ。fixtures/ では CSV / JSON などのテキストだけを許す
        if (file.startsWith('fixtures/')) {
          bad++;
          console.error(`${file}: 検査できないバイナリです。fixtures/ にはテキスト（UTF-8 の CSV・JSON など）だけを置いてください。`);
        }
        continue;
      }
      text = buf.toString('utf8');
    }
    text.split('\n').forEach((line, i) => {
      for (const email of findEmails(line)) {
        if (file === SELF_TEST_FILE && SELF_TEST_DOMAINS.has(email.split('@')[1].toLowerCase())) continue;
        bad++;
        // 値そのものはログに出さない（ログへの転記を避ける）
        console.error(`${file}:${i + 1}: メールアドレスらしき文字列 (${email.length} 文字)`);
      }
    });
  }
  if (bad > 0) {
    console.error(`\n${bad} 件見つかりました。テスト用には example.test などの予約ドメインを使ってください。`);
    process.exit(1);
  }
  console.log(`OK: ${files.length} ファイルにメールアドレスはありません。`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
