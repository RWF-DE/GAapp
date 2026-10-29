// T14 履歴のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep "T14 "` で notes/T14/ に撮る（CI では流さない）。
// 一覧（PC・スマホ）、絞り込んだ一覧、表の選び・した人の選び（ポップオーバー）、さらに読み込んだ後、空・読み込み中・権限なし。
import { expect, test, type Page, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

async function waitList(page: Page): Promise<void> {
  await expect(page.getByTestId('history-filters')).toBeVisible();
  await expect(page.getByTestId('history-row').first()).toBeVisible();
}

test.describe('T14 履歴 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T14 一覧・絞り込み・選びのポップオーバー・さらに読み込む・空・読み込み中', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', requestWindow: 'closed', roles: { admin: true, staff: true } });
    try {
      const stall = s.ids.groups[SMALL.groups.stall]!;
      const items = Object.values(s.ids.items);
      const storage = s.ids.rooms[SMALL.rooms.storageA]!;
      // 部員の在庫の数え直し（60 行。1 分おき）と、管理者の締切後の修正・使用不可・団体の削除の記録を足す
      const now = Date.now();
      const rows: unknown[] = [];
      for (let i = 0; i < 60; i++) {
        const item = items[i % items.length]!;
        rows.push({
          table_name: 'stocks',
          action: 'update',
          year_id: s.yearId,
          group_id: null,
          before: { year_id: s.yearId, room_id: storage, item_id: item, count: 10 + i, counted_by: SEED_USER_IDS.staff },
          after: { year_id: s.yearId, room_id: storage, item_id: item, count: 12 + i, counted_by: SEED_USER_IDS.staff },
          reason: null,
          user_id: SEED_USER_IDS.staff,
          at: new Date(now - (90 - i) * 60_000).toISOString(),
        });
      }
      rows.push(
        {
          table_name: 'requests',
          action: 'update',
          year_id: s.yearId,
          group_id: stall,
          before: { group_id: stall, item_id: items[0], count: 4 },
          after: { group_id: stall, item_id: items[0], count: 6 },
          reason: '締切後の修正（団体から連絡あり）',
          user_id: SEED_USER_IDS.admin,
          at: new Date(now - 20 * 60_000).toISOString(),
        },
        {
          table_name: 'room_years',
          action: 'insert',
          year_id: s.yearId,
          group_id: null,
          before: null,
          after: { year_id: s.yearId, room_id: storage, usable: false, note: '工事のため使えない' },
          reason: null,
          user_id: SEED_USER_IDS.admin,
          at: new Date(now - 10 * 60_000).toISOString(),
        },
        {
          table_name: 'groups',
          action: 'delete',
          year_id: s.yearId,
          group_id: '99999999-9999-4999-8999-999999999999',
          before: { id: '99999999-9999-4999-8999-999999999999', name: '取り下げた模擬店', category: 'stall', sort_order: 9 },
          after: null,
          reason: null,
          user_id: SEED_USER_IDS.admin,
          at: new Date(now - 5 * 60_000).toISOString(),
        },
      );
      await sql(
        `insert into public.audit_logs (table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at)
         select table_name, '{}'::jsonb, action, year_id, group_id, before, after, reason, user_id, at
         from jsonb_to_recordset($1::jsonb) as x(table_name text, action text, year_id uuid, group_id uuid,
                                                before jsonb, after jsonb, reason text, user_id uuid, at timestamptz)`,
        [JSON.stringify(rows)],
      );

      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      // 読み込み中（履歴の応答を止めて撮る）
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/rest/v1/audit_logs?*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await page.goto('/history/');
      await expect(page.getByTestId('history-filters')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T14', 'state-loading-pc');
      release();
      await waitList(page);
      await shoot(page, 'T14', 'list-pc');

      // さらに読み込む
      await page.getByRole('button', { name: 'さらに読み込む' }).click();
      await expect(page.getByTestId('history-shown')).not.toHaveText('50 件を表示');
      await page.getByTestId('history-shown').scrollIntoViewIfNeeded();
      await shoot(page, 'T14', 'load-more-pc');

      // 表の選び（ポップオーバー）
      await page.getByRole('combobox', { name: '表', exact: true }).click();
      await page.getByRole('checkbox', { name: '申請', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: '申請', exact: true })).toBeChecked();
      await page.getByRole('checkbox', { name: '場所の状態', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: '場所の状態', exact: true })).toBeChecked();
      await shoot(page, 'T14', 'table-select-pc');
      await page.keyboard.press('Escape');
      await waitList(page);
      await shoot(page, 'T14', 'list-filtered-pc');

      // した人の選び
      await page.goto('/history/');
      await waitList(page);
      await page.getByRole('combobox', { name: 'した人', exact: true }).click();
      await expect(page.getByRole('option', { name: 'テスト部員', exact: true })).toBeVisible();
      await shoot(page, 'T14', 'user-select-pc');
      await page.getByRole('option', { name: 'テスト部員', exact: true }).click();
      await expect(page.locator('[cmdk-root]')).toHaveCount(0);
      await waitList(page);
      await shoot(page, 'T14', 'list-by-user-pc');

      // 空（その日の変更がない）
      await page.goto('/history/?from=2001-01-01&to=2001-01-01');
      await expect(page.getByText('この条件の変更はありません')).toBeVisible();
      await shoot(page, 'T14', 'state-empty-pc');
      await page.setViewportSize(MOBILE);
      await shoot(page, 'T14', 'state-empty-mobile');
      await page.goto('/history/');
      await waitList(page);
      await shoot(page, 'T14', 'list-mobile');
    } finally {
      await s.cleanup();
      await sql('delete from public.audit_logs where year_id = $1', [s.yearId]);
    }
  });
});

test.describe('T14 履歴 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T14 権限なし（PC・スマホ）', async ({ page }) => {
    await page.setViewportSize(PC);
    await page.goto('/history/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T14', 'state-forbidden-pc');
    await page.setViewportSize(MOBILE);
    await shoot(page, 'T14', 'state-forbidden-mobile');
  });
});
