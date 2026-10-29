// assertLocalDbUrl：E2E の補助（e2e/support/db.ts）が pg でつなぐ先がローカルの DB であることを確かめる。
// pg（pg-connection-string）はクエリの host・hostaddr などで接続先を上書きできるので、URL の hostname だけでは足りない。
import { describe, expect, it } from 'vitest';
import { assertLocalDbUrl } from './local-supabase-env.mjs';

describe('assertLocalDbUrl', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgres://postgres:postgres@localhost:54322/postgres',
    'postgresql://postgres:postgres@[::1]:54322/postgres',
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres?application_name=e2e',
  ])('ローカルを指す URL は通す：%s', (url) => {
    expect(() => assertLocalDbUrl(url)).not.toThrow();
  });

  it.each([
    ['ほかのホスト', 'postgresql://postgres:postgres@db.example.test:5432/postgres'],
    ['ユーザー名にローカルの名前', 'postgresql://127.0.0.1@db.example.test:5432/postgres'],
    ['クエリの host で上書き', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.example.test'],
    ['クエリの host（大文字・小文字の別のキーは pg が見ないが、念のため拒否）', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?HOST=db.example.test'],
    ['クエリの hostaddr', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?hostaddr=192.0.2.1'],
    ['クエリの port', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?port=5432'],
    ['クエリの options', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-c%20search_path%3Dx'],
    ['ソケットのパス', '/var/run/postgresql postgres'],
    ['socket: の形', 'socket://postgres:postgres@/var/run/postgresql?db=postgres'],
    ['ホストなし（pg は PGHOST を見る）', 'postgresql://postgres:postgres@/postgres'],
    ['URL でない', 'not a url'],
    ['postgres 以外のスキーム', 'http://127.0.0.1:54322/postgres'],
  ])('%s は拒否', (_name, url) => {
    expect(() => assertLocalDbUrl(url)).toThrow(/DB_URL/);
  });

  it('エラーの文に URL（パスワード）を出さない', () => {
    expect(() => assertLocalDbUrl('postgresql://postgres:secret-pass@db.example.test/postgres')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-pass') }),
    );
  });
});
