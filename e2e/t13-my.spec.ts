import { expect, test, type Locator, type Page } from '@playwright/test';
import { accessToken, restGet, rpc, storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T13 自団体の振り分け /my（画面の設計 3.11・7.2 の T13 の行、04「自団体の振り分け」、Q4）。団体代表。スマホ幅。
// 確定前：振り分け作業中・申請の内容・交換の依頼への回答と「回答を変える」（Q4）・依頼の後に増えたときの「待ってください」、
// 振り分けの行を読みに行かない。確定後：品目ごとの数と運び元、代替、ほかの団体は見えない、団体の切り替え。
// シナリオの年度で閉じる。

test.use({ storageState: storageStateFor('rep'), viewport: MOBILE });

const SUBS = `requested_item_id = (select id from public.items where code = 'desk')
  and item_id = (select id from public.items where code = 'caster_desk')`;

async function itemIds(): Promise<{ desk: string; caster: string }> {
  const r = await sql<{ desk: string; caster: string }>(
    `select (select id from public.items where code = 'desk') as desk, (select id from public.items where code = 'caster_desk') as caster`,
  );
  return r[0]!;
}

async function consentStatus(groupId: string): Promise<string | undefined> {
  const r = await sql<{ status: string }>(
    `select status::text as status from public.substitution_consents where group_id = $1
       and from_item_id = (select id from public.items where code = 'desk')`,
    [groupId],
  );
  return r[0]?.status;
}

/** シナリオの年度は最新の年度（seed の R8）より前なので、回答の前に「最新でない年度（…）に回答します」を確かめる（1.3.1・T13-15） */
async function answer(page: Page, card: Locator, label: '了承する' | '了承しない'): Promise<void> {
  await card.getByRole('button', { name: label }).click();
  const d = page.getByRole('alertdialog').filter({ hasText: '最新でない年度' });
  await expect(d).toContainText('に回答します。よろしいですか');
  await d.getByRole('button', { name: 'この年度に回答する' }).click();
  await expect(d).toBeHidden();
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const w = await page.evaluate<number>('document.documentElement.scrollWidth');
  expect(w).toBeLessThanOrEqual(MOBILE.width);
}

test('T13 自団体の振り分け（確定前）：申請の内容と交換の依頼、了承する → 回答を変える（Q4）。振り分けの行は読まない', async ({ page, request }) => {
  const s = await createScenario({
    dataset: 'synthetic',
    status: 'allocating',
    allocations: 'reference',
    roles: { admin: true },
    repGroup: '模擬店10',
  });
  try {
    const g = s.ids.groups['模擬店10']!;
    const { desk, caster } = await itemIds();
    const admin = await accessToken(request, 'admin');
    const asked = await rpc(request, admin, 'set_consent', { p_group_id: g, p_from_item: desk, p_to_item: caster, p_status: 'asked' });
    expect(asked.error).toBeNull();
    const [{ n }] = (await sql<{ n: number }>(
      `select coalesce(sum(count), 0)::int as n from public.allocations where year_id = $1 and group_id = $2 and ${SUBS}`,
      [s.yearId, g],
    )) as [{ n: number }];
    const [{ desk_req }] = (await sql<{ desk_req: number }>(
      `select count as desk_req from public.requests where group_id = $1 and item_id = $2`,
      [g, desk],
    )) as [{ desk_req: number }];

    const allocationRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/rest/v1/allocations')) allocationRequests.push(r.url());
    });
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.goto('/my/');
    await expect(page.getByRole('heading', { level: 1, name: '自団体の振り分け' })).toBeVisible();
    await expect(page.getByTestId('my-group')).toHaveText(/模擬店10/);
    await expect(page.getByTestId('my-in-progress')).toContainText('振り分け作業中');
    // 最新でない年度を開いているので、見出しのすぐ下に「最新の年度に切り替える」（設計 1.3.1）
    const sw = page.getByTestId('my-screen').getByTestId('latest-year-switch');
    await expect(sw).toBeVisible();
    await expect(sw.getByRole('button', { name: /^最新の年度（.+）に切り替える$/ })).toBeVisible();
    const headingBox = (await page.getByRole('heading', { level: 1, name: '自団体の振り分け' }).boundingBox())!;
    const switchBox = (await sw.boundingBox())!;
    const progressBox = (await page.getByTestId('my-in-progress').boundingBox())!;
    expect(switchBox.y).toBeGreaterThan(headingBox.y);
    expect(switchBox.y + switchBox.height).toBeLessThanOrEqual(progressBox.y);
    await expect(page.getByTestId('my-requests').getByText('机(木)')).toBeVisible();
    await expect(page.getByTestId('my-requests').locator('li').filter({ hasText: '机(木)' })).toContainText(String(desk_req));
    await expect(page.getByTestId('my-submitted')).toContainText('提出日時');
    const card = page.getByTestId('my-consent');
    await expect(card.getByTestId('my-consent-text')).toHaveText(`机(木) ${n} 台をキャスター机に交換してほしいという依頼があります`);
    await expectNoHorizontalScroll(page);

    // 了承する
    await card.getByLabel('コメント（任意）').fill('E2E：入口が狭いので');
    await answer(page, card, '了承する');
    await expect(card).toHaveAttribute('data-status', 'accepted');
    await expect(card.getByTestId('my-consent-answer')).toContainText('了承しました');
    expect(await consentStatus(g)).toBe('accepted');
    // 了承で置き換えの行が固定される
    const pinned = await sql<{ n: number }>(
      `select count(*) filter (where not pinned)::int as n from public.allocations where year_id = $1 and group_id = $2 and ${SUBS}`,
      [s.yearId, g],
    );
    expect(pinned[0]!.n).toBe(0);

    // 回答を変える（Q4：確定まで）
    await card.getByRole('button', { name: '回答を変える' }).click();
    await answer(page, card, '了承しない');
    await expect(card).toHaveAttribute('data-status', 'declined');
    await expect(card.getByTestId('my-consent-answer')).toContainText('了承しないと答えました');
    expect(await consentStatus(g)).toBe('declined');

    // 確定前は振り分けの行を読みに行かない
    expect(allocationRequests).toEqual([]);
  } finally {
    await s.cleanup();
  }
});

test('T13 自団体の振り分け（確定前）：依頼の後に置き換えが増えていると「総務が依頼し直すのを待ってください」', async ({ page, request }) => {
  const s = await createScenario({
    dataset: 'synthetic',
    status: 'allocating',
    allocations: 'reference',
    roles: { admin: true },
    repGroup: '模擬店10',
  });
  try {
    const g = s.ids.groups['模擬店10']!;
    const { desk, caster } = await itemIds();
    const admin = await accessToken(request, 'admin');
    expect((await rpc(request, admin, 'set_consent', { p_group_id: g, p_from_item: desk, p_to_item: caster, p_status: 'asked' })).error).toBeNull();
    await sql(
      `update public.allocations set count = count + 1 where id = (
         select id from public.allocations where year_id = $1 and group_id = $2 and ${SUBS} order by id limit 1)`,
      [s.yearId, g],
    );
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.goto('/my/');
    const card = page.getByTestId('my-consent');
    await answer(page, card, '了承する');
    await expect(card.getByTestId('my-consent-wait')).toHaveText(
      '依頼の後に置き換えの台数が増えたので、今は回答を記録できません。総務が依頼し直すのを待ってください',
    );
    expect(await consentStatus(g)).toBe('asked');
    // 「了承しない」は台数によらず記録できる
    await answer(page, card, '了承しない');
    await expect(card).toHaveAttribute('data-status', 'declined');
  } finally {
    await s.cleanup();
  }
});

test('T13 自団体の振り分け（確定後）：品目ごとの数と運び元・代替。ほかの団体は見えず、代表を務める団体を切り替えられる', async ({ page, request }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', repGroup: '模擬店07' });
  try {
    const g07 = s.ids.groups['模擬店07']!;
    const g20 = s.ids.groups['模擬店20']!;
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.goto('/my/');
    await expect(page.getByTestId('my-screen')).toHaveAttribute('data-final', 'true');
    const lines = page.getByTestId('my-allocation-line');
    await expect(lines.filter({ hasText: '机(木)の代わりにキャスター机' })).toHaveText('机(木)の代わりにキャスター机 5台：3-1 から 2台、4-2 から 3台');
    // 机(木)：DB の行の合計と運び元
    const desk = await sql<{ room: string; n: number }>(
      `select r.name as room, sum(a.count)::int as n from public.allocations a join public.rooms r on r.id = a.source_room_id
        where a.year_id = $1 and a.group_id = $2 and a.item_id = (select id from public.items where code = 'desk')
          and a.requested_item_id = a.item_id group by r.name`,
      [s.yearId, g07],
    );
    const deskTotal = desk.reduce((x, r) => x + r.n, 0);
    const deskLine = lines.filter({ hasText: new RegExp(`^机\\(木\\) ${deskTotal}台`) });
    await expect(deskLine).toHaveCount(1);
    for (const r of desk) await expect(deskLine).toContainText(`${r.room} から`);
    await expect(page.getByTestId('my-in-progress')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // API でもほかの団体の振り分けは読めない（RLS。自団体の行だけ）
    const rep = await accessToken(request, 'rep');
    const seen = await restGet<{ group_id: string }[]>(request, rep, `allocations?select=group_id&year_id=eq.${s.yearId}`);
    expect(seen.error).toBeNull();
    expect(seen.data!.length).toBeGreaterThan(0);
    expect(new Set(seen.data!.map((r) => r.group_id))).toEqual(new Set([g07]));

    // 2つ目の団体の代表にする → 切り替え（?group=）
    await sql('insert into public.group_members (group_id, user_id) values ($1, $2)', [g20, SEED_USER_IDS.rep]);
    await page.reload();
    const select = page.getByTestId('my-group-select');
    await expect(select).toBeVisible();
    await select.selectOption(g20);
    await expect(page).toHaveURL(new RegExp(`[?&]group=${g20}`));
    await expect(page.getByTestId('my-group')).toHaveText(/模擬店20/);
    await expect(lines.filter({ hasText: '机(木)の代わりにキャスター机' })).toHaveText('机(木)の代わりにキャスター机 7台（MER から）');
  } finally {
    await s.cleanup();
  }
});
