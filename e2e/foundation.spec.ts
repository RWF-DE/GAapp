import { expect, test, type Page } from '@playwright/test';
import { loginAs, navLabels } from './helpers';
import { accessToken, restGet, rpc, storageStateFor, type StoredUser } from './support/auth';
import { createScenario, sql } from './support/db';
import { SEED_R8, SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T09a 画面の共通基盤（画面の設計 7.2 の表の T09a の行）：ナビ・直接開いたときの権限・年度の切り替え・見え方。
// シナリオの年度（createScenario）は 2001 年の日付なので、seed の利用者の既定の年度は R8 のまま。
//
// ページの中身（雛形の「この画面は準備中です」か、各チケットの画面か）はここでは確かめない。開ける立場では
// 「h1 が出て、権限なしでない」、開けない立場では「権限がありません」だけを見る。雛形が各チケットの画面に
// 置き換わってもこのファイルは直さなくてよい（中身は各チケットの e2e/t10-stock.spec.ts などで確かめる）。

/** 全ルート（lib/navigation.ts の ROUTES のホーム以外。末尾の / は静的書き出しの形。/furniture は T16、/notices は T17、/calendar は T18） */
const ALL_PAGES = [
  '/furniture/', '/settings/', '/stock/', '/stocks/', '/stocks/qr/', '/requests/', '/rules/', '/allocation/', '/swaps/', '/history/',
  '/request/', '/my/', '/notices/', '/calendar/',
];

// ナビは見出し（ホーム／机椅子／お知らせ／締切と予定／共通。T16・T17・T18。D-51・D-52・D-54）の順。navLabels は見出しを除いた
// 項目の平らな一覧。お知らせ一覧（T17）と締切と予定（T18）は招待されている全員
const NAV: Record<StoredUser, string[]> = {
  admin: ['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', 'お知らせ一覧', '締切と予定', 'マスタ設定', '履歴'],
  // 総務部門長（部門長以上）のナビは管理者と同じ（マスタ設定の中のタブは段で分ける。D-50。e2e/t15b-roles.spec.ts）
  head: ['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', 'お知らせ一覧', '締切と予定', 'マスタ設定', '履歴'],
  // Q1（D-39）：総務部門員は振り分けをいつでも読み取り専用で開ける。机椅子の状況は総務（T16）
  staff: ['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け', 'お知らせ一覧', '締切と予定'],
  // 閲覧のみは振り分けが確定・終了の年度だけ。R8 は申請受付中なのでホームとお知らせ一覧と締切と予定だけ
  viewer: ['ホーム', 'お知らせ一覧', '締切と予定'],
  rep: ['ホーム', '申請', '自団体の振り分け', 'お知らせ一覧', '締切と予定'],
};

/** R8（申請受付中）で開ける画面（lib/navigation.ts の ROUTES の立場から） */
const OPENS: Record<StoredUser, string[]> = {
  admin: ['/furniture/', '/settings/', '/stock/', '/stocks/', '/stocks/qr/', '/requests/', '/rules/', '/allocation/', '/swaps/', '/history/', '/notices/', '/calendar/'],
  head: ['/furniture/', '/settings/', '/stock/', '/stocks/', '/stocks/qr/', '/requests/', '/rules/', '/allocation/', '/swaps/', '/history/', '/notices/', '/calendar/'],
  staff: ['/furniture/', '/stock/', '/stocks/', '/stocks/qr/', '/requests/', '/allocation/', '/notices/', '/calendar/'],
  viewer: ['/notices/', '/calendar/'],
  rep: ['/request/', '/my/', '/notices/', '/calendar/'],
};

const forbidden = (page: Page) => page.getByText('権限がありません', { exact: true });

/**
 * 開けた：立場を読み終え（ヘッダーの年度の印が出る）、h1 が出て、「権限がありません」が出ていない。
 * 雛形のページでも、各チケットの画面でも通る（RequireAudience は立場を読み終えたのと同じ描画で権限なしを出す）。
 */
async function expectOpens(page: Page): Promise<void> {
  await expect(page.getByTestId('current-year')).toBeAttached();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(forbidden(page)).toHaveCount(0);
}

/** 開けない：「権限がありません」（RequireAudience の ForbiddenState）が出て、雛形の中身は出ていない */
async function expectForbidden(page: Page): Promise<void> {
  await expect(page.getByRole('alert').filter({ has: forbidden(page) })).toBeVisible();
  await expect(page.getByText(/この画面は準備中です/)).toHaveCount(0);
}

for (const user of ['admin', 'head', 'staff', 'viewer', 'rep'] as const) {
  test.describe(`T09a ${user}`, () => {
    test.use({ storageState: storageStateFor(user) });

    test(`T09a ${user} のナビ：全項目が使え、押すとそのページが開く`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
      expect(await navLabels(page)).toEqual(NAV[user]);
      const nav = page.getByRole('navigation', { name: 'メインメニュー' });
      await expect(nav.getByText('準備中')).toHaveCount(0);
      for (const label of NAV[user].slice(1)) {
        const link = nav.getByRole('link', { name: label });
        const path = (await link.getAttribute('href')) ?? '';
        await link.click();
        await expect(page).toHaveURL((u) => u.pathname === path);
        await expectOpens(page);
      }
    });

    test(`T09a ${user}：立場の合わない画面を URL で開くと「権限がありません」`, async ({ page }) => {
      for (const path of ALL_PAGES) {
        await page.goto(path);
        if (OPENS[user].includes(path)) await expectOpens(page);
        else await expectForbidden(page);
      }
    });
  });
}

test('T09a 未招待：ナビも画面もなく「総務から招待されていません」だけ。画面を URL で開いても同じ', async ({ page }) => {
  await loginAs(page, 'outsider');
  await expect(page.getByRole('heading', { name: '総務から招待されていません' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  for (const path of ['/settings/', '/requests/', '/request/']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '総務から招待されていません' })).toBeVisible();
    await expect(page.getByText(/この画面は準備中です/)).toHaveCount(0);
  }
});

test.describe('T09a 閲覧のみと確定した年度（Q1）', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('T09a 閲覧のみ：確定した年度を開くと振り分けがナビに出て開ける。受付中の年度では開けない', async ({ page }) => {
    const s = await createScenario({ status: 'confirmed', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・確定`);
      expect(await navLabels(page)).toEqual(['ホーム', '振り分け', 'お知らせ一覧', '締切と予定']);
      await expectOpens(page);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09a 年度の切り替え', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T09a シナリオの年度を選ぶと表示が変わり、同じタブの再読み込みでも残り、新しいタブでは最新の年度で開く', async ({ page, context }) => {
    const s = await createScenario({ status: 'allocating', roles: { staff: true } });
    try {
      await page.goto('/');
      await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
      const select = page.getByTestId('year-select');
      await expect(select.locator('option', { hasText: `${s.label}（振り分け中）` })).toHaveCount(1);
      await expect(page.getByTestId('not-latest-year-banner')).toHaveCount(0);

      await select.selectOption(s.yearId);
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（振り分け中）`);
      await expect(page.getByTestId('not-latest-year-banner')).toContainText(`最新でない年度（${s.label}・振り分け中）を表示しています`);
      expect(await navLabels(page)).toEqual(NAV.staff);

      // 別の画面に移っても、同じタブの再読み込みでも、選んだ年度のまま
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '在庫一覧' }).click();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      await page.reload();
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・振り分け中`);
      await expectOpens(page);

      // 新しいタブ（sessionStorage はタブごと）は最新の年度
      const tab = await context.newPage();
      await tab.goto('/');
      await expect(tab.getByTestId('current-year')).toHaveText('R8・申請受付中');
      await expect(tab.getByTestId('not-latest-year-banner')).toHaveCount(0);
      await tab.close();

      // 帯のボタンで最新の年度に戻る
      await page.getByTestId('not-latest-year-banner').getByRole('button', { name: '最新の年度（R8）に切り替える' }).click();
      await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
      await expect(page.getByTestId('not-latest-year-banner')).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });

  test('T09a スマホ（幅 390px）：年度が2つ以上で年度名が長くても、ヘッダーがはみ出さず、ログアウトのボタンが画面の中にある', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', roles: { staff: true } });
    try {
      // 年度名は 50 字まで入れられる（年度名の上限いっぱいにする）
      const label = `${s.label}-${'第60回電波祭の年度名'.repeat(5)}`.slice(0, 50);
      await sql('update public.years set label = $2 where id = $1', [s.yearId, label]);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      const expectFits = async () => {
        expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390);
        const box = await page.getByRole('button', { name: 'ログアウト' }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      };
      await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
      await expectFits();
      await page.getByTestId('year-select').selectOption(s.yearId);
      await expect(page.getByTestId('current-year')).toHaveText(`${label}・振り分け中`);
      await expectFits();
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09a 団体代表の年度の切り替え', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T09a 団体代表：シナリオの年度に切り替えると、立場の表示がその年度の団体になる', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', repGroup: 'E2E模擬店1' });
    try {
      await page.goto('/');
      await expect(page.getByTestId('home-roles')).toHaveText(`${SEED_R8.groupName} の店長`);
      await page.getByTestId('year-select').selectOption(s.yearId);
      await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・申請受付中`);
      await expect(page.getByTestId('home-roles')).toHaveText('E2E模擬店1 の店長');
      expect(await navLabels(page)).toEqual(NAV.rep);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T09a 見え方（API を直接呼んでも）', () => {
  test('T09a 団体代表はほかの団体の申請・提出・振り分け・団体が 0 行（自団体の分は読める）', async ({ request }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', repGroup: '模擬店01' });
    try {
      const token = await accessToken(request, 'rep');
      const own = s.ids.groups['模擬店01']!;
      const others = Object.entries(s.ids.groups)
        .filter(([name]) => name !== '模擬店01')
        .map(([, id]) => id);
      const inOthers = `in.(${others.join(',')})`;
      for (const table of ['requests', 'request_submissions', 'allocations', 'substitution_consents']) {
        const theirs = await restGet<unknown[]>(request, token, `${table}?select=group_id&group_id=${inOthers}`);
        expect(theirs.error, table).toBeNull();
        expect(theirs.data, `${table}：ほかの団体`).toEqual([]);
      }
      for (const table of ['requests', 'request_submissions', 'allocations']) {
        const mine = await restGet<unknown[]>(request, token, `${table}?select=group_id&group_id=eq.${own}`);
        expect(mine.data?.length ?? 0, `${table}：自団体`).toBeGreaterThan(0);
      }
      const groups = await restGet<{ id: string }[]>(request, token, `groups?select=id&year_id=eq.${s.yearId}`);
      expect(groups.data?.map((g) => g.id)).toEqual([own]);
      const stocks = await restGet<unknown[]>(request, token, `stocks?select=room_id&year_id=eq.${s.yearId}`);
      expect(stocks.data).toEqual([]);
      const rules = await restGet<unknown[]>(request, token, `rules?select=id&year_id=eq.${s.yearId}`);
      expect(rules.data).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 未招待は全表 0 行（自分のプロフィールだけ）、RPC は forbidden', async ({ request }) => {
    const token = await accessToken(request, 'outsider');
    const tables = [
      'years', 'rooms', 'room_years', 'items', 'stocks', 'groups', 'year_roles', 'group_members', 'invitations',
      'request_submissions', 'requests', 'rules', 'substitution_consents', 'allocations', 'distance_overrides', 'slots',
      'deliveries', 'audit_logs', 'v_remaining',
    ];
    for (const table of tables) {
      const r = await restGet<unknown[]>(request, token, `${table}?select=*&limit=5`);
      expect(r.error, table).toBeNull();
      expect(r.data, table).toEqual([]);
    }
    const profiles = await restGet<{ user_id: string }[]>(request, token, 'profiles?select=user_id');
    expect(profiles.data).toEqual([{ user_id: SEED_USER_IDS.outsider }]);

    const calls: [string, Record<string, unknown>][] = [
      ['set_year_status', { p_year_id: SEED_R8.yearId, p_to: 'allocating' }],
      ['create_year_from', { p_prev_year_id: SEED_R8.yearId, p_label: 'R9', p_festival_start: '2027-10-16' }],
      ['submit_requests', { p_group_id: SEED_R8.groupId, p_rows: [] }],
      ['save_allocation_rows', { p_year_id: SEED_R8.yearId, p_changes: [], p_reason: 'E2E' }],
      ['invite', { p_year_id: SEED_R8.yearId, p_email: 'someone@example.test', p_role: 'staff' }],
    ];
    for (const [name, args] of calls) {
      const r = await rpc(request, token, name, args);
      expect(r.error?.code, name).toBe('P0001');
      expect(r.error?.message, name).toBe('forbidden');
    }
  });
});

test('T09a ログアウトは、その端末のセッションだけを終える（保存したログインは使えるまま）', async ({ page, browser }) => {
  // 画面からログインし直したセッションでログアウトする（storageState は使わない。設計 7.2）
  await loginAs(page, 'staff');
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page).toHaveURL(/\/login\/$/);
  // signOut({ scope: 'local' }) なので、auth-setup が保存した staff のセッションは終わっていない
  const ctx = await browser.newContext({ storageState: storageStateFor('staff') });
  try {
    const other = await ctx.newPage();
    await other.goto('/stocks/');
    await expect(other.getByTestId('current-year')).toHaveText('R8・申請受付中');
    await other.reload();
    await expectOpens(other);
  } finally {
    await ctx.close();
  }
});
