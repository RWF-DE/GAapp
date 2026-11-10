// T22 備品（数えるだけ）：在庫入力の「備品（数えるだけ）」と「その他」・在庫一覧の2つ目の表・マスタ設定の品目のタブ（04・D-60）。
// どのテストもシナリオの年度（createScenario）で閉じる。count_items は年度をまたぐ表なので、テストが足す名前は E2E-T22- で始まる
// 乱数つきの名前にし（並行のテストと重ならない）、finally で消す（残れば db-setup の cleanupLeftovers が消す）。
// count_items に行を足しても振り分けの版は上がらない（D-60）ので、最初から出さない名前は並行のテストの途中で足してよい
// （ほかのテストの在庫入力には出ない）。最初から出す物を変えるテスト（マスタ設定の編集）は、並行の在庫入力の保存に効くので
// serial（e2e/serial/t22-count-items.spec.ts）に置く。
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SMALL } from './support/datasets';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

/** マイグレーション 0021 が入れる「最初から出す」4つ（並び順） */
const ALWAYS = ['ゴミ箱', '延長コード', '扇風機', 'オレンジ椅子'] as const;

const input = (page: Page, name: string) => page.getByRole('textbox', { name: `${name}の数` });
const plus = (page: Page, name: string) => page.getByRole('button', { name: `${name}の数を1増やす` });
const save = (page: Page) => page.getByRole('button', { name: '保存', exact: true });
const countRow = (page: Page, name: string) => page.getByTestId('count-item-row').filter({ hasText: name });

/** テストごとの名前（E2E-T22-<tag>-<乱数>） */
function uniqueName(tag: string): string {
  return `E2E-T22-${tag}-${randomBytes(4).toString('hex')}`;
}

async function countItemId(name: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select id from public.count_items where name = $1', [name]);
  if (!row) throw new Error(`count_items にありません：${name}`);
  return row.id;
}

async function alwaysIds(): Promise<Record<(typeof ALWAYS)[number], string>> {
  const rows = await sql<{ id: string; name: string }>('select id, name from public.count_items where always_shown and name = any($1::text[])', [[...ALWAYS]]);
  return Object.fromEntries(rows.map((r) => [r.name, r.id])) as Record<(typeof ALWAYS)[number], string>;
}

/** テストが足した名前を消す（数の行は年度とともに消えている） */
async function removeCountItems(names: readonly string[]): Promise<void> {
  await sql(
    'delete from public.count_stocks where count_item_id in (select id from public.count_items where name = any($1::text[]))',
    [[...names]],
  );
  await sql('delete from public.count_items where name = any($1::text[])', [[...names]]);
}

async function confirmNotLatest(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('最新でない年度');
  await dialog.getByRole('button', { name: 'この年度に保存する' }).click();
}

/** 在庫入力が読み込み終わるまで待つ（t10-stock の waitInput と同じ印） */
async function waitInput(page: Page): Promise<void> {
  await expect(page.getByTestId('count-items-section')).toBeVisible();
  await expect(page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
}

test.describe('T22 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T22 在庫入力（390px）：4つの行が出て、その他を一覧と新しい名前で足して保存すると、読み直しても残り、新しい名前はほかの場所でも選べる', async ({
    page,
  }) => {
    const listed = uniqueName('選択');
    const created = uniqueName('新規');
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      // 選択肢にだけある物（どの場所にも数の行がない）
      await sql('insert into public.count_items (name, sort_order) values ($1, 9001)', [listed]);
      const listedId = await countItemId(listed);
      const always = await alwaysIds();

      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageA);
      await waitInput(page);

      // 9 品目の下に、最初から出す4つ（並び順）。その他はまだない
      const section = page.getByTestId('count-items-section');
      await expect(section.getByRole('heading', { name: '備品（数えるだけ）' })).toBeVisible();
      await expect(section.getByRole('list', { name: '備品（数えるだけ）の数' }).getByTestId('count-item-row')).toHaveText(
        ALWAYS.map((n) => new RegExp(n)),
      );
      for (const n of ALWAYS) await expect(input(page, n)).toHaveValue('0');
      await expect(page.getByTestId('count-others-empty')).toBeVisible();

      await plus(page, 'ゴミ箱').click();
      await plus(page, 'ゴミ箱').click();
      await input(page, '扇風機').fill('3');
      await input(page, '扇風機').press('Enter');

      // 一覧から選ぶ（名前で絞る）
      await page.getByTestId('count-item-add').click();
      const dialog = page.getByTestId('add-count-item-dialog');
      await expect(dialog.getByRole('heading', { name: 'その他を足す' })).toBeVisible();
      // 最初から出す物は選択肢に出ない
      await expect(dialog.getByTestId('add-count-item-option').filter({ hasText: 'ゴミ箱' })).toHaveCount(0);
      await dialog.getByLabel('名前で絞る').fill(listed);
      await expect(dialog.getByTestId('add-count-item-option')).toHaveText([listed]);
      await dialog.getByTestId('add-count-item-option').click();
      await expect(dialog).toBeHidden();
      await expect(input(page, listed)).toHaveValue('0');
      await input(page, listed).fill('4');
      await input(page, listed).press('Enter');

      // 新しい名前で足す（前後の空白は除いて送る）
      await page.getByTestId('count-item-add').click();
      await dialog.getByLabel('新しい名前で足す').fill(`  ${created}  `);
      await dialog.getByRole('button', { name: '新しい名前で足す' }).click();
      await expect(dialog).toBeHidden();
      await expect(input(page, created)).toHaveValue('0');
      await plus(page, created).click();
      await expect(page.getByRole('list', { name: 'その他の数' }).getByTestId('count-item-row')).toHaveText([new RegExp(listed), new RegExp(created)]);
      const createdId = await countItemId(created);

      await save(page).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-saved')).toContainText('保存しました');
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);

      // 出ている行を全部（0 を含む）書いた。数えた人は部員
      const rows = await sql<{ count_item_id: string; count: number; counted_by: string | null }>(
        'select count_item_id, count, counted_by from public.count_stocks where year_id = $1 and room_id = $2',
        [s.yearId, roomA],
      );
      const byId = new Map(rows.map((r) => [r.count_item_id, r]));
      expect(byId.size).toBe(ALWAYS.length + 2);
      expect(byId.get(always['ゴミ箱'])!.count).toBe(2);
      expect(byId.get(always['延長コード'])!.count).toBe(0);
      expect(byId.get(always['扇風機'])!.count).toBe(3);
      expect(byId.get(always['オレンジ椅子'])!.count).toBe(0);
      expect(byId.get(listedId)!.count).toBe(4);
      expect(byId.get(createdId)!.count).toBe(1);
      expect(rows.every((r) => r.counted_by === SEED_USER_IDS.staff)).toBe(true);
      // 足した名前は前後の空白なし・最初から出さない
      const [made] = await sql<{ always_shown: boolean }>('select always_shown from public.count_items where id = $1', [createdId]);
      expect(made!.always_shown).toBe(false);

      // 読み直しても残る（数の行がある物は「その他」に出る）
      await page.reload();
      await waitInput(page);
      await expect(input(page, 'ゴミ箱')).toHaveValue('2');
      await expect(input(page, '扇風機')).toHaveValue('3');
      await expect(input(page, listed)).toHaveValue('4');
      await expect(input(page, created)).toHaveValue('1');
      await expect(page.getByTestId('count-others-empty')).toHaveCount(0);

      // ほかの場所：その他はまだないが、足した名前を選べる（同じ名前を書けば新しく足さずにその物を出す）
      await page.goto(`/stock/?room=${roomB}`);
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageB);
      await waitInput(page);
      await expect(page.getByTestId('count-others-empty')).toBeVisible();
      await page.getByTestId('count-item-add').click();
      await dialog.getByLabel('名前で絞る').fill('E2E-T22-');
      await expect(dialog.getByTestId('add-count-item-option').filter({ hasText: created })).toHaveCount(1);
      await dialog.getByLabel('新しい名前で足す').fill(created.toLowerCase());
      await dialog.getByRole('button', { name: '新しい名前で足す' }).click();
      await expect(dialog).toBeHidden();
      await expect(input(page, created)).toHaveValue('0');
      const [same] = await sql<{ n: number }>('select count(*)::int as n from public.count_items where lower(name) = lower($1)', [created]);
      expect(same!.n).toBe(1);
    } finally {
      await s.cleanup();
      await removeCountItems([listed, created]);
    }
  });

  test('T22 前年の数：在庫入力に前年の数、在庫一覧の「備品（数えるだけ）」の表に前年との差が出る', async ({ page }) => {
    const prevOnly = uniqueName('前年');
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      const always = await alwaysIds();
      await sql('insert into public.count_items (name, sort_order) values ($1, 9002)', [prevOnly]);
      const prevOnlyId = await countItemId(prevOnly);
      // 前年度：倉庫A のゴミ箱 3・延長コード 5・前年だけの物 2。今年：倉庫A のゴミ箱 4・延長コード 5
      await sql(
        `insert into public.count_stocks (year_id, room_id, count_item_id, count) values
           ($1, $2, $3, 3), ($1, $2, $4, 5), ($1, $2, $5, 2)`,
        [s.prevYearId, roomA, always['ゴミ箱'], always['延長コード'], prevOnlyId],
      );
      await sql('insert into public.count_stocks (year_id, room_id, count_item_id, count) values ($1, $2, $3, 4), ($1, $2, $4, 5)', [
        s.yearId,
        roomA,
        always['ゴミ箱'],
        always['延長コード'],
      ]);

      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page);
      await expect(input(page, 'ゴミ箱')).toHaveValue('4');
      await expect(countRow(page, 'ゴミ箱').getByTestId('stock-prev')).toHaveText('前年 3');
      await expect(countRow(page, '延長コード').getByTestId('stock-prev')).toHaveText('前年 5');
      // 数の行がない物は前年も 0（数の行がなければ 0。04「在庫入力」）
      await expect(countRow(page, '扇風機').getByTestId('stock-prev')).toHaveText('前年 0');
      // 前年だけに数がある物は、今年の「その他」には出ない（選択肢から足せる）
      await expect(countRow(page, prevOnly)).toHaveCount(0);

      await page.setViewportSize(PC);
      await page.goto('/stocks/');
      const section = page.getByTestId('count-matrix-section');
      await expect(section.getByRole('heading', { name: '備品（数えるだけ）' })).toBeVisible();
      const table = page.getByTestId('count-matrix');
      // 列：最初から出す4つと、前年に数がある物
      await expect(table.locator('thead th')).toHaveText(['保管場所', ...ALWAYS, prevOnly, '合計']);
      const rowA = table.locator(`[data-testid="count-matrix-row"][data-room-id="${roomA}"]`);
      await expect(rowA.locator(`td[data-item-id="${always['ゴミ箱']}"]`)).toHaveText('4（+1）');
      await expect(rowA.locator(`td[data-item-id="${always['延長コード']}"]`)).toHaveText('5（±0）');
      await expect(rowA.locator(`td[data-item-id="${prevOnlyId}"]`)).toHaveText('0（−2）');
      const rowB = table.locator(`[data-testid="count-matrix-row"][data-room-id="${roomB}"]`);
      await expect(rowB.locator(`td[data-item-id="${always['ゴミ箱']}"]`)).toHaveText('0（±0）');
      await expect(page.getByTestId('count-total-usable').locator(`td[data-item-id="${always['ゴミ箱']}"]`)).toHaveText('4（+1）');
      // 「まだ数えていない場所」は机椅子の在庫だけで決める（small の保管場所はすべて数えてある）
      await expect(page.getByTestId('uncounted-rooms')).not.toContainText(SMALL.rooms.storageB);
    } finally {
      await s.cleanup();
      await removeCountItems([prevOnly]);
    }
  });

  test('T22 振り分け中：部員には備品（数えるだけ）も読み取り専用（「＋ その他を足す」がない）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page);
      await expect(input(page, 'ゴミ箱')).toBeDisabled();
      await expect(page.getByTestId('count-item-add')).toHaveCount(0);
      await expect(save(page)).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T22 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T22 マスタ設定の品目のタブ：数が入力された物は削除できない', async ({ page }) => {
    const name = uniqueName('使用中');
    const s = await createScenario({ status: 'requesting', roles: { admin: true } });
    try {
      await sql('insert into public.count_items (name, sort_order) values ($1, 9004)', [name]);
      const id = await countItemId(name);
      await sql('insert into public.count_stocks (year_id, room_id, count_item_id, count) values ($1, $2, $3, 1)', [
        s.yearId,
        s.ids.rooms[SMALL.rooms.storageA]!,
        id,
      ]);
      await page.setViewportSize(PC);
      await page.goto('/settings/?tab=items');
      const section = page.getByTestId('count-items-settings');
      await section.getByRole('row').filter({ hasText: name }).getByRole('button', { name: '削除' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('数が入力された物は削除できません').first()).toBeVisible();
      expect(await sql('select 1 from public.count_items where id = $1', [id])).toHaveLength(1);
    } finally {
      await s.cleanup();
      await removeCountItems([name]);
    }
  });
});
