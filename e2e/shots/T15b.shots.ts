// T15b ロールの段の画面のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep "T15b "` で notes/T15b/ に撮る（CI では流さない）。
// マスタ設定のユーザーのタブ（管理者・総務部門長）、招待の立場の選択肢、兼任の禁止のエラー、店長⇄副店長の確かめ、
// 総務部門長のマスタ設定（年度・場所）とダッシュボード（確定中）、スマホのヘッダー（副店長）。年度をまたぐ表には書かない。
// ロール・店長と副店長は使い捨てのユーザーに付ける（D-36）。招待のメールは使い捨ての @example.test。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, createUser, sql, type Scenario, type TestUser } from '../support/db';
import { SMALL } from '../support/datasets';
import { loginWith, memberRow, ROLE_OVERLAP_MESSAGE } from '../support/roles';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

/** ユーザーのタブが読み終わるのを待つ（メンバーと招待の表） */
async function openUsersTab(page: Page): Promise<void> {
  await page.goto('/settings/?tab=users');
  await expect(page.getByRole('table', { name: 'メンバー' })).toBeVisible();
  await expect(page.getByRole('table', { name: '招待' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '読み込み中…' })).toHaveCount(0);
}

/**
 * 招待の立場の選択肢をすべて見せる（native の select は開いた形を撮れないので、撮るときだけ size を付けてリストにし、
 * 欄の高さの指定〔h-9〕も外す）
 */
async function expandInviteKinds(page: Page): Promise<void> {
  const select = page.getByTestId('invite-form').getByLabel('立場');
  const count = await select.locator('option').count();
  await select.evaluate((el, n) => {
    el.setAttribute('size', String(n));
    el.setAttribute('style', 'height: auto');
  }, count);
}

async function resetInviteKinds(page: Page): Promise<void> {
  await page
    .getByTestId('invite-form')
    .getByLabel('立場')
    .evaluate((el) => {
      el.removeAttribute('size');
      el.removeAttribute('style');
    });
}

/**
 * ユーザーのタブを撮る年度：ロール（管理者・総務部門長・総務部門員・閲覧のみ）、店長・副店長（閲覧のみで店長を兼ねる人も）、
 * 未使用の招待（総務部門員・副店長と、総務部門長には見えない閲覧のみ）。
 */
async function usersScenario(): Promise<{ s: Scenario; manager: TestUser; cleanup: () => Promise<void> }> {
  const manager = await createUser({ purpose: 'shot-manager', name: 'E2E 店長' });
  const deputy = await createUser({ purpose: 'shot-deputy', name: 'E2E 副店長' });
  const staff = await createUser({ purpose: 'shot-staff', name: 'E2E 部門員' });
  const viewer = await createUser({ purpose: 'shot-viewer', name: 'E2E 閲覧' });
  const users = [manager, deputy, staff, viewer];
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    roles: { admin: true, head: true },
    grants: [
      { userId: staff.id, role: 'staff' },
      { userId: viewer.id, role: 'viewer' },
    ],
    groupMembers: [
      { userId: manager.id, group: SMALL.groups.stall },
      { userId: deputy.id, group: SMALL.groups.stall, role: 'deputy_manager' },
      { userId: viewer.id, group: SMALL.groups.company },
    ],
  });
  const mail = (what: string) => `e2e-shot-${what}-${s.yearId.slice(0, 8)}@example.test`;
  await sql(`insert into public.invitations (year_id, email, role) values ($1, $2, 'staff'), ($1, $3, 'viewer')`, [
    s.yearId,
    mail('staff'),
    mail('viewer'),
  ]);
  await sql(`insert into public.invitations (year_id, email, group_id, group_role) values ($1, $2, $3, 'deputy_manager')`, [
    s.yearId,
    mail('deputy'),
    s.ids.groups[SMALL.groups.department],
  ]);
  return {
    s,
    manager,
    cleanup: async () => {
      await s.cleanup();
      await Promise.all(users.map((u) => u.cleanup()));
    },
  };
}

test.describe('T15b マスタ設定のユーザー（管理者）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T15b 管理者のユーザーのタブと招待の立場（7つ）', async ({ page }) => {
    const { s, cleanup } = await usersScenario();
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openUsersTab(page);
      await expect(memberRow(page, 'E2E 店長').getByTestId('member-position')).toContainText(`${SMALL.groups.stall} の店長`);
      await shoot(page, 'T15b', 'settings-users-admin-pc', { fullPage: true });

      await expandInviteKinds(page);
      await shoot(page, 'T15b', 'settings-invite-kinds-admin-pc');
      await resetInviteKinds(page);
    } finally {
      await cleanup();
    }
  });
});

test.describe('T15b マスタ設定のユーザー（総務部門長）', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T15b 総務部門長のユーザーのタブ・招待の立場（3つ）・兼任の禁止・店長⇄副店長の確かめ', async ({ page }) => {
    const { s, manager, cleanup } = await usersScenario();
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await openUsersTab(page);
      await expect(memberRow(page, 'E2E 部門員').getByRole('button', { name: 'ロールを外す' })).toBeVisible();
      await shoot(page, 'T15b', 'settings-users-head-pc', { fullPage: true });

      await expandInviteKinds(page);
      await shoot(page, 'T15b', 'settings-invite-kinds-head-pc');
      await resetInviteKinds(page);

      // 店長⇄副店長の確かめ（押さずに閉じる）
      await memberRow(page, 'E2E 店長').getByTestId('member-position').getByRole('button', { name: '副店長にする' }).click();
      await expect(page.getByRole('dialog')).toContainText('店長と副店長は、できることが同じです（表示だけが変わります）。');
      await shoot(page, 'T15b', 'settings-switch-dialog-pc');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // 兼任の禁止：店長を総務部門員に招待する（立場の欄の下に出て、入力は残る）
      await page.evaluate('window.scrollTo(0, 0)');
      const form = page.getByTestId('invite-form');
      await form.getByLabel('メールアドレス').fill(manager.email);
      await form.getByLabel('立場').selectOption('staff');
      await form.getByRole('button', { name: '招待する' }).click();
      await expect(page.getByTestId('invite-kind-error')).toHaveText(ROLE_OVERLAP_MESSAGE);
      await shoot(page, 'T15b', 'settings-invite-overlap-pc');
    } finally {
      await cleanup();
    }
  });

  test('T15b 総務部門長のユーザーのタブ（スマホ）：表の中だけが横にスクロールし、兼任の禁止の文言は折り返す', async ({ page }) => {
    const { s, manager, cleanup } = await usersScenario();
    try {
      await page.setViewportSize(MOBILE);
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await openUsersTab(page);
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T15b', 'settings-users-head-mobile', { fullPage: true });

      const form = page.getByTestId('invite-form');
      await form.getByLabel('メールアドレス').fill(manager.email);
      await form.getByLabel('立場').selectOption('staff');
      await form.getByRole('button', { name: '招待する' }).click();
      await expect(page.getByTestId('invite-kind-error')).toHaveText(ROLE_OVERLAP_MESSAGE);
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T15b', 'settings-invite-overlap-mobile');
    } finally {
      await cleanup();
    }
  });

  test('T15b 総務部門長のマスタ設定（タブは年度・場所・ユーザー、年度名・1日目は読み取り、場所は今年の使用だけ）', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'small', roles: { head: true } });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      await expect(page.getByTestId('year-create-unavailable')).toBeVisible();
      await shoot(page, 'T15b', 'settings-years-head-pc', { fullPage: true });

      await page.getByTestId('settings-tab-rooms').click();
      await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: SMALL.rooms.class1, exact: true }) })).toBeVisible();
      await expect(page.getByTestId('global-read-only')).toBeVisible();
      await shoot(page, 'T15b', 'settings-rooms-head-pc');

      await page.setViewportSize(MOBILE);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T15b', 'settings-years-head-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });

  test('T15b 総務部門長のダッシュボード（確定中：「確定を解除」だけで「終了」がない）', async ({ page }) => {
    const s = await createScenario({ status: 'confirmed', dataset: 'synthetic', allocations: 'reference', roles: { head: true } });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      // 年度の状態のボタンは机椅子の状況（T16 より前は / のダッシュボード。D-51。画像は T16 より前に撮ったまま）
      await page.goto('/furniture/');
      await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
      await expect(page.getByTestId('year-status-actions').getByRole('button')).toHaveText(['確定を解除']);
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: '読み込み中…' })).toHaveCount(0);
      await shoot(page, 'T15b', 'dashboard-head-confirmed-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T15b スマホのヘッダー（副店長）', () => {
  test.use({ viewport: MOBILE });

  test('T15b スマホのヘッダー：メニューを開くと「{団体} の副店長」', async ({ page }) => {
    const u = await createUser({ purpose: 'shot-header', name: 'E2E 副店長' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      groupMembers: [{ userId: u.id, group: SMALL.groups.stall, role: 'deputy_manager' }],
    });
    try {
      // 年度名は本番に近い短い名前にする（E2E の長い年度名では、スマホのヘッダーのアプリ名が省略されるため。年度名は E2E- のまま
      // にして、途中で止まっても db-setup が消せるようにする）
      await sql('update public.years set label = $2 where id = $1', [s.yearId, `E2E-${s.label.slice(-4)}`]);
      await loginWith(page, u);
      await expect(page.getByTestId('home-roles')).toHaveText(`${SMALL.groups.stall} の副店長`);
      await page.getByRole('button', { name: 'メニューを開く' }).click();
      const menu = page.locator('#app-mobile-nav');
      await expect(menu).toContainText(`E2E 副店長（${SMALL.groups.stall} の副店長）`);
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T15b', 'header-deputy-manager-mobile');
    } finally {
      await s.cleanup();
      await u.cleanup();
    }
  });
});
