// T22 マスタ設定の品目のタブの「備品（数えるだけ）」の欄（04「マスタ設定」。D-60）。
// 最初から出す（always_shown）物を足すと、並行の在庫入力のすべての場所に行が出て、その保存が数の行を書く。テストの途中で
// その物を消すと、並行の保存が 23503 で落ちるので、並行の chromium では書かない（serial）。名前は E2E-T22- で始め、終わったら消す
// （残っても db-setup の cleanupLeftovers が消す）。
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { sql } from '../support/db';
import { PC } from '../support/shots';

const ALWAYS = ['ゴミ箱', '延長コード', '扇風機', 'オレンジ椅子'] as const;

function uniqueName(tag: string): string {
  return `E2E-T22-${tag}-${randomBytes(4).toString('hex')}`;
}

async function removeCountItems(names: readonly string[]): Promise<void> {
  await sql('delete from public.count_stocks where count_item_id in (select id from public.count_items where name = any($1::text[]))', [[...names]]);
  await sql('delete from public.count_items where name = any($1::text[])', [[...names]]);
}

test.use({ storageState: storageStateFor('admin') });

test('T22 マスタ設定の品目のタブ：備品（数えるだけ）を足し、名前と「最初から出す」を直し、同じ名前は足せず、数のない物は削除できる', async ({ page }) => {
  const name = uniqueName('設定');
  const renamed = `${name}-改`;
  try {
    await page.setViewportSize(PC);
    await page.goto('/settings/?tab=items');
    const section = page.getByTestId('count-items-settings');
    await expect(section.getByRole('heading', { name: '備品（数えるだけ）' })).toBeVisible();
    for (const n of ALWAYS) await expect(section.getByRole('row').filter({ hasText: n })).toContainText('出す');

    await section.getByTestId('count-item-settings-add').click();
    const form = page.getByTestId('count-item-form');
    await form.getByLabel('名前').fill(name);
    await form.getByLabel('並び順').fill('9003');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form).toBeHidden();
    const row = () => section.getByRole('row').filter({ hasText: name });
    await expect(row()).toContainText('—');

    // 名前を直し、最初から出すにする
    await row().getByRole('button', { name: '編集' }).click();
    await form.getByLabel('名前').fill(renamed);
    await form.getByLabel('最初から出す（在庫入力のすべての場所に最初から行を出す）').check();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form).toBeHidden();
    await expect(section.getByRole('row').filter({ hasText: renamed })).toContainText('出す');
    const [saved] = await sql<{ always_shown: boolean; sort_order: number }>('select always_shown, sort_order from public.count_items where name = $1', [
      renamed,
    ]);
    expect(saved).toEqual({ always_shown: true, sort_order: 9003 });

    // 同じ名前（大文字小文字だけ違う）は足せない
    await section.getByTestId('count-item-settings-add').click();
    await form.getByLabel('名前').fill(renamed.toLowerCase());
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('同じ名前の物があります').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();

    // 削除（数の行がない）
    await section.getByRole('row').filter({ hasText: renamed }).getByRole('button', { name: '削除' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '削除する' }).click();
    // 確かめのダイアログが開いている間は後ろが aria-hidden で行が role で見えないので、閉じてから行がないことを確かめる
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(section.getByText(renamed, { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await sql('select 1 from public.count_items where name = $1', [renamed])).length).toBe(0);
  } finally {
    await removeCountItems([name, renamed]);
  }
});
