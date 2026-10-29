import { expect, test } from '@playwright/test';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './helpers';

// Before User Created フック（0007_auth.sql）が、ローカルの GoTrue で実際に呼ばれることを確かめる。
// メールのサインアップ（Google 以外のプロバイダー）は、学校のドメインでもテスト用のドメインでも拒否される。
for (const email of ['new-user@school.example', 'new-user@example.test']) {
  test(`メールのサインアップは拒否される（${email.split('@')[1]}）`, async ({ request }) => {
    const res = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      data: { email, password: 'password123' },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).msg).toBe('学校の Google アカウントでログインしてください');
  });
}
