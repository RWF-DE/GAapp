// T09 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T09` で notes/T09/ に撮る（CI では流さない）。
// 段 1：マスタ設定（settings-*）。段 2 がダッシュボード・ホーム（dashboard-*・home-*）を足す。
// 年度をまたぐ表（場所・品目・距離）には書かない（開くだけ）。
import { expect, test, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario } from '../support/db';
import { S05_GROUP, SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

test.describe('T09 マスタ設定（管理者）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T09 マスタ設定の各タブ（PC）と主なダイアログ', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-years-pc', { fullPage: true });

      for (const tab of ['rooms', 'items', 'groups', 'distance', 'users', 'export'] as const) {
        await page.getByTestId(`settings-tab-${tab}`).click();
        await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
        await expect(page.getByRole('status').filter({ hasText: '読み込み中…' })).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
        await shoot(page, 'T09', `settings-${tab}-pc`);
      }

      // 団体の編集のシート
      await page.getByTestId('settings-tab-groups').click();
      await page.getByRole('row').filter({ hasText: S05_GROUP }).getByRole('button', { name: '編集' }).click();
      await expect(page.getByTestId('group-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-group-edit-pc');
      await page.keyboard.press('Escape');

      // 参照している有効なルールがあって削除できない確認
      await page.getByRole('row').filter({ hasText: S05_GROUP }).getByRole('button', { name: '削除' }).click();
      await expect(page.getByTestId('rule-refs')).toBeVisible();
      await shoot(page, 'T09', 'settings-group-delete-blocked-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      // CSV の取り込みのプレビュー（エラーの行つき）
      await page.getByTestId('groups-csv-open').click();
      await page.getByLabel('CSV ファイル（UTF-8 か Shift_JIS）').setInputFiles({
        name: 'groups.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          `団体名,表示名,区分,飲食,使用場所,別名,並び順\n${S05_GROUP},設営の企画,部門,いいえ,,,\n新しい模擬店,,模擬店,はい,1-1,新|しん,\n余り,,模擬店,,,,\n`,
          'utf8',
        ),
      });
      await expect(page.getByTestId('groups-csv-preview')).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-csv-pc');
      await page.getByRole('button', { name: 'やめる' }).click();

      // 場所の今年の使用（振り分け中で固定・手動の行がなければ使用不可にできる）
      await page.getByTestId('settings-tab-rooms').click();
      await page.getByRole('row').filter({ has: page.getByRole('cell', { name: '1-1', exact: true }) }).getByRole('button', { name: '1-1の今年の使用を変える' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T09', 'settings-room-usable-pc');
      await page.keyboard.press('Escape');

      // 書き出しの確定前の確認
      await page.getByTestId('settings-tab-export').click();
      await page.getByTestId('export-xlsx').click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T09', 'settings-export-confirm-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T09 マスタ設定の読み込み中（団体の読み込みを止めて撮る）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    try {
      await page.route('**/rest/v1/groups*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T09', 'settings-loading-pc');
      release();
      await expect(page.getByTestId('group-add')).toBeVisible();
    } finally {
      release();
      await s.cleanup();
    }
  });

  test('T09 マスタ設定の空と終了した年度（読み取り専用）', async ({ page }) => {
    const s = await createScenario({ status: 'closed', dataset: 'empty', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await expect(page.getByText('団体がありません')).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-empty-closed-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T09 マスタ設定（スマホ）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      await page.setViewportSize(MOBILE);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-years-mobile', { fullPage: true });
      await page.goto('/settings/?tab=groups');
      await expect(page.getByRole('cell', { name: SMALL.groups.stall, exact: true })).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 マスタ設定（権限なし）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T09 部員がマスタ設定を開いたとき', async ({ page }) => {
    await page.goto('/settings/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T09', 'settings-forbidden-pc');
  });
});
