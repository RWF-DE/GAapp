import { expect, test, type Page } from '@playwright/test';
import { createScenario, createUser, sql, type TestUser } from '../support/db';
import { shoot } from '../support/shots';

// T09 年度の作成（画面の設計 3.2・7.2）。create_year_from は全年度の中で最新の年度からしか作れないので、`festivalStart: 'latest'`
// のシナリオの年度（2199 年）から、grants でロールを付けた createUser の管理者で作る（新しい年度の1日目は 2200 年）。
// 最新の年度は全年度で1つなので、並行の chromium では流さない（serial）。cleanup は作った年度も消す。

async function loginWith(page: Page, u: TestUser): Promise<void> {
  await page.goto('/login/');
  const form = page.getByTestId('test-login-form');
  await form.getByLabel('メールアドレス').fill(u.email);
  await form.getByLabel('パスワード').fill(u.password);
  await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
  await expect(page.getByTestId('current-year')).toBeVisible();
}

test('T09 年度の作成：欄のエラーは送る前に出る。作ると団体とルールが付け替わり、無効になったルールの数が出て新しい年度に切り替わる', async ({ page }) => {
  const admin = await createUser({ purpose: 'admin' });
  const s = await createScenario({ festivalStart: 'latest', status: 'allocating', dataset: 'synthetic', grants: [{ userId: admin.id, role: 'admin' }] });
  try {
    // 付け替えられないルール（どの団体にも当たらない group）を1つ足す
    await sql(
      `insert into public.rules (year_id, code, kind, params, enabled, memo)
       values ($1, 'E2E-X1', 'fixed_request', jsonb_build_object('group', gen_random_uuid(), 'item', 'desk', 'count', 1), true, null)`,
      [s.yearId],
    );
    const [prev] = await sql<{ groups: number; rules: number }>(
      `select (select count(*)::int from public.groups where year_id = $1) as groups, (select count(*)::int from public.rules where year_id = $1) as rules`,
      [s.yearId],
    );

    await loginWith(page, admin);
    await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
    await page.goto('/settings/');
    const form = page.getByTestId('year-create-form');
    await expect(form).toBeVisible();

    // 年度名が空・1日目が複製元と同じ → 送る前に欄にエラー
    await form.getByLabel('新しい年度の1日目').fill(s.festivalStart);
    await form.getByRole('button', { name: '新しい年度を作る' }).click();
    await expect(form.getByText('入力してください')).toBeVisible();
    await expect(form.getByText(`1日目は今の年度（${s.festivalStart}）より後の日付にしてください`)).toBeVisible();
    expect(await sql('select id from public.years where prev_year_id = $1', [s.yearId])).toEqual([]);

    const label = `${s.label}-next`;
    await form.getByLabel('新しい年度名').fill(label);
    await form.getByLabel('新しい年度の1日目').fill('2200-10-14');
    await form.getByRole('button', { name: '新しい年度を作る' }).click();
    await expect(page.getByText(`${label} を作りました`, { exact: true })).toBeVisible();
    await expect(page.getByText(/無効になったルールが 1 件あります（E2E-X1）/)).toBeVisible();
    // 新しい年度に切り替わる
    await expect(page.getByTestId('current-year')).toHaveText(`${label}・準備中`);
    // 切り替えた後も、無効になったルールの数とルール画面へのリンクが残る（04・設計 3.2）
    const notice = page.getByTestId('year-created');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`${label} を作りました。無効になったルール 1 件（E2E-X1）`);
    // 年度の作成は serial でだけ流せるので、知らせのスクリーンショットはここで撮る（E2E_SHOTS=1 のときだけ）
    if (process.env.E2E_SHOTS) await shoot(page, 'T09', 'settings-year-created-pc');
    await notice.getByRole('link', { name: 'ルール画面へ' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/rules/');
    await expect(page.getByTestId('current-year')).toHaveText(`${label}・準備中`);

    const [created] = await sql<{ id: string; groups: number; rules: number; disabled: string[]; foreign: number }>(
      `select y.id,
              (select count(*)::int from public.groups g where g.year_id = y.id) as groups,
              (select count(*)::int from public.rules r where r.year_id = y.id) as rules,
              (select coalesce(array_agg(r.code order by r.code), '{}') from public.rules r where r.year_id = y.id and not r.enabled
                 and r.code in (select code from public.rules where year_id = $1 and enabled)) as disabled,
              (select count(*)::int from public.rules r where r.year_id = y.id and r.params ? 'group'
                 and (r.params ->> 'group')::uuid in (select id from public.groups where year_id = $1)) as foreign
       from public.years y where y.prev_year_id = $1`,
      [s.yearId],
    );
    expect(created).toMatchObject({ groups: prev!.groups, rules: prev!.rules, disabled: ['E2E-X1'], foreign: 0 });
  } finally {
    await s.cleanup();
    await admin.cleanup();
  }
});

test('T09 年度の作成：終了した年度からも新しい年度を作れる', async ({ page }) => {
  const admin = await createUser({ purpose: 'admin' });
  const s = await createScenario({ festivalStart: 'latest', status: 'closed', dataset: 'small', grants: [{ userId: admin.id, role: 'admin' }] });
  try {
    await loginWith(page, admin);
    await page.goto('/settings/');
    // 終了した年度は読み取り専用だが、作成はできる
    await expect(page.getByTestId('read-only-notice')).toBeVisible();
    const form = page.getByTestId('year-create-form');
    const label = `${s.label}-n2`;
    await form.getByLabel('新しい年度名').fill(label);
    await form.getByLabel('新しい年度の1日目').fill('2200-10-15');
    await form.getByRole('button', { name: '新しい年度を作る' }).click();
    await expect(page.getByText(`${label} を作りました`, { exact: true })).toBeVisible();
    await expect(page.getByText('無効になったルールはありません')).toBeVisible();
    await expect(page.getByTestId('current-year')).toHaveText(`${label}・準備中`);
    await expect(page.getByTestId('year-created')).toContainText(`${label} を作りました。無効になったルール 0 件`);
    expect(await sql('select label from public.years where prev_year_id = $1', [s.yearId])).toEqual([{ label }]);
  } finally {
    await s.cleanup();
    await admin.cleanup();
  }
});
