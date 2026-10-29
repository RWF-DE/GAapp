// T09 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T09` で notes/T09/ に撮る（CI では流さない）。
// 段 1：マスタ設定（settings-*）。段 2：ダッシュボード・ホーム（dashboard-*・home-*）。
// 年度をまたぐ表（場所・品目・距離）には書かない（開くだけ）。
import { expect, test, type Route } from '@playwright/test';
import { loginAs } from '../helpers';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { S05_GROUP, SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

test.describe('T09 マスタ設定（管理者）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T09 マスタ設定の各タブ（PC）と主なダイアログ', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-years-pc', { fullPage: true });

      for (const tab of ['rooms', 'items', 'groups', 'distance', 'users', 'export'] as const) {
        await page.getByTestId(`settings-tab-${tab}`).click();
        await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
        await expect(page.getByRole('status').filter({ hasText: '読み込み中…' })).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
        await shoot(page, 'T09', `settings-${tab}-pc`);
      }

      // 団体の編集のシート
      await page.getByTestId('settings-tab-groups').click();
      await page.getByRole('row').filter({ hasText: S05_GROUP }).getByRole('button', { name: '編集' }).click();
      await expect(page.getByTestId('group-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-group-edit-pc');
      await page.keyboard.press('Escape');

      // 参照している有効なルールがあって削除できない確認
      await page.getByRole('row').filter({ hasText: S05_GROUP }).getByRole('button', { name: '削除' }).click();
      await expect(page.getByTestId('rule-refs')).toBeVisible();
      await shoot(page, 'T09', 'settings-group-delete-blocked-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      // CSV の取り込みのプレビュー（エラーの行つき）
      await page.getByTestId('groups-csv-open').click();
      await page.getByLabel('CSV ファイル（UTF-8 か Shift_JIS）').setInputFiles({
        name: 'groups.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          `団体名,表示名,区分,飲食,使用場所,別名,並び順\n${S05_GROUP},設営の企画,部門,いいえ,,,\n新しい模擬店,,模擬店,はい,1-1,新|しん,\n余り,,模擬店,,,,\n`,
          'utf8',
        ),
      });
      await expect(page.getByTestId('groups-csv-preview')).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-csv-pc');
      await page.getByRole('button', { name: 'やめる' }).click();

      // 場所の今年の使用（振り分け中で固定・手動の行がなければ使用不可にできる）
      await page.getByTestId('settings-tab-rooms').click();
      await page.getByRole('row').filter({ has: page.getByRole('cell', { name: '1-1', exact: true }) }).getByRole('button', { name: '1-1の今年の使用を変える' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T09', 'settings-room-usable-pc');
      await page.keyboard.press('Escape');

      // 書き出しの確定前の確認
      await page.getByTestId('settings-tab-export').click();
      await page.getByTestId('export-xlsx').click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T09', 'settings-export-confirm-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T09 マスタ設定の読み込み中（団体の読み込みを止めて撮る）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    try {
      await page.route('**/rest/v1/groups*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T09', 'settings-loading-pc');
      release();
      await expect(page.getByTestId('group-add')).toBeVisible();
    } finally {
      release();
      await s.cleanup();
    }
  });

  test('T09 マスタ設定の空と終了した年度（読み取り専用）', async ({ page }) => {
    const s = await createScenario({ status: 'closed', dataset: 'empty', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await expect(page.getByText('団体がありません')).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-empty-closed-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T09 マスタ設定（スマホ）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      await page.setViewportSize(MOBILE);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('year-edit-form')).toBeVisible();
      await shoot(page, 'T09', 'settings-years-mobile', { fullPage: true });
      await page.goto('/settings/?tab=groups');
      await expect(page.getByRole('cell', { name: SMALL.groups.stall, exact: true })).toBeVisible();
      await shoot(page, 'T09', 'settings-groups-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 マスタ設定（権限なし）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T09 部員がマスタ設定を開いたとき', async ({ page }) => {
    await page.goto('/settings/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T09', 'settings-forbidden-pc');
  });
});

// ---- 段 2：ダッシュボード・ホーム（dashboard-*・home-*）

/** 了承が要る置き換え（机(木) → キャスター机）を1行と、その了承の行を入れる */
async function addSwap(yearId: string, roomId: string, groupId: string, status: 'asked' | 'declined' | null): Promise<void> {
  const [desk] = await sql<{ id: string }>("select id from public.items where code = 'desk'");
  const [caster] = await sql<{ id: string }>("select id from public.items where code = 'caster_desk'");
  await sql(
    `insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
     values ($1, $2, $3, $4, $5, 2, false, 'manual')`,
    [yearId, roomId, groupId, caster!.id, desk!.id],
  );
  if (status) {
    await sql(
      `insert into public.substitution_consents (group_id, from_item_id, to_item_id, status, count) values ($1, $2, $3, $4, 1)
       on conflict (group_id, from_item_id, to_item_id) do update set status = excluded.status, count = excluded.count`,
      [groupId, desk!.id, caster!.id, status],
    );
  }
}

test.describe('T09 ダッシュボード（管理者）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T09 ダッシュボード：振り分け中（了承の状況つき。PC）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    try {
      // 了承の状況（拒否・依頼済み・未依頼）を1団体ずつ（在庫を超えるので error も出る）
      await addSwap(s.yearId, s.ids.rooms['1-1']!, s.ids.groups['模擬店01']!, 'declined');
      await addSwap(s.yearId, s.ids.rooms['1-1']!, s.ids.groups['模擬店02']!, 'asked');
      await addSwap(s.yearId, s.ids.rooms['1-1']!, s.ids.groups['模擬店03']!, null);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-validation-counts')).toBeVisible();
      await expect(page.getByTestId('dashboard-consent-statuses')).toBeVisible();
      await shoot(page, 'T09', 'dashboard-allocating-pc', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });

  test('T09 ダッシュボード：確定のダイアログと版の見張りの帯', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-validation-counts')).toBeVisible();
      await page.getByTestId('year-status-actions').getByRole('button', { name: '確定', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByLabel(/理由/).fill('在庫の確認が済んだため');
      await shoot(page, 'T09', 'dashboard-confirm-dialog-pc');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // ほかの人が入力を変えた（版が進む）→ 画面に戻ったときに帯が出る
      await sql('update public.stocks set count = count + 1 where year_id = $1 and room_id = (select min(room_id::text)::uuid from public.stocks where year_id = $1)', [s.yearId]);
      await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
      await expect(page.getByTestId('stale-banner')).toBeVisible();
      await expect(page.getByTestId('confirm-blockers')).toContainText('ほかの人が入力を変えました');
      await shoot(page, 'T09', 'dashboard-stale-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T09 ダッシュボード：受付中（未提出・未計数つき）、確定中と終了のダイアログ', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { admin: true } });
    const c = await createScenario({ status: 'confirmed', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    try {
      // 未提出を6団体、数えていない場所を2か所にする
      await sql(
        `delete from public.request_submissions where group_id in (select id from public.groups where year_id = $1 order by sort_order desc limit 6)`,
        [s.yearId],
      );
      await sql("delete from public.stocks where year_id = $1 and room_id in (select id from public.rooms where name in ('1-1', '1-2'))", [s.yearId]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-unsubmitted')).toBeVisible();
      await shoot(page, 'T09', 'dashboard-requesting-pc', { fullPage: true });

      const p2 = await page.context().newPage();
      await pinYear(p2, SEED_USER_IDS.admin, c.yearId);
      await p2.goto('/');
      await expect(p2.getByTestId('dashboard-validation-counts')).toBeVisible();
      await shoot(p2, 'T09', 'dashboard-confirmed-pc', { fullPage: true });
      await p2.getByTestId('year-status-actions').getByRole('button', { name: '終了' }).click();
      await expect(p2.getByTestId('close-export-json')).toBeVisible();
      await shoot(p2, 'T09', 'dashboard-close-dialog-pc');
      await p2.close();
    } finally {
      await c.cleanup();
      await s.cleanup();
    }
  });

  test('T09 ダッシュボード：読み込み中（スナップショットを止めて撮る）と空の年度（受付開始を押せない）', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'empty', roles: { admin: true } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    try {
      await sql('update public.years set request_open_at = null, request_close_at = null where id = $1', [s.yearId]);
      await page.route('**/rest/v1/stocks*', async (route: Route) => {
        await held;
        await route.continue();
      });
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-loading')).toBeVisible();
      await shoot(page, 'T09', 'dashboard-loading-pc');
      release();
      await expect(page.getByTestId('dashboard-year')).toBeVisible();
      await expect(page.getByTestId('year-status-actions').getByRole('button', { name: '受付開始' })).toBeDisabled();
      await shoot(page, 'T09', 'dashboard-empty-pc', { fullPage: true });
    } finally {
      release();
      await s.cleanup();
    }
  });

  test('T09 ダッシュボード（スマホ）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    try {
      await page.setViewportSize(MOBILE);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-validation-counts')).toBeVisible();
      expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T09', 'dashboard-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ダッシュボード（部員）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T09 部員のダッシュボード（状態のボタンなし・入力の誤りはコードだけ）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { staff: true } });
    try {
      await addSwap(s.yearId, s.ids.rooms[SMALL.rooms.storageA]!, s.ids.groups[SMALL.groups.stall]!, 'declined');
      await sql(
        `insert into public.rules (year_id, code, kind, params, enabled)
         values ($1, 'E2E-BROKEN', 'keep', jsonb_build_object('group', gen_random_uuid(), 'room', $2::uuid, 'items', jsonb_build_array('desk')), true)`,
        [s.yearId, s.ids.rooms[SMALL.rooms.class1]],
      );
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('dashboard-problems')).toBeVisible();
      await shoot(page, 'T09', 'dashboard-staff-pc', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ホーム（団体代表）', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: MOBILE });

  test('T09 団体代表のホーム（スマホ）：受付中と交換の依頼、確定後', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: SMALL.groups.stall });
    try {
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('rep-card')).toBeVisible();
      await shoot(page, 'T09', 'home-rep-mobile', { fullPage: true });

      await addSwap(s.yearId, s.ids.rooms[SMALL.rooms.storageA]!, s.ids.groups[SMALL.groups.stall]!, 'asked');
      await sql("update public.years set status = 'allocating' where id = $1", [s.yearId]);
      await page.reload();
      await expect(page.getByTestId('rep-consent-asked')).toBeVisible();
      expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, 'T09', 'home-rep-consent-mobile', { fullPage: true });

      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await page.reload();
      await expect(page.getByTestId('rep-final')).toBeVisible();
      await shoot(page, 'T09', 'home-rep-final-mobile', { fullPage: true });
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ホーム（閲覧のみ）', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: MOBILE });

  test('T09 閲覧のみのホーム（スマホ）：確定前と確定後', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('viewer-home')).toBeVisible();
      await shoot(page, 'T09', 'home-viewer-mobile');
      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await page.reload();
      await expect(page.getByTestId('viewer-home').getByRole('link', { name: '振り分け表を見る' })).toBeVisible();
      await shoot(page, 'T09', 'home-viewer-confirmed-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test('T09 ホーム（権限なし：招待されていない人）', async ({ page }) => {
  await page.setViewportSize(PC);
  await loginAs(page, 'outsider');
  await expect(page.getByRole('heading', { name: '総務から招待されていません' })).toBeVisible();
  await shoot(page, 'T09', 'home-not-invited-pc');
});
