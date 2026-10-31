// T16 ダッシュボード（/）・見出しごとのナビ・机椅子の状況（/furniture）のスクリーンショット（画面の設計 7.4。notes/T16.md の
// 「スクリーンショット」）。`pnpm e2e:shots --grep "T16 "` で notes/T16/ に撮る（CI では流さない）。年度をまたぐ表には書かない。
// 締切と予定に祭の日（前々日〜2日目。日付だけの行）を出すため、撮るときだけシナリオの年度の1日目を今日より後に動かす
// （festivalIn）。撮影は1つずつ流れ（shots のプロジェクトは workers 1）、年度は pinYear で開くので、ほかのテストの既定の年度は
// 変わらない（並行の E2E〔e2e/t16-portal.spec.ts〕では動かさない。D-36）。年度は撮り終えたら消す。
import { expect, test, type Page, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql, type Scenario } from '../support/db';
import { SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

/** 撮るときだけ、1日目を今日（Asia/Tokyo）から days 日後にする */
async function festivalIn(s: Scenario, days: number): Promise<void> {
  await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + $2::int where id = $1`, [s.yearId, days]);
}

/** キャスター机交換の了承の行（机(木) → キャスター机。依頼中）を入れる */
async function askConsent(groupId: string): Promise<void> {
  await sql(
    `insert into public.substitution_consents (group_id, from_item_id, to_item_id, status, count)
     select $1, f.id, t.id, 'asked', 2 from public.items f, public.items t where f.code = 'desk' and t.code = 'caster_desk'
     on conflict (group_id, from_item_id, to_item_id) do update set status = excluded.status`,
    [groupId],
  );
}

/** ダッシュボードを開き、欄の読み込みが終わるのを待つ */
async function openPortal(page: Page, h1: 'ダッシュボード' | 'ホーム'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
  await expect(page.getByTestId('portal-dated')).toBeVisible();
  await expect(page.getByTestId('portal-loading')).toHaveCount(0);
  await expect(page.getByTestId('rep-home-loading')).toHaveCount(0);
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

const furnitureCard = (page: Page) => page.locator('[data-testid="module-card"][data-module="furniture"]');

test.describe('T16 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T16 管理者のダッシュボード・机椅子の状況・見出しごとのナビ・欄の読み込み中と失敗（受付中で締切を過ぎた年度）', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', dataset: 'synthetic', roles: { admin: true } });
    const route = '**/rest/v1/request_submissions*';
    let release: () => void = () => undefined;
    try {
      // 未提出を6団体、数えていない保管場所を2か所に。祭は2週間後
      await sql(
        `delete from public.request_submissions where group_id in (select id from public.groups where year_id = $1 order by sort_order desc limit 6)`,
        [s.yearId],
      );
      await sql("delete from public.stocks where year_id = $1 and room_id in (select id from public.rooms where name in ('1-1', '1-2'))", [s.yearId]);
      await festivalIn(s, 14);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);

      // ダッシュボード：要対応（急ぎ・ふつう）、締切と予定（祭の日）、机椅子のカード
      await openPortal(page, 'ダッシュボード');
      await expect(page.locator('[data-testid="portal-todo"][data-severity="urgent"]')).toHaveCount(1);
      await expect(page.getByTestId('portal-dated-item')).toHaveCount(4);
      await expect(furnitureCard(page)).toBeVisible();
      await shoot(page, 'T16', 'portal-admin-pc', { fullPage: true });

      // 机椅子の状況（T16 より前の / のダッシュボードと同じ中身）と、見出しごとのナビ（机椅子の状況を開いた形）
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '机椅子の状況' }).click();
      await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
      await expect(page.getByTestId('dashboard-unsubmitted')).toBeVisible();
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: '読み込み中' })).toHaveCount(0);
      await shoot(page, 'T16', 'nav-grouped-pc');
      await shoot(page, 'T16', 'furniture-pc', { fullPage: true });

      // 欄の読み込み中：机椅子の読み込み（提出の記録）を止める。年度の行だけで決まる項目は先に出ている。読み込み中は要対応とカード
      // だけで、締切と予定（年度の行だけで決まる）には出さない（決定 7）。2回目の / なので覚えた id で机椅子の読み取りを先に始める
      // （先読み。D-45）が、その提出の記録も同じ route で止まる
      const held = new Promise<void>((r) => (release = r));
      await page.route(route, async (r: Route) => {
        await held;
        await r.continue();
      });
      await page.goto('/');
      await expect(page.locator('[data-testid="portal-todo"][data-id="furniture:lead:close-requests"]')).toBeVisible();
      await expect(page.getByTestId('portal-todos').locator('[data-testid="portal-loading"][data-module="furniture"]')).toBeVisible();
      await expect(page.getByTestId('portal-cards').getByTestId('portal-loading')).toBeVisible();
      await expect(page.getByTestId('portal-dated').getByTestId('portal-loading')).toHaveCount(0);
      await expect(page.getByTestId('portal-dated-item')).toHaveCount(4);
      await shoot(page, 'T16', 'portal-loading-pc', { fullPage: true });
      release();
      await expect(furnitureCard(page)).toBeVisible();
      await page.unroute(route);

      // 欄の失敗：机椅子の読み込みを通信の失敗にする（supabase-js と TanStack Query の読み直しの後に出る）
      await page.route(route, (r: Route) => r.abort());
      await page.goto('/');
      await expect(page.getByTestId('portal-todos').getByTestId('portal-module-error')).toBeVisible({ timeout: 45_000 });
      await expect(page.getByTestId('portal-cards').getByTestId('portal-module-error')).toBeVisible();
      await expect(page.getByTestId('portal-dated').getByTestId('portal-module-error')).toHaveCount(0);
      await shoot(page, 'T16', 'portal-widget-error-pc', { fullPage: true });
    } finally {
      release();
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});

test.describe('T16 総務部門長', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T16 総務部門長のダッシュボード（振り分け中：自動振り分け・了承の依頼中。これからの締切と予定はない）', async ({ page }) => {
    const s = await createScenario({
      status: 'allocating',
      requestWindow: 'closed',
      dataset: 'synthetic',
      allocations: 'reference',
      roles: { head: true },
    });
    try {
      await askConsent(s.ids.groups['模擬店01']!);
      await askConsent(s.ids.groups['模擬店02']!);
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await openPortal(page, 'ダッシュボード');
      await expect(page.getByTestId('portal-todo')).toHaveCount(2);
      await expect(page.getByTestId('portal-dated-empty')).toBeVisible();
      await shoot(page, 'T16', 'portal-head-pc', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T16 総務部門員（スマホ）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: MOBILE });

  test('T16 総務部門員のダッシュボード（受付中。要対応は総務の分）とスマホのメニュー（見出しごと）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { staff: true } });
    try {
      await sql(
        `delete from public.request_submissions where group_id in (select id from public.groups where year_id = $1 order by sort_order desc limit 3)`,
        [s.yearId],
      );
      await sql("delete from public.stocks where year_id = $1 and room_id in (select id from public.rooms where name = '1-1')", [s.yearId]);
      await festivalIn(s, 40);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openPortal(page, 'ダッシュボード');
      await expect(page.getByTestId('portal-todo')).toHaveCount(2);
      await expect(page.getByTestId('portal-dated-item')).toHaveCount(5);
      await expectNoOverflow(page);
      await shoot(page, 'T16', 'portal-staff-mobile', { fullPage: true });

      // スマホのメニュー（机椅子の状況を開いた形。共通の見出しはない）
      await page.goto('/furniture/');
      await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
      await expect(page.getByTestId('dashboard-year')).toBeVisible();
      await page.getByRole('button', { name: 'メニューを開く' }).click();
      await expect(page.locator('#app-mobile-nav')).toBeVisible();
      await expectNoOverflow(page);
      await shoot(page, 'T16', 'nav-grouped-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T16 閲覧のみ', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: PC });

  test('T16 閲覧のみのホーム（確定：机椅子のカードから振り分け表へ。要対応の欄はない）', async ({ page }) => {
    const s = await createScenario({ status: 'confirmed', requestWindow: 'closed', dataset: 'small', roles: { viewer: true } });
    try {
      await festivalIn(s, 7);
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await openPortal(page, 'ホーム');
      await expect(furnitureCard(page).getByRole('link', { name: '振り分け表を見る' })).toBeVisible();
      await expect(page.getByTestId('portal-dated-item')).toHaveCount(4);
      await shoot(page, 'T16', 'portal-viewer-pc');

      await page.setViewportSize(MOBILE);
      await openPortal(page, 'ホーム');
      await expectNoOverflow(page);
      await shoot(page, 'T16', 'portal-viewer-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T16 団体代表（スマホ）', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: MOBILE });

  test('T16 団体代表のホーム（受付中：要対応・締切と予定・代表する団体）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: SMALL.groups.stall });
    try {
      const gid = s.ids.groups[SMALL.groups.stall]!;
      await sql('delete from public.request_submissions where group_id = $1', [gid]);
      await askConsent(gid);
      await festivalIn(s, 40);
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await openPortal(page, 'ホーム');
      await expect(page.getByTestId('portal-todo')).toHaveCount(2);
      await expect(page.getByTestId('rep-card')).toBeVisible();
      await expectNoOverflow(page);
      await shoot(page, 'T16', 'portal-rep-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});
