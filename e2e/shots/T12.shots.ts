// T12 ルールのスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T12` で notes/T12/ に撮る（CI では流さない）。
// 一覧（PC・スマホ）、?code=S05 で開いた編集のシート、欄の下のエラー、ひな形のメニュー、無効にする確認、有効にできない理由、
// 読み直しの失敗（前の一覧を残す帯）、使用不可の場所を指す「残す」の印と知らせ、空・読み込み中・権限なし・確定中（メモだけ）。
import { expect, test, type Page, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

async function waitList(page: Page): Promise<void> {
  await expect(page.getByTestId('rules-screen')).toBeVisible();
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
}

test.describe('T12 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T12 一覧・参照の切れた印・?code=S05 のシート・エラー・ダイアログ', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      // S06 の団体を存在しない id にし（参照の切れ）、S04 を無効にしておく
      await sql(`update public.rules set params = jsonb_set(params, '{group}', '"99999999-9999-4999-8999-999999999999"') where year_id = $1 and code = 'S06'`, [
        s.yearId,
      ]);
      await sql(`update public.rules set enabled = false, memo = 'E2E：今年は使わない' where year_id = $1 and code = 'S04'`, [s.yearId]);
      // S08（残す）の場所を今年は使用不可にする（一覧の印・フォームの場所の欄の知らせ）
      await sql(
        `insert into public.room_years (year_id, room_id, usable, note) values ($1, $2, false, 'E2E：工事')
         on conflict (year_id, room_id) do update set usable = false, note = excluded.note`,
        [s.yearId, s.ids.rooms['第一多目的室']],
      );
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      await waitList(page);
      await shoot(page, 'T12', 'list-pc');
      await shoot(page, 'T12', 'list-pc-full', { fullPage: true });

      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByRole('menuitem', { name: '代替', exact: true })).toBeVisible();
      await shoot(page, 'T12', 'add-menu-pc');
      await page.getByRole('menuitem', { name: '代替', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: '代替のルールを追加' })).toBeVisible();
      await shoot(page, 'T12', 'form-substitute-empty-pc');
      // 重なる代替と形の誤り（欄の下のエラー）
      await sheet.getByLabel('コード').fill('S01b');
      await sheet.getByRole('combobox', { name: '元の品目', exact: true }).click();
      await page.getByRole('option', { name: '机(木)', exact: true }).click();
      await expect(page.locator('[cmdk-root]')).toHaveCount(0);
      await sheet.getByRole('combobox', { name: '先の品目', exact: true }).click();
      await page.getByRole('option', { name: '不可机', exact: true }).click();
      await expect(page.locator('[cmdk-root]')).toHaveCount(0);
      await sheet.getByRole('group', { name: '区分' }).getByRole('checkbox', { name: '模擬店', exact: true }).check();
      await sheet.getByLabel(/^重さ/).fill('12');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.cost"] [data-field-error]')).toBeVisible();
      await sheet.getByLabel(/^重さ/).fill('0');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.categories"] [data-field-error]')).toBeVisible();
      await shoot(page, 'T12', 'form-overlap-error-pc');
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T12', 'discard-dialog-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: '捨てて閉じる' }).click();
      await expect(sheet).toBeHidden();

      // 参照の切れた S06 を開いて保存しようとする
      const s06 = page.locator(`[data-row-id="${s.ids.rules['S06']}"]`);
      await s06.getByRole('button', { name: 'S06 を編集' }).click();
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.group"] [data-field-error]')).toBeVisible();
      await shoot(page, 'T12', 'form-broken-ref-error-pc');
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(sheet).toBeHidden();

      // 使用不可の場所を指す「残す」（S08）：場所の欄の下の知らせ
      await page.locator(`[data-row-id="${s.ids.rules['S08']}"]`).getByRole('button', { name: 'S08 を編集' }).click();
      await expect(sheet.locator('[data-field="params.room"] [data-field-warning]')).toBeVisible();
      await shoot(page, 'T12', 'form-keep-unusable-pc');
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(sheet).toBeHidden();

      // 無効にする確認
      await page.locator(`[data-row-id="${s.ids.rules['S05']}"]`).getByRole('switch', { name: 'S05 を有効にする' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T12', 'disable-dialog-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      // 有効にできない理由（S01 と重なる無効のルール）
      await sql(
        `insert into public.rules (year_id, code, kind, params, enabled, memo) values ($1, 'S01x', 'substitute', '{"from":"desk","to":"desk_ng","categories":["stall"],"cost":0}', false, 'E2E：重なる代替')`,
        [s.yearId],
      );
      await page.getByRole('button', { name: '読み直す' }).first().click();
      const s01x = page.locator('[data-row-id]').filter({ hasText: 'S01x' });
      await s01x.getByRole('switch', { name: 'S01x を有効にする' }).click();
      await expect(page.getByTestId('enable-blocked-messages')).toBeVisible();
      await shoot(page, 'T12', 'enable-blocked-dialog-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: '閉じる' }).click();

      // ?code=S05（振り分け画面のリンクから来たとき）
      await page.goto('/rules/?code=S05');
      await expect(sheet.getByRole('heading', { name: 'ルール S05（運び元の制限）を編集' })).toBeVisible();
      await shoot(page, 'T12', 'code-s05-sheet-pc');
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(sheet).toBeHidden();
      await shoot(page, 'T12', 'code-s05-highlight-pc');

      // スマホ（PC の画面だが、崩れずに読めること。ページは横にスクロールしない）
      await page.setViewportSize(MOBILE);
      await page.goto('/rules/');
      await waitList(page);
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T12', 'list-mobile');
      await page.locator(`[data-row-id="${s.ids.rules['S08']}"]`).getByRole('button', { name: 'S08 を編集' }).click();
      await expect(sheet.getByRole('heading', { name: 'ルール S08（残す）を編集' })).toBeVisible();
      await expect(sheet.locator('[data-field="params.room"] [data-field-warning]')).toBeVisible();
      await shoot(page, 'T12', 'form-keep-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T12 読み直しの失敗（前に読んだ一覧を残して帯と toast）', async ({ page }) => {
    // supabase-js の GET の再試行と React Query の再試行で、失敗が出るまで十数秒かかる
    test.setTimeout(150_000);
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      await waitList(page);
      await page.route('**/rest/v1/rules*', (route: Route) => route.abort('internetdisconnected'));
      await page.getByRole('button', { name: '読み直す' }).first().click();
      await expect(page.getByTestId('rules-reload-error')).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T12', 'reload-error-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T12 空の状態と読み込み中', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', rules: 'none', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/rest/v1/rules?*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await page.goto('/rules/');
      // アプリ全体の読み込み（立場・年度）が終わり、/rules の PageHeader が出て、ルールの応答を待っているところを撮る
      await expect(page.getByRole('heading', { level: 1, name: 'ルール' })).toBeVisible();
      await expect(page.getByTestId('current-year')).toBeAttached();
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await expect(page.getByTestId('rules-screen')).toHaveCount(0);
      await shoot(page, 'T12', 'state-loading-pc');
      release();
      await expect(page.getByText('ルールがありません')).toBeVisible();
      await shoot(page, 'T12', 'state-empty-pc');
      // ひな形のメニューと、団体・場所を選ぶひな形（S05）のフォーム
      await page.getByRole('button', { name: 'R8 の初期ルールから追加' }).first().click();
      await expect(page.getByRole('menuitem').first()).toBeVisible();
      await shoot(page, 'T12', 'template-menu-pc');
      await page.getByRole('menuitem', { name: /^S05/ }).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: /R8 の初期ルール S05/ })).toBeVisible();
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.group"] [data-field-error]')).toBeVisible();
      await shoot(page, 'T12', 'form-template-s05-pc');
      // ひな形のまま（入力を変えていない）なら、確かめずに閉じる
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(sheet).toBeHidden();
      await page.setViewportSize(MOBILE);
      await shoot(page, 'T12', 'state-empty-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T12 確定中（メモだけ直せる）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      await waitList(page);
      await expect(page.getByTestId('read-only-notice')).toBeVisible();
      await shoot(page, 'T12', 'confirmed-pc');
      await page.locator(`[data-row-id="${s.ids.rules['S05']}"]`).getByRole('button', { name: 'S05 のメモを直す' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: 'ルール S05 のメモを直す' })).toBeVisible();
      await shoot(page, 'T12', 'confirmed-memo-sheet-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T12 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T12 権限なし（PC・スマホ）', async ({ page }) => {
    await page.setViewportSize(PC);
    await page.goto('/rules/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T12', 'state-forbidden-pc');
    await page.setViewportSize(MOBILE);
    await shoot(page, 'T12', 'state-forbidden-mobile');
  });
});
