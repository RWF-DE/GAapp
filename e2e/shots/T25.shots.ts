// T25 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T25` で notes/T25/ に撮る（CI では流さない）。
// 現状復帰の写真：部屋の一覧（スマホ・PC）、部屋の写真（今年と前年。スマホ・PC）、写真を足すダイアログ（スマホ）、大きく見る、
// 写真のメニュー、部門の代表（副部門長）が見る部屋の写真（スマホ）。写真は API（画面と同じ予約 → upload → add）で付け、終わったら
// cleanupRoomPhotosScenario で Storage API で消してから年度を消す（SQL では物を消さない）。写真はテストの中で canvas で作る（実物の写真なし）。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, createUser, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { makePhoto } from '../support/item-images';
import { loginWith } from '../support/roles';
import { addRoomPhotoAs, cleanupRoomPhotosScenario } from '../support/room-photos';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

async function waitPhotosLoaded(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="room-photo-image"][data-state="loading"]')).toHaveCount(0);
  await page.evaluate('Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => undefined)))');
  await page.waitForTimeout(200);
}

test('T25 現状復帰の写真：部屋の一覧・部屋の写真（今年と前年）・写真を足す・大きく見る・メニュー・部門の代表', async ({ browser }) => {
  test.setTimeout(180_000);
  const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small', status: 'confirmed' } });
  const dept = await createUser({ purpose: 'deptrep-shot', name: 'E2E 副部門長' });
  const staff = await browser.newContext({ storageState: storageStateFor('staff') });
  const deptCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
    const class1 = s.ids.rooms[SMALL.rooms.class1]!;
    const class2 = s.ids.rooms[SMALL.rooms.class2]!;
    await sql(`insert into public.group_members (group_id, user_id, role) values ($1, $2, 'deputy_manager')`, [s.ids.groups[SMALL.groups.department], dept.id]);
    await sql(`insert into public.year_roles (year_id, user_id, role) values ($1, $2, 'staff')`, [s.prevYearId, SEED_USER_IDS.staff]);

    const page = await staff.newPage();
    await page.goto('/');
    const photo = (color: string, label: string, w = 1600, h = 1200) => makePhoto(page, { color, label, width: w, height: h });
    // 前年：倉庫A に2枚、教室1 に1枚
    await addRoomPhotoAs('staff', { yearId: s.prevYearId!, roomId: roomA, jpeg: await photo('#78350f', 'prev 1'), memo: '机は壁ぎわに 10 台' });
    await addRoomPhotoAs('staff', { yearId: s.prevYearId!, roomId: roomA, jpeg: await photo('#1d4ed8', 'prev 2', 1200, 1600), memo: '' });
    await addRoomPhotoAs('staff', { yearId: s.prevYearId!, roomId: class1, jpeg: await photo('#15803d', 'prev 3'), memo: '黒板の前は空ける' });
    await sql(`delete from public.year_roles where year_id = $1 and user_id = $2`, [s.prevYearId, SEED_USER_IDS.staff]);
    await sql(`update public.years set status = 'closed' where id = $1`, [s.prevYearId]);
    // 今年：倉庫A に3枚、教室2 に1枚
    await addRoomPhotoAs('staff', { yearId: s.yearId, roomId: roomA, jpeg: await photo('#92400e', 'now 1'), memo: '机は窓側に 6 台、椅子は奥に重ねる' });
    await addRoomPhotoAs('staff', { yearId: s.yearId, roomId: roomA, jpeg: await photo('#0e7490', 'now 2'), memo: '' });
    await addRoomPhotoAs('staff', { yearId: s.yearId, roomId: roomA, jpeg: await photo('#be123c', 'now 3', 1200, 1600), memo: '掃除用具入れの前は空ける' });
    await addRoomPhotoAs('staff', { yearId: s.yearId, roomId: class2, jpeg: await photo('#a16207', 'now 4'), memo: '' });

    // 部屋の一覧（スマホ）
    await pinYear(page, SEED_USER_IDS.staff, s.yearId);
    await page.setViewportSize(MOBILE);
    await page.goto('/room-photos/');
    await expect(page.getByTestId('room-photos-list')).toBeVisible();
    await page.getByPlaceholder('場所の名前で絞る').fill('E2E');
    await expect(page.getByTestId('room-photo-room').filter({ hasText: SMALL.rooms.storageA }).getByTestId('room-photo-count')).toHaveText(
      '今年 3 枚・前年 2 枚',
    );
    await shoot(page, 'T25', 'room-list-mobile');

    // 部屋の写真（スマホ）
    await page.goto(`/room-photos/?room=${roomA}`);
    await expect(page.getByTestId('room-photos-current').getByTestId('room-photo')).toHaveCount(3);
    await waitPhotosLoaded(page);
    await shoot(page, 'T25', 'room-detail-mobile');
    await shoot(page, 'T25', 'room-detail-mobile-full', { fullPage: true });

    // 写真のメニュー
    await page.getByTestId('room-photos-current').getByTestId('room-photo-menu').first().click();
    await expect(page.getByRole('menuitem', { name: '消す' })).toBeVisible();
    await shoot(page, 'T25', 'room-photo-menu-mobile');
    await page.keyboard.press('Escape');

    // 大きく見る
    await page.getByTestId('room-photos-current').getByRole('button', { name: /を大きく見る$/ }).first().click();
    await expect(page.getByTestId('room-photo-large').getByRole('img')).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'T25', 'room-photo-large-mobile');
    await page.keyboard.press('Escape');

    // 写真を足す（写真を選んでメモを書いたところ）
    await page.getByTestId('room-photo-add').click();
    const dialog = page.getByTestId('room-photo-add-dialog');
    await dialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: await photo('#475569', 'new') });
    await expect(dialog.getByTestId('item-photo-preview')).toBeVisible();
    await dialog.getByTestId('room-photo-memo-input').fill('長机は2台を廊下側に');
    await page.waitForTimeout(300);
    await shoot(page, 'T25', 'room-photo-add-mobile');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // PC
    await page.setViewportSize(PC);
    await page.goto('/room-photos/');
    await expect(page.getByTestId('room-photos-list')).toBeVisible();
    await page.getByPlaceholder('場所の名前で絞る').fill('E2E');
    await expect(page.getByTestId('room-photo-room').first()).toBeVisible();
    await shoot(page, 'T25', 'room-list-pc');
    await page.goto(`/room-photos/?room=${roomA}`);
    await expect(page.getByTestId('room-photos-current').getByTestId('room-photo')).toHaveCount(3);
    await waitPhotosLoaded(page);
    await shoot(page, 'T25', 'room-detail-pc');
    await shoot(page, 'T25', 'room-detail-pc-full', { fullPage: true });

    // 在庫入力のリンク（スマホ）
    await page.setViewportSize(MOBILE);
    await page.goto(`/stock/?room=${roomA}`);
    await expect(page.getByTestId('room-photos-link')).toBeVisible();
    await shoot(page, 'T25', 'stock-link-mobile');

    // 部門の代表（副部門長。スマホ）：ヘッダーの呼び方と、見るだけの部屋の写真
    const dp = await deptCtx.newPage();
    await loginWith(dp, dept);
    await dp.setViewportSize(MOBILE);
    await dp.goto('/');
    await expect(dp.getByTestId('home-roles')).toHaveText(`${SMALL.groups.department} の副部門長`);
    await shoot(dp, 'T25', 'dept-rep-home-mobile');
    await dp.goto(`/room-photos/?room=${roomA}`);
    await expect(dp.getByTestId('room-photos-current').getByTestId('room-photo')).toHaveCount(3);
    await waitPhotosLoaded(dp);
    await shoot(dp, 'T25', 'dept-rep-room-detail-mobile');
  } finally {
    await staff.close();
    await deptCtx.close();
    await dept.cleanup();
    await cleanupRoomPhotosScenario(s);
  }
});
