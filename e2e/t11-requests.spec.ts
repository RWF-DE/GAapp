// T11 申請一覧 /requests（総務。PC）の E2E（画面の設計 3.6・7.2）。シナリオの年度で閉じる。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SMALL } from './support/datasets';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

async function countOf(groupId: string, code: string): Promise<number | null> {
  const rows = await sql<{ count: number }>(
    'select r.count from public.requests r join public.items i on i.id = r.item_id where r.group_id = $1 and i.code = $2',
    [groupId, code],
  );
  return rows[0]?.count ?? null;
}

const cell = (page: Page, group: string, item: string) => page.getByRole('textbox', { name: `${group}の${item}`, exact: true });

async function typeCell(page: Page, group: string, item: string, value: string) {
  const c = cell(page, group, item);
  await c.fill(value);
  await c.press('Enter');
}

test.describe('T11 申請一覧（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T11 申請一覧：締切前はセルを直接保存し、ほかの人が先に変えたセルは読み直した値に戻して印をつける', async ({ page }) => {
    const s = await createScenario({ roles: { admin: true } });
    try {
      const stall = s.ids.groups[SMALL.groups.stall]!;
      const dept = s.ids.groups[SMALL.groups.department]!;
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await expect(cell(page, SMALL.groups.stall, '机(木)')).toHaveValue('3');
      await expect(page.getByTestId('deadline-text')).toContainText('締切');

      await typeCell(page, SMALL.groups.stall, '机(木)', '5');
      await typeCell(page, SMALL.groups.department, '教卓', '1');
      // 保存の前に、ほかの人が部門の机(木)を変えた
      await typeCell(page, SMALL.groups.department, '机(木)', '8');
      await sql(
        "update public.requests set count = 4 where group_id = $1 and item_id = (select id from public.items where code = 'desk')",
        [dept],
      );
      await page.getByRole('button', { name: '保存（3件）' }).click();
      await expect(page.getByTestId('save-error')).toContainText('2 件を保存しました。1 件は保存できませんでした');
      expect(await countOf(stall, 'desk')).toBe(5);
      expect(await countOf(dept, 'lectern')).toBe(1);
      expect(await countOf(dept, 'desk')).toBe(4);
      await expect(cell(page, SMALL.groups.department, '机(木)')).toHaveValue('4');
      await expect(page.locator(`[data-cell="${SMALL.groups.department}:desk"]`)).toHaveAttribute('data-mark', 'conflict');
      await expect(page.getByRole('button', { name: '保存（0件）' })).toBeDisabled();

      // 編集した後にほかの人が同じセルを変え、「読み直す」→ 読み直した値に戻して印をつける（古い値で上書きしない）
      await typeCell(page, SMALL.groups.stall, '机(木)', '7');
      await sql(
        "update public.requests set count = 9 where group_id = $1 and item_id = (select id from public.items where code = 'desk')",
        [stall],
      );
      await page.getByRole('button', { name: '読み直す' }).click();
      await expect(cell(page, SMALL.groups.stall, '机(木)')).toHaveValue('9');
      await expect(page.locator(`[data-cell="${SMALL.groups.stall}:desk"]`)).toHaveAttribute('data-mark', 'conflict');
      await expect(page.getByRole('button', { name: '保存（0件）' })).toBeDisabled();
      expect(await countOf(stall, 'desk')).toBe(9);
    } finally {
      await s.cleanup();
    }
  });

  test('T11 申請一覧：締切後は理由をつけて団体ごとに保存し、audit_logs に理由が残る', async ({ page }) => {
    const s = await createScenario({ roles: { admin: true }, requestWindow: 'closed' });
    try {
      const stall = s.ids.groups[SMALL.groups.stall]!;
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await expect(page.getByTestId('deadline-text')).toHaveText('締切後（変更には理由が要ります）');
      await typeCell(page, SMALL.groups.stall, '机(木)', '6');
      await page.getByRole('button', { name: '保存（1件）' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('理由（必須）').fill('E2E 締切後の修正');
      await dialog.getByRole('button', { name: '保存する' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('1 団体の申請を保存しました')).toBeVisible();
      expect(await countOf(stall, 'desk')).toBe(6);
      const logs = await sql<{ reason: string | null; action: string }>(
        "select reason, action from public.audit_logs where table_name = 'requests' and group_id = $1 and year_id = $2 order by id desc limit 1",
        [stall, s.yearId],
      );
      expect(logs[0]).toEqual({ reason: 'E2E 締切後の修正', action: 'update' });
    } finally {
      await s.cleanup();
    }
  });

  test('T11 申請一覧：休憩所の代理入力で「前年の数を入れる」と前年度の数が入り、提出できる', async ({ page }) => {
    const s = await createScenario({
      roles: { admin: true },
      extraGroups: [{ name: '休憩所1', category: 'rest_area' }],
      prevYear: { dataset: 'synthetic' },
    });
    try {
      const rest = s.ids.groups['休憩所1']!;
      const prev = await sql<{ code: string; name: string; count: number }>(
        `select i.code, i.name, r.count from public.requests r join public.groups g on g.id = r.group_id
         join public.items i on i.id = r.item_id where g.year_id = $1 and g.name = '休憩所1'`,
        [s.prevYearId],
      );
      expect(prev.some((p) => p.count > 0)).toBe(true);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/?category=rest_area');
      const row = page.locator('tr[data-group-name="休憩所1"]');
      await row.getByRole('button', { name: '代理入力' }).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: '代理入力：休憩所1' })).toBeVisible();
      await sheet.getByRole('button', { name: '前年の数を入れる' }).click();
      for (const p of prev) {
        await expect(sheet.getByRole('textbox', { name: `${p.name}の数`, exact: true })).toHaveValue(String(p.count));
      }
      await sheet.getByRole('button', { name: '提出する' }).click();
      await expect(sheet).toHaveCount(0);
      for (const p of prev) expect(await countOf(rest, p.code)).toBe(p.count);
      const sub = await sql<{ submitted_at: Date | null }>('select submitted_at from public.request_submissions where group_id = $1', [rest]);
      expect(sub[0]?.submitted_at).toBeTruthy();
      await expect(row.getByTestId('submitted-cell')).not.toHaveText('未提出');
    } finally {
      await s.cleanup();
    }
  });

  test('T11 申請一覧：締切前に「提出済みにする」と提出日時が入る（未提出に戻す操作はない）', async ({ page }) => {
    const s = await createScenario({ roles: { admin: true }, extraGroups: [{ name: 'E2E休憩所', category: 'rest_area' }] });
    try {
      const rest = s.ids.groups['E2E休憩所']!;
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/?filter=unsubmitted');
      await expect(page.getByTestId('unsubmitted')).toContainText('E2E休憩所');
      const row = page.locator('tr[data-group-name="E2E休憩所"]');
      await row.getByRole('button', { name: '提出済みにする' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '提出済みにする' }).click();
      await expect(page.getByText('E2E休憩所を提出済みにしました')).toBeVisible();
      const sub = await sql<{ submitted_at: Date | null }>('select submitted_at from public.request_submissions where group_id = $1', [rest]);
      expect(sub[0]?.submitted_at).toBeTruthy();
      await expect(page.getByText('未提出に戻す')).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T11 申請一覧（部員）', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T11 申請一覧：部員は読み取りだけ', async ({ page }) => {
    const s = await createScenario({ roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/requests/');
      await expect(page.getByTestId('requests-table')).toBeVisible();
      await expect(page.getByTestId('read-only-notice')).toHaveText('部員は申請一覧を見るだけです');
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /保存|代理入力|提出済みにする/ })).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });
});
