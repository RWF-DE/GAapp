import { expect, test, type Page } from '@playwright/test';
import { navLabels } from './helpers';
import { storageStateFor } from './support/auth';
import { createScenario, createUser, sql } from './support/db';
import { SMALL } from './support/datasets';
import {
  ADMIN_INVITE_KINDS,
  invitationRow,
  inviteKindLabels,
  LEAD_INVITE_KINDS,
  LEAD_NAV,
  LEAD_SETTINGS_TABS,
  loginWith,
  memberRow,
  pickInviteGroup,
  ROLE_OVERLAP_MESSAGE,
  settingsTabLabels,
  submitInvite,
} from './support/roles';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T15b ロールの段の画面（D-48・D-50。04「共通レイアウト」の段の表と「マスタ設定」のユーザー。notes/T15b.md の E2E の 1〜10）。
// シナリオの年度（2001 年）で閉じる。seed の総務部門長（head@example.test）にはシナリオの年度にだけロールを付ける。
// ロール・招待・店長と副店長を変えるテストと総務副部門長は、使い捨てのユーザーで行う（D-36）。
// 画面の出し分けは見た目だけで、データは RLS と RPC が守る。ここでは画面の操作が DB の段で通ること（部門長の受付期間・今年の使用・
// 招待・店長⇄副店長・総務部門員を外す・状態の遷移）も DB の行で確かめる。

const dialog = (page: Page) => page.getByRole('dialog');
const statusOf = async (yearId: string) => (await sql<{ status: string }>('select status::text from public.years where id = $1', [yearId]))[0]!.status;

/**
 * 机椅子の状況が読み終わるのを待つ（総務〔部門長以上と総務部門員〕。T16 より前は / のダッシュボード。年度の状態のボタンはここ。
 * D-51）
 */
async function openDashboard(page: Page): Promise<void> {
  await page.goto('/furniture/');
  await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
  await expect(page.getByTestId('dashboard-year')).toBeVisible();
}

test.describe('T15b 総務部門長（seed）', () => {
  test.use({ storageState: storageStateFor('head') });

  test('T15b 総務部門長（R8）：立場は「総務部門長」、ナビは管理者と同じで、最新の年度でも年度の作成の欄はない', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
    await expect(page.getByTestId('home-roles')).toHaveText('総務部門長');
    // ヘッダー（PC）：表示名と立場
    await expect(page.getByRole('banner')).toContainText('テスト部門長');
    await expect(page.getByRole('banner')).toContainText('総務部門長');
    expect(await navLabels(page)).toEqual(LEAD_NAV);
    // 総務のホームはダッシュボード。年度の状態のボタン（受付中の遷移は「締切」）は机椅子の状況（T16）
    await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    await openDashboard(page);
    await expect(page.getByTestId('year-status-actions').getByRole('button')).toHaveText(['締切（振り分けを始める）']);

    // R8 は総務部門長の最新の年度だが、年度の作成は管理者だけ（作成の欄を出さず、管理者が作ると知らせる。読むだけで何も変えない）
    await page.goto('/settings/');
    await expect(page.getByTestId('year-edit-form')).toBeVisible();
    expect(await settingsTabLabels(page)).toEqual(LEAD_SETTINGS_TABS);
    await expect(page.getByTestId('year-create-form')).toHaveCount(0);
    await expect(page.getByTestId('year-create-unavailable')).toHaveText('新しい年度は、最新の年度（R8）の管理者が作ります。');
  });

  test('T15b 総務部門長：マスタ設定のタブは年度・場所・ユーザーだけ。開けないタブの ?tab= は年度。場所は今年の使用だけ変えられる', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'small', roles: { head: true } });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・準備中`);
      expect(await settingsTabLabels(page)).toEqual(LEAD_SETTINGS_TABS);
      for (const t of ['items', 'groups', 'distance', 'export']) await expect(page.getByTestId(`settings-tab-${t}`)).toHaveCount(0);

      // 開けないタブ・知らない値の ?tab= は、開けるタブの最初（年度）を出す（URL は書き換えない）
      for (const t of ['groups', 'export', 'unknown']) {
        await page.goto(`/settings/?tab=${t}`);
        await expect(page.getByTestId('year-edit-form')).toBeVisible();
        await expect(page.getByTestId('settings-tab-years')).toHaveAttribute('aria-selected', 'true');
        await expect(page).toHaveURL(new RegExp(`tab=${t}$`));
      }

      // 場所：追加・編集・削除はなく（場所は管理者のマスタ）、今年の使用の「変える」はある（room_years は部門長以上。D-48）
      await page.getByTestId('settings-tab-rooms').click();
      await expect(page).toHaveURL(/tab=rooms/);
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: SMALL.rooms.class2, exact: true }) });
      await expect(row).toBeVisible();
      await expect(page.getByTestId('room-add')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
      await expect(page.getByTestId('global-read-only')).toHaveText(
        '場所の追加・編集・削除は管理者が行います（すべての年度で共有の表のため）。今年の使用（使用不可と理由のメモ）は年度ごとで、各行の「変える」から変えられます。',
      );

      await row.getByRole('button', { name: `${SMALL.rooms.class2}の今年の使用を変える` }).click();
      await dialog(page).getByLabel('今年は使用する').uncheck();
      await dialog(page).getByLabel('理由のメモ（任意）').fill('E2E 総務部門長が使用不可にする');
      await dialog(page).getByRole('button', { name: '保存' }).click();
      await expect(page.getByText(`「${SMALL.rooms.class2}」を今年は使用不可にしました`)).toBeVisible();
      await expect(row).toContainText('使用不可');
      expect(
        await sql('select usable, note from public.room_years where year_id = $1 and room_id = $2', [s.yearId, s.ids.rooms[SMALL.rooms.class2]]),
      ).toEqual([{ usable: false, note: 'E2E 総務部門長が使用不可にする' }]);
    } finally {
      await s.cleanup();
    }
  });

  test('T15b 総務部門長：年度は受付期間だけ変えられ（年度名・1日目は読み取り）、締切を保存すると DB の request_close_at だけが変わる', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'empty', roles: { head: true } });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/?tab=years');
      const form = page.getByTestId('year-edit-form');
      // 年度名・1日目は入力欄でなく文字で出す（書ける欄と見分けられるように。管理者が変える）
      await expect(page.getByTestId('year-fixed-label')).toHaveText(s.label);
      await expect(page.getByTestId('year-fixed-festival-start')).toHaveText(s.festivalStart.replaceAll('-', '/'));
      await expect(form.getByLabel('年度名')).toHaveCount(0);
      await expect(form.getByLabel('1日目')).toHaveCount(0);
      await expect(form.getByLabel('受付開始（日本時間）')).toBeEditable();
      await expect(form.getByLabel('締切（日本時間）')).toBeEditable();
      await expect(page.getByTestId('year-edit-description')).toContainText('申請の受付期間を変えます（年度名と1日目は管理者が変えます）。');
      await expect(page.getByTestId('year-create-form')).toHaveCount(0);
      await expect(page.getByTestId('year-create-unavailable')).toBeVisible();

      await form.getByLabel('締切（日本時間）').fill('2099-03-31T17:00');
      await form.getByLabel('理由（任意）').fill('E2E 受付期間を延ばす');
      await form.getByRole('button', { name: '年度を保存' }).click();
      await expect(page.getByText('年度を保存しました')).toBeVisible();
      const [y] = await sql<{ label: string; festival_start: string; close: string }>(
        `select label, to_char(festival_start, 'YYYY-MM-DD') as festival_start,
                to_char(request_close_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as close
         from public.years where id = $1`,
        [s.yearId],
      );
      expect(y).toEqual({ label: s.label, festival_start: s.festivalStart, close: '2099-03-31T17:00' });
    } finally {
      await s.cleanup();
    }
  });

  test('T15b 招待の立場：総務部門長は総務部門員・店長・副店長の3つ、管理者は7つ。総務部門長が副店長で招待すると一覧に「{団体} の副店長」', async ({
    page,
    browser,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
    const ctxA = await browser.newContext({ storageState: storageStateFor('admin') });
    const email = `e2e-deputy-${s.yearId.slice(0, 8)}@example.test`;
    try {
      const pageA = await ctxA.newPage();
      await pinYear(pageA, SEED_USER_IDS.admin, s.yearId);
      await pageA.goto('/settings/?tab=users');
      expect(await inviteKindLabels(pageA)).toEqual(ADMIN_INVITE_KINDS);

      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/?tab=users');
      expect(await inviteKindLabels(page)).toEqual(LEAD_INVITE_KINDS);
      const form = page.getByTestId('invite-form');
      // 既定は総務部門員で、団体の欄は店長・副店長を選んだときだけ
      await expect(form.getByLabel('立場')).toHaveValue('staff');
      await expect(form.getByRole('combobox', { name: '団体', exact: true })).toHaveCount(0);

      await form.getByLabel('メールアドレス').fill(email);
      await form.getByLabel('立場').selectOption('deputy_manager');
      await pickInviteGroup(page, SMALL.groups.stall);
      await form.getByRole('button', { name: '招待する' }).click();
      await expect(page.getByTestId('invite-result')).toHaveText('招待しました。この人が学校の Google アカウントでログインしたときに付きます');
      const row = invitationRow(page, email);
      await expect(row).toContainText(`${SMALL.groups.stall} の副店長`);
      await expect(row).toContainText('未使用');
      await expect(row.getByRole('button', { name: '取り消す' })).toBeVisible();
      expect(await sql('select role, group_id, group_role::text from public.invitations where year_id = $1 and email = $2', [s.yearId, email])).toEqual([
        { role: null, group_id: s.ids.groups[SMALL.groups.stall], group_role: 'deputy_manager' },
      ]);
      // 送った後も同じ立場と団体が残る（続けて同じ立場で招待できる）
      await expect(form.getByLabel('立場')).toHaveValue('deputy_manager');
      await expect(form.getByRole('combobox', { name: '団体', exact: true })).toHaveText(SMALL.groups.stall);
      await expect(form.getByLabel('メールアドレス')).toHaveValue('');
    } finally {
      await ctxA.close().catch(() => undefined);
      await s.cleanup();
    }
  });

  test('T15b 店長⇄副店長：総務部門長が「副店長にする」を押すと、メンバーの一覧とその人のヘッダー・ホームの立場が「{団体} の副店長」になる', async ({
    page,
    browser,
  }) => {
    const u = await createUser({ purpose: 'switch', name: 'E2E 店長' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { head: true },
      groupMembers: [{ userId: u.id, group: SMALL.groups.stall }],
    });
    // その人の画面（この describe の storageState〔総務部門長〕を引き継がないよう、空のログインの状態で作る）
    const ctxU = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const groupId = s.ids.groups[SMALL.groups.stall]!;
    const roleOf = async () =>
      (await sql<{ role: string }>('select role::text from public.group_members where group_id = $1 and user_id = $2', [groupId, u.id]))[0]?.role;
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/?tab=users');
      const position = memberRow(page, 'E2E 店長').getByTestId('member-position');
      await expect(position).toContainText(`${SMALL.groups.stall} の店長`);
      await expect(position.getByRole('button', { name: '代表を外す' })).toBeVisible();

      await position.getByRole('button', { name: '副店長にする' }).click();
      await expect(dialog(page)).toContainText(`E2E 店長を「${SMALL.groups.stall}」の副店長にしますか`);
      await expect(dialog(page)).toContainText('店長と副店長は、できることが同じです（表示だけが変わります）。');
      await dialog(page).getByRole('button', { name: '副店長にする' }).click();
      await expect(page.getByText(`E2E 店長を「${SMALL.groups.stall}」の副店長にしました`)).toBeVisible();
      await expect(position).toContainText(`${SMALL.groups.stall} の副店長`);
      await expect(position.getByRole('button', { name: '店長にする', exact: true })).toBeVisible();
      expect(await roleOf()).toBe('deputy_manager');

      // その人のヘッダー（PC）とホームの立場（別のコンテキストで画面からログインする）
      const pageU = await ctxU.newPage();
      await loginWith(pageU, u);
      await expect(pageU.getByTestId('current-year')).toHaveText(`${s.label}・申請受付中`);
      await expect(pageU.getByTestId('home-roles')).toHaveText(`${SMALL.groups.stall} の副店長`);
      await expect(pageU.getByRole('banner')).toContainText(`${SMALL.groups.stall} の副店長`);
      // 店長と副店長はできることが同じ（ナビも同じ。お知らせ一覧は T17）
      expect(await navLabels(pageU)).toEqual(['ホーム', '申請', '自団体の振り分け', 'お知らせ一覧']);

      // 店長に戻す（「店長にする」は「副店長にする」に部分一致するので exact で探す）
      await position.getByRole('button', { name: '店長にする', exact: true }).click();
      await expect(dialog(page)).toContainText(`E2E 店長を「${SMALL.groups.stall}」の店長にしますか`);
      await dialog(page).getByRole('button', { name: '店長にする', exact: true }).click();
      await expect(page.getByText(`E2E 店長を「${SMALL.groups.stall}」の店長にしました`)).toBeVisible();
      await expect(position).toContainText(`${SMALL.groups.stall} の店長`);
      expect(await roleOf()).toBe('manager');
      await pageU.reload();
      await expect(pageU.getByTestId('home-roles')).toHaveText(`${SMALL.groups.stall} の店長`);
    } finally {
      await ctxU.close().catch(() => undefined);
      await s.cleanup();
      await u.cleanup();
    }
  });

  test('T15b 兼任の禁止：店長を総務部門員に・総務部門員を店長に招待すると立場の欄に兼任の文言が出て、招待は増えない。同じ団体の別の立場も欄に出る', async ({
    page,
  }) => {
    const mgr = await createUser({ purpose: 'overlap-mgr', name: 'E2E 兼任の店長' });
    const stf = await createUser({ purpose: 'overlap-staff', name: 'E2E 兼任の部門員' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { head: true },
      grants: [{ userId: stf.id, role: 'staff' }],
      groupMembers: [{ userId: mgr.id, group: SMALL.groups.stall }],
    });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/?tab=users');
      await expect(memberRow(page, 'E2E 兼任の店長')).toBeVisible();
      const form = page.getByTestId('invite-form');
      const kindError = page.getByTestId('invite-kind-error');

      // 1. 店長（ロールなし）を総務部門員に招待する
      await form.getByLabel('メールアドレス').fill(mgr.email);
      await form.getByLabel('立場').selectOption('staff');
      let r = await submitInvite(page);
      expect(r.body?.message).toBe('role_overlap');
      await expect(kindError).toHaveText(ROLE_OVERLAP_MESSAGE);
      // 入力は残り（直すのはメンバーの一覧か別の立場）、招待の結果は出ない
      await expect(form.getByLabel('メールアドレス')).toHaveValue(mgr.email);
      await expect(form.getByLabel('立場')).toHaveValue('staff');
      await expect(page.getByTestId('invite-result')).toHaveCount(0);

      // 2. 総務部門員を別の団体の店長に招待する（立場を選び直すと前の誤りは消え、送ると同じ文言がまた出る）
      await form.getByLabel('メールアドレス').fill(stf.email);
      await form.getByLabel('立場').selectOption('manager');
      await pickInviteGroup(page, SMALL.groups.department);
      await expect(kindError).toHaveCount(0);
      r = await submitInvite(page);
      expect(r.body?.message).toBe('role_overlap');
      await expect(kindError).toHaveText(ROLE_OVERLAP_MESSAGE);

      // 3. 店長を同じ団体の副店長に招待する（別の立場でいる：conflict の field: group_role。切り替えはメンバーの一覧から）
      await form.getByLabel('メールアドレス').fill(mgr.email);
      await form.getByLabel('立場').selectOption('deputy_manager');
      await pickInviteGroup(page, SMALL.groups.stall);
      r = await submitInvite(page);
      expect(r.body?.message).toBe('conflict');
      await expect(kindError).toHaveText('この人はすでにこの団体の店長です。店長・副店長の切り替えはメンバーの一覧から');

      // 招待は増えず、ロールと店長・副店長も変わらない
      expect(await sql('select email from public.invitations where year_id = $1', [s.yearId])).toEqual([]);
      expect(await sql('select user_id::text, role::text from public.year_roles where year_id = $1 and user_id = any($2::uuid[])', [s.yearId, [mgr.id, stf.id]])).toEqual([
        { user_id: stf.id, role: 'staff' },
      ]);
      expect(
        await sql(
          'select gm.user_id::text, gm.role::text from public.group_members gm join public.groups g on g.id = gm.group_id where g.year_id = $1',
          [s.yearId],
        ),
      ).toEqual([{ user_id: mgr.id, role: 'manager' }]);
    } finally {
      await s.cleanup();
      await Promise.all([mgr.cleanup(), stf.cleanup()]);
    }
  });

  test('T15b 総務部門長のユーザーの操作：「ロールを変える」はなく、「ロールを外す」は総務部門員の行だけで、外せる', async ({ page }) => {
    const stf = await createUser({ purpose: 'remove-staff', name: 'E2E 部門員' });
    const vw = await createUser({ purpose: 'remove-viewer', name: 'E2E 閲覧' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { admin: true, head: true },
      grants: [
        { userId: stf.id, role: 'staff' },
        { userId: vw.id, role: 'viewer' },
      ],
    });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await page.goto('/settings/?tab=users');
      const members = page.getByRole('table', { name: 'メンバー' });
      await expect(memberRow(page, 'E2E 部門員')).toContainText('総務部門員');
      await expect(memberRow(page, 'E2E 閲覧')).toContainText('閲覧のみ');
      await expect(memberRow(page, 'テスト管理者')).toContainText('管理者');
      await expect(memberRow(page, 'テスト部門長')).toContainText('総務部門長');
      await expect(members.getByRole('button', { name: 'ロールを変える' })).toHaveCount(0);
      await expect(members.getByRole('button', { name: 'ロールを外す' })).toHaveCount(1);
      await expect(memberRow(page, 'E2E 部門員').getByRole('button', { name: 'ロールを外す' })).toBeVisible();

      await memberRow(page, 'E2E 部門員').getByRole('button', { name: 'ロールを外す' }).click();
      await expect(dialog(page)).toContainText('E2E 部門員のロール（総務部門員）を外しますか');
      await expect(dialog(page)).toContainText('この年度の画面を開けなくなります。この人あての未使用の総務部門員の招待も取り消します。');
      await dialog(page).getByRole('button', { name: '外す' }).click();
      await expect(page.getByText('E2E 部門員のロールを外しました')).toBeVisible();
      await expect(memberRow(page, 'E2E 部門員')).toHaveCount(0);
      expect(await sql('select user_id::text from public.year_roles where year_id = $1 and user_id = any($2::uuid[])', [s.yearId, [stf.id, vw.id]])).toEqual([
        { user_id: vw.id },
      ]);
    } finally {
      await s.cleanup();
      await Promise.all([stf.cleanup(), vw.cleanup()]);
    }
  });

  test('T15b 総務部門長の年度の状態のボタン：受付開始・締切・確定・確定の解除はでき、「終了」はない（管理者には出る）', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'preparing', dataset: 'synthetic', allocations: 'reference', roles: { admin: true, head: true } });
    const ctxA = await browser.newContext({ storageState: storageStateFor('admin') });
    try {
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await openDashboard(page);
      const actions = page.getByTestId('year-status-actions');
      const buttons = actions.getByRole('button');

      // 準備中 → 受付開始
      await expect(buttons).toHaveText(['受付開始']);
      await actions.getByRole('button', { name: '受付開始' }).click();
      await dialog(page).getByRole('button', { name: '受付開始' }).click();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・申請受付中`);
      expect(await statusOf(s.yearId)).toBe('requesting');

      // 受付中 → 締切（振り分けを始める）
      await expect(buttons).toHaveText(['締切（振り分けを始める）']);
      await actions.getByRole('button', { name: '締切（振り分けを始める）' }).click();
      await dialog(page).getByRole('button', { name: '締切（振り分けを始める）' }).click();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      expect(await statusOf(s.yearId)).toBe('allocating');

      // 振り分け中 → 確定（理由が必須。検証〔合成データ〕が済んでから押せる。並行のテストで遅くなっても待つ）
      await expect(page.getByTestId('dashboard-validation-counts')).toContainText('0error', { timeout: 30_000 });
      await expect(buttons).toHaveText(['確定']);
      await actions.getByRole('button', { name: '確定', exact: true }).click();
      await dialog(page).getByLabel(/理由/).fill('E2E 総務部門長が確定する');
      const check = dialog(page).getByLabel('warning を確認しました');
      if ((await check.count()) > 0) await check.check();
      await dialog(page).getByRole('button', { name: '確定', exact: true }).click();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・確定`);
      expect(await statusOf(s.yearId)).toBe('confirmed');

      // 確定中：総務部門長は「確定を解除」だけ（終了は管理者だけ。D-48）
      await expect(buttons).toHaveText(['確定を解除']);
      await expect(actions.getByRole('button', { name: '終了' })).toHaveCount(0);
      const pageA = await ctxA.newPage();
      await pinYear(pageA, SEED_USER_IDS.admin, s.yearId);
      await openDashboard(pageA);
      await expect(pageA.getByTestId('year-status-actions').getByRole('button')).toHaveText(['確定を解除', '終了']);

      // 確定を解除（理由が必須）
      await actions.getByRole('button', { name: '確定を解除' }).click();
      await dialog(page).getByLabel(/理由/).fill('E2E 総務部門長が確定を解除する');
      await dialog(page).getByRole('button', { name: '確定を解除' }).click();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      expect(await statusOf(s.yearId)).toBe('allocating');
    } finally {
      await ctxA.close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

test('T15b 総務副部門長（使い捨て）：ナビ・マスタ設定のタブ・招待の立場は総務部門長と同じで、立場は「総務副部門長」', async ({ page }) => {
  const u = await createUser({ purpose: 'deputy-head', name: 'E2E 副部門長' });
  const s = await createScenario({ status: 'requesting', dataset: 'small', grants: [{ userId: u.id, role: 'deputy_head' }] });
  try {
    await loginWith(page, u);
    await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・申請受付中`);
    await expect(page.getByTestId('home-roles')).toHaveText('総務副部門長');
    await expect(page.getByRole('banner')).toContainText('総務副部門長');
    expect(await navLabels(page)).toEqual(LEAD_NAV);
    await openDashboard(page);
    await expect(page.getByTestId('year-status-actions').getByRole('button')).toHaveText(['締切（振り分けを始める）']);

    await page.goto('/settings/?tab=items');
    await expect(page.getByTestId('year-edit-form')).toBeVisible();
    expect(await settingsTabLabels(page)).toEqual(LEAD_SETTINGS_TABS);
    await expect(page.getByTestId('year-fixed-label')).toHaveText(s.label);
    await expect(page.getByTestId('year-edit-form').getByLabel('年度名')).toHaveCount(0);
    await page.getByTestId('settings-tab-users').click();
    expect(await inviteKindLabels(page)).toEqual(LEAD_INVITE_KINDS);
    await expect(memberRow(page, 'E2E 副部門長')).toContainText('総務副部門長');
    await expect(page.getByRole('table', { name: 'メンバー' }).getByRole('button', { name: /ロールを(変える|外す)/ })).toHaveCount(0);
  } finally {
    await s.cleanup();
    await u.cleanup();
  }
});

test.describe('T15b 閲覧のみ（確定前の振り分け）', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('T15b 閲覧のみが確定前の年度で /allocation/ を開くと「権限がありません」と「振り分けは確定後に表示されます。」', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      const alert = page.getByRole('alert').filter({ hasText: '権限がありません' });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('振り分けは確定後に表示されます。');
      expect(await navLabels(page)).toEqual(['ホーム', 'お知らせ一覧']);
    } finally {
      await s.cleanup();
    }
  });
});
