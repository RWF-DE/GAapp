import { describe, expect, it } from 'vitest';
// @ts-expect-error JS モジュール（型宣言なし）
import { findEmails } from './check-emails.mjs';

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
