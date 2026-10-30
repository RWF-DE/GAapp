// scripts/build-e2e.mjs の引数（T14。basePath のスモークと、総務の PC から LAN に配るとき。画面の設計 7.2・7.6）
import { describe, expect, it } from 'vitest';
// @ts-expect-error JS モジュール（型宣言なし）
import { parseArgs } from './build-e2e.mjs';

describe('build-e2e の parseArgs', () => {
  it('引数がなければ basePath なし・URL はそのまま', () => {
    expect(parseArgs([])).toEqual({ basePath: '', supabaseUrl: '' });
  });

  it('--base-path と --supabase-url（空白区切り・= 区切り）。pnpm が渡す単独の -- は飛ばす', () => {
    expect(parseArgs(['--', '--base-path', '/GAapp'])).toEqual({ basePath: '/GAapp', supabaseUrl: '' });
    expect(parseArgs(['--supabase-url=http://192.168.0.10:54321/'])).toEqual({ basePath: '', supabaseUrl: 'http://192.168.0.10:54321' });
    expect(parseArgs(['--base-path=/GAapp', '--supabase-url', 'http://pc.local:54321'])).toEqual({
      basePath: '/GAapp',
      supabaseUrl: 'http://pc.local:54321',
    });
  });

  it.each([
    [['--base-path'], '値がありません'],
    [['--base-path', '--supabase-url', 'http://x'], '値がありません'],
    [['--base-path', 'GAapp'], '/ で始まる'],
    [['--base-path', '/GAapp/'], '/ で始まる'],
    [['--base-path', '/a/b'], '/ で始まる'],
    [['--supabase-url', 'not a url'], 'URL の形ではありません'],
    [['--supabase-url', 'ftp://192.168.0.10'], 'http:// か https://'],
    [['--port', '3000'], '分からない引数'],
  ])('誤った引数は止める：%j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
