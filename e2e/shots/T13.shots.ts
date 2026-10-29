// T13 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T13` で notes/T13/ に撮る（CI では流さない）。
// 段 1：振り分け画面（読み込み中・空〔まだ自動振り分けをしていない〕・権限なし〔確定前の閲覧のみ〕・受付中）、
// 計算中のロック、自動振り分けの後、確定前の Excel の確認、解けない入力のパネル、部員の読み取り・団体別、閲覧のみの確定後、スマホ幅。
// 読み込み中とロックは page.route で応答を止めてから撮る。
// 段 2：行の編集（未保存の変更のバー・備考・運び元・理由のダイアログ）、使用不可にする前の一覧、使用不可にした後、
// 下書きを戻す表示、ほかの人の変更とぶつかって外した変更、検証の一覧の E002 の操作。
// 段 3：キャスター机交換（読み込み中・一覧・操作のダイアログ・エラーの帯・確定中の読み取り・置き換えなし・部員の権限なし）、
// 自団体の振り分け（スマホ。読み込み中・確定前の依頼・回答の後・待ってください・確定後・団体の切り替え・申請なし・管理者の権限なし）。
import { expect, test, type Page } from '@playwright/test';
import { accessToken, rpc, storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

async function hold(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route(pattern, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test.describe('T13 管理者', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T13 振り分け：読み込み中・まだ自動振り分けをしていない・ロック・自動振り分けの後・確定前の Excel の確認', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      const releaseLoad = await hold(page, '**/rest/v1/allocations*');
      await page.goto('/allocation/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-loading-pc');
      releaseLoad();
      await page.unroute('**/rest/v1/allocations*');

      await expect(page.getByText('まだ自動振り分けをしていません')).toBeVisible();
      await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
      await shoot(page, 'T13', 'allocation-empty-pc');

      await page.getByRole('button', { name: '自動振り分け', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T13', 'allocation-auto-confirm-pc');

      const releaseSave = await hold(page, '**/rest/v1/rpc/save_auto_allocations');
      await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
      await expect(page.getByTestId('allocate-lock')).toHaveAttribute('data-phase', 'saving');
      await shoot(page, 'T13', 'allocation-lock-pc');
      releaseSave();
      await expect(page.getByTestId('allocate-elapsed')).toBeVisible({ timeout: 30_000 });
      await page.unroute('**/rest/v1/rpc/save_auto_allocations');
      await shoot(page, 'T13', 'allocation-after-auto-pc');
      await shoot(page, 'T13', 'allocation-after-auto-full-pc', { fullPage: true });

      await page.getByRole('button', { name: 'Excel出力' }).click();
      await expect(page.getByRole('alertdialog').getByText('確定前の振り分けです')).toBeVisible();
      await shoot(page, 'T13', 'allocation-excel-before-confirm-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      await page.getByTestId('year-status-actions').getByRole('button', { name: '確定', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, 'T13', 'allocation-confirm-dialog-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 振り分け：解けない入力（S05）のパネル', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic-infeasible-s05', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '自動振り分け', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
      await expect(page.getByTestId('allocate-failure')).toBeVisible({ timeout: 30_000 });
      await shoot(page, 'T13', 'allocation-infeasible-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 振り分け：受付中の年度（締切の後に振り分けます）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByText('締切の後に振り分けます')).toBeVisible();
      await shoot(page, 'T13', 'allocation-requesting-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 管理者（段 2：手での編集と使用不可の部屋）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T13 振り分けの編集：未保存の変更・備考・運び元・理由・下書き・使用不可にする前の一覧・ぶつかった変更・E002', async ({ page, context }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      const mer = await sql<{ id: string }>(
        `select a.id from public.allocations a join public.items i on i.id = a.item_id join public.rooms r on r.id = a.source_room_id
         where a.year_id = $1 and r.name = 'MER' and i.code = 'desk' order by a.id`,
        [s.yearId],
      );
      await sql(`update public.allocations set pinned = true where id = $1`, [mer[0]!.id]);
      await sql(`update public.allocations set origin = 'manual' where id = $1`, [mer[1]!.id]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto(`/allocation/?row=${mer[0]!.id}`);
      const row = page.locator(`[data-row-id="${mer[0]!.id}"]`);
      await expect(row).toBeVisible();
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeVisible();

      // 数を変える・行を追加する → 未保存の変更のバー（開いた一覧）
      await row.getByRole('button', { name: /を1増やす$/ }).click();
      await page.getByRole('button', { name: '行を追加' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: '行を追加' })).toBeVisible();
      await shoot(page, 'T13', 'allocation-add-row-dialog-pc');
      await page.getByRole('dialog').getByRole('button', { name: '追加する', exact: true }).click();
      const auto = page.locator('[data-row-id]').filter({ hasText: '自動' }).filter({ hasNot: page.locator('[data-pending]') }).first();
      await auto.getByRole('button', { name: '備考' }).click();
      await expect(page.getByText('備考を書くと、この行は手動の行になり')).toBeVisible();
      await shoot(page, 'T13', 'allocation-note-popover-pc');
      await page.keyboard.press('Escape');
      await page.getByTestId('pending-bar').getByRole('button', { name: /未保存の変更/ }).click();
      await expect(page.getByTestId('pending-list')).toBeVisible();
      await shoot(page, 'T13', 'allocation-pending-bar-pc');

      // 下書き：再読み込みすると「保存していない入力があります」
      await page.waitForTimeout(700); // 下書きは 500 ms まとめて書く
      await page.reload();
      await expect(page.getByTestId('draft-notice')).toBeVisible();
      await shoot(page, 'T13', 'allocation-draft-notice-pc');
      await page.getByTestId('draft-notice').getByRole('button', { name: '戻す' }).click();
      await expect(page.getByTestId('pending-bar')).toHaveAttribute('data-count', '2');

      // 運び元を変える
      await page.locator(`[data-row-id="${mer[0]!.id}"]`).getByRole('button', { name: /運び元を変える$/ }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: '運び元を変える' })).toBeVisible();
      await shoot(page, 'T13', 'allocation-source-dialog-pc');
      await page.getByRole('dialog').getByRole('button', { name: 'やめる' }).click();

      // 理由のダイアログ
      await page.getByTestId('pending-bar').getByRole('button', { name: '保存…' }).click();
      await expect(page.getByRole('dialog').getByLabel('理由（必須）')).toBeVisible();
      await shoot(page, 'T13', 'allocation-reason-dialog-pc');
      await page.getByRole('dialog').getByRole('button', { name: 'やめる' }).click();

      // ほかの画面で同じ行を変えて保存 → この画面の保存は「他の人が変更しました」で外れる
      const other = await context.newPage();
      await pinYear(other, SEED_USER_IDS.admin, s.yearId);
      await other.goto(`/allocation/?row=${mer[0]!.id}`);
      await other.locator(`[data-row-id="${mer[0]!.id}"]`).getByRole('button', { name: /を1増やす$/ }).click();
      await other.getByTestId('pending-bar').getByRole('button', { name: '保存…' }).click();
      await other.getByRole('dialog').getByLabel('理由（必須）').fill('E2E');
      await other.getByRole('dialog').getByRole('button', { name: '保存する' }).click();
      await expect(other.getByText(/^保存しました/)).toBeVisible();
      await other.close();
      await page.getByTestId('pending-bar').getByRole('button', { name: '保存…' }).click();
      await page.getByRole('dialog').getByLabel('理由（必須）').fill('E2E');
      await page.getByRole('dialog').getByRole('button', { name: '保存する' }).click();
      await expect(page.getByTestId('rows-dropped')).toBeVisible();
      await page.getByTestId('rows-dropped').scrollIntoViewIfNeeded();
      await shoot(page, 'T13', 'allocation-rows-dropped-pc');
      await page.getByTestId('pending-bar').getByRole('button', { name: '取り消す' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '取り消す' }).click();

      // 使用不可にする前の一覧（固定の自動の行と手動の行）
      const block = page.locator(`[data-room-block="${s.ids.rooms['MER']}"]`);
      await block.getByRole('button', { name: 'MERのメニュー' }).click();
      await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
      await expect(page.getByTestId('unusable-checklist')).toBeVisible();
      await shoot(page, 'T13', 'allocation-unusable-dialog-pc');
      await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).first().click();

      // ほかの人が先に使用不可にした形：検証の一覧の E002 に運び元の変更と削除だけ
      await sql(
        `insert into public.room_years (year_id, room_id, usable, note) values ($1, $2, false, 'E2E')
         on conflict (year_id, room_id) do update set usable = false`,
        [s.yearId, s.ids.rooms['MER']],
      );
      await page.reload();
      const e002 = page.getByTestId('issues-panel').locator('[data-issue-code="E002"]');
      await expect(e002).toBeVisible();
      await e002.scrollIntoViewIfNeeded();
      await shoot(page, 'T13', 'allocation-e002-actions-pc');
      await block.scrollIntoViewIfNeeded();
      await shoot(page, 'T13', 'allocation-unusable-rows-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 振り分けの編集：使用不可にした後（最小変更で再実行を目立たせる）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
      const block = page.locator(`[data-room-block="${s.ids.rooms['MER']}"]`);
      await block.getByRole('button', { name: 'MERのメニュー' }).click();
      await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
      await expect(page.getByTestId('unusable-checklist-empty')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: '使用不可にする' }).click();
      await expect(page.getByTestId('suggest-minimal')).toBeVisible();
      await shoot(page, 'T13', 'allocation-unusable-done-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 部員', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T13 振り分け：部員の読み取り（品目別・団体別・スマホ幅）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-pc');
      await page.getByRole('button', { name: '団体別' }).click();
      await expect(page.locator('[data-group-block]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-group-pc');
      await page.setViewportSize(MOBILE);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-staff-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 閲覧のみ', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: PC });

  test('T13 振り分け：閲覧のみ（確定前は権限なし、確定後は行の一覧）', async ({ page }) => {
    const before = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, before.yearId);
      await page.goto('/allocation/');
      await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
      await shoot(page, 'T13', 'allocation-viewer-forbidden-pc');
    } finally {
      await before.cleanup();
    }
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'allocation-viewer-confirmed-pc');
      await page.setViewportSize(MOBILE);
      await shoot(page, 'T13', 'allocation-viewer-confirmed-mobile');
    } finally {
      await s.cleanup();
    }
  });
});

/** シナリオの年度は最新の年度より前なので、書く前の「最新でない年度に記録します・回答します」を確かめる（T13-15） */
async function confirmNotLatest(page: Page, verb: '記録' | '回答'): Promise<void> {
  const d = page.getByRole('alertdialog').filter({ hasText: '最新でない年度' });
  await d.getByRole('button', { name: `この年度に${verb}する` }).click();
  await expect(d).toBeHidden();
}

const SUBS = `requested_item_id = (select id from public.items where code = 'desk')
  and item_id = (select id from public.items where code = 'caster_desk')`;

test.describe('T13 キャスター机交換', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T13 キャスター机交換：読み込み中・一覧・操作のダイアログ・エラーの帯', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      // 拒否なのに置き換えが残っている団体（注意の列）
      await sql(
        `update public.substitution_consents set status = 'declined' where group_id = $1
           and from_item_id = (select id from public.items where code = 'desk')`,
        [s.ids.groups['模擬店02']],
      );
      const release = await hold(page, '**/rest/v1/allocations*');
      await page.goto('/swaps/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T13', 'swaps-loading-pc');
      release();
      const row10 = page.locator('[data-row-id]').filter({ has: page.getByText('模擬店10', { exact: true }) });
      await expect(row10).toBeVisible();
      await page.unroute('**/rest/v1/allocations*');
      await shoot(page, 'T13', 'swaps-pc');
      await shoot(page, 'T13', 'swaps-full-pc', { fullPage: true });

      await row10.getByRole('button', { name: '依頼済みにする' }).click();
      await confirmNotLatest(page, '記録');
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expect(page.getByRole('alertdialog').getByTestId('swap-note-help')).toBeVisible();
      await shoot(page, 'T13', 'swaps-op-dialog-pc');
      await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();

      // 置き換えの行を消してから依頼する（画面は古い）→ no_rows のエラーの帯
      await sql(`delete from public.allocations where year_id = $1 and group_id = $2 and ${SUBS}`, [s.yearId, s.ids.groups['模擬店10']]);
      await row10.getByRole('button', { name: '依頼済みにする' }).click();
      await confirmNotLatest(page, '記録');
      await page.getByRole('alertdialog').getByRole('button', { name: '依頼済みにする' }).click();
      await expect(page.getByTestId('error-banner')).toBeVisible();
      await shoot(page, 'T13', 'swaps-error-banner-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 キャスター机交換：確定中の読み取り・置き換えなし', async ({ page }) => {
    const confirmed = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { admin: true } });
    const empty = await createScenario({ dataset: 'small', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, confirmed.yearId);
      await page.goto('/swaps/');
      await expect(page.getByTestId('read-only-notice')).toBeVisible();
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await shoot(page, 'T13', 'swaps-confirmed-pc');
      await pinYear(page, SEED_USER_IDS.admin, empty.yearId);
      await page.goto('/swaps/');
      await expect(page.getByText('キャスター机への置き換えはありません')).toBeVisible();
      await shoot(page, 'T13', 'swaps-empty-pc');
    } finally {
      await confirmed.cleanup();
      await empty.cleanup();
    }
  });
});

test.describe('T13 キャスター机交換（部員）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T13 キャスター机交換：部員は権限なし', async ({ page }) => {
    const s = await createScenario({ dataset: 'small', status: 'allocating', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/swaps/');
      await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
      await shoot(page, 'T13', 'swaps-forbidden-pc');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 自団体の振り分け', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: MOBILE });

  test('T13 自団体の振り分け：読み込み中・確定前の依頼・回答の後・待ってください', async ({ page, request }) => {
    const s = await createScenario({
      dataset: 'synthetic',
      status: 'allocating',
      allocations: 'reference',
      roles: { admin: true },
      repGroup: '模擬店10',
    });
    try {
      const g = s.ids.groups['模擬店10']!;
      const [ids] = await sql<{ desk: string; caster: string }>(
        `select (select id from public.items where code = 'desk') as desk, (select id from public.items where code = 'caster_desk') as caster`,
      );
      const admin = await accessToken(request, 'admin');
      const ask = () => rpc(request, admin, 'set_consent', { p_group_id: g, p_from_item: ids!.desk, p_to_item: ids!.caster, p_status: 'asked' });
      expect((await ask()).error).toBeNull();
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      const release = await hold(page, '**/rest/v1/substitution_consents*');
      await page.goto('/my/');
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' }).first()).toBeVisible();
      await shoot(page, 'T13', 'my-loading-mobile');
      release();
      const card = page.getByTestId('my-consent');
      await expect(card).toBeVisible();
      await page.unroute('**/rest/v1/substitution_consents*');
      await shoot(page, 'T13', 'my-before-mobile');
      await shoot(page, 'T13', 'my-before-full-mobile', { fullPage: true });

      await card.getByRole('button', { name: '了承する' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shoot(page, 'T13', 'my-not-latest-confirm-mobile');
      await confirmNotLatest(page, '回答');
      await expect(card).toHaveAttribute('data-status', 'accepted');
      await shoot(page, 'T13', 'my-answered-mobile');
      await card.getByRole('button', { name: '回答を変える' }).click();
      await shoot(page, 'T13', 'my-change-answer-mobile');

      // 依頼し直した後に置き換えが増えた → 了承は記録できない
      expect((await ask()).error).toBeNull();
      await sql(
        `update public.allocations set count = count + 1 where id = (
           select id from public.allocations where year_id = $1 and group_id = $2 and ${SUBS} order by id limit 1)`,
        [s.yearId, g],
      );
      await page.reload();
      await card.getByRole('button', { name: '了承する' }).click();
      await confirmNotLatest(page, '回答');
      await expect(card.getByTestId('my-consent-wait')).toBeVisible();
      await shoot(page, 'T13', 'my-wait-reask-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T13 自団体の振り分け：確定後・団体の切り替え・申請なし', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', repGroup: '模擬店07' });
    const empty = await createScenario({ dataset: 'small', status: 'allocating', repGroup: 'E2E模擬店1' });
    try {
      await sql('insert into public.group_members (group_id, user_id) values ($1, $2)', [s.ids.groups['模擬店08'], SEED_USER_IDS.rep]);
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.goto('/my/');
      await expect(page.getByTestId('my-allocations')).toBeVisible();
      await shoot(page, 'T13', 'my-final-mobile');
      await shoot(page, 'T13', 'my-final-full-mobile', { fullPage: true });
      await page.getByTestId('my-group-select').selectOption(s.ids.groups['模擬店08']!);
      await expect(page.getByTestId('my-group')).toHaveText(/模擬店08/);
      await shoot(page, 'T13', 'my-group-switch-mobile');

      await sql('delete from public.requests where group_id = $1', [empty.ids.groups['E2E模擬店1']]);
      await pinYear(page, SEED_USER_IDS.rep, empty.yearId);
      await page.goto('/my/');
      await expect(page.getByText('申請している品目はありません')).toBeVisible();
      await shoot(page, 'T13', 'my-empty-mobile');
    } finally {
      await s.cleanup();
      await empty.cleanup();
    }
  });
});

test.describe('T13 自団体の振り分け（管理者）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: MOBILE });

  test('T13 自団体の振り分け：団体代表でなければ権限なし', async ({ page }) => {
    const s = await createScenario({ dataset: 'small', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/my/');
      await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
      await shoot(page, 'T13', 'my-forbidden-mobile');
    } finally {
      await s.cleanup();
    }
  });
});
