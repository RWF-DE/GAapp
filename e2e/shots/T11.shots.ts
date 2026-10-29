// T11 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T11` で notes/T11/ に撮る（CI では流さない）。
// 申請（スマホ）と申請一覧（PC）、取り込みのダイアログ（PC）。読み込み中は page.route で応答を止めてから撮る。
import { fileURLToPath } from 'node:url';
import { expect, test, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const STALL_CSV = fileURLToPath(new URL('../../fixtures/importer-samples/stall.csv', import.meta.url));

test.describe('T11 団体代表', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T11 申請（スマホ）：入力・提出の確認・読み込み中・締切後・時計のずれ', async ({ page }) => {
    const s = await createScenario({ repGroup: SMALL.groups.stall });
    try {
      const gid = s.ids.groups[SMALL.groups.stall]!;
      await sql(
        "insert into public.requests (group_id, item_id, count) select $1, id, 2 from public.items where code = 'long_desk_3'",
        [gid],
      );
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.setViewportSize(MOBILE);

      // 読み込み中（申請の読み込みを止める）
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/rest/v1/requests*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await page.goto('/request/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T11', 'request-loading-mobile');
      release();

      await expect(page.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
      await page.getByRole('button', { name: '机(木)の数を1増やす' }).click();
      await shoot(page, 'T11', 'request-mobile', { fullPage: true });
      await page.getByRole('button', { name: '修正して再提出' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'この年度に保存する' }).click();
      await expect(page.getByRole('alertdialog').getByTestId('submit-summary')).toBeVisible();
      await shoot(page, 'T11', 'request-confirm-mobile');
      await page.getByRole('alertdialog').getByRole('button', { name: '提出する' }).click();
      await expect(page.getByText(/^提出しました（/)).toBeVisible();
      await shoot(page, 'T11', 'request-submitted-mobile');

      await sql("update public.years set request_close_at = now() - interval '1 minute' where id = $1", [s.yearId]);
      await page.reload();
      await expect(page.getByTestId('read-only-notice')).toHaveText('締切を過ぎました。変更は総務へ');
      await shoot(page, 'T11', 'request-closed-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });

  test('T11 申請（スマホ）：DB が締切後と判断したとき（端末の時計のずれ）', async ({ page }) => {
    const s = await createScenario({ repGroup: SMALL.groups.stall, requestWindow: 'closed' });
    try {
      await page.clock.setFixedTime(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto('/request/');
      await page.getByRole('button', { name: '修正して再提出' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'この年度に保存する' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '提出する' }).click();
      await expect(page.getByTestId('submit-error')).toBeVisible();
      await shoot(page, 'T11', 'request-clock-skew-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T11 権限なし（団体代表が申請一覧を開く）', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/requests/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T11', 'requests-forbidden-mobile');
  });
});

test.describe('T11 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T11 申請一覧（PC）：表・未保存のセル・締切後の理由・代理入力・提出済みにする', async ({ page }) => {
    const s = await createScenario({
      roles: { admin: true },
      dataset: 'synthetic',
      requestWindow: 'closed',
      extraGroups: [{ name: 'E2E休憩所', category: 'rest_area' }],
    });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await expect(page.getByTestId('requests-table')).toBeVisible();
      await shoot(page, 'T11', 'requests-pc');
      const c = page.getByRole('textbox', { name: '模擬店01の机(木)', exact: true });
      await c.fill('9');
      await c.press('Enter');
      await shoot(page, 'T11', 'requests-pending-pc');
      await page.getByRole('button', { name: '保存（1件）' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T11', 'requests-reason-pc');
      await page.getByRole('dialog').getByRole('button', { name: 'やめる' }).click();

      await page.locator('tr[data-group-name="休憩所1"]').getByRole('button', { name: '代理入力' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: '代理入力：休憩所1' })).toBeVisible();
      await shoot(page, 'T11', 'requests-proxy-pc');
      await page.keyboard.press('Escape');

      await page.goto('/requests/?filter=unsubmitted');
      await page.locator('tr[data-group-name="E2E休憩所"]').getByRole('button', { name: '提出済みにする' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T11', 'requests-mark-submitted-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T11 取り込み（PC）：ファイルを選ぶ前・プレビュー・手で選ぶ・読めない CSV・結果', async ({ page }) => {
    const s = await createScenario({
      roles: { admin: true },
      extraGroups: [
        { name: '模擬店甲', category: 'stall' },
        { name: '模擬店乙', category: 'stall' },
        { name: '模擬店丙', category: 'stall' },
      ],
    });
    try {
      const kou = s.ids.groups['模擬店甲']!;
      // 模擬店甲はフォームの回答より後にアプリで提出した（既定で上書きしない）
      await sql("insert into public.request_submissions (group_id, submitted_at) values ($1, now())", [kou]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await page.getByRole('button', { name: 'Googleフォームの回答を取り込む' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('CSV ファイル')).toBeVisible();
      await shoot(page, 'T11', 'import-start-pc');

      await dialog.getByLabel('CSV ファイル').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
      await expect(dialog.getByRole('alert')).toBeVisible();
      await shoot(page, 'T11', 'import-format-error-pc');

      await dialog.getByLabel('CSV ファイル').setInputFiles(STALL_CSV);
      await expect(dialog.getByTestId('import-counts')).toBeVisible();
      await shoot(page, 'T11', 'import-preview-pc', { fullPage: true });
      await dialog.getByRole('combobox', { name: '行8の団体' }).click();
      await expect(page.getByRole('option', { name: '模擬店丙', exact: true })).toBeVisible();
      await shoot(page, 'T11', 'import-manual-pc');
      await page.getByRole('option', { name: '模擬店丙', exact: true }).click();
      await expect(dialog.getByTestId('plan-模擬店丙')).toBeVisible();
      await dialog.getByTestId('import-plans').scrollIntoViewIfNeeded();
      await shoot(page, 'T11', 'import-plans-pc');
      await dialog.getByRole('button', { name: '取り込む（2 団体）' }).click();
      await expect(dialog.getByTestId('import-results')).toBeVisible();
      await shoot(page, 'T11', 'import-results-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T11 申請一覧（PC）：団体がない（空）', async ({ page }) => {
    const s = await createScenario({ roles: { admin: true }, dataset: 'empty' });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await expect(page.getByText('団体がありません')).toBeVisible();
      await shoot(page, 'T11', 'requests-empty-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T11 部員', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T11 申請一覧（PC）：部員は読み取り', async ({ page }) => {
    const s = await createScenario({ roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/requests/');
      await expect(page.getByTestId('requests-table')).toBeVisible();
      await shoot(page, 'T11', 'requests-staff-pc');
    } finally {
      await s.cleanup();
    }
  });
});
