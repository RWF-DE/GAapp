import { expect, test } from '@playwright/test';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './helpers';

// Before User Created フック（0007_auth.sql）が、ローカルの GoTrue で実際に呼ばれることを確かめる。
// メールのサインアップ（Google 以外のプロバイダー）は拒否される。ここでは予約済みのドメインだけを使う
// （学校のドメイン g.kumamoto-nct.ac.jp は実在するので、そのメールアドレスを公開リポジトリに書かない。school.example は
// pgTAP で学校のドメインの代わりに使う予約済みのドメイン）。学校のドメインでもメールのサインアップは拒否されることは、
// pgTAP（030_auth）で private.school_domain を置き換えて確かめる（notes/T04.md）。
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
