import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, createUser, sql, type TestUser } from './support/db';
import { SMALL } from './support/datasets';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T09 ダッシュボード・ホーム（画面の設計 3.1・7.2 の表の T09 の行）。シナリオの年度（2001 年）で閉じる。
// seed の利用者にはシナリオの年度にだけロールを付ける。兼ねる人のテストは createUser のユーザーで（D-36）。

async function loginWith(page: Page, u: TestUser): Promise<void> {
  await page.goto('/login/');
  const form = page.getByTestId('test-login-form');
  await form.getByLabel('メールアドレス').fill(u.email);
  await form.getByLabel('パスワード').fill(u.password);
  await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
  await expect(page.getByTestId('current-year')).toBeVisible();
}

/** ダッシュボードが読み終わるのを待つ */
async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
  await expect(page.getByTestId('dashboard-year')).toBeVisible();
}

const statusOf = async (yearId: string) => (await sql<{ status: string }>('select status from public.years where id = $1', [yearId]))[0]!.status;
const versionOf = async (yearId: string) =>
  (await sql<{ v: number }>('select allocation_version as v from public.years where id = $1', [yearId]))[0]!.v;
const actions = (page: Page) => page.getByTestId('year-status-actions');
const dialog = (page: Page) => page.getByRole('dialog');

test.describe('T09 ダッシュボード（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T09 受付中：提出・在庫・検証（振り分け前）・了承の数と立場の一覧が出る', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      // 模擬店1 を未提出に、倉庫B を数えていないことにする
      await sql('delete from public.request_submissions where group_id = $1', [s.ids.groups[SMALL.groups.stall]]);
      await sql('delete from public.stocks where year_id = $1 and room_id = $2', [s.yearId, s.ids.rooms[SMALL.rooms.storageB]]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);

      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（申請受付中）`);
      await expect(page.getByTestId('home-roles')).toHaveText('総務管理者');

      const sub = page.getByTestId('dashboard-submissions');
      await expect(sub).toContainText('2 ／ 3団体');
      await expect(sub.getByTestId('dashboard-submissions-by-category')).toHaveText('模擬店 0／1部門 1／1企業 1／1');
      await expect(sub.getByTestId('dashboard-unsubmitted')).toContainText(`未提出 1 団体${SMALL.groups.stall}`);
      await expect(sub.getByRole('link', { name: '未提出の団体を申請一覧で見る' })).toHaveAttribute('href', /\/requests\/?\?filter=unsubmitted$/);

      const st = page.getByTestId('dashboard-stocks');
      await expect(st).toContainText('2 ／ 3か所');
      await expect(st.getByRole('link', { name: SMALL.rooms.storageB })).toHaveAttribute('href', new RegExp(`/stock/?\\?room=${s.ids.rooms[SMALL.rooms.storageB]}$`));

      await expect(page.getByTestId('dashboard-validation')).toContainText('振り分け前（検証は振り分け中から）');
      await expect(page.getByTestId('dashboard-consents')).toContainText('了承が要る置き換えはありません');
      await expect(page.getByTestId('dashboard-consents').getByRole('link', { name: 'キャスター机交換へ' })).toBeVisible();
      await expect(actions(page).getByRole('button', { name: '締切（振り分けを始める）' })).toBeEnabled();
    } finally {
      await s.cleanup();
    }
  });

  test('T09 状態の遷移：締切がないと受付開始を押せずマスタ設定へ案内、受付開始 → 締切（締切前の確認）', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'small', roles: { admin: true } });
    try {
      await sql('update public.years set request_open_at = null, request_close_at = null where id = $1', [s.yearId]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);
      const start = actions(page).getByRole('button', { name: '受付開始' });
      await expect(start).toBeDisabled();
      await expect(actions(page)).toContainText('先に受付期間（締切は未来の日時）を入れてください。');
      await expect(actions(page).getByRole('link', { name: 'マスタ設定の年度へ' })).toHaveAttribute('href', /\/settings\/?\?tab=years$/);

      await sql("update public.years set request_close_at = now() + interval '30 days' where id = $1", [s.yearId]);
      await page.reload();
      await expect(start).toBeEnabled();
      await start.click();
      await expect(dialog(page)).toContainText('団体代表が申請を書けるようになります。');
      await dialog(page).getByRole('button', { name: '受付開始' }).click();
      await expect(page.getByText(`${s.label} を「受付開始」にしました`)).toBeVisible();
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（申請受付中）`);
      expect(await statusOf(s.yearId)).toBe('requesting');

      await actions(page).getByRole('button', { name: '締切（振り分けを始める）' }).click();
      await expect(dialog(page)).toContainText('締切の前ですが、団体代表は申請を変えられなくなります。');
      await dialog(page).getByRole('button', { name: '締切（振り分けを始める）' }).click();
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（振り分け中）`);
      expect(await statusOf(s.yearId)).toBe('allocating');
      // 振り分け中は検証の数が出る
      await expect(page.getByTestId('dashboard-validation-counts')).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });

  test('T09 確定：2つの画面で開き、在庫が変わってから片方で確定すると検証をやり直し、もう一度押すと確定する。確定の解除は理由が必須', async ({ page, browser }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    const other = await openSecondAdmin(browser, s.yearId);
    try {
      // 2つの画面（同じ管理者の別のブラウザ）でダッシュボードを開く
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);
      await expect(page.getByTestId('dashboard-validation-counts')).toContainText('0error');
      await openDashboard(other);
      await expect(other.getByTestId('dashboard-validation-counts')).toContainText('0error');
      const before = await versionOf(s.yearId);

      // 開いた後に在庫を1つ増やす。このブランチには在庫入力の画面（T10）がないので、DB に直接（超ユーザーの SQL で）書く
      // （stocks の更新のトリガーで版が進む）。どちらの画面も読み直していないので、見張りが気づく前に確定を押す
      const [st] = await sql<{ room_id: string; item_id: string; count: number }>(
        'select room_id, item_id, count from public.stocks where year_id = $1 order by room_id, item_id limit 1',
        [s.yearId],
      );
      const changed = await sql<{ count: number }>(
        'update public.stocks set count = count + 1 where year_id = $1 and room_id = $2 and item_id = $3 returning count',
        [s.yearId, st!.room_id, st!.item_id],
      );
      expect(changed).toEqual([{ count: st!.count + 1 }]);
      expect(await versionOf(s.yearId)).toBeGreaterThan(before);

      const confirm = actions(page).getByRole('button', { name: '確定', exact: true });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await confirmInDialog(page, '在庫の確認が済んだため');
      await expect(page.getByTestId('error-banner')).toContainText(
        '確定の前に入力が変わったので、検証をやり直しました。結果を確かめてから、もう一度『確定』を押してください',
      );
      await expect(dialog(page)).toHaveCount(0);
      expect(await statusOf(s.yearId)).toBe('allocating');

      await expect(confirm).toBeEnabled();
      await confirm.click();
      await confirmInDialog(page, '在庫の確認が済んだため');
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（確定）`);
      expect(await statusOf(s.yearId)).toBe('confirmed');
      await expect(page.getByTestId('error-banner')).toHaveCount(0);

      // 確定の解除：理由が空なら欄にエラー
      await actions(page).getByRole('button', { name: '確定を解除' }).click();
      await expect(dialog(page)).toContainText('確定を解除すると、団体への公開も止まります。');
      await dialog(page).getByRole('button', { name: '確定を解除' }).click();
      await expect(dialog(page)).toContainText('理由を入れてください');
      await dialog(page).getByLabel(/理由/).fill('団体の申請の直しのため');
      await dialog(page).getByRole('button', { name: '確定を解除' }).click();
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（振り分け中）`);
      expect(await statusOf(s.yearId)).toBe('allocating');
    } finally {
      await other.context().close();
      await s.cleanup();
    }
  });

  test('T09 確定：別の画面で確定と解除をされた後に確定を押しても検証をやり直す', async ({ page, browser }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    const other = await openSecondAdmin(browser, s.yearId);
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);
      await expect(page.getByTestId('dashboard-validation-counts')).toContainText('0error');
      await openDashboard(other);
      await expect(other.getByTestId('dashboard-validation-counts')).toContainText('0error');
      const before = await versionOf(s.yearId);

      // もう1つの画面で、画面から確定して確定を解除する（状態が2回変わり、版が進む）
      await actions(other).getByRole('button', { name: '確定', exact: true }).click();
      await confirmInDialog(other, '別の画面での確定');
      await expect(other.getByTestId('home-year')).toHaveText(`${s.label}（確定）`);
      await actions(other).getByRole('button', { name: '確定を解除' }).click();
      await dialog(other).getByLabel(/理由/).fill('別の画面での確定の解除');
      await dialog(other).getByRole('button', { name: '確定を解除' }).click();
      await expect(other.getByTestId('home-year')).toHaveText(`${s.label}（振り分け中）`);
      expect(await statusOf(s.yearId)).toBe('allocating');
      expect(await versionOf(s.yearId)).toBeGreaterThan(before);

      const confirm = actions(page).getByRole('button', { name: '確定', exact: true });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await confirmInDialog(page, '在庫の確認が済んだため');
      await expect(page.getByTestId('error-banner')).toContainText('確定の前に入力が変わったので、検証をやり直しました');
      expect(await statusOf(s.yearId)).toBe('allocating');
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await confirmInDialog(page, '在庫の確認が済んだため');
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（確定）`);
      expect(await statusOf(s.yearId)).toBe('confirmed');
    } finally {
      await other.context().close();
      await s.cleanup();
    }
  });

  test('T09 読み直しの失敗：データがあるときは中身を残して帯で知らせ、もう一度で消える', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);
      await expect(page.getByTestId('dashboard-stocks')).toBeVisible();
      let fail = true;
      await page.route('**/rest/v1/stocks*', async (route) => {
        if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"e2e"}' });
        else await route.continue();
      });
      await page.getByRole('main').getByRole('button', { name: '読み直す', exact: true }).click();
      const banner = page.getByTestId('dashboard-reload-error');
      await expect(banner).toBeVisible();
      await expect(banner.getByRole('alert')).toBeVisible();
      // 中身は前のまま
      await expect(page.getByTestId('dashboard-year')).toBeVisible();
      await expect(page.getByTestId('dashboard-stocks')).toBeVisible();
      fail = false;
      await banner.getByRole('button', { name: 'もう一度' }).click();
      await expect(banner).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });

  test('T09 終了：書き出しのボタンが並び、終了すると状態のボタンが消える', async ({ page }) => {
    const s = await createScenario({ status: 'confirmed', dataset: 'synthetic', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(page);
      await actions(page).getByRole('button', { name: '終了' }).click();
      const d = dialog(page);
      await expect(d).toContainText('終了すると読み取り専用になり、戻せません。先に年度データと振り分け表を書き出してください。');
      const download = page.waitForEvent('download');
      await d.getByTestId('close-export-json').click();
      expect((await download).suggestedFilename()).toBe(`${s.label}_年度データ.json`);
      const xlsx = page.waitForEvent('download');
      await d.getByTestId('close-export-xlsx').click();
      expect((await xlsx).suggestedFilename()).toBe(`${s.label}_椅子机振り分け_部門員共有用.xlsx`);
      await d.getByRole('button', { name: '終了' }).click();
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（終了）`);
      expect(await statusOf(s.yearId)).toBe('closed');
      await expect(actions(page)).toHaveCount(0);
      await expect(page.getByTestId('dashboard-validation')).toContainText('終了した年度です');
    } finally {
      await s.cleanup();
    }
  });
});

/** 同じ管理者の別の画面（別のブラウザのコンテキスト。フォーカスの移りで見張りを動かさないため） */
async function openSecondAdmin(browser: Browser, yearId: string): Promise<Page> {
  const ctx = await browser.newContext({ storageState: storageStateFor('admin') });
  const p = await ctx.newPage();
  await pinYear(p, SEED_USER_IDS.admin, yearId);
  return p;
}

/** 確定のダイアログ：理由を入れ、warning があれば確認のチェックを入れて押す */
async function confirmInDialog(page: Page, reason: string): Promise<void> {
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByLabel(/理由/).fill(reason);
  const check = d.getByLabel('warning を確認しました');
  if ((await check.count()) > 0) await check.check();
  await d.getByRole('button', { name: '確定', exact: true }).click();
}

test.describe('T09 ダッシュボード（部員）', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T09 部員：数は見えるが状態のボタンがなく、開けない画面（キャスター机交換・ルール・マスタ設定）へのリンクがない', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { staff: true } });
    try {
      // 了承が要る置き換え（机(木) → キャスター机）と、参照の切れたルールを入れる
      const desk = (await sql<{ id: string }>("select id from public.items where code = 'desk'"))[0]!.id;
      const caster = (await sql<{ id: string }>("select id from public.items where code = 'caster_desk'"))[0]!.id;
      await sql(
        `insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
         values ($1, $2, $3, $4, $5, 2, false, 'auto')`,
        [s.yearId, s.ids.rooms[SMALL.rooms.storageA], s.ids.groups[SMALL.groups.stall], caster, desk],
      );
      await sql(
        `insert into public.rules (year_id, code, kind, params, enabled)
         values ($1, 'E2E-BROKEN', 'keep', jsonb_build_object('group', gen_random_uuid(), 'room', $2::uuid, 'items', jsonb_build_array('desk')), true)`,
        [s.yearId, s.ids.rooms[SMALL.rooms.class1]],
      );
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openDashboard(page);
      await expect(page.getByTestId('home-roles')).toHaveText('総務部員');

      await expect(page.getByTestId('dashboard-consents')).toContainText('未依頼 1');
      await expect(page.getByTestId('dashboard-problems')).toContainText('E2E-BROKEN');
      await expect(page.getByTestId('dashboard-problems').getByRole('link')).toHaveCount(0);
      await expect(page.getByTestId('year-status-actions')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /確定|締切|受付開始|終了/ })).toHaveCount(0);

      const main = page.getByRole('main');
      for (const path of ['/swaps', '/rules', '/settings', '/history']) {
        await expect(main.locator(`a[href*="${path}"]`)).toHaveCount(0);
      }
      // 開ける画面へのリンクはある
      await expect(main.locator('a[href*="/allocation"]')).toHaveCount(1);
      await expect(main.locator('a[href*="/requests"]')).toHaveCount(0); // 全団体が提出済み
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ホーム（団体代表）', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T09 団体代表：申請の状況・締切・申請へのボタン、交換の依頼、確定後の案内', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: SMALL.groups.stall });
    try {
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'ホーム' })).toBeVisible();
      await expect(page.getByTestId('home-roles')).toHaveText(`${SMALL.groups.stall} の団体代表`);
      const card = page.getByTestId('rep-card');
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId('rep-submission')).toHaveText('提出済み（7/1 12:00）');
      await expect(card.getByRole('link', { name: '申請を直す' })).toHaveAttribute('href', new RegExp(`/request/?\\?group=${s.ids.groups[SMALL.groups.stall]}$`));
      await expect(card.getByTestId('rep-consent-asked')).toHaveCount(0);
      await expect(page.getByTestId('dashboard-year')).toHaveCount(0);

      // 交換の依頼（asked）があると自団体の振り分けへ
      const desk = (await sql<{ id: string }>("select id from public.items where code = 'desk'"))[0]!.id;
      const caster = (await sql<{ id: string }>("select id from public.items where code = 'caster_desk'"))[0]!.id;
      await sql(
        `insert into public.substitution_consents (group_id, from_item_id, to_item_id, status, count) values ($1, $2, $3, 'asked', 2)`,
        [s.ids.groups[SMALL.groups.stall], desk, caster],
      );
      await sql('delete from public.request_submissions where group_id = $1', [s.ids.groups[SMALL.groups.stall]]);
      await page.reload();
      await expect(card.getByTestId('rep-submission')).toHaveText('未提出');
      await expect(card.getByRole('link', { name: '申請する' })).toBeVisible();
      await expect(card.getByTestId('rep-consent-asked')).toContainText('キャスター机への交換の依頼があります');
      await expect(card.getByRole('link', { name: '依頼に答える' })).toHaveAttribute('href', new RegExp(`/my/?\\?group=${s.ids.groups[SMALL.groups.stall]}$`));

      // 確定後
      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await page.reload();
      await expect(card.getByTestId('rep-final')).toContainText('振り分けが決まりました');
      await expect(card.getByRole('link', { name: '自団体の振り分けを見る' })).toBeVisible();
      await expect(card.getByRole('link', { name: '申請を見る' })).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ホーム（閲覧のみ）', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('T09 閲覧のみ：確定前は案内だけ、確定後は振り分け表へのリンク', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/');
      await expect(page.getByTestId('home-roles')).toHaveText('閲覧のみ');
      await expect(page.getByTestId('viewer-home')).toContainText('振り分けが確定すると、ここから見られます。');
      await expect(page.getByRole('main').locator('a[href*="/allocation"]')).toHaveCount(0);
      await expect(page.getByTestId('dashboard-year')).toHaveCount(0);

      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await page.reload();
      await expect(page.getByTestId('viewer-home').getByRole('link', { name: '振り分け表を見る' })).toHaveAttribute('href', /\/allocation\/?$/);
    } finally {
      await s.cleanup();
    }
  });
});

test('T09 部員で団体代表も兼ねる人：団体代表のカードがダッシュボードの上に出る', async ({ page }) => {
  const u = await createUser({ purpose: 'staffrep' });
  const s = await createScenario({ status: 'requesting', dataset: 'small', grants: [{ userId: u.id, role: 'staff' }] });
  try {
    await sql('insert into public.group_members (group_id, user_id) values ($1, $2)', [s.ids.groups[SMALL.groups.department], u.id]);
    await loginWith(page, u);
    await expect(page.getByTestId('home-roles')).toHaveText(`総務部員${SMALL.groups.department} の団体代表`);
    await expect(page.getByTestId('rep-card')).toHaveAttribute('data-group', SMALL.groups.department);
    await expect(page.getByTestId('dashboard-year')).toBeVisible();
    const repTop = (await page.getByTestId('rep-card').boundingBox())!.y;
    const dashTop = (await page.getByTestId('dashboard-year').boundingBox())!.y;
    expect(repTop).toBeLessThan(dashTop);
  } finally {
    await s.cleanup();
    await u.cleanup();
  }
});
