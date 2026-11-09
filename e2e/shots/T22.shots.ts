// T22 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T22` で notes/T22/ に撮る（CI では流さない）。
// 在庫入力（スマホ）の「備品（数えるだけ）」と「その他を足す」のダイアログ、在庫一覧（PC）の2つ目の表、マスタ設定の品目のタブの欄。
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const ALWAYS = ['ゴミ箱', '延長コード', '扇風機', 'オレンジ椅子'] as const;
const input = (page: Page, name: string) => page.getByRole('textbox', { name: `${name}の数` });

async function alwaysIds(): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; name: string }>('select id, name from public.count_items where always_shown and name = any($1::text[])', [[...ALWAYS]]);
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

async function removeCountItems(names: readonly string[]): Promise<void> {
  await sql('delete from public.count_stocks where count_item_id in (select id from public.count_items where name = any($1::text[]))', [[...names]]);
  await sql('delete from public.count_items where name = any($1::text[])', [[...names]]);
}

test.describe('T22 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T22 在庫入力（スマホ）の備品（数えるだけ）とその他のダイアログ、在庫一覧（PC）の表', async ({ page }) => {
    const suffix = randomBytes(3).toString('hex');
    // 撮影用の名前（白椅子などの本番の選択肢に似せる。E2E- で始めて残り物を消せるようにする）
    const names = [`E2E-白椅子-${suffix}`, `E2E-台形机-${suffix}`, `E2E-掃除機-${suffix}`];
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      for (const [i, n] of names.entries()) await sql('insert into public.count_items (name, sort_order) values ($1, $2)', [n, 9101 + i]);
      const ids = Object.fromEntries((await sql<{ id: string; name: string }>('select id, name from public.count_items where name = any($1::text[])', [names])).map((r) => [r.name, r.id]));
      const always = await alwaysIds();
      const put = (year: string, room: string, id: string, n: number) =>
        sql('insert into public.count_stocks (year_id, room_id, count_item_id, count) values ($1, $2, $3, $4)', [year, room, id, n]);
      // 前年度と今年の数（倉庫A は白椅子を数えている。倉庫B はゴミ箱と扇風機だけ）
      await put(s.prevYearId!, roomA, always['ゴミ箱']!, 3);
      await put(s.prevYearId!, roomA, always['延長コード']!, 5);
      await put(s.prevYearId!, roomA, ids[names[0]!]!, 6);
      await put(s.prevYearId!, roomB, always['扇風機']!, 2);
      await put(s.yearId, roomA, always['ゴミ箱']!, 4);
      await put(s.yearId, roomA, always['延長コード']!, 5);
      await put(s.yearId, roomA, always['オレンジ椅子']!, 11);
      await put(s.yearId, roomA, ids[names[0]!]!, 8);
      await put(s.yearId, roomB, always['ゴミ箱']!, 2);
      await put(s.yearId, roomB, always['扇風機']!, 3);

      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(input(page, 'ゴミ箱')).toHaveValue('4');
      await expect(page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
      await page.getByTestId('count-items-section').scrollIntoViewIfNeeded();
      await page.getByTestId('count-item-add').scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'stock-count-section-mobile');
      await shoot(page, 'T22', 'stock-input-mobile-full', { fullPage: true });

      await page.getByTestId('count-item-add').click();
      const dialog = page.getByTestId('add-count-item-dialog');
      await dialog.getByLabel('名前で絞る').fill('E2E-');
      await expect(dialog.getByTestId('add-count-item-option').filter({ hasText: names[1]! })).toBeVisible();
      await shoot(page, 'T22', 'add-count-item-dialog-mobile');
      // 名前の誤り（51 字）
      await dialog.getByLabel('新しい名前で足す').fill('あ'.repeat(51));
      await dialog.getByRole('button', { name: '新しい名前で足す' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await shoot(page, 'T22', 'add-count-item-dialog-error-mobile');
      await dialog.getByLabel('新しい名前で足す').fill('');
      await dialog.getByLabel('名前で絞る').fill(names[1]!);
      await dialog.getByTestId('add-count-item-option').click();
      await expect(input(page, names[1]!)).toHaveValue('0');
      await page.getByRole('list', { name: 'その他の数' }).scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'stock-count-added-mobile');

      await page.setViewportSize(PC);
      await page.goto('/stocks/');
      await expect(page.getByTestId('count-matrix')).toBeVisible();
      await expect(page.getByTestId('count-matrix').locator('[data-testid="count-matrix-row"]').first()).toBeVisible();
      // 表の中をシナリオの保管場所（E2E倉庫A・B）までスクロールする（上には、ほかのデータセットの使用不可の場所が並ぶ）
      const rowA = page.locator(`[data-testid="count-matrix-row"][data-room-id="${roomA}"]`);
      await page.getByTestId('count-matrix-section').scrollIntoViewIfNeeded();
      await rowA.scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'stocks-count-matrix-pc');
      await shoot(page, 'T22', 'stocks-pc-full', { fullPage: true });

      await page.setViewportSize(MOBILE);
      await rowA.scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'stocks-count-matrix-mobile');
    } finally {
      await s.cleanup();
      await removeCountItems(names);
    }
  });
});

test.describe('T22 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T22 マスタ設定の品目のタブの備品（数えるだけ）の欄と編集', async ({ page }) => {
    const name = `E2E-白椅子-${randomBytes(3).toString('hex')}`;
    try {
      await sql('insert into public.count_items (name, sort_order) values ($1, 9201)', [name]);
      await page.setViewportSize(PC);
      await page.goto('/settings/?tab=items');
      const section = page.getByTestId('count-items-settings');
      await expect(section.getByRole('row').filter({ hasText: name })).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'settings-count-items-pc');
      await section.getByRole('row').filter({ hasText: name }).getByRole('button', { name: '編集' }).click();
      await expect(page.getByTestId('count-item-form')).toBeVisible();
      await shoot(page, 'T22', 'settings-count-item-form-pc');
      await page.keyboard.press('Escape');

      await page.setViewportSize(MOBILE);
      await page.goto('/settings/?tab=items');
      await expect(section.getByRole('row').filter({ hasText: name })).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await shoot(page, 'T22', 'settings-count-items-mobile');
    } finally {
      await removeCountItems([name]);
    }
  });
});
