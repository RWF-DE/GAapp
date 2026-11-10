// T25 現状復帰の写真（04「現状復帰の写真」。D-63）：総務が撮って足す・メモ・大きく見る・消す（Storage の物も消える）、部門の代表
// （執行部。副部門長）が見る（書けない）、前の年度の写真が出る、模擬店の代表と閲覧のみはナビに出ず画面で断られる、部門の代表の
// 呼び方（ヘッダーの「{団体} の副部門長」）。
// どのテストもシナリオの年度（createScenario。前年度つき）で閉じ、写真の行はその年度だけに付く（年度をまたぐ表を変えない）ので並行で流す。
// 片付けは cleanupRoomPhotosScenario（写真の行を消し、Storage の物を Storage API で消してから年度を消す。SQL では物を消さない）。
// 写真はテストの中で canvas で作る（実物の写真・個人名なし）。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { navLabels } from './helpers';
import { storageStateFor } from './support/auth';
import { createScenario, createUser, sql, type Scenario, type TestUser } from './support/db';
import { SMALL } from './support/datasets';
import { apiRpc, apiToken, expectNoOverflow, expectNoSignedUrlStored } from './support/documents';
import { makePhoto } from './support/item-images';
import { loginWith } from './support/roles';
import {
  addRoomPhotoAs,
  cleanupRoomPhotosScenario,
  roomPhotoMetaOf,
  roomPhotoObjectExists,
  roomPhotoRows,
  storageListRoomPhotos,
} from './support/room-photos';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

const PREV_MEMO = 'E2E 前年は黒板の前に机';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * 前年度つきのシナリオ（総務部門員 staff が今年の総務）。前年度の 倉庫A に写真を1枚（staff が前年度にも総務のときに API で足し、
 * その後で前年度を終了にする。今年の部門の代表は前年度に立場がなくても読める）。
 */
async function scenarioWithPrevPhoto(opts: { repGroup?: string; viewer?: boolean } = {}): Promise<{ s: Scenario; roomA: string; prevPath: string }> {
  const s = await createScenario({
    status: 'requesting',
    roles: { staff: true, ...(opts.viewer ? { viewer: true } : {}) },
    prevYear: { dataset: 'small', status: 'confirmed' },
    ...(opts.repGroup ? { repGroup: opts.repGroup } : {}),
  });
  try {
    const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
    await sql(`insert into public.year_roles (year_id, user_id, role) values ($1, $2, 'staff')`, [s.prevYearId, SEED_USER_IDS.staff]);
    const jpeg = await photoInNode();
    const prev = await addRoomPhotoAs('staff', { yearId: s.prevYearId!, roomId: roomA, jpeg, memo: PREV_MEMO });
    await sql(`delete from public.year_roles where year_id = $1 and user_id = $2`, [s.prevYearId, SEED_USER_IDS.staff]);
    await sql(`update public.years set status = 'closed' where id = $1`, [s.prevYearId]);
    return { s, roomA, prevPath: prev.objectPath };
  } catch (e) {
    await cleanupRoomPhotosScenario(s);
    throw e;
  }
}

/** ページなしで作る写真（小さな JPEG。canvas のページを開かずに前提を作るため、Chromium の空のページで描く） */
let photoBrowser: Browser | null = null;
async function photoInNode(): Promise<Buffer> {
  if (!photoBrowser) throw new Error('photoBrowser がありません');
  const p = await photoBrowser.newPage();
  try {
    return await makePhoto(p, { color: '#78350f', label: 'E2E T25 prev', width: 1200, height: 900 });
  } finally {
    await p.close();
  }
}

test.beforeAll(({ browser }) => {
  photoBrowser = browser;
});

const tile = (page: Page, which: 'current' | 'previous') => page.getByTestId(`room-photos-${which}`).getByTestId('room-photo');

async function openRoom(page: Page, roomId: string): Promise<void> {
  await page.goto(`/room-photos/?room=${roomId}`);
  await expect(page.getByTestId('room-photo-room-name')).toHaveText(SMALL.rooms.storageA);
  await expect(page.getByTestId('room-photos-current')).toBeVisible();
}

test.describe('T25 総務', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T25 総務（390px）：在庫入力のリンクから開き、撮って足す（WebP に作り直す）・大きく見る・前年の写真・部門の代表が見る・消すと物も消える', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { s, roomA } = await scenarioWithPrevPhoto();
    const dept: TestUser = await createUser({ purpose: 'deptrep', name: 'E2E 副部門長' });
    try {
      await sql(`insert into public.group_members (group_id, user_id, role) values ($1, $2, 'deputy_manager')`, [
        s.ids.groups[SMALL.groups.department],
        dept.id,
      ]);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);

      // 在庫入力の場所名の下のリンク
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageA);
      await page.getByTestId('room-photos-link').click();
      await expect(page).toHaveURL(new RegExp(`/room-photos/\\?room=${roomA}$`));
      await expect(page.getByRole('heading', { level: 1, name: '現状復帰の写真' })).toBeVisible();
      await expect(page.getByText('写真は総務と執行部（各部門の部門長・副部門長）だけが見られます')).toBeVisible();
      await expect(page.getByTestId('room-photo-room-name')).toHaveText(SMALL.rooms.storageA);

      // 今年はまだない。前年（終了した前年度）の写真が出る（メモつき）
      await expect(page.getByTestId('room-photos-current')).toContainText('まだ写真がありません');
      // staff は前年度にロールがない（前年度の行を読めない）ので、見出しは「前年」とだけ出す
      await expect(page.getByTestId('room-photos-previous').getByRole('heading')).toHaveText('前年');
      await expect(tile(page, 'previous')).toHaveCount(1);
      await expect(tile(page, 'previous').getByTestId('room-photo-image')).toHaveAttribute('data-state', 'loaded');
      await expect(tile(page, 'previous').getByTestId('room-photo-memo')).toHaveText(PREV_MEMO);
      // 前年の写真にはメニューがない（書けるのは今年だけ）
      await expect(tile(page, 'previous').getByTestId('room-photo-menu')).toHaveCount(0);

      // 写真を足す（横長の大きい写真。長い辺 1600px・WebP に作り直して送る）
      const photo = await makePhoto(page, { width: 3200, height: 2400, label: 'E2E T25' });
      await page.getByTestId('room-photo-add').click();
      const dialog = page.getByTestId('room-photo-add-dialog');
      await expect(dialog.getByRole('heading', { name: `写真を足す（${SMALL.rooms.storageA}）` })).toBeVisible();
      await expect(dialog.getByText('人の顔・名前・掲示物が写らないように撮ってください')).toBeVisible();
      await dialog.getByTestId('item-photo-input').setInputFiles({ name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: photo });
      await expect(dialog.getByTestId('item-photo-preview')).toBeVisible();
      await dialog.getByTestId('room-photo-memo-input').fill('E2E 机は窓側に 6 台');
      await expect(dialog.getByTestId('room-photo-memo-count')).toHaveText('13/50');
      await dialog.getByTestId('room-photo-submit').click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('写真を足しました')).toBeVisible();
      await expect(tile(page, 'current')).toHaveCount(1);
      await expect(tile(page, 'current').getByTestId('room-photo-image')).toHaveAttribute('data-state', 'loaded');
      await expect(tile(page, 'current').getByTestId('room-photo-memo')).toHaveText('E2E 机は窓側に 6 台');

      // DB の行と届いた物（path は年度/場所/写真の id。WebP・1 MiB 以下・元より小さい）
      const rows = await roomPhotoRows(s.yearId, roomA);
      expect(rows).toHaveLength(1);
      const path = rows[0]!.object_path;
      expect(path).toMatch(new RegExp(`^${s.yearId}/${roomA}/${UUID}\\.(webp|jpg)$`));
      const meta = await roomPhotoMetaOf(path);
      expect(meta?.mimetype).toBe('image/webp');
      expect(meta!.size).toBeLessThanOrEqual(1024 * 1024);
      expect(meta!.size).toBeLessThan(photo.length);

      // 押すと大きく出す（総務には足した日時）
      await tile(page, 'current').getByRole('button', { name: /を大きく見る$/ }).click();
      const large = page.getByTestId('room-photo-large');
      await expect(large.getByRole('img')).toBeVisible();
      await expect(large.getByTestId('room-photo-created-at')).toContainText('足した日時');
      await page.keyboard.press('Escape');
      await expect(large).toBeHidden();
      await expectNoOverflow(page);
      await expectNoSignedUrlStored(page);

      // 一覧：今年 1 枚・前年 1 枚
      await page.getByRole('link', { name: '一覧へ' }).click();
      await expect(page.getByTestId('room-photos-list')).toBeVisible();
      await page.getByPlaceholder('場所の名前で絞る').fill(SMALL.rooms.storageA);
      const row = page.getByTestId('room-photo-room').filter({ hasText: SMALL.rooms.storageA });
      await expect(row.getByTestId('room-photo-count')).toHaveText('今年 1 枚・前年 1 枚');
      await expectNoOverflow(page);

      // 部門の代表（副部門長）：ナビに出て、ヘッダーは「{団体} の副部門長」、今年と前年の写真を見る（書くボタン・メニューなし）
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const dp = await ctx.newPage();
        await loginWith(dp, dept);
        await expect(dp.getByRole('banner')).toContainText(`${SMALL.groups.department} の副部門長`);
        await expect(dp.getByTestId('home-roles')).toHaveText(`${SMALL.groups.department} の副部門長`);
        expect(await navLabels(dp)).toContain('現状復帰の写真');
        await dp.setViewportSize(MOBILE);
        await openRoom(dp, roomA);
        await expect(tile(dp, 'current')).toHaveCount(1);
        await expect(tile(dp, 'current').getByTestId('room-photo-image')).toHaveAttribute('data-state', 'loaded');
        await expect(tile(dp, 'previous').getByTestId('room-photo-image')).toHaveAttribute('data-state', 'loaded');
        await expect(dp.getByTestId('room-photo-add')).toHaveCount(0);
        await expect(dp.getByTestId('room-photo-menu')).toHaveCount(0);
        // 大きく見ても足した日時は出さない（総務だけ）
        await tile(dp, 'current').getByRole('button', { name: /を大きく見る$/ }).click();
        await expect(dp.getByTestId('room-photo-large').getByRole('img')).toBeVisible();
        await expect(dp.getByTestId('room-photo-created-at')).toHaveCount(0);
      } finally {
        await ctx.close();
      }

      // 消す（確かめてから）。行が消え、Storage の物も消える（Storage API の一覧で確かめる）
      await openRoom(page, roomA);
      await tile(page, 'current').getByTestId('room-photo-menu').click();
      await page.getByRole('menuitem', { name: '消す' }).click();
      const confirm = page.getByRole('alertdialog').filter({ hasText: 'この写真を消します。元に戻せません' });
      await confirm.getByRole('button', { name: '消す' }).click();
      await expect(page.getByText('写真を消しました')).toBeVisible();
      await expect(tile(page, 'current')).toHaveCount(0);
      await expect(page.getByTestId('room-photos-current')).toContainText('まだ写真がありません');
      expect(await roomPhotoRows(s.yearId, roomA)).toHaveLength(0);
      await expect.poll(() => roomPhotoObjectExists(path)).toBe(false);
      expect(await storageListRoomPhotos(await apiToken('staff'), `${s.yearId}/${roomA}`)).toEqual([]);
    } finally {
      await dept.cleanup();
      await cleanupRoomPhotosScenario(s);
    }
  });
});

test.describe('T25 見られない人', () => {
  test('T25 模擬店の代表：ナビに出ず、/room-photos は「権限がありません」、API でも写真の行は返らない', async ({ browser }) => {
    const { s, roomA } = await scenarioWithPrevPhoto({ repGroup: SMALL.groups.stall });
    const ctx = await browser.newContext({ storageState: storageStateFor('rep') });
    try {
      // 今年にも1枚（総務が API で足す）
      await addRoomPhotoAs('staff', { yearId: s.yearId, roomId: roomA, jpeg: await photoInNode() });
      const page = await ctx.newPage();
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.goto('/');
      await expect(page.getByRole('banner')).toContainText(`${SMALL.groups.stall} の店長`);
      expect(await navLabels(page)).not.toContain('現状復帰の写真');
      await page.goto(`/room-photos/?room=${roomA}`);
      await expect(page.getByText('権限がありません', { exact: true })).toBeVisible();
      await expect(page.getByTestId('room-photo')).toHaveCount(0);
      // API：見られない人には 0 行（エラーにしない）、表の select も 0 行、Storage の一覧も空
      const token = await apiToken('rep');
      const r = await apiRpc<unknown[]>(token, 'room_photos_with_previous', { p_year_id: s.yearId, p_room_id: roomA });
      expect(r.error).toBeNull();
      expect(r.data).toEqual([]);
      expect(await storageListRoomPhotos(token, `${s.yearId}/${roomA}`)).toEqual([]);
      expect(await storageListRoomPhotos(token, `${s.prevYearId}/${roomA}`)).toEqual([]);
    } finally {
      await ctx.close();
      await cleanupRoomPhotosScenario(s);
    }
  });

  test('T25 閲覧のみ：ナビに出ず、/room-photos は「権限がありません」', async ({ browser }) => {
    const { s, roomA } = await scenarioWithPrevPhoto({ viewer: true });
    const ctx = await browser.newContext({ storageState: storageStateFor('viewer') });
    try {
      const page = await ctx.newPage();
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/');
      expect(await navLabels(page)).not.toContain('現状復帰の写真');
      await page.goto(`/room-photos/?room=${roomA}`);
      await expect(page.getByText('権限がありません', { exact: true })).toBeVisible();
      await expect(page.getByTestId('room-photo')).toHaveCount(0);
    } finally {
      await ctx.close();
      await cleanupRoomPhotosScenario(s);
    }
  });
});
