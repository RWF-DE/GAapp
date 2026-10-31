// T17 お知らせ（/notices とダッシュボードの欄）のスクリーンショット（画面の設計 7.4。notes/T17.md の「後半のスクリーンショット」）。
// `pnpm e2e:shots --grep "T17 "` で notes/T17/ に撮る（CI では流さない）。年度をまたぐ表には書かない。
// お知らせは SQL で入れ（e2e/support/notices.ts）、撮るときだけ出した日時・直した日時をこの数日の間にばらけさせる（backdateNotices）。
// 「最新でない年度」の帯を出さないよう、撮るときだけシナリオの年度の1日目を今日より後に動かす（festivalIn。T16 の撮影と同じ）。
// 撮影は1つずつ流れ（shots のプロジェクトは workers 1）、年度は pinYear で開くので、ほかのテストの既定の年度は変わらない
// （並行の E2E〔e2e/t17-notices.spec.ts〕では動かさない。D-36）。幅 390px のものは撮るときに scrollWidth ≤ 390 を確かめる。
// 団体は合成データ r8like の名前、書いた人は seed の表示名（個人名は入れない）。年度は撮り終えたら消す。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import { createScenario, sql, type Scenario } from '../support/db';
import {
  backdateNotices,
  insertNotices,
  noticeIds,
  noticeItem,
  openNotices,
  openPortal,
  portalNoticeIds,
} from '../support/notices';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

/** 撮るときだけ、1日目を今日（Asia/Tokyo）から days 日後にする */
async function festivalIn(s: Scenario, days: number): Promise<void> {
  await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + $2::int where id = $1`, [s.yearId, days]);
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

/** その利用者がシナリオの年度を開くページ（別のブラウザのコンテキスト） */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

const H = SEED_USER_IDS.head;
const S = SEED_USER_IDS.staff;
const AD = SEED_USER_IDS.admin;

/** 臨時の団体（宛先に入れた後に消し、「宛先の団体がありません」を出す） */
const TEMP_GROUP = '臨時出店（雨天）';

test.describe('T17 一覧とダッシュボードの欄', () => {
  test('T17 お知らせ一覧（総務部門長・総務部門員・店長・閲覧のみ。PC とスマホ）とダッシュボードの欄（総務部門長・店長・閲覧のみ）', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const s = await createScenario({
      status: 'requesting',
      dataset: 'synthetic',
      roles: { admin: true, head: true, staff: true, viewer: true },
      repGroup: '模擬店01',
      extraGroups: [{ name: TEMP_GROUP, category: 'stall' }],
    });
    const pages: Page[] = [];
    try {
      await festivalIn(s, 14);
      const g = s.ids.groups;
      // 古い順に入れる（総務内6件〔ピン留め1〕・全団体あて2件〔ピン留め1〕・指定の団体あて3件）
      const ids = await insertNotices(s.yearId, [
        {
          audience: 'soumu',
          title: '倉庫Bの鍵の受け渡し',
          body: '倉庫Bの鍵は、前日の17時に総務の部屋で受け渡します。\n受け取ったら、鍵の貸し出し表に書いてください。',
          createdBy: S,
        },
        {
          audience: 'all_groups',
          title: '搬入日の集合と机・椅子の受け取り',
          body:
            '搬入日は 8:30 に各団体の代表が体育館の前に集合してください。\n\n・机と椅子は、申請した数を保管場所の前で受け取ります\n・キャスター机は数に限りがあります（交換の依頼が来た団体は「自団体の振り分け」で答えてください）',
          pinned: true,
          createdBy: H,
        },
        { audience: 'soumu', title: '当日の総務の集合時間', body: '1日目は 7:30、2日目は 8:00 に総務の部屋に集合です。', pinned: true, createdBy: H },
        {
          audience: 'groups',
          title: '模擬店の電源の申請について',
          body: '電源を使う模擬店は、前々日までに申請してください。\n・延長コードは各団体で用意してください\n・1口 1500W までです',
          createdBy: H,
          groupIds: [g['模擬店01']!, g['模擬店02']!, g['模擬店03']!],
        },
        { audience: 'soumu', title: '机椅子の振り分けの確認会', body: '振り分けの確認会は、締切の次の日の放課後に行います。', createdBy: AD },
        { audience: 'groups', title: '臨時出店の場所の変更', body: '雨天のため、出店の場所を変更します。', createdBy: H, groupIds: [g[TEMP_GROUP]!] },
        {
          audience: 'groups',
          title: '試食の提供の届け出',
          body: '試食を出す団体は、当日の朝に本部へ届け出てください。',
          createdBy: H,
          groupIds: [g['模擬店05']!, g['模擬店06']!],
        },
        { audience: 'soumu', title: 'ゴミの分別表の印刷', body: '分別表を 60 部印刷して、各団体の机に置きます。', createdBy: S },
        { audience: 'all_groups', title: '落とし物の届け先', body: '落とし物は本部（第一体育館）で預かります。', createdBy: AD },
        { audience: 'soumu', title: '受付の机の配置', body: '受付の机は 2 台、昇降口の右側に置きます。', createdBy: H },
        { audience: 'soumu', title: '無線機の貸し出し', body: '無線機は 8 台です。使い終わったら充電器に戻してください。', createdBy: AD },
      ]);
      const [s1, g1, s2, g2, s3, g4, g5, s4, g3, s5, s6] = ids;
      // 出した日時をこの3日ほどの間に。電源の申請は後で直した（「（… に更新）」）
      const ago = [4300, 4100, 3500, 3000, 2600, 2200, 1700, 1300, 900, 420, 75];
      await backdateNotices(ids.map((id, k) => ({ id, createdMinutesAgo: ago[k]!, updatedMinutesAgo: id === g2 ? 700 : ago[k]! })));
      // 臨時の団体を消した（宛先の団体の行だけが消え、お知らせは残る）
      await sql('delete from public.groups where id = $1', [g[TEMP_GROUP]]);

      // 総務部門長：ピン留め（当日の集合・搬入日）→ 新しい順。3つの宛先・宛先の団体の名前・「宛先の団体がありません」・書いた人・更新
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openNotices(head);
      expect(await noticeIds(head)).toEqual([s2, g1, s6, s5, g3, s4, g5, g4, s3, g2, s1]);
      await expect(noticeItem(head, g4).getByTestId('notice-groups')).toHaveAttribute('data-empty', 'true');
      await expect(noticeItem(head, g2).getByTestId('notice-updated')).toBeVisible();
      await shoot(head, 'T17', 'notices-head-pc', { fullPage: true });
      await head.setViewportSize(MOBILE);
      await openNotices(head);
      await expectNoOverflow(head);
      await shoot(head, 'T17', 'notices-head-mobile', { fullPage: true });

      // 総務部門長のダッシュボード：「総務内のお知らせ」（ピン留めが先の5件。6件目〔倉庫Bの鍵〕は出ない）
      await head.setViewportSize(PC);
      await openPortal(head, 'ダッシュボード');
      expect(await portalNoticeIds(head.getByTestId('portal-soumu-notices'))).toEqual([s2, s6, s5, s4, s3]);
      await shoot(head, 'T17', 'portal-notices-head-pc', { fullPage: true });

      // 総務部門員：自分の総務内（倉庫Bの鍵・ゴミの分別表）にだけ「編集」「削除」
      const staff = await openAs(browser, 'staff', s);
      pages.push(staff);
      await openNotices(staff);
      await expect(staff.getByTestId('notices-list').getByRole('button', { name: /を編集$/ })).toHaveCount(2);
      await expect(staff.getByTestId('notices-list').getByRole('button', { name: /を削除$/ })).toHaveCount(2);
      await expect(noticeItem(staff, s1).getByRole('button')).toHaveText(['編集', '削除']);
      await shoot(staff, 'T17', 'notices-staff-pc', { fullPage: true });
      await staff.setViewportSize(MOBILE);
      await openNotices(staff);
      await expectNoOverflow(staff);
      await shoot(staff, 'T17', 'notices-staff-mobile', { fullPage: true });

      // 店長（模擬店01）：全団体あてと自団体あて（電源の申請の宛先の団体は「模擬店01」だけ）。書いた人・操作・絞り込みなし
      const rep = await openAs(browser, 'rep', s);
      pages.push(rep);
      await openNotices(rep);
      expect(await noticeIds(rep)).toEqual([g1, g3, g2]);
      await expect(noticeItem(rep, g2).getByTestId('notice-groups')).toHaveText('模擬店01');
      await shoot(rep, 'T17', 'notices-rep-pc', { fullPage: true });
      await rep.setViewportSize(MOBILE);
      await openNotices(rep);
      await expectNoOverflow(rep);
      await shoot(rep, 'T17', 'notices-rep-mobile', { fullPage: true });
      // 店長のホーム（スマホ）：「お知らせ」の欄
      await openPortal(rep, 'ホーム');
      expect(await portalNoticeIds(rep.getByTestId('portal-notices'))).toEqual([g1, g3, g2]);
      await expectNoOverflow(rep);
      await shoot(rep, 'T17', 'portal-notices-rep-mobile', { fullPage: true });

      // 閲覧のみ：団体あて（宛先の団体は全部。臨時の団体あては「宛先の団体がありません」）
      const viewer = await openAs(browser, 'viewer', s);
      pages.push(viewer);
      await openNotices(viewer);
      expect(await noticeIds(viewer)).toEqual([g1, g3, g5, g4, g2]);
      await expect(noticeItem(viewer, g2).getByTestId('notice-groups')).toHaveText('模擬店01・模擬店02・模擬店03');
      await shoot(viewer, 'T17', 'notices-viewer-pc', { fullPage: true });
      // 閲覧のみのホーム（PC）：「お知らせ」の欄
      await openPortal(viewer, 'ホーム');
      expect(await portalNoticeIds(viewer.getByTestId('portal-notices'))).toEqual([g1, g3, g5, g4, g2]);
      await shoot(viewer, 'T17', 'portal-notices-viewer-pc', { fullPage: true });
      await viewer.setViewportSize(MOBILE);
      await openNotices(viewer);
      await expectNoOverflow(viewer);
      await shoot(viewer, 'T17', 'notices-viewer-mobile', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

test.describe('T17 書く・編集のダイアログ', () => {
  test('T17 お知らせを書くダイアログ（部門長以上：指定の団体・宛先の団体の一覧・ピン留め。PC とスマホ）と、総務部門員のダイアログ（総務内だけ）', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { head: true, staff: true } });
    const pages: Page[] = [];
    try {
      await festivalIn(s, 14);
      // 部門長以上：指定の団体を選び、宛先の団体を3つ選んで、ピン留めする
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openNotices(head);
      await head.getByRole('button', { name: 'お知らせを書く' }).click();
      const dialog = head.getByRole('dialog', { name: 'お知らせを書く' });
      await dialog.getByRole('radio', { name: '指定の団体' }).click();
      const picker = dialog.getByTestId('notice-group-picker');
      for (const name of ['模擬店01', '模擬店02', '部門01']) await picker.getByRole('checkbox', { name, exact: true }).click();
      await expect(picker.getByTestId('notice-group-count')).toHaveText('3 団体を選んでいます');
      await dialog.getByLabel('題名', { exact: true }).fill('電源の申請の締切');
      await dialog
        .getByLabel('本文（任意）')
        .fill('電源を使う団体は、前々日までに申請してください。\n・延長コードは各団体で用意してください\n・1口 1500W までです');
      await dialog.getByRole('switch', { name: 'ピン留めする' }).click();
      await expect(dialog.getByRole('switch', { name: 'ピン留めする' })).toBeChecked();
      // 宛先の団体の一覧は先頭（選んだ模擬店01・02）を、ダイアログの中身は上（宛先）から見せる
      const first = picker.getByRole('checkbox', { name: '模擬店01', exact: true });
      await first.scrollIntoViewIfNeeded();
      await dialog.getByTestId('notice-form').evaluate((el) => el.scrollTo({ top: 0 }));
      await shoot(head, 'T17', 'notice-compose-lead-pc');

      // 同じダイアログをスマホで（宛先の団体のチェックの一覧を見える所に）
      await head.setViewportSize(MOBILE);
      await first.scrollIntoViewIfNeeded();
      await expect(picker).toBeVisible();
      await expectNoOverflow(head);
      await shoot(head, 'T17', 'notice-compose-lead-mobile');

      // 総務部門員：宛先は総務内だけ（選ぶ欄がない）、ピン留めの欄がない
      const staff = await openAs(browser, 'staff', s);
      pages.push(staff);
      await openNotices(staff);
      await staff.getByRole('button', { name: 'お知らせを書く' }).click();
      const staffDialog = staff.getByRole('dialog', { name: 'お知らせを書く' });
      await expect(staffDialog.getByTestId('notice-audience-fixed')).toBeVisible();
      await staffDialog.getByLabel('題名', { exact: true }).fill('倉庫Bの鍵の受け渡し');
      await staffDialog.getByLabel('本文（任意）').fill('倉庫Bの鍵は、前日の17時に総務の部屋で受け渡します。\n受け取ったら、鍵の貸し出し表に書いてください。');
      await shoot(staff, 'T17', 'notice-compose-staff-pc');
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

test.describe('T17 編集の衝突と終了した年度', () => {
  test('T17 編集の衝突の知らせ（管理者のダイアログ。入力を残し、今の題名と更新の日時）と、終了した年度の一覧（帯と、操作なし）', async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
    const closed = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'small', roles: { head: true } });
    const pages: Page[] = [];
    try {
      await festivalIn(s, 14);
      const [id] = await insertNotices(s.yearId, [
        { audience: 'all_groups', title: '搬入日の集合', body: '搬入日は 8:30 に体育館の前に集合してください。', createdBy: H },
      ]);
      await backdateNotices([{ id, createdMinutesAgo: 600 }]);
      const head = await openAs(browser, 'head', s);
      const admin = await openAs(browser, 'admin', s);
      pages.push(head, admin);
      for (const p of [head, admin]) {
        await openNotices(p);
        await noticeItem(p, id).getByRole('button', { name: '「搬入日の集合」を編集' }).click();
      }
      const hd = head.getByRole('dialog', { name: 'お知らせを編集' });
      await hd.getByLabel('題名', { exact: true }).fill('搬入日の集合（時間を変更）');
      await hd.getByLabel('本文（任意）').fill('搬入日は 8:00 に体育館の前に集合してください。');
      await hd.getByRole('button', { name: '保存' }).click();
      await expect(hd).toHaveCount(0);
      const ad = admin.getByRole('dialog', { name: 'お知らせを編集' });
      await ad.getByLabel('本文（任意）').fill('搬入日は 8:30 に体育館の前に集合してください。\n雨のときは昇降口に集合です。');
      await ad.getByRole('button', { name: '保存' }).click();
      await expect(ad.getByTestId('notice-conflict')).toBeVisible();
      await expect(ad.getByTestId('notice-conflict')).toContainText('今の題名：搬入日の集合（時間を変更）');
      await shoot(admin, 'T17', 'notice-conflict-pc');

      // 終了した年度（総務部門長）：読み取り専用の帯、「お知らせを書く」「編集」「削除」なし。終了した年度はふつう前の年度なので、
      // 1日目は動かさない（「最新でない年度」の帯も出る）
      const [c1, c2, c3] = await insertNotices(closed.yearId, [
        { audience: 'soumu', title: '片付けの分担', body: '片付けは各係で分担します。', createdBy: H },
        { audience: 'all_groups', title: '机と椅子の返却', body: '使った机と椅子は、受け取った保管場所に返してください。', pinned: true, createdBy: H },
        { audience: 'all_groups', title: 'ご協力ありがとうございました', createdBy: AD },
      ]);
      await backdateNotices([
        { id: c1, createdMinutesAgo: 2000 },
        { id: c2, createdMinutesAgo: 1500 },
        { id: c3, createdMinutesAgo: 300 },
      ]);
      const closedHead = await openAs(browser, 'head', closed);
      pages.push(closedHead);
      await openNotices(closedHead);
      await expect(closedHead.getByTestId('read-only-notice')).toHaveText('終了した年度のため、お知らせは読むだけです');
      await expect(closedHead.getByTestId('notices-list').getByRole('button')).toHaveCount(0);
      await shoot(closedHead, 'T17', 'notices-closed-pc', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
      await closed.cleanup();
    }
  });
});
