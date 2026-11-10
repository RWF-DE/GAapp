// T23 品目の画像：在庫入力の「新しく登録」の写真・行の画像・「その他を足す」の画像のカード・行のメニューの「写真を足す」（04「在庫入力」。D-61）。
// どのテストもシナリオの年度（createScenario）で閉じる。count_items は年度をまたぐ表なので、テストが足す名前は E2E-T23- で始まる乱数つきの
// 名前にし（並行のテストと重ならない）、finally で行を消してから、そのフォルダの Storage の物を Storage API で消す（SQL では消さない。
// 残れば db-setup の removeLeftoverItemImages が消す）。count_items の画像は振り分けの版に効かない（D-60・D-61）ので並行で流す。
// 9 品目（items）の画像を変えるテスト（管理者の画像の替え・団体代表の /request の画像）は、並行のテストの画面に画像が出てしまうので
// serial（e2e/serial/t23-item-images.spec.ts）に置く。写真はテストの中で canvas で作る（実物の写真・個人名なし）。
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SMALL } from './support/datasets';
import { expectNoOverflow, expectNoSignedUrlStored } from './support/documents';
import { imagePathOf, ITEM_IMAGES_BUCKET, makePhoto, objectMetaOf, removeFolderObjects } from './support/item-images';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

const input = (page: Page, name: string) => page.getByRole('textbox', { name: `${name}の数` });
const countRow = (page: Page, name: string) => page.getByTestId('count-item-row').filter({ hasText: name });

function uniqueName(tag: string): string {
  return `E2E-T23-${tag}-${randomBytes(4).toString('hex')}`;
}

async function countItemId(name: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select id from public.count_items where name = $1', [name]);
  if (!row) throw new Error(`count_items にありません：${name}`);
  return row.id;
}

/** テストが足した名前を消し、そのフォルダの Storage の物を Storage API で消す（行を消すと、物はどの行にも使われていない物になる） */
async function removeCountItemsWithImages(names: readonly string[]): Promise<void> {
  const ids = (await sql<{ id: string }>('select id from public.count_items where name = any($1::text[])', [[...names]])).map((r) => r.id);
  await sql('delete from public.count_stocks where count_item_id = any($1::uuid[])', [ids]);
  await sql('delete from public.count_items where id = any($1::uuid[])', [ids]);
  for (const id of ids) await removeFolderObjects('count_item', id);
}

async function waitInput(page: Page): Promise<void> {
  await expect(page.getByTestId('count-items-section')).toBeVisible();
  await expect(page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
}

test.describe('T23 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T23 在庫入力（390px）：写真つきで新しく登録すると、行に画像が出て、ほかの場所の「その他を足す」に画像のカードが出る', async ({ page }) => {
    const name = uniqueName('写真');
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page);
      // 横長の大きい写真（長い辺 1024px・WebP に作り直して送る）
      const photo = await makePhoto(page, { width: 2400, height: 1600 });

      await page.getByTestId('count-item-add').click();
      const dialog = page.getByTestId('add-count-item-dialog');
      await dialog.getByLabel('新しく登録する名前').fill(name);
      await expect(dialog.getByText('人の顔・名前・掲示物が写らないように撮ってください')).toBeVisible();
      await dialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: photo });
      await expect(dialog.getByTestId('item-photo-preview')).toBeVisible();
      await dialog.getByRole('button', { name: '新しく登録' }).click();
      await expect(dialog).toBeHidden();
      await expect(input(page, name)).toHaveValue('0');

      // 行の画像（読み込み終わる）
      await expect(countRow(page, name).getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
      const id = await countItemId(name);
      const path = await imagePathOf('count_item', id);
      expect(path).toMatch(new RegExp(`^count-items/${id}/[0-9a-f-]{36}\\.(webp|jpg)$`));
      // 届いた物は作り直した物（WebP。1 MiB 以下）
      const meta = await objectMetaOf(path!);
      expect(meta?.mimetype).toBe('image/webp');
      expect(meta!.size).toBeLessThanOrEqual(1024 * 1024);
      expect(meta!.size).toBeLessThan(photo.length);
      // 押すと大きく出す
      await countRow(page, name).getByRole('button', { name: `${name}の画像を大きく見る` }).click();
      const large = page.getByTestId('item-image-large');
      await expect(large.getByRole('img', { name })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(large).toBeHidden();
      await expectNoOverflow(page);

      // 行のメニューは「写真を替える」
      await countRow(page, name).getByTestId('count-item-menu').click();
      await expect(page.getByTestId('count-item-photo')).toHaveText('写真を替える');
      await page.keyboard.press('Escape');

      // 署名つき URL は下書き・ブラウザの保存に残らない
      await expectNoSignedUrlStored(page);

      // ほかの場所：選択肢に画像のカード（画像と名前）
      await page.goto(`/stock/?room=${roomB}`);
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageB);
      await waitInput(page);
      await page.getByTestId('count-item-add').click();
      await dialog.getByLabel('名前で絞る').fill(name);
      const option = dialog.getByTestId('add-count-item-option');
      await expect(option).toHaveText([name]);
      await expect(option.getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
      // カードは押せる大きさ（44px 以上）
      const box = await option.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await option.click();
      await expect(dialog).toBeHidden();
      await expect(countRow(page, name).getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
    } finally {
      await s.cleanup();
      await removeCountItemsWithImages([name]);
    }
  });

  test('T23 在庫入力：画像の段で失敗しても名前は登録され、行のメニューの「写真を足す」で後から足せる', async ({ page }) => {
    const name = uniqueName('後から');
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page);
      const photo = await makePhoto(page, { color: '#b45309' });

      // Storage への upload だけを落とす（通信の失敗）
      const uploadUrl = new RegExp(`/storage/v1/object/${ITEM_IMAGES_BUCKET}/count-items/`);
      await page.route(uploadUrl, (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
      await page.getByTestId('count-item-add').click();
      const dialog = page.getByTestId('add-count-item-dialog');
      await dialog.getByLabel('新しく登録する名前').fill(name);
      await dialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: photo });
      await dialog.getByRole('button', { name: '新しく登録' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('名前は登録しました。画像は後から足せます')).toBeVisible();
      await expect(input(page, name)).toHaveValue('0');
      await expect(countRow(page, name).getByTestId('item-image')).toHaveAttribute('data-state', 'none');
      const id = await countItemId(name);
      expect(await imagePathOf('count_item', id)).toBeNull();
      await page.unroute(uploadUrl);

      // 行のメニューから写真を足す
      await countRow(page, name).getByTestId('count-item-menu').click();
      await page.getByTestId('count-item-photo').filter({ hasText: '写真を足す' }).click();
      const photoDialog = page.getByTestId('item-photo-dialog');
      await expect(photoDialog.getByRole('heading', { name: `「${name}」の写真を足す` })).toBeVisible();
      await photoDialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: photo });
      await photoDialog.getByTestId('item-photo-submit').click();
      await expect(photoDialog).toBeHidden();
      await expect(page.getByText('写真を送りました')).toBeVisible();
      await expect(countRow(page, name).getByTestId('item-image')).toHaveAttribute('data-state', 'loaded');
      expect(await imagePathOf('count_item', id)).toMatch(new RegExp(`^count-items/${id}/`));
    } finally {
      await s.cleanup();
      await removeCountItemsWithImages([name]);
    }
  });
});
