// T23 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T23` で notes/T23/ に撮る（CI では流さない）。
// 在庫入力（スマホ）の画像つきの行、「その他を足す」の画像のカード、「新しく登録」の写真の欄、団体代表の /request（スマホ）の画像、
// マスタ設定の品目のタブ（PC・スマホ）。画像は API（画面と同じ予約 → upload → set）で付け、終わったら外して Storage API で消す
// （shots は単独で流すので 9 品目に画像を付けてよい。SQL では物を消さない）。写真はテストの中で canvas で作る（実物の写真なし）。
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { attachImageAs, clearImageOf, makePhoto, removeFolderObjects } from '../support/item-images';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const input = (page: Page, name: string) => page.getByRole('textbox', { name: `${name}の数` });

/** 画像を付ける品目（code と色）と備品（数えるだけ。最初から出す物の名前と色） */
const ITEM_PHOTOS = [
  ['desk', '#92400e'],
  ['chair', '#b45309'],
  ['caster_desk', '#475569'],
  ['blue_chair', '#1d4ed8'],
  ['long_desk_2', '#78350f'],
] as const;
const COUNT_PHOTOS = [
  ['ゴミ箱', '#15803d'],
  ['扇風機', '#0e7490'],
] as const;

async function idsBy(table: 'items' | 'count_items', column: 'code' | 'name', keys: readonly string[]): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; k: string }>(`select id, ${column} as k from public.${table} where ${column} = any($1::text[])`, [[...keys]]);
  return Object.fromEntries(rows.map((r) => [r.k, r.id]));
}

async function waitImagesLoaded(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="item-image"][data-state="loading"]')).toHaveCount(0);
  // 読み込み終わった画像の描画（decode）を待つ（撮った絵に空の枠が残らないように）
  await page.evaluate('Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => undefined)))');
  await page.waitForTimeout(200);
}

test('T23 品目の画像：在庫入力（スマホ）・その他を足す・新しく登録・申請（スマホ）・マスタ設定の品目のタブ', async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = randomBytes(3).toString('hex');
  // 撮影用の名前（本番の選択肢に似せる。E2E- で始めて残り物を消せるようにする）
  const extras = [`E2E-白椅子-${suffix}`, `E2E-台形机-${suffix}`, `E2E-掃除機-${suffix}`, `E2E-ホワイトボード-${suffix}`];
  const s = await createScenario({ status: 'requesting', roles: { staff: true }, repGroup: SMALL.groups.stall });
  const itemIds = await idsBy('items', 'code', ITEM_PHOTOS.map(([c]) => c));
  const countIds = await idsBy('count_items', 'name', COUNT_PHOTOS.map(([n]) => n));
  const extraIds: Record<string, string> = {};
  const staff = await browser.newContext({ storageState: storageStateFor('staff') });
  const rep = await browser.newContext({ storageState: storageStateFor('rep') });
  const admin = await browser.newContext({ storageState: storageStateFor('admin') });
  try {
    for (const [i, n] of extras.entries()) await sql('insert into public.count_items (name, sort_order) values ($1, $2)', [n, 9301 + i]);
    Object.assign(extraIds, await idsBy('count_items', 'name', extras));
    const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
    // 倉庫A は白椅子を数えている（その他の行）
    await sql('insert into public.count_stocks (year_id, room_id, count_item_id, count) values ($1, $2, $3, 8)', [s.yearId, roomA, extraIds[extras[0]!]]);

    const page = await staff.newPage();
    await page.setViewportSize(MOBILE);
    await page.goto('/');
    for (const [code, color] of ITEM_PHOTOS) await attachImageAs('admin', 'item', itemIds[code]!, await makePhoto(page, { color, label: code }));
    for (const [name, color] of COUNT_PHOTOS) await attachImageAs('admin', 'count_item', countIds[name]!, await makePhoto(page, { color, label: 'count' }));
    // 白椅子・台形机・ホワイトボードは画像あり、掃除機は画像なし（頭文字のカード）
    for (const [k, color] of [[0, '#e7e5e4'], [1, '#a16207'], [3, '#f8fafc']] as const) {
      await attachImageAs('staff', 'count_item', extraIds[extras[k]!]!, await makePhoto(page, { color, label: 'extra' }));
    }

    // 在庫入力（スマホ）
    await pinYear(page, SEED_USER_IDS.staff, s.yearId);
    await page.goto(`/stock/?room=${roomA}`);
    await expect(page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
    await expect(input(page, extras[0]!)).toHaveValue('8');
    await waitImagesLoaded(page);
    await page.getByTestId('stock-item-row').first().scrollIntoViewIfNeeded();
    await shoot(page, 'T23', 'stock-input-images-mobile');
    await page.getByTestId('count-items-section').scrollIntoViewIfNeeded();
    await waitImagesLoaded(page);
    await shoot(page, 'T23', 'stock-count-images-mobile');
    await shoot(page, 'T23', 'stock-input-images-mobile-full', { fullPage: true });

    // 押すと大きく
    await page.getByRole('button', { name: 'ゴミ箱の画像を大きく見る' }).click();
    await expect(page.getByTestId('item-image-large').getByRole('img')).toBeVisible();
    await shoot(page, 'T23', 'item-image-large-mobile');
    await page.keyboard.press('Escape');

    // 行のメニュー
    await page.getByTestId('count-item-row').filter({ hasText: extras[0]! }).getByTestId('count-item-menu').click();
    await expect(page.getByTestId('count-item-photo')).toBeVisible();
    await shoot(page, 'T23', 'count-item-menu-mobile');
    await page.keyboard.press('Escape');

    // その他を足す（画像のカード）
    await page.getByTestId('count-item-add').click();
    const dialog = page.getByTestId('add-count-item-dialog');
    await dialog.getByLabel('名前で絞る').fill('E2E-');
    await expect(dialog.getByTestId('add-count-item-option').filter({ hasText: extras[1]! })).toBeVisible();
    await waitImagesLoaded(page);
    await shoot(page, 'T23', 'add-count-item-cards-mobile');

    // 新しく登録（写真を選んだところ）
    await dialog.getByLabel('新しく登録する名前').fill('パイプ椅子');
    await dialog.getByTestId('item-photo-input').setInputFiles({
      name: 'e2e-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: await makePhoto(page, { color: '#be123c', label: 'new' }),
    });
    await expect(dialog.getByTestId('item-photo-preview')).toBeVisible();
    await dialog.getByTestId('item-photo-field').scrollIntoViewIfNeeded();
    await shoot(page, 'T23', 'add-count-item-new-photo-mobile');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // 写真を足す（行のメニューから）
    await page.getByTestId('count-item-row').filter({ hasText: extras[0]! }).getByTestId('count-item-menu').click();
    await page.getByTestId('count-item-photo').click();
    await expect(page.getByTestId('item-photo-dialog')).toBeVisible();
    await shoot(page, 'T23', 'item-photo-dialog-mobile');
    await page.keyboard.press('Escape');

    // 申請（団体代表。スマホ）
    const rp = await rep.newPage();
    await pinYear(rp, SEED_USER_IDS.rep, s.yearId);
    await rp.setViewportSize(MOBILE);
    await rp.goto('/request/');
    await expect(rp.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
    await expect(rp.getByTestId('request-field').first()).toBeVisible();
    await waitImagesLoaded(rp);
    await rp.getByTestId('request-field').first().scrollIntoViewIfNeeded();
    await shoot(rp, 'T23', 'request-images-mobile');
    await shoot(rp, 'T23', 'request-images-mobile-full', { fullPage: true });

    // マスタ設定の品目のタブ（管理者。PC とスマホ）
    const ap = await admin.newPage();
    await ap.setViewportSize(PC);
    await ap.goto('/settings/?tab=items');
    await expect(ap.getByRole('row').filter({ hasText: '机(木)' }).first()).toBeVisible();
    await waitImagesLoaded(ap);
    await shoot(ap, 'T23', 'settings-items-images-pc');
    await ap.getByTestId('count-items-settings').scrollIntoViewIfNeeded();
    await waitImagesLoaded(ap);
    await shoot(ap, 'T23', 'settings-count-items-images-pc');
    await ap.getByRole('row').filter({ hasText: '机(木)' }).first().getByTestId('item-image-replace').click();
    await expect(ap.getByTestId('item-photo-dialog')).toBeVisible();
    await shoot(ap, 'T23', 'settings-item-image-replace-pc');
    await ap.keyboard.press('Escape');
    await ap.setViewportSize(MOBILE);
    await ap.goto('/settings/?tab=items');
    await expect(ap.getByRole('row').filter({ hasText: '机(木)' }).first()).toBeVisible();
    await waitImagesLoaded(ap);
    await shoot(ap, 'T23', 'settings-items-images-mobile');
  } finally {
    await staff.close();
    await rep.close();
    await admin.close();
    for (const id of Object.values(itemIds)) await clearImageOf('item', id);
    for (const id of Object.values(countIds)) await clearImageOf('count_item', id);
    await s.cleanup();
    const ids = Object.values(extraIds);
    await sql('delete from public.count_stocks where count_item_id = any($1::uuid[])', [ids]);
    await sql('delete from public.count_items where id = any($1::uuid[])', [ids]);
    for (const id of ids) await removeFolderObjects('count_item', id);
  }
});
