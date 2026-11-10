// T23 9 品目（items）の画像：マスタ設定の品目のタブで管理者が足す・替える（前の物は Storage から消える）、団体代表の /request に出る
// （04「マスタ設定」「申請」。D-61）。items は年度をまたぐ表で、画像は並行のテストの画面（在庫入力・申請の行）に出てしまうので、
// 並行の chromium では書かない（serial）。終わったら set_item_image(…, null) で外し、フォルダの物を Storage API で消す（SQL では消さない）。
// 画像だけの変更は振り分けの版を上げない（0022。振り分け中の年度の allocation_version が変わらないことも確かめる）。
import { expect, test } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { expectNoOverflow, expectNoSignedUrlStored, apiToken } from '../support/documents';
import { clearImageOf, folderOf, imagePathOf, makePhoto, storageListFolder } from '../support/item-images';
import { MOBILE, PC } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const ITEM_NAME = '机(木)';

test.use({ storageState: storageStateFor('admin') });

async function itemIdOf(code: string): Promise<string> {
  const [r] = await sql<{ id: string }>('select id from public.items where code = $1', [code]);
  if (!r) throw new Error(`items にありません：${code}`);
  return r.id;
}

test('T23 マスタ設定の品目のタブ：管理者が品目の画像を足して替えると前の物は消え、振り分けの版は上がらず、団体代表の /request に画像が出る', async ({
  page,
  browser,
}) => {
  const itemId = await itemIdOf('desk');
  // 前の実行の残り（画像）を外してから始める
  await clearImageOf('item', itemId);
  const allocating = await createScenario({ status: 'allocating' });
  const repScenario = await createScenario({ repGroup: SMALL.groups.stall });
  try {
    const versionOf = async () =>
      (await sql<{ v: number }>('select allocation_version as v from public.years where id = $1', [allocating.yearId]))[0]!.v;
    const before = await versionOf();
    const token = await apiToken('admin');

    await page.setViewportSize(PC);
    await page.goto('/settings/?tab=items');
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: ITEM_NAME, exact: true }) });
    await expect(row.getByTestId('item-image')).toHaveAttribute('data-state', 'none');

    // 足す
    await row.getByTestId('item-image-add').click();
    const dialog = page.getByTestId('item-photo-dialog');
    await expect(dialog.getByRole('heading', { name: `「${ITEM_NAME}」の画像を足す` })).toBeVisible();
    await dialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: await makePhoto(page) });
    await dialog.getByTestId('item-photo-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`「${ITEM_NAME}」の画像を足しました`)).toBeVisible();
    await expect(row.getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
    const first = await imagePathOf('item', itemId);
    expect(first).toMatch(new RegExp(`^items/${itemId}/[0-9a-f-]{36}\\.(webp|jpg)$`));
    expect(await storageListFolder(token, folderOf('item', itemId))).toEqual([first]);

    // 替える（前の物は Storage API で消える）
    await row.getByTestId('item-image-replace').click();
    await expect(dialog.getByRole('heading', { name: `「${ITEM_NAME}」の画像を替える` })).toBeVisible();
    await expect(dialog).toContainText('送ると前の画像は消えます');
    await dialog
      .getByTestId('item-photo-input')
      .setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: await makePhoto(page, { color: '#1d4ed8', label: 'E2E T23 new' }) });
    await dialog.getByTestId('item-photo-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`「${ITEM_NAME}」の画像を替えました`)).toBeVisible();
    const second = await imagePathOf('item', itemId);
    expect(second).not.toBe(first);
    await expect.poll(() => storageListFolder(token, folderOf('item', itemId))).toEqual([second]);
    await expect(row.getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
    // 押すと大きく出す
    await row.getByRole('button', { name: `${ITEM_NAME}の画像を大きく見る` }).click();
    await expect(page.getByTestId('item-image-large').getByRole('img', { name: ITEM_NAME })).toBeVisible();
    await page.keyboard.press('Escape');

    // 画像だけの変更は振り分けの版を上げない
    expect(await versionOf()).toBe(before);

    // 団体代表の /request（スマホ）：品目の行に画像（読むだけ。押すと大きく）
    const repContext = await browser.newContext({ storageState: storageStateFor('rep') });
    try {
      const rep = await repContext.newPage();
      await pinYear(rep, SEED_USER_IDS.rep, repScenario.yearId);
      await rep.setViewportSize(MOBILE);
      await rep.goto('/request/');
      await expect(rep.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
      const field = rep.getByTestId('request-field').filter({ has: rep.getByRole('textbox', { name: `${ITEM_NAME}の数`, exact: true }) });
      await expect(field.getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
      // 画像のない品目は頭文字のカード
      const chair = rep.getByTestId('request-field').filter({ has: rep.getByRole('textbox', { name: '椅子(木)の数', exact: true }) });
      await expect(chair.getByTestId('item-image')).toHaveAttribute('data-state', 'none');
      await field.getByRole('button', { name: `${ITEM_NAME}の画像を大きく見る` }).click();
      await expect(rep.getByTestId('item-image-large').getByRole('img', { name: ITEM_NAME })).toBeVisible();
      await rep.keyboard.press('Escape');
      await expectNoOverflow(rep);
      await expectNoSignedUrlStored(rep);
    } finally {
      await repContext.close();
    }

    // 外す（確かめの後）。物は Storage から消える
    await row.getByTestId('item-image-remove').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(`「${ITEM_NAME}」の画像を外しますか`);
    await confirm.getByRole('button', { name: '外す' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText(`「${ITEM_NAME}」の画像を外しました`)).toBeVisible();
    await expect(row.getByTestId('item-image')).toHaveAttribute('data-state', 'none');
    expect(await imagePathOf('item', itemId)).toBeNull();
    await expect.poll(() => storageListFolder(token, folderOf('item', itemId))).toEqual([]);
    expect(await versionOf()).toBe(before);
  } finally {
    await clearImageOf('item', itemId);
    await repScenario.cleanup();
    await allocating.cleanup();
  }
});
