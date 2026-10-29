// auth-setup（画面の設計 7.2。T09a）：seed の admin・staff・viewer・rep に1回ずつ画面からログインし、
// storageState（e2e/.auth/<user>.json。git に入れない）を保存する。supabase-js のセッションは localStorage にあるので入る。
// アプリのログアウトは signOut({ scope: 'local' }) なので、ほかのテストのログアウトがこのセッションを壊さない。
import { expect, test as setup } from '@playwright/test';
import { loginAs } from '../helpers';
import { STORED_USERS, storageStateFor } from '../support/auth';

for (const user of STORED_USERS) {
  setup(`${user} のログインを保存する`, async ({ page }) => {
    await loginAs(page, user);
    // 立場を読み終えてから保存する（ヘッダーの年度が出る）
    await expect(page.getByTestId('current-year')).toBeVisible();
    await page.context().storageState({ path: storageStateFor(user) });
  });
}
