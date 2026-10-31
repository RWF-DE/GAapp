import { expect, type Page } from '@playwright/test';

// supabase/seed.sql のテストユーザー（ローカル専用。パスワードは秘密ではない）。総務部門長（head）は T15b で足した
export const TEST_PASSWORD = 'password123';
export const USERS = {
  admin: 'admin@example.test',
  head: 'head@example.test',
  staff: 'staff@example.test',
  rep: 'rep@example.test',
  viewer: 'viewer@example.test',
  outsider: 'outsider@example.test',
} as const;

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

/** テスト用ログインのフォームでログインする */
export async function loginAs(page: Page, user: keyof typeof USERS, path = '/login/'): Promise<void> {
  await page.goto(path);
  const form = page.getByTestId('test-login-form');
  await form.getByLabel('メールアドレス').fill(USERS[user]);
  await form.getByLabel('パスワード').fill(TEST_PASSWORD);
  await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
  await expect(page).not.toHaveURL(/\/login\//);
}

/** メインメニューの項目名（準備中の印を除く） */
export async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: 'メインメニュー' });
  await expect(nav).toBeVisible();
  const texts = await nav.getByRole('listitem').allInnerTexts();
  return texts.map((t) => t.replace('準備中', '').trim());
}
