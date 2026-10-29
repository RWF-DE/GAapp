import { describe, expect, it } from 'vitest';
import { loginErrorMessage, oauthCallbackUrl, safeNextPath } from './redirect';

describe('safeNextPath', () => {
  it.each([
    ['/stock/?room=abc', '/stock/?room=abc'],
    ['/', '/'],
    [null, '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/a\nb', '/'],
    ['/login/', '/'],
    ['/auth/callback/', '/'],
  ])('%s → %s', (input, want) => {
    expect(safeNextPath(input)).toBe(want);
  });
});

describe('oauthCallbackUrl', () => {
  it('basePath 込みの URL', () => {
    expect(oauthCallbackUrl('https://org.github.io', '/GAapp')).toBe('https://org.github.io/GAapp/auth/callback/');
    expect(oauthCallbackUrl('http://127.0.0.1:3100', '')).toBe('http://127.0.0.1:3100/auth/callback/');
  });
});

describe('loginErrorMessage', () => {
  it('エラーがなければ null', () => {
    expect(loginErrorMessage(new URLSearchParams('code=abc'))).toBeNull();
  });
  it('フックの拒否は、学校のアカウントを使うよう案内する', () => {
    const p = new URLSearchParams({ error: 'access_denied', error_description: '学校の Google アカウントでログインしてください' });
    expect(loginErrorMessage(p)).toContain('学校の Google アカウント');
  });
  it('URL の文言はそのまま出さない', () => {
    const p = new URLSearchParams({ error: 'server_error', error_description: 'ここに電話してください' });
    expect(loginErrorMessage(p)).toBe('ログインに失敗しました。もう一度お試しください。');
  });
});
