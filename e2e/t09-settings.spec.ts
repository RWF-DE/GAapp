import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, createUser, sql, type TestUser } from './support/db';
import { S05_GROUP, SMALL } from './support/datasets';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T09 マスタ設定（画面の設計 3.2・7.2 の表の T09 の行）。シナリオの年度（2001 年）で閉じる。
// 年度をまたぐ表（rooms・items・distance_overrides）には書かない（書くテストは serial。設計 7.2）。
// ロール・招待を変えるテストは createUser のユーザーで（seed のユーザーのロールは変えない。D-36）。

/** 使い捨てのユーザーで画面からログインする（storageState を使わない） */
async function loginWith(page: Page, u: TestUser): Promise<void> {
  await page.goto('/login/');
  const form = page.getByTestId('test-login-form');
  await form.getByLabel('メールアドレス').fill(u.email);
  await form.getByLabel('パスワード').fill(u.password);
  await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
  await expect(page.getByTestId('current-year')).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByTestId(`settings-tab-${name}`);
const rowOf = (page: Page, text: string) => page.getByRole('row').filter({ has: page.getByRole('cell', { name: text, exact: true }) });

test.describe('T09 マスタ設定（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T09 年度：1日目の範囲外・締切が受付開始より前は送る前に欄にエラー、年度名の変更は保存できる', async ({ page }) => {
    const s = await createScenario({ status: 'preparing', dataset: 'empty', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/');
      await expect(page.getByRole('heading', { level: 1, name: 'マスタ設定' })).toBeVisible();
      const form = page.getByTestId('year-edit-form');
      await expect(form.getByLabel('年度名')).toHaveValue(s.label);
      // シナリオの年度は最新ではないので、新しい年度の作成は出ない
      await expect(page.getByTestId('year-create-unavailable')).toBeVisible();

      await form.getByLabel('1日目').fill('2201-01-01');
      await form.getByLabel('受付開始（日本時間）').fill('2001-07-10T09:00');
      await form.getByLabel('締切（日本時間）').fill('2001-07-01T09:00');
      await form.getByRole('button', { name: '年度を保存' }).click();
      await expect(form.getByText('2000年1月1日〜2200年12月31日の日付にしてください')).toBeVisible();
      await expect(form.getByText('締切は受付開始より後にしてください')).toBeVisible();

      await form.getByLabel('1日目').fill(s.festivalStart);
      await form.getByLabel('受付開始（日本時間）').fill('');
      await form.getByLabel('締切（日本時間）').fill('');
      await form.getByLabel('年度名').fill(`${s.label}改`);
      await form.getByRole('button', { name: '年度を保存' }).click();
      await expect(page.getByText('年度を保存しました')).toBeVisible();
      const [y] = await sql<{ label: string }>('select label from public.years where id = $1', [s.yearId]);
      expect(y!.label).toBe(`${s.label}改`);
      // 年度名を戻す（cleanup は id で消すが、名前の一意を崩さないように）
      await sql('update public.years set label = $2 where id = $1', [s.yearId, s.label]);

      // タブを順に開ける（クエリの tab に入る）
      for (const [name, heading] of [
        ['rooms', '場所'],
        ['items', '品目'],
        ['groups', '団体'],
        ['distance', '建物どうしの距離の上書き'],
        ['users', 'メンバー'],
        ['export', 'データの書き出し'],
      ] as const) {
        await tab(page, name).click();
        await expect(page).toHaveURL(new RegExp(`tab=${name}`));
        await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
      }
    } finally {
      await s.cleanup();
    }
  });

  test('T09 団体：表示名の空欄は null で保存、CSV は使えない団体名で止まり、正しい CSV は1回で取り込む', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await expect(rowOf(page, SMALL.groups.stall)).toBeVisible();

      // 追加（表示名は空白だけ → null）
      await page.getByTestId('group-add').click();
      const form = page.getByTestId('group-form');
      await form.getByLabel('団体名').fill('E2E追加団体');
      await form.getByLabel('表示名（企画名。任意）').fill('   ');
      await form.getByLabel('区分').selectOption('department');
      await form.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('「E2E追加団体」を足しました')).toBeVisible();
      const [g] = await sql<{ display_name: string | null; category: string }>(
        'select display_name, category from public.groups where year_id = $1 and name = $2',
        [s.yearId, 'E2E追加団体'],
      );
      expect(g).toEqual({ display_name: null, category: 'department' });

      // 使えない団体名は保存の前に欄に出る
      await expect(form).toHaveCount(0);
      await page.getByTestId('group-add').click();
      await form.getByLabel('団体名').fill('余り');
      await form.getByRole('button', { name: '保存' }).click();
      await expect(form.getByText('団体名に「(計)」「使用不可」「余り」「残す」は使えません')).toBeVisible();
      await page.keyboard.press('Escape');

      // CSV：使えない団体名の行があれば何も保存しない
      await page.getByTestId('groups-csv-open').click();
      const header = '団体名,表示名,区分,飲食,使用場所,別名,並び順';
      await page.getByLabel('CSV ファイル（UTF-8 か Shift_JIS）').setInputFiles({
        name: 'groups.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(`${header}\nE2E取込1,,模擬店,はい,${SMALL.rooms.class1},,\n*E2E,,模擬店,,,,\n`, 'utf8'),
      });
      await expect(page.getByTestId('groups-csv-errors')).toContainText('3 行目：団体名に半角の * ? ~ は使えません');
      await expect(page.getByTestId('groups-csv-save')).toBeDisabled();

      // 正しい CSV：追加1・変更1（既存の団体の表示名）
      await page.getByLabel('CSV ファイル（UTF-8 か Shift_JIS）').setInputFiles({
        name: 'groups.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          `${header}\nE2E取込1,取込の企画,模擬店,はい,${SMALL.rooms.class1},甲|乙,\n${SMALL.groups.company},企業の企画,企業,いいえ,,,30\n`,
          'utf8',
        ),
      });
      await expect(page.getByTestId('groups-csv-counts')).toContainText('追加 1 件・変更 1 件');
      await page.getByTestId('groups-csv-save').click();
      await expect(page.getByText('団体を 2 件取り込みました（追加 1・変更 1）')).toBeVisible();
      const rows = await sql<{ name: string; display_name: string | null; aliases: string[]; is_food: boolean; location: string | null }>(
        `select g.name, g.display_name, g.aliases, g.is_food, r.name as location
         from public.groups g left join public.rooms r on r.id = g.location_room_id
         where g.year_id = $1 and g.name = any($2::text[]) order by g.name`,
        [s.yearId, ['E2E取込1', SMALL.groups.company]],
      );
      expect(rows).toEqual([
        { name: 'E2E企業1', display_name: '企業の企画', aliases: [], is_food: false, location: null },
        { name: 'E2E取込1', display_name: '取込の企画', aliases: ['甲', '乙'], is_food: true, location: SMALL.rooms.class1 },
      ]);
    } finally {
      await s.cleanup();
    }
  });

  test('T09 団体・場所の削除：参照している有効なルールのコードが出て削除できない', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await rowOf(page, S05_GROUP).getByRole('button', { name: '削除' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByTestId('rule-refs')).toContainText('S05');
      await expect(dialog.getByTestId('rule-refs')).toContainText('S06');
      await expect(dialog.getByRole('button', { name: '削除する' })).toBeDisabled();
      await dialog.getByRole('button', { name: 'やめる' }).click();

      // 場所（S05 の運び元の 1-1）。年度をまたぐ表なので押さずに確かめるだけ
      await tab(page, 'rooms').click();
      await rowOf(page, '1-1').getByRole('button', { name: '削除' }).click();
      await expect(dialog.getByTestId('rule-refs')).toContainText('S05');
      await expect(dialog.getByRole('button', { name: '削除する' })).toBeDisabled();
      await dialog.getByRole('button', { name: 'やめる' }).click();
      expect(await sql('select id from public.groups where year_id = $1 and name = $2', [s.yearId, S05_GROUP])).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test('T09 削除：開いた後に年度が終了して消えなかったときは「削除しました」と出ない', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=groups');
      await rowOf(page, SMALL.groups.company).getByRole('button', { name: '削除' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByRole('button', { name: '削除する' })).toBeEnabled();
      // ほかの管理者が年度を終了した
      await sql(`update public.years set status = 'closed' where id = $1`, [s.yearId]);
      await dialog.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('権限がありません。立場が変わった可能性があります')).toBeVisible();
      await expect(page.getByText(/を削除しました/)).toHaveCount(0);
      expect(await sql('select id from public.groups where year_id = $1 and name = $2', [s.yearId, SMALL.groups.company])).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 ユーザー（使い捨てのユーザー）', () => {
  test('T09 招待：確かめたユーザーはその場で付き、確かめていないユーザー・新しいメールは「ログインしたときに付きます」。ロールを変えて外せる', async ({ page }) => {
    const admin = await createUser({ purpose: 'admin' });
    const verified = await createUser({ purpose: 'verified', name: 'E2E 確認済み' });
    const unverified = await createUser({ purpose: 'unverified', verified: false });
    const s = await createScenario({ status: 'requesting', dataset: 'small', grants: [{ userId: admin.id, role: 'admin' }] });
    const newEmail = `e2e-new-${s.yearId.slice(0, 8)}@example.test`;
    try {
      await loginWith(page, admin);
      await page.goto('/settings/?tab=users');
      const form = page.getByTestId('invite-form');
      // 説明は applied が偽を「アカウントがない」と読ませない（アカウントがあってもメールを確かめられなければ偽。D-17a）
      const description = page.getByTestId('invite-description');
      await expect(description).toContainText('今のメールを本人のものと確かめられれば、その場でロールが付きます');
      await expect(description).toContainText('メールを確かめられない');
      await expect(description).not.toContainText('なければその人がログインしたときに付きます');
      const invite = async (email: string) => {
        await form.getByLabel('メールアドレス').fill(email);
        await form.getByLabel('立場').selectOption('staff');
        await form.getByRole('button', { name: '招待する' }).click();
      };
      await invite(verified.email);
      await expect(page.getByTestId('invite-result')).toHaveText('この人はすでにアカウントがあるので、その場でロールを付けました');
      await invite(unverified.email);
      await expect(page.getByTestId('invite-result')).toHaveText('招待しました。この人が学校の Google アカウントでログインしたときに付きます');
      await invite(newEmail);
      await expect(page.getByTestId('invite-result')).toHaveText('招待しました。この人が学校の Google アカウントでログインしたときに付きます');
      const roles = await sql<{ user_id: string; role: string }>('select user_id::text, role from public.year_roles where year_id = $1', [s.yearId]);
      expect(Object.fromEntries(roles.map((r) => [r.user_id, r.role]))).toEqual({ [admin.id]: 'admin', [verified.id]: 'staff' });

      // ロールを変える → 外す（理由は任意）
      const member = rowOf(page, 'E2E 確認済み');
      await member.getByRole('button', { name: 'ロールを変える' }).click();
      await page.getByLabel('新しいロール').selectOption('viewer');
      await page.getByRole('dialog').getByRole('button', { name: '変える' }).click();
      await expect(page.getByText('E2E 確認済みのロールを「閲覧のみ」にしました')).toBeVisible();
      await rowOf(page, 'E2E 確認済み').getByRole('button', { name: 'ロールを外す' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '外す' }).click();
      await expect(page.getByText('E2E 確認済みのロールを外しました')).toBeVisible();
      expect(await sql('select 1 from public.year_roles where year_id = $1 and user_id = $2', [s.yearId, verified.id])).toEqual([]);

      // 最後の管理者（自分）は外せない
      await page.getByRole('row').filter({ hasText: '総務管理者' }).getByRole('button', { name: 'ロールを外す' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '外す' }).click();
      await expect(page.getByText('最後の管理者は外せません', { exact: true })).toBeVisible();
    } finally {
      await s.cleanup();
      await Promise.all([admin.cleanup(), verified.cleanup(), unverified.cleanup()]);
    }
  });

  test('T09 終了した年度：招待とロールの変更は出ず、ロールを外すことはできる', async ({ page }) => {
    const admin = await createUser({ purpose: 'admin' });
    const staff = await createUser({ purpose: 'staff', name: 'E2E 部員' });
    const s = await createScenario({
      status: 'closed',
      dataset: 'small',
      grants: [
        { userId: admin.id, role: 'admin' },
        { userId: staff.id, role: 'staff' },
      ],
    });
    try {
      await loginWith(page, admin);
      await page.goto('/settings/?tab=users');
      await expect(page.getByTestId('invite-form')).toHaveCount(0);
      const member = rowOf(page, 'E2E 部員');
      await expect(member.getByRole('button', { name: 'ロールを変える' })).toHaveCount(0);
      await member.getByRole('button', { name: 'ロールを外す' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '外す' }).click();
      await expect(page.getByText('E2E 部員のロールを外しました')).toBeVisible();
      expect(await sql('select 1 from public.year_roles where year_id = $1 and user_id = $2', [s.yearId, staff.id])).toEqual([]);
      // 団体のタブは読み取り専用（追加・削除のボタンがない）
      await tab(page, 'groups').click();
      await expect(page.getByTestId('group-add')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '削除' })).toHaveCount(0);
    } finally {
      await s.cleanup();
      await Promise.all([admin.cleanup(), staff.cleanup()]);
    }
  });
});

test.describe('T09 マスタ設定（開いている年度の管理者が、終了した年度を開く）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T09 終了した年度：開いている年度（R8）の管理者でも、場所・品目・距離は読み取り専用', async ({ page }) => {
    const s = await createScenario({ status: 'closed', dataset: 'small', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=rooms');
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・終了`);
      await expect(page.getByTestId('read-only-notice')).toBeVisible();
      for (const [name, heading, add] of [
        ['rooms', '場所', 'room-add'],
        ['items', '品目', 'item-add'],
        ['distance', '建物どうしの距離の上書き', 'distance-add'],
      ] as const) {
        await tab(page, name).click();
        await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
        if (name !== 'distance') await expect(page.getByRole('row').nth(1)).toBeVisible();
        await expect(page.getByTestId(add)).toHaveCount(0);
        await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
        // 読み取り専用の理由は終了した年度。「開いている年度の管理者でない」とは言わず、最新の年度で直すよう案内する
        await expect(page.getByText(/開いている年度の管理者でないため/)).toHaveCount(0);
        await expect(page.getByTestId('global-read-only')).toContainText('最新の年度を開いて直してください');
      }
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 場所（開いている年度が2つ以上）', () => {
  test('T09 場所の削除：表示中でない終了していない年度の有効なルールが参照していれば削除できず、ルールを読めない年度は知らせる', async ({ page }) => {
    const u = await createUser({ purpose: 'rooms-refs' });
    // 表示する年度（ルールなし）、部員の年度（S05 が 1-1 を運び元にする）、団体代表だけの年度（ルールを読めない）、終了した年度（見ない）
    const shown = await createScenario({ status: 'requesting', dataset: 'small', rules: 'none', grants: [{ userId: u.id, role: 'admin' }] });
    const other = await createScenario({ status: 'allocating', dataset: 'synthetic', grants: [{ userId: u.id, role: 'staff' }] });
    const repOnly = await createScenario({ status: 'preparing', dataset: 'small' });
    const closed = await createScenario({ status: 'closed', dataset: 'synthetic', grants: [{ userId: u.id, role: 'admin' }] });
    try {
      await sql('insert into public.group_members (group_id, user_id) values ($1, $2)', [repOnly.ids.groups[SMALL.groups.stall], u.id]);
      await pinYear(page, u.id, shown.yearId);
      await loginWith(page, u);
      await page.goto('/settings/?tab=rooms');
      await expect(page.getByTestId('current-year')).toContainText(shown.label);
      await rowOf(page, '1-1').getByRole('button', { name: '削除' }).click();
      const dialog = page.getByRole('alertdialog');
      const refs = dialog.getByTestId('rule-refs');
      await expect(refs).toContainText(other.label);
      await expect(refs).toContainText('S05');
      await expect(refs).not.toContainText(closed.label);
      await expect(dialog.getByTestId('rule-refs-unreadable')).toContainText(repOnly.label);
      await expect(dialog.getByRole('button', { name: '削除する' })).toBeDisabled();
      await dialog.getByRole('button', { name: 'やめる' }).click();
      expect(await sql("select id from public.rooms where name = '1-1'")).toHaveLength(1);
    } finally {
      await Promise.all([shown.cleanup(), other.cleanup(), repOnly.cleanup(), closed.cleanup()]);
      await u.cleanup();
    }
  });
});

test.describe('T09 場所の今年の使用（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T09 今年の使用：振り分けの行を読めなければ知らせて読み直せる（保存を押せないままにしない）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { admin: true } });
    try {
      let fail = true;
      await page.route('**/rest/v1/allocations*', async (route) => {
        if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"e2e"}' });
        else await route.continue();
      });
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/settings/?tab=rooms');
      await rowOf(page, SMALL.rooms.class1).getByRole('button', { name: `${SMALL.rooms.class1}の今年の使用を変える` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('今年は使用する').uncheck();
      const err = dialog.getByTestId('usable-sources-error');
      await expect(err).toContainText('振り分けの行を読めなかったので');
      await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
      fail = false;
      await err.getByRole('button', { name: '読み直す' }).click();
      await expect(err).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'やめる' }).click();
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09 マスタ設定の権限', () => {
  for (const user of ['staff', 'viewer', 'rep'] as const) {
    test.describe(user, () => {
      test.use({ storageState: storageStateFor(user) });
      test(`T09 ${user} はマスタ設定を開けない`, async ({ page }) => {
        await page.goto('/settings/');
        await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
        await expect(page.getByTestId('settings-tab-years')).toHaveCount(0);
      });
    });
  }
});
