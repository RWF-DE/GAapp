// T13 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T13` で notes/T13/ に撮る（CI では流さない）。
// 段 1：振り分け画面（読み込み中・空〔まだ自動振り分けをしていない〕・権限なし〔確定前の閲覧のみ〕・受付中）、
// 計算中のロック、自動振り分けの後、確定前の Excel の確認、解けない入力のパネル、部員の読み取り・団体別、閲覧のみの確定後、スマホ幅。
// 読み込み中とロックは page.route で応答を止めてから撮る。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario } from '../support/db';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

async function hold(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route(pattern, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test.describe('T13 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T13 振り分け：読み込み中・まだ自動振り分けをしていない・ロック・自動振り分けの後・確定前の Excel の確認', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      const releaseLoad = await hold(page, '**/rest/v1/allocations*');
      await page.goto('/allocation/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-loading-pc');
      releaseLoad();
      await page.unroute('**/rest/v1/allocations*');

      await expect(page.getByText('まだ自動振り分けをしていません')).toBeVisible();
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled({ timeout: 30_000 });
      await shoot(page, 'T13', 'allocation-empty-pc');

      await page.getByRole('button', { name: '自動振り分け', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T13', 'allocation-auto-confirm-pc');

      const releaseSave = await hold(page, '**/rest/v1/rpc/save_auto_allocations');
      await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
      await expect(page.getByTestId('allocate-lock')).toHaveAttribute('data-phase', 'saving');
      await shoot(page, 'T13', 'allocation-lock-pc');
      releaseSave();
      await expect(page.getByTestId('allocate-elapsed')).toBeVisible({ timeout: 30_000 });
      await page.unroute('**/rest/v1/rpc/save_auto_allocations');
      await shoot(page, 'T13', 'allocation-after-auto-pc');
      await shoot(page, 'T13', 'allocation-after-auto-full-pc', { fullPage: true });

      await page.getByRole('button', { name: 'Excel出力' }).click();
      await expect(page.getByRole('alertdialog').getByText('確定前の振り分けです')).toBeVisible();
      await shoot(page, 'T13', 'allocation-excel-before-confirm-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      await page.getByTestId('year-status-actions').getByRole('button', { name: '確定', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T13', 'allocation-confirm-dialog-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 振り分け：解けない入力（S05）のパネル', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic-infeasible-s05', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled({ timeout: 30_000 });
      await page.getByRole('button', { name: '自動振り分け', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
      await expect(page.getByTestId('allocate-failure')).toBeVisible({ timeout: 30_000 });
      await shoot(page, 'T13', 'allocation-infeasible-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 振り分け：受付中の年度（締切の後に振り分けます）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByText('締切の後に振り分けます')).toBeVisible();
      await shoot(page, 'T13', 'allocation-requesting-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 部員', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T13 振り分け：部員の読み取り（品目別・団体別・スマホ幅）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-pc');
      await page.getByRole('button', { name: '団体別' }).click();
      await expect(page.locator('[data-group-block]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-group-pc');
      await page.setViewportSize(MOBILE);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 閲覧のみ', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: PC });

  test('T13 振り分け：閲覧のみ（確定前は権限なし、確定後は行の一覧）', async ({ page }) => {
    const before = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, before.yearId);
      await page.goto('/allocation/');
      await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
      await shoot(page, 'T13', 'allocation-viewer-forbidden-pc');
    } finally {
      await before.cleanup();
    }
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-viewer-confirmed-pc');
      await page.setViewportSize(MOBILE);
      await shoot(page, 'T13', 'allocation-viewer-confirmed-mobile');
    } finally {
      await s.cleanup();
    }
  });
});
