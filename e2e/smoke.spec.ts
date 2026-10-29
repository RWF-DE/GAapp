import { expect, test } from '@playwright/test';

test('ログインしていなければ /login/ に送られる', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\/$/);
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
});

test('/login/ に Google のログインボタンがある', async ({ page }) => {
  await page.goto('/login/');
  await expect(page.getByRole('button', { name: '学校の Google アカウントでログイン' })).toBeVisible();
});
