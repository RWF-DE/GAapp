import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T14 履歴（/history。画面の設計 3.12・7.2 の表の T14 の行）。シナリオの年度（createScenario）で閉じる。
// 履歴の行は、シナリオの1日目（2001 年）の日時で audit_logs に直接入れる（シナリオを作ったときの記録は今の日時なので、期間で分けられる）。
// 年度のない行（場所）は、そのテストの id で消す。シナリオの年度の行は cleanup の後に年度の id で消す（audit_logs を膨らませない）。

interface LogSeed {
  table_name: string;
  action?: 'insert' | 'update' | 'delete';
  year_id: string | null;
  group_id?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason: string;
  user_id?: string | null;
  at: string;
}

async function insertLogs(rows: LogSeed[]): Promise<number[]> {
  const json = rows.map((r) => ({
    table_name: r.table_name,
    row_pk: {},
    action: r.action ?? 'update',
    year_id: r.year_id,
    group_id: r.group_id ?? null,
    before: r.before === undefined ? { count: 1 } : r.before,
    after: r.after === undefined ? { count: 2 } : r.after,
    reason: r.reason,
    user_id: r.user_id ?? null,
    at: r.at,
  }));
  const res = await sql<{ id: string }>(
    `insert into public.audit_logs (table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at)
     select table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at
     from jsonb_to_recordset($1::jsonb) as x(table_name text, row_pk jsonb, action text, year_id uuid, group_id uuid,
                                            before jsonb, after jsonb, reason text, user_id uuid, at timestamptz)
     returning id`,
    [JSON.stringify(json)],
  );
  return res.map((r) => Number(r.id));
}

async function cleanupLogs(s: Scenario, ids: readonly number[]): Promise<void> {
  await s.cleanup();
  await sql('delete from public.audit_logs where year_id = $1 or id = any($2::bigint[])', [s.yearId, ids]);
}

async function reasons(page: Page): Promise<string[]> {
  return page.getByTestId('history-reason').allTextContents();
}

async function waitTable(page: Page): Promise<void> {
  await expect(page.getByTestId('history-filters')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '読み込み中' })).toHaveCount(0);
}

/** EntitySelect（cmdk）で名前を選び、ポップオーバーが閉じきるまで待つ */
async function pick(page: Page, label: string, name: string): Promise<void> {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveText(name);
  await expect(page.locator('[cmdk-root]')).toHaveCount(0);
}

async function toggleTable(page: Page, name: string, on: boolean): Promise<void> {
  await page.getByRole('combobox', { name: '表', exact: true }).click();
  const box = page.getByRole('checkbox', { name, exact: true });
  // 選んだ表は URL から読み直して表示するので、押した後に印が変わるのを待つ（check・uncheck は押した直後に確かめるため使わない）
  await box.click();
  if (on) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(0);
}

async function clearFilter(page: Page): Promise<void> {
  await page.getByTestId('history-filters').getByRole('button', { name: '絞り込みを消す' }).click();
  await expect(page).toHaveURL(/\/history\/?$/);
  await waitTable(page);
}

test.describe('T14 履歴（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T14 絞り込み：表（年度をまたぐ表は年度のない行も）・団体・期間（Asia/Tokyo の日付の境目）・した人。URL に入り、再読み込みでも残る', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', roles: { admin: true, staff: true } });
    const ids: number[] = [];
    try {
      const stall = s.ids.groups[SMALL.groups.stall]!;
      const dept = s.ids.groups[SMALL.groups.department]!;
      const item = Object.values(s.ids.items)[0]!;
      const Y = s.yearId;
      ids.push(
        ...(await insertLogs([
          // 期間：2001-10-01（Asia/Tokyo）の境目
          { table_name: 'stocks', year_id: Y, reason: 'T14-境界-前日', at: '2001-09-30T14:59:59Z' },
          { table_name: 'stocks', year_id: Y, reason: 'T14-境界-0時', at: '2001-09-30T15:00:00Z' },
          { table_name: 'stocks', year_id: Y, reason: 'T14-境界-終わり', at: '2001-10-01T14:59:59Z' },
          { table_name: 'stocks', year_id: Y, reason: 'T14-境界-翌日', at: '2001-10-01T15:00:00Z' },
          // 団体
          { table_name: 'requests', year_id: Y, group_id: stall, before: { group_id: stall, item_id: item, count: 3 }, after: { group_id: stall, item_id: item, count: 5 }, reason: 'T14-団体-模擬店', at: '2001-10-03T03:00:00Z' },
          { table_name: 'requests', year_id: Y, group_id: dept, after: { group_id: dept, item_id: item, count: 1 }, before: null, action: 'insert', reason: 'T14-団体-部門', at: '2001-10-03T03:01:00Z' },
          // した人
          { table_name: 'requests', year_id: Y, group_id: stall, user_id: SEED_USER_IDS.staff, reason: 'T14-した人-部員', at: '2001-10-04T03:00:00Z' },
          { table_name: 'stocks', year_id: Y, user_id: SEED_USER_IDS.admin, reason: 'T14-した人-管理者', at: '2001-10-04T03:01:00Z' },
          // 年度をまたぐ表（年度のない行）
          { table_name: 'rooms', year_id: null, before: null, after: { name: `T14-場所-${s.label}` }, action: 'insert', reason: `T14-場所-${s.label}`, at: '2001-10-05T03:00:00Z' },
        ])),
      );

      await pinYear(page, SEED_USER_IDS.admin, Y);
      await page.goto('/history/');
      await waitTable(page);
      await expect(page.getByRole('heading', { name: '履歴' })).toBeVisible();
      // 絞り込みなし：年度の行だけ（年度のない場所の行は出ない）。新しい順
      await expect(page.getByTestId('history-row').first()).toBeVisible();

      // 期間（Asia/Tokyo の日付。その日を含む）
      await page.getByLabel('期間の始め').fill('2001-10-01');
      await page.getByLabel('期間の終わり').fill('2001-10-01');
      await expect(page).toHaveURL(/from=2001-10-01/);
      await expect(page).toHaveURL(/to=2001-10-01/);
      await expect.poll(() => reasons(page)).toEqual(['T14-境界-終わり', 'T14-境界-0時']);
      await page.reload();
      await waitTable(page);
      await expect(page.getByLabel('期間の始め')).toHaveValue('2001-10-01');
      await expect.poll(() => reasons(page)).toEqual(['T14-境界-終わり', 'T14-境界-0時']);
      // 変更の列（diffAudit）と、アプリの外の変更
      await expect(page.getByTestId('history-diff').first()).toHaveText('count：1 → 2');
      await expect(page.getByTestId('history-actor').first()).toHaveText('SQL・seed（アプリの外）');
      await page.getByLabel('期間の始め').fill('1999-01-01');
      await page.getByLabel('期間の終わり').fill('1999-01-01');
      await expect(page.getByText('この条件の変更はありません')).toBeVisible();
      await clearFilter(page);

      // 表（日本語の名前・複数）。2001 年の行だけを見るため期間も付ける
      await page.goto('/history/?from=2001-09-01&to=2001-10-31');
      await waitTable(page);
      await toggleTable(page, '在庫', true);
      await expect(page).toHaveURL(/table=stocks/);
      await expect.poll(() => reasons(page)).toEqual(['T14-した人-管理者', 'T14-境界-翌日', 'T14-境界-終わり', 'T14-境界-0時', 'T14-境界-前日']);
      await expect(page.getByRole('combobox', { name: '表', exact: true })).toHaveText('在庫');
      // 場所（年度をまたぐ表）を足すと、年度のない行も出る（年度のない行はほかのテストのものも見えるので、自分の行で確かめる）
      await toggleTable(page, '場所', true);
      await expect(page).toHaveURL(/table=stocks%2Crooms|table=stocks,rooms/);
      const mine = page.getByTestId('history-row').filter({ hasText: `T14-場所-${s.label}` });
      await expect(mine).toHaveCount(1);
      await expect(mine).toHaveAttribute('data-table', 'rooms');
      await expect(mine.getByTestId('history-target')).toHaveText(`T14-場所-${s.label}`);
      await expect(mine.getByTestId('history-diff')).toHaveText(`name：T14-場所-${s.label}`);
      await toggleTable(page, '在庫', false);
      await expect(page).toHaveURL(/table=rooms(&|$)/);
      await expect(page.getByTestId('history-row').filter({ hasText: 'T14-境界-' })).toHaveCount(0);
      await expect(mine).toHaveCount(1);
      await expect.poll(async () => [...new Set(await page.getByTestId('history-row').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-table'))))]).toEqual(['rooms']);
      await clearFilter(page);

      // 団体
      await page.goto('/history/?from=2001-10-03&to=2001-10-03');
      await waitTable(page);
      await expect.poll(() => reasons(page)).toEqual(['T14-団体-部門', 'T14-団体-模擬店']);
      await pick(page, '団体', SMALL.groups.stall);
      await expect(page).toHaveURL(new RegExp(`group=${stall}`));
      await expect.poll(() => reasons(page)).toEqual(['T14-団体-模擬店']);
      const item0 = (await sql<{ name: string }>('select name from public.items where id = $1', [item]))[0]!.name;
      await expect(page.getByTestId('history-target')).toHaveText(`${SMALL.groups.stall}・${item0}`);
      await expect(page.getByTestId('history-diff')).toHaveText('count：3 → 5');
      await clearFilter(page);

      // した人（その年度のメンバーの表示名から・アプリの外）
      await page.goto('/history/?from=2001-10-04&to=2001-10-04');
      await waitTable(page);
      await pick(page, 'した人', 'テスト部員');
      await expect(page).toHaveURL(new RegExp(`user=${SEED_USER_IDS.staff}`));
      await expect.poll(() => reasons(page)).toEqual(['T14-した人-部員']);
      await expect(page.getByTestId('history-actor')).toHaveText('テスト部員');
      await pick(page, 'した人', 'テスト管理者');
      await expect.poll(() => reasons(page)).toEqual(['T14-した人-管理者']);
      await page.goto('/history/?from=2001-09-30&to=2001-10-04&user=outside');
      await waitTable(page);
      await expect(page.getByRole('combobox', { name: 'した人', exact: true })).toHaveText('SQL・seed（アプリの外）');
      await expect.poll(async () => (await reasons(page)).sort()).toEqual(
        ['T14-団体-部門', 'T14-団体-模擬店', 'T14-境界-翌日', 'T14-境界-終わり', 'T14-境界-0時', 'T14-境界-前日'].sort(),
      );
    } finally {
      await cleanupLogs(s, ids);
    }
  });

  test('T14 さらに読み込む：50 件ずつ、同じ日時の行も id で抜けも重なりもなく、新しい順に最後まで', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { admin: true } });
    const ids: number[] = [];
    try {
      // 120 行：最初の 60 行は同じ日時（ページの境目が同じ at の中に来る）、残りは 1 秒ずつ前
      const rows: LogSeed[] = Array.from({ length: 120 }, (_, i) => ({
        table_name: 'substitution_consents',
        year_id: s.yearId,
        reason: `T14-続き-${String(i).padStart(3, '0')}`,
        at: i < 60 ? '2001-10-10T03:00:00Z' : new Date(Date.UTC(2001, 9, 10, 2, 59, 0) - (i - 60) * 1000).toISOString(),
      }));
      ids.push(...(await insertLogs(rows)));
      const expected = (
        await sql<{ reason: string }>(
          `select reason from public.audit_logs where id = any($1::bigint[]) order by at desc, id desc`,
          [ids],
        )
      ).map((r) => r.reason);

      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/history/?table=substitution_consents&from=2001-10-10&to=2001-10-10');
      await waitTable(page);
      await expect(page.getByRole('combobox', { name: '表', exact: true })).toHaveText('了承');
      await expect.poll(() => reasons(page)).toEqual(expected.slice(0, 50));
      await expect(page.getByTestId('history-shown')).toHaveText('50 件を表示');

      const more = page.getByRole('button', { name: 'さらに読み込む' });
      await more.click();
      await expect.poll(() => reasons(page)).toEqual(expected.slice(0, 100));
      await more.click();
      await expect.poll(() => reasons(page)).toEqual(expected);
      await expect(page.getByTestId('history-shown')).toHaveText('120 件を表示');
      await expect(more).toHaveCount(0);
      await expect(page.getByText('これより前の変更はありません')).toBeVisible();
    } finally {
      await cleanupLogs(s, ids);
    }
  });
});

test.describe('T14 履歴（管理者でない）', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T14 部員が URL で開くと「権限がありません」', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/history/');
      await expect(page.getByText('権限がありません', { exact: true })).toBeVisible();
      await expect(page.getByTestId('history-filters')).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });
});
