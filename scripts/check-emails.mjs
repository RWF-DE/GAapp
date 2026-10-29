#!/usr/bin/env node
// git の追跡ファイル全体からメールアドレスのパターンを探し、見つかったら失敗する。
// RFC 2606 / 6761 の予約ドメインは許可する。公開リポジトリへの個人情報の誤コミットを防ぐ。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const ALLOWED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const ALLOWED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);

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

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);
  let bad = 0;
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue; // 削除済み・ワークツリー上にないファイル
    }
    if (buf.includes(0)) continue; // バイナリ
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const email of findEmails(line)) {
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

if (import.meta.url === `file://${process.argv[1]}`) main();
