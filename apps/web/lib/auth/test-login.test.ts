import { describe, expect, it } from 'vitest';
import { isTestLoginAvailable } from './test-login';

describe('isTestLoginAvailable', () => {
  it('フラグがあり、Supabase がローカルのときだけ出す', () => {
    expect(isTestLoginAvailable(true, 'http://127.0.0.1:54321')).toBe(true);
    expect(isTestLoginAvailable(true, 'http://localhost:54321')).toBe(true);
  });
  it('フラグがなければ出さない', () => {
    expect(isTestLoginAvailable(false, 'http://127.0.0.1:54321')).toBe(false);
  });
  it('本番の Supabase に向いていれば、フラグがあっても出さない', () => {
    expect(isTestLoginAvailable(true, 'https://abcdefgh.supabase.co')).toBe(false);
    expect(isTestLoginAvailable(true, 'http://127.0.0.1.evil.example')).toBe(false);
    expect(isTestLoginAvailable(true, '')).toBe(false);
  });
});
