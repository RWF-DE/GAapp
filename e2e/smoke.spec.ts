import { expect, test } from '@playwright/test';

test('トップページが開く', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '電波祭 総務 机椅子管理' })).toBeVisible();
});

test('/login/ が開く', async ({ page }) => {
  await page.goto('/login/');
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
});
