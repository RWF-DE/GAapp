import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import { createScenario, createUser, sql, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import {
  insertNotices,
  noticeIds,
  noticeItem,
  noticesOf,
  noticeTimeLabel,
  openNotices,
  openPortal,
  portalNotice,
  portalNoticeIds,
} from './support/notices';
import { loginWith } from './support/roles';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T17 お知らせ（/notices とダッシュボードの欄。04「お知らせ一覧」「ダッシュボード」、D-53、notes/T17.md の「後半のテストの計画」の
// E2E の 1〜9）。シナリオの年度（small。1日目は 2001 年）で閉じる。お知らせは画面から出すほか、e2e/support/notices.ts で SQL から
// 入れる（書いた人を入れる。年度をまたぐ表には書かない）。団体は A＝E2E模擬店1（seed の店長が代表する団体）・B＝E2E部門1・
// C＝E2E企業1。表示名は seed のもの（テスト部門長・テスト部員・テスト管理者）。
// 期待値の文言は 04 の「お知らせ一覧」のとおりに書く（アプリの定数から引かない）。

const A = SMALL.groups.stall;
const B = SMALL.groups.department;

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ（PC） */
async function openAs(browser: Browser, user: StoredUser, s: Scenario): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport: PC });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** ダッシュボードの欄の日時の表示（「10/5 17:00」。Asia/Tokyo）を DB で作る */
async function shortTimeLabel(id: string): Promise<string> {
  const [r] = await sql<{ t: string }>(
    `select to_char(created_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.notices where id = $1`,
    [id],
  );
  return r!.t;
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

/** 本文の表示（改行と行頭の空白を残す。white-space: pre-wrap の innerText） */
const bodyText = (page: Page, id: string) => noticeItem(page, id).getByTestId('notice-body').innerText();

// ---------------------------------------------------------------- 総務部門員

test.describe('T17 総務部門員', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T17 総務部門員：総務内のお知らせだけを出せる（宛先を選べず、ピン留めの欄もない）。一覧に書いた人と日時、ダッシュボードの「総務内のお知らせ」に出る。ほかの人のお知らせには「編集」「削除」が出ない', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { staff: true, head: true } });
    try {
      // 部門長が出した総務内（ピン留め）・全団体あてと、部員が前に（部門長だったときに）出した全団体あて。DB は書いた人の削除を許し、
      // 画面は総務部門員に削除だけを出す（宛先を選べないので、団体あてを編集させない。後半の判断したことの 5）
      const [headSoumu, headAll, staffAll] = await insertNotices(s.yearId, [
        { audience: 'soumu', title: 'E2E 部門長の連絡', body: '部門長が書いた本文', pinned: true, createdBy: SEED_USER_IDS.head },
        { audience: 'all_groups', title: 'E2E 部門長の全団体あて', createdBy: SEED_USER_IDS.head },
        { audience: 'all_groups', title: 'E2E 部員が前に出した全団体あて', createdBy: SEED_USER_IDS.staff },
      ]);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openNotices(page);
      await expect(page.getByTestId('notices-filter')).toBeVisible();

      // 書く：宛先は総務内だけ（選ぶ欄がない）、ピン留めの欄もない。題名の字数は前後の空白を除いて数える
      await page.getByRole('button', { name: 'お知らせを書く' }).click();
      const dialog = page.getByRole('dialog', { name: 'お知らせを書く' });
      await expect(dialog.getByTestId('notice-audience-fixed')).toContainText('総務内（総務部門員が出せるのは総務内のお知らせだけです）');
      await expect(dialog.getByTestId('notice-audience-fixed')).toContainText('総務だけが読みます');
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(dialog.getByTestId('notice-group-picker')).toHaveCount(0);
      await expect(dialog.getByRole('switch')).toHaveCount(0);
      const title = 'E2E 部員の連絡';
      await dialog.getByLabel('題名', { exact: true }).fill(`  ${title}\u3000`);
      await expect(dialog.getByTestId('notice-title-count')).toHaveText(`${[...title].length}/100`);
      await dialog.getByLabel('本文（任意）').fill('1行目\n  2行目（字下げ）');
      await expect(dialog.getByTestId('notice-body-count')).toHaveText('14/4000');
      await dialog.getByRole('button', { name: '出す' }).click();
      await expect(page.getByText(`お知らせ「${title}」を出しました`)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // DB：総務内・ピン留めなし・書いた人は部員。題名は前後の空白を除いた形、本文は改行と字下げのまま
      const mine = (await noticesOf(s.yearId)).find((n) => n.title === title)!;
      expect(mine).toMatchObject({
        audience: 'soumu',
        pinned: false,
        body: '1行目\n  2行目（字下げ）',
        created_by: SEED_USER_IDS.staff,
        updated_by: SEED_USER_IDS.staff,
        group_ids: [],
      });

      // 一覧：ピン留め → 出した日時の新しい順。宛先の印・本文（改行を残す）・書いた人の表示名・出した日時（Asia/Tokyo）
      await expect.poll(() => noticeIds(page)).toEqual([headSoumu, mine.id, staffAll, headAll]);
      const item = noticeItem(page, mine.id);
      await expect(item).toHaveAttribute('data-audience', 'soumu');
      await expect(item).toHaveAttribute('data-pinned', 'false');
      await expect(item.getByTestId('notice-audience')).toHaveText('総務内');
      await expect(item.getByTestId('notice-pinned')).toHaveCount(0);
      expect(await bodyText(page, mine.id)).toBe('1行目\n  2行目（字下げ）');
      await expect(item.getByTestId('notice-author')).toHaveText('テスト部員');
      await expect(item.getByTestId('notice-time')).toHaveText(await noticeTimeLabel(mine.id));
      await expect(item.getByTestId('notice-updated')).toHaveCount(0);
      await expect(noticeItem(page, headSoumu).getByTestId('notice-pinned')).toHaveText('ピン留め');
      await expect(noticeItem(page, headSoumu).getByTestId('notice-author')).toHaveText('テスト部門長');

      // 操作：自分の総務内には「編集」「削除」、部門長のお知らせには何もない。自分が前に出した全団体あては「削除」だけ
      await expect(item.getByRole('button')).toHaveText(['編集', '削除']);
      await expect(item.getByRole('button', { name: `「${title}」を編集` })).toBeVisible();
      await expect(item.getByRole('button', { name: `「${title}」を削除` })).toBeVisible();
      for (const id of [headSoumu, headAll]) await expect(noticeItem(page, id).getByRole('button')).toHaveCount(0);
      await expect(noticeItem(page, staffAll).getByRole('button')).toHaveText(['削除']);
      await expect(noticeItem(page, staffAll).getByRole('button', { name: '「E2E 部員が前に出した全団体あて」を削除' })).toBeVisible();

      // 自分の総務内を編集：宛先は総務内のまま（選ぶ欄がない）、ピン留めの欄もない。本文を直すと「（… に更新）」
      await item.getByRole('button', { name: `「${title}」を編集` }).click();
      const edit = page.getByRole('dialog', { name: 'お知らせを編集' });
      await expect(edit.getByTestId('notice-audience-fixed')).toBeVisible();
      await expect(edit.getByRole('switch')).toHaveCount(0);
      await expect(edit.getByLabel('題名', { exact: true })).toHaveValue(title);
      await expect(edit.getByLabel('本文（任意）')).toHaveValue('1行目\n  2行目（字下げ）');
      await edit.getByLabel('本文（任意）').fill('1行目\n  2行目（直した）');
      await edit.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText(`「${title}」を保存しました`)).toBeVisible();
      await expect(edit).toHaveCount(0);
      await expect(item.getByTestId('notice-updated')).toBeVisible();
      await expect(item.getByTestId('notice-updated-time')).toHaveText(await noticeTimeLabel(mine.id, 'updated_at'));
      expect(await bodyText(page, mine.id)).toBe('1行目\n  2行目（直した）');

      // ダッシュボード：「総務内のお知らせ」にピン留め → 新しい順（団体あては出ない）。「お知らせ」の欄はない
      await openPortal(page, 'ダッシュボード');
      const widget = page.getByTestId('portal-soumu-notices');
      await expect(widget.getByRole('heading', { level: 2, name: '総務内のお知らせ' })).toBeVisible();
      expect(await portalNoticeIds(widget)).toEqual([headSoumu, mine.id]);
      await expect(page.getByTestId('portal-notices')).toHaveCount(0);
      const digest = portalNotice(widget, mine.id);
      await expect(digest).toContainText(title);
      await expect(digest.locator('time')).toHaveText(await shortTimeLabel(mine.id));
      await expect(digest.getByRole('link')).toHaveAttribute('href', new RegExp(`/notices/?\\?notice=${mine.id}$`));
      await expect(portalNotice(widget, headSoumu)).toContainText('ピン留め');
      await expect(widget.getByTestId('portal-notices-link')).toHaveText('お知らせ一覧へ');
      await expect(widget.getByTestId('portal-notices-link')).toHaveAttribute('href', /\/notices\/?\?audience=soumu$/);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 総務部門長

test.describe('T17 総務部門長', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T17 総務部門長：全団体あて（ピン留め）と指定の団体あて（団体 A・B）を出せる。一覧はピン留めが先で、宛先の団体の名前が出る。宛先で絞り込め、何も変えない編集は送らない', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true } });
    try {
      const [old] = await insertNotices(s.yearId, [{ audience: 'soumu', title: 'E2E 前からある連絡', createdBy: SEED_USER_IDS.head }]);
      await pinYear(page, SEED_USER_IDS.head, s.yearId);
      await openNotices(page);

      // 全団体あて（ピン留め）。宛先は3つ（既定は総務内）と、それぞれ読める人の説明。ピン留めの欄がある（既定は外す）
      await page.getByRole('button', { name: 'お知らせを書く' }).click();
      const dialog = page.getByRole('dialog', { name: 'お知らせを書く' });
      await expect(dialog.getByRole('radio')).toHaveCount(3);
      await expect(dialog.getByRole('radio', { name: '総務内' })).toBeChecked();
      await expect(dialog.getByText('総務だけが読みます')).toBeVisible();
      await expect(dialog.getByText('すべての団体の店長・副店長と、閲覧のみの人が読みます')).toBeVisible();
      await expect(dialog.getByText('選んだ団体の店長・副店長と、閲覧のみの人が読みます')).toBeVisible();
      await expect(dialog.getByTestId('notice-audience-fixed')).toHaveCount(0);
      await dialog.getByRole('radio', { name: '全団体' }).click();
      await expect(dialog.getByTestId('notice-group-picker')).toHaveCount(0);
      await dialog.getByLabel('題名', { exact: true }).fill('E2E 搬入日の集合');
      const pin = dialog.getByRole('switch', { name: 'ピン留めする' });
      await expect(pin).not.toBeChecked();
      await expect(dialog.getByText('一覧とダッシュボードの欄の先頭に出します')).toBeVisible();
      await pin.click();
      await expect(pin).toBeChecked();
      await dialog.getByRole('button', { name: '出す' }).click();
      await expect(page.getByText('お知らせ「E2E 搬入日の集合」を出しました')).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // 指定の団体あて：団体を選ばずに「出す」と欄の下に誤り（送らない）。A を選び、「団体を探す」で B を探して選ぶ
      await page.getByRole('button', { name: 'お知らせを書く' }).click();
      await dialog.getByRole('radio', { name: '指定の団体' }).click();
      const picker = dialog.getByTestId('notice-group-picker');
      await expect(picker).toBeVisible();
      await expect(picker.getByTestId('notice-group-count')).toHaveText('0 団体を選んでいます');
      await expect(picker.getByRole('checkbox')).toHaveCount(3);
      await dialog.getByLabel('題名', { exact: true }).fill('E2E 電源の申請');
      await dialog.getByLabel('本文（任意）').fill('模擬店と部門の方へ');
      await dialog.getByRole('button', { name: '出す' }).click();
      await expect(dialog.locator('[data-field-error="groupIds"]')).toHaveText('宛先の団体を1つ以上選んでください');
      expect((await noticesOf(s.yearId)).map((n) => n.title)).not.toContain('E2E 電源の申請');
      await picker.getByRole('checkbox', { name: A }).click();
      const search = picker.getByRole('searchbox', { name: '団体を探す' });
      await search.fill('部門');
      await expect(picker.getByRole('checkbox')).toHaveCount(1);
      await picker.getByRole('checkbox', { name: B }).click();
      await search.fill('');
      await expect(picker.getByRole('checkbox')).toHaveCount(3);
      await expect(picker.getByTestId('notice-group-count')).toHaveText('2 団体を選んでいます');
      await dialog.getByRole('button', { name: '出す' }).click();
      await expect(page.getByText('お知らせ「E2E 電源の申請」を出しました')).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // DB：全団体あてはピン留めで宛先の団体なし、指定の団体あては A・B
      const rows = await noticesOf(s.yearId);
      const all = rows.find((n) => n.title === 'E2E 搬入日の集合')!;
      const grp = rows.find((n) => n.title === 'E2E 電源の申請')!;
      expect(all).toMatchObject({ audience: 'all_groups', pinned: true, body: null, group_ids: [], created_by: SEED_USER_IDS.head });
      expect(grp).toMatchObject({ audience: 'groups', pinned: false, body: '模擬店と部門の方へ', created_by: SEED_USER_IDS.head });
      expect(grp.group_ids).toEqual([s.ids.groups[A]!, s.ids.groups[B]!].sort());

      // 一覧：ピン留め → 新しい順。宛先の印と、指定の団体あての宛先の団体（団体の並び〔sort_order〕で「・」）
      await expect.poll(() => noticeIds(page)).toEqual([all.id, grp.id, old]);
      await expect(noticeItem(page, all.id).getByTestId('notice-pinned')).toHaveText('ピン留め');
      await expect(noticeItem(page, all.id).getByTestId('notice-audience')).toHaveText('全団体');
      await expect(noticeItem(page, all.id).getByTestId('notice-groups')).toHaveCount(0);
      await expect(noticeItem(page, all.id).getByTestId('notice-body')).toHaveCount(0);
      await expect(noticeItem(page, grp.id).getByTestId('notice-audience')).toHaveText('指定の団体');
      await expect(noticeItem(page, grp.id).getByTestId('notice-groups')).toHaveText(`${A}・${B}`);
      // 部門長以上はどのお知らせにも「編集」「削除」
      for (const id of [all.id, grp.id, old]) await expect(noticeItem(page, id).getByRole('button')).toHaveText(['編集', '削除']);

      // 何も変えない編集は送らずに「変更はありません」で閉じる（DB の版は変わらない）
      const before = (await sql<{ u: string }>('select updated_at::text as u from public.notices where id = $1', [grp.id]))[0]!.u;
      await noticeItem(page, grp.id).getByRole('button', { name: '「E2E 電源の申請」を編集' }).click();
      const edit = page.getByRole('dialog', { name: 'お知らせを編集' });
      await expect(edit.getByRole('radio', { name: '指定の団体' })).toBeChecked();
      await expect(edit.getByTestId('notice-group-count')).toHaveText('2 団体を選んでいます');
      await expect(edit.getByRole('checkbox', { name: A })).toBeChecked();
      await expect(edit.getByRole('checkbox', { name: B })).toBeChecked();
      await edit.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('変更はありません')).toBeVisible();
      await expect(edit).toHaveCount(0);
      expect((await sql<{ u: string }>('select updated_at::text as u from public.notices where id = $1', [grp.id]))[0]!.u).toBe(before);

      // 絞り込み（件数つき。URL の ?audience=）
      const filter = page.getByTestId('notices-filter');
      await expect(filter.getByRole('radio')).toHaveText(['すべて（3）', '総務内（1）', '全団体（1）', '指定の団体（1）']);
      await expect(filter.getByRole('radio', { name: 'すべて（3）' })).toHaveAttribute('aria-checked', 'true');
      await filter.getByRole('radio', { name: '指定の団体（1）' }).click();
      await expect(page).toHaveURL(/\/notices\/?\?audience=groups$/);
      await expect.poll(() => noticeIds(page)).toEqual([grp.id]);
      await filter.getByRole('radio', { name: '全団体（1）' }).click();
      await expect(page).toHaveURL(/\/notices\/?\?audience=all_groups$/);
      await expect.poll(() => noticeIds(page)).toEqual([all.id]);
      await filter.getByRole('radio', { name: 'すべて（3）' }).click();
      await expect(page).toHaveURL(/\/notices\/?$/);
      await expect.poll(() => noticeIds(page)).toEqual([all.id, grp.id, old]);
      // 開いたときの ?audience=（知らない値は「すべて」）
      await openNotices(page, '?audience=soumu');
      await expect(filter.getByRole('radio', { name: '総務内（1）' })).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => noticeIds(page)).toEqual([old]);
      await openNotices(page, '?audience=unknown');
      await expect(filter.getByRole('radio', { name: 'すべて（3）' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('notice-item')).toHaveCount(3);

      // スマホの幅：1件ずつ縦に重ね、横にはみ出さない（操作のボタンも画面の中）
      await page.setViewportSize(MOBILE);
      await openNotices(page);
      await expectNoOverflow(page);
      const box = await noticeItem(page, grp.id).getByRole('button', { name: '「E2E 電源の申請」を削除' }).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 店長・閲覧のみ

test.describe('T17 店長', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: PC });

  test('T17 店長：全団体あてと自団体あてだけが読め（ほかの団体だけあて・総務内は出ない）、宛先の団体は自団体の名前だけ。書く・編集・削除・書いた人・絞り込みはない。ホームの「お知らせ」に出る', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    // 団体 B には使い捨ての店長（同じお知らせが、B の店長には B の分だけ見える）
    const u = await createUser({ purpose: 'notice-rep', name: 'E2E 部門の店長' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { head: true },
      repGroup: A,
      groupMembers: [{ userId: u.id, group: B }],
    });
    // B の店長の画面（この describe の storageState〔seed の店長〕を引き継がないよう、空のログインの状態で作る）
    const ctxB = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: PC });
    try {
      const g = s.ids.groups;
      const [, all, toA, toAB, toB] = await insertNotices(s.yearId, [
        { audience: 'soumu', title: 'E2E 総務の連絡', createdBy: SEED_USER_IDS.head },
        { audience: 'all_groups', title: 'E2E 全団体あて', pinned: true, createdBy: SEED_USER_IDS.head },
        { audience: 'groups', title: 'E2E 模擬店1あて', groupIds: [g[A]!], createdBy: SEED_USER_IDS.head },
        { audience: 'groups', title: 'E2E 模擬店1と部門1あて', body: '模擬店1と部門1の方へ', groupIds: [g[A]!, g[B]!], createdBy: SEED_USER_IDS.head },
        { audience: 'groups', title: 'E2E 部門1だけあて', groupIds: [g[B]!], createdBy: SEED_USER_IDS.head },
      ]);
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await openNotices(page);
      expect(await noticeIds(page)).toEqual([all, toAB, toA]);
      // 宛先の団体は自団体の名前だけ（ほかにどの団体へ出したかは出ない）
      await expect(noticeItem(page, toAB).getByTestId('notice-groups')).toHaveText(A);
      await expect(noticeItem(page, toA).getByTestId('notice-groups')).toHaveText(A);
      await expect(noticeItem(page, all).getByTestId('notice-pinned')).toHaveText('ピン留め');
      expect(await bodyText(page, toAB)).toBe('模擬店1と部門1の方へ');
      await expect(noticeItem(page, all).getByTestId('notice-time')).toHaveText(await noticeTimeLabel(all));
      // 書くためのもの（ボタン・帯）・書いた人・絞り込みはない（?audience= を付けても絞らない）
      await expect(page.getByRole('button', { name: 'お知らせを書く' })).toHaveCount(0);
      await expect(page.getByTestId('notices-list').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('notice-author')).toHaveCount(0);
      await expect(page.getByTestId('notices-filter')).toHaveCount(0);
      await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
      await openNotices(page, '?audience=all_groups');
      await expect(page.getByTestId('notice-item')).toHaveCount(3);

      // スマホの幅：横にはみ出さない
      await page.setViewportSize(MOBILE);
      await openNotices(page);
      await expectNoOverflow(page);
      await page.setViewportSize(PC);

      // ホーム：「お知らせ」の欄（ピン留め → 新しい順、宛先の印）。「総務内のお知らせ」の欄はない
      await openPortal(page, 'ホーム');
      const widget = page.getByTestId('portal-notices');
      await expect(widget.getByRole('heading', { level: 2, name: 'お知らせ' })).toBeVisible();
      expect(await portalNoticeIds(widget)).toEqual([all, toAB, toA]);
      await expect(portalNotice(widget, all)).toContainText('ピン留め');
      await expect(portalNotice(widget, all)).toHaveAttribute('data-audience', 'all_groups');
      await expect(portalNotice(widget, all).getByText('全団体', { exact: true })).toBeVisible();
      await expect(portalNotice(widget, toA).getByText('指定の団体', { exact: true })).toBeVisible();
      await expect(page.getByTestId('portal-soumu-notices')).toHaveCount(0);
      await expect(widget.getByTestId('portal-notices-link')).toHaveAttribute('href', /\/notices\/?$/);

      // 部門1の店長（使い捨て）：全団体あて・部門1だけあて・模擬店1と部門1あて（宛先の団体は部門1だけ）。模擬店1だけあては出ない
      const pageB = await ctxB.newPage();
      await loginWith(pageB, u);
      await openNotices(pageB);
      expect(await noticeIds(pageB)).toEqual([all, toB, toAB]);
      await expect(noticeItem(pageB, toAB).getByTestId('notice-groups')).toHaveText(B);
      await expect(noticeItem(pageB, toB).getByTestId('notice-groups')).toHaveText(B);
    } finally {
      await ctxB.close().catch(() => undefined);
      await s.cleanup();
      await u.cleanup();
    }
  });
});

test.describe('T17 閲覧のみ', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: PC });

  test('T17 閲覧のみ：団体あて（全団体・指定の団体。宛先の団体は全部）だけが読め、総務内は出ない。書くためのものはない。ホームの「お知らせ」から一覧のそのお知らせへ', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { viewer: true, head: true } });
    try {
      const g = s.ids.groups;
      const [, toAB, all] = await insertNotices(s.yearId, [
        { audience: 'soumu', title: 'E2E 総務の連絡', createdBy: SEED_USER_IDS.head },
        { audience: 'groups', title: 'E2E 模擬店1と部門1あて', groupIds: [g[A]!, g[B]!], createdBy: SEED_USER_IDS.head },
        { audience: 'all_groups', title: 'E2E 全団体あて', createdBy: SEED_USER_IDS.head },
      ]);
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await openNotices(page);
      expect(await noticeIds(page)).toEqual([all, toAB]);
      await expect(noticeItem(page, toAB).getByTestId('notice-groups')).toHaveText(`${A}・${B}`);
      await expect(page.getByRole('button', { name: 'お知らせを書く' })).toHaveCount(0);
      await expect(page.getByTestId('notices-list').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('notice-author')).toHaveCount(0);
      await expect(page.getByTestId('notices-filter')).toHaveCount(0);

      // ホーム：「お知らせ」の欄。1件を押すと、一覧でそのお知らせが目立つ（?notice=）
      await openPortal(page, 'ホーム');
      const widget = page.getByTestId('portal-notices');
      expect(await portalNoticeIds(widget)).toEqual([all, toAB]);
      await expect(page.getByTestId('portal-soumu-notices')).toHaveCount(0);
      await portalNotice(widget, toAB).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/notices/?\\?notice=${toAB}$`));
      await expect(noticeItem(page, toAB)).toHaveAttribute('data-highlighted', 'true');
      await expect(page.locator('[data-testid="notice-item"][data-highlighted]')).toHaveCount(1);
      await expect(page.getByTestId('notice-item')).toHaveCount(2);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 編集の衝突・削除（2つのセッション）

test('T17 編集の衝突：2つのセッション（総務部門長と管理者）で同じお知らせを直すと、後の保存は「ほかの人が…」と今の題名を出して入力を残し、もう一度の保存で上書きできる', async ({
  browser,
}) => {
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
  const head = await openAs(browser, 'head', s);
  const admin = await openAs(browser, 'admin', s);
  try {
    const [id] = await insertNotices(s.yearId, [
      { audience: 'all_groups', title: 'E2E 衝突するお知らせ', body: '元の本文', createdBy: SEED_USER_IDS.head },
    ]);
    for (const p of [head, admin]) {
      await openNotices(p);
      await noticeItem(p, id).getByRole('button', { name: '「E2E 衝突するお知らせ」を編集' }).click();
      await expect(p.getByRole('dialog', { name: 'お知らせを編集' })).toBeVisible();
    }

    // 先に総務部門長が題名を変えて保存
    const hd = head.getByRole('dialog', { name: 'お知らせを編集' });
    await hd.getByLabel('題名', { exact: true }).fill('E2E 部門長が直した題名');
    await hd.getByRole('button', { name: '保存' }).click();
    await expect(head.getByText('「E2E 部門長が直した題名」を保存しました')).toBeVisible();
    await expect(hd).toHaveCount(0);

    // 後から管理者が本文を変えて保存 → 読み直して、今の題名と更新の日時を出す。入力は残し、ダイアログは開いたまま
    const ad = admin.getByRole('dialog', { name: 'お知らせを編集' });
    await ad.getByLabel('本文（任意）').fill('管理者が直した本文');
    await ad.getByRole('button', { name: '保存' }).click();
    const conflict = ad.getByTestId('notice-conflict');
    await expect(conflict).toContainText(
      'ほかの人がこのお知らせを先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）',
    );
    await expect(conflict).toContainText('今の題名：E2E 部門長が直した題名');
    await expect(conflict).toContainText(`更新：${await noticeTimeLabel(id, 'updated_at')}`);
    await expect(ad.getByLabel('題名', { exact: true })).toHaveValue('E2E 衝突するお知らせ');
    await expect(ad.getByLabel('本文（任意）')).toHaveValue('管理者が直した本文');
    // DB は総務部門長の保存のまま。管理者の一覧（ダイアログの後ろ）も読み直している
    expect((await noticesOf(s.yearId))[0]).toMatchObject({ title: 'E2E 部門長が直した題名', body: '元の本文', updated_by: SEED_USER_IDS.head });
    await expect(noticeItem(admin, id).getByTestId('notice-title')).toHaveText('E2E 部門長が直した題名');

    // もう一度「保存」：読み直した版で送り、管理者の入力で上書きする
    await ad.getByRole('button', { name: '保存' }).click();
    await expect(admin.getByText('「E2E 衝突するお知らせ」を保存しました')).toBeVisible();
    await expect(ad).toHaveCount(0);
    await expect(noticeItem(admin, id).getByTestId('notice-title')).toHaveText('E2E 衝突するお知らせ');
    expect(await bodyText(admin, id)).toBe('管理者が直した本文');
    expect((await noticesOf(s.yearId))[0]).toMatchObject({
      title: 'E2E 衝突するお知らせ',
      body: '管理者が直した本文',
      created_by: SEED_USER_IDS.head,
      updated_by: SEED_USER_IDS.admin,
    });
    // 総務部門長が開き直すと後の内容（書いた人は総務部門長のまま）
    await openNotices(head);
    await expect(noticeItem(head, id).getByTestId('notice-title')).toHaveText('E2E 衝突するお知らせ');
    await expect(noticeItem(head, id).getByTestId('notice-author')).toHaveText('テスト部門長');
    await expect(noticeItem(head, id).getByTestId('notice-updated')).toBeVisible();
  } finally {
    await head.context().close().catch(() => undefined);
    await admin.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

test('T17 削除：確かめてから削除すると一覧とダッシュボードの欄から消える。もう消えたお知らせを別のセッションで削除すると「すでに削除されていました」', async ({
  browser,
}) => {
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
  const head = await openAs(browser, 'head', s);
  const admin = await openAs(browser, 'admin', s);
  try {
    const [keep, del] = await insertNotices(s.yearId, [
      { audience: 'soumu', title: 'E2E 残すお知らせ', createdBy: SEED_USER_IDS.head },
      { audience: 'soumu', title: 'E2E 消すお知らせ', body: '消す本文', createdBy: SEED_USER_IDS.head },
    ]);
    // 管理者は、消す前の一覧で同じお知らせの削除の確かめを開いておく
    await openNotices(admin);
    await noticeItem(admin, del).getByRole('button', { name: '「E2E 消すお知らせ」を削除' }).click();
    const adminConfirm = admin.getByRole('alertdialog', { name: '「E2E 消すお知らせ」を削除しますか' });
    await expect(adminConfirm).toBeVisible();

    // 総務部門長：ダッシュボードの欄に2件 → 一覧で削除（「やめる」なら消さない）
    await openPortal(head, 'ダッシュボード');
    const widget = head.getByTestId('portal-soumu-notices');
    expect(await portalNoticeIds(widget)).toEqual([del, keep]);
    await openNotices(head);
    await noticeItem(head, del).getByRole('button', { name: '「E2E 消すお知らせ」を削除' }).click();
    const confirm = head.getByRole('alertdialog', { name: '「E2E 消すお知らせ」を削除しますか' });
    await expect(confirm).toContainText('宛先の人もこのお知らせを読めなくなります。元に戻せません。');
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(noticeItem(head, del)).toBeVisible();
    await noticeItem(head, del).getByRole('button', { name: '「E2E 消すお知らせ」を削除' }).click();
    await confirm.getByRole('button', { name: '削除する' }).click();
    await expect(head.getByText('「E2E 消すお知らせ」を削除しました')).toBeVisible();
    await expect(confirm).toHaveCount(0);
    await expect(noticeItem(head, del)).toHaveCount(0);
    await expect(noticeItem(head, keep)).toBeVisible();
    expect((await noticesOf(s.yearId)).map((n) => n.id)).toEqual([keep]);

    // ダッシュボードの欄からも消える（アプリの中で移る。書いた後に欄を読み直す）
    await head.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: 'ホーム' }).click();
    await expect(head.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    await expect.poll(() => portalNoticeIds(widget)).toEqual([keep]);

    // 管理者が開いていた確かめで「削除する」→ もうないので「すでに削除されていました」。一覧からも消える
    await adminConfirm.getByRole('button', { name: '削除する' }).click();
    await expect(admin.getByText('すでに削除されていました（ほかの人が削除した可能性があります）')).toBeVisible();
    await expect(adminConfirm).toHaveCount(0);
    await expect(noticeItem(admin, del)).toHaveCount(0);
    await expect(noticeItem(admin, keep)).toBeVisible();
  } finally {
    await head.context().close().catch(() => undefined);
    await admin.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- 終了した年度・宛先の団体が消えた

test('T17 終了した年度：一覧は読めるが「お知らせを書く」「編集」「削除」が出ず、総務には読み取り専用の帯。閲覧のみには帯も出ない', async ({ browser }) => {
  const s = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'small', roles: { head: true, viewer: true } });
  const head = await openAs(browser, 'head', s);
  const viewer = await openAs(browser, 'viewer', s);
  try {
    const [soumu, all] = await insertNotices(s.yearId, [
      { audience: 'soumu', title: 'E2E 終了した年度の連絡', createdBy: SEED_USER_IDS.head },
      { audience: 'all_groups', title: 'E2E 終了した年度の全団体あて', pinned: true, createdBy: SEED_USER_IDS.head },
    ]);
    await openNotices(head);
    await expect(head.getByTestId('read-only-notice')).toHaveText('終了した年度のため、お知らせは読むだけです');
    expect(await noticeIds(head)).toEqual([all, soumu]);
    await expect(head.getByRole('button', { name: 'お知らせを書く' })).toHaveCount(0);
    await expect(head.getByTestId('notices-list').getByRole('button')).toHaveCount(0);
    await expect(head.getByTestId('notices-filter')).toBeVisible();
    await expect(noticeItem(head, all).getByTestId('notice-author')).toHaveText('テスト部門長');

    await openNotices(viewer);
    expect(await noticeIds(viewer)).toEqual([all]);
    await expect(viewer.getByTestId('read-only-notice')).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'お知らせを書く' })).toHaveCount(0);
    await expect(viewer.getByTestId('notices-list').getByRole('button')).toHaveCount(0);
  } finally {
    await head.context().close().catch(() => undefined);
    await viewer.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

test('T17 宛先の団体が消えた指定の団体あて：団体を消すと、総務部門長と閲覧のみの一覧に「宛先の団体がありません」（お知らせは残る）', async ({ browser }) => {
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    roles: { head: true, viewer: true },
    extraGroups: [{ name: 'E2E臨時の団体', category: 'rest_area' }],
  });
  const head = await openAs(browser, 'head', s);
  const viewer = await openAs(browser, 'viewer', s);
  try {
    const gid = s.ids.groups['E2E臨時の団体']!;
    const [id, other] = await insertNotices(s.yearId, [
      { audience: 'groups', title: 'E2E 臨時の団体あて', groupIds: [gid], createdBy: SEED_USER_IDS.head },
      { audience: 'groups', title: 'E2E 模擬店1と臨時の団体あて', groupIds: [s.ids.groups[A]!, gid], createdBy: SEED_USER_IDS.head },
    ]);
    // 管理者が団体を消した（宛先の団体の行だけが消え、お知らせは残る）
    await sql('delete from public.groups where id = $1', [gid]);
    const rows = await noticesOf(s.yearId);
    expect(rows.map((n) => [n.id, n.group_ids])).toEqual([
      [id, []],
      [other, [s.ids.groups[A]]],
    ]);
    for (const p of [head, viewer]) {
      await openNotices(p);
      const groups = noticeItem(p, id).getByTestId('notice-groups');
      await expect(groups).toHaveText('宛先の団体がありません');
      await expect(groups).toHaveAttribute('data-empty', 'true');
      await expect(noticeItem(p, id).getByTestId('notice-audience')).toHaveText('指定の団体');
      await expect(noticeItem(p, other).getByTestId('notice-groups')).toHaveText(A);
    }
  } finally {
    await head.context().close().catch(() => undefined);
    await viewer.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- ダッシュボード（新着5件と欄の失敗）

test.describe('T17 ダッシュボード（総務部門員）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T17 ダッシュボード：「総務内のお知らせ」は新着5件（ピン留めが先）。お知らせの読み込みが通信で失敗すると、この欄にだけ失敗と「もう一度」が出て、ほかの欄は出る。もう一度で直る', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { staff: true } });
    const route = '**/rest/v1/notices*';
    try {
      // 古い順に総務内を6件（いちばん古いものをピン留め）と、全団体あてを1件（この欄には出ない）
      const ids = await insertNotices(s.yearId, [
        { audience: 'soumu', title: 'E2E 連絡1（ピン留め）', pinned: true, createdBy: SEED_USER_IDS.staff },
        { audience: 'soumu', title: 'E2E 連絡2', createdBy: SEED_USER_IDS.staff },
        { audience: 'soumu', title: 'E2E 連絡3', createdBy: SEED_USER_IDS.staff },
        { audience: 'soumu', title: 'E2E 連絡4', createdBy: SEED_USER_IDS.staff },
        { audience: 'soumu', title: 'E2E 連絡5', createdBy: SEED_USER_IDS.staff },
        { audience: 'soumu', title: 'E2E 連絡6', createdBy: SEED_USER_IDS.staff },
        { audience: 'all_groups', title: 'E2E 全団体あて', createdBy: SEED_USER_IDS.staff },
      ]);
      const [p1, , n3, n4, n5, n6] = ids;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openPortal(page, 'ダッシュボード');
      const widget = page.getByTestId('portal-soumu-notices');
      expect(await portalNoticeIds(widget)).toEqual([p1, n6, n5, n4, n3]);
      await expect(portalNotice(widget, p1)).toHaveAttribute('data-pinned', 'true');
      await expect(portalNotice(widget, p1)).toContainText('ピン留め');
      await expect(portalNotice(widget, n6)).toHaveAttribute('data-pinned', 'false');
      await expect(portalNotice(widget, n6)).not.toContainText('ピン留め');
      // 総務内のお知らせの欄には宛先の印を出さない
      await expect(portalNotice(widget, n6).getByText('総務内', { exact: true })).toHaveCount(0);
      await expect(portalNotice(widget, n6).locator('time')).toHaveText(await shortTimeLabel(n6));

      // 1件のリンクから一覧へ：そのお知らせが目立ち、絞り込みは「すべて」
      await portalNotice(widget, n4).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/notices/?\\?notice=${n4}$`));
      await expect(noticeItem(page, n4)).toHaveAttribute('data-highlighted', 'true');
      await expect(page.getByTestId('notices-filter').getByRole('radio', { name: 'すべて（7）' })).toHaveAttribute('aria-checked', 'true');
      // 欄の下の「お知らせ一覧へ」は総務内で絞った一覧
      await openPortal(page, 'ダッシュボード');
      await widget.getByTestId('portal-notices-link').click();
      await expect(page).toHaveURL(/\/notices\/?\?audience=soumu$/);
      await expect(page.getByTestId('notices-filter').getByRole('radio', { name: '総務内（6）' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('notice-item')).toHaveCount(6);

      // 欄の失敗：お知らせの読み取りを通信の失敗にする（supabase-js と TanStack Query の読み直しの後に出る）
      await page.route(route, (r) => r.abort());
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
      const error = widget.getByTestId('portal-module-error');
      await expect(error).toBeVisible({ timeout: 45_000 });
      await expect(error).toHaveAttribute('data-module', 'notices');
      await expect(error).toContainText('お知らせ：通信できませんでした。電波の良い所でもう一度');
      await expect(error.getByRole('button', { name: 'もう一度' })).toBeVisible();
      await expect(widget.getByTestId('portal-notices-link')).toBeVisible();
      await expect(widget.getByTestId('portal-notice')).toHaveCount(0);
      // ほかの欄（要対応・締切と予定・カード）は出たまま。失敗も読み込み中も出ない（欄の失敗の表示は1つだけ）
      for (const w of ['portal-todos', 'portal-dated', 'portal-cards']) {
        await expect(page.getByTestId(w)).toBeVisible();
        await expect(page.getByTestId(w).getByTestId('portal-module-error')).toHaveCount(0);
        await expect(page.getByTestId(w).getByTestId('portal-loading')).toHaveCount(0);
      }
      await expect(page.locator('[data-testid="module-card"][data-module="furniture"]')).toBeVisible();
      await expect(page.getByTestId('portal-module-error')).toHaveCount(1);
      await expect(page.getByTestId('portal-widget-error')).toHaveCount(0);

      // 通信が戻って「もう一度」を押すと出る
      await page.unroute(route);
      await error.getByRole('button', { name: 'もう一度' }).click();
      await expect.poll(() => portalNoticeIds(widget)).toEqual([p1, n6, n5, n4, n3]);
      await expect(page.getByTestId('portal-module-error')).toHaveCount(0);
    } finally {
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});
