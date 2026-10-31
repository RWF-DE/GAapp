// T18 締切と予定（/calendar とダッシュボードの「締切と予定」）のスクリーンショット（画面の設計 7.4。notes/T18.md の「後半の
// スクリーンショット」）。`pnpm e2e:shots --grep "T18 "` で notes/T18/ に撮る（CI では流さない）。年度をまたぐ表には書かない。
// 項目は SQL で入れる（e2e/support/calendar.ts）。日付は撮る日の Asia/Tokyo の今日からの日数で決める。
// 「最新でない年度」の帯を出さず、祭の日・受付開始・申請の締切を今日のまわりに並べるため、撮るときだけシナリオの年度の1日目と受付期間を
// 動かす（schedule。T16・T17 の撮影と同じ考え）。1日目は今日の 35 日後（ダッシュボードの「これからの 30 日」の外。一覧には出る）、
// 受付開始は 10 日前、申請の締切は 6 日後の 17:00。撮影は1つずつ流れ（shots のプロジェクトは workers 1）、年度は pinYear で開くので、
// ほかのテストの既定の年度は変わらない（並行の E2E〔e2e/t18-calendar.spec.ts〕では動かさない。D-36）。
// 終了した年度はふつう前の年度なので動かさない（帯も出る形を撮る）。幅 390px のものは撮るときに scrollWidth ≤ 390 を確かめる。
// 書いた人は seed の利用者（画面には出さない）。年度は撮り終えたら消す。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import {
  addDays,
  calendarItem,
  calendarItemIds,
  eventDataId,
  insertEvents,
  openCalendar,
  portalDatedIds,
  tokyoToday,
} from '../support/calendar';
import { createScenario, sql, type Scenario } from '../support/db';
import { SMALL } from '../support/datasets';
import { openPortal } from '../support/notices';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const H = SEED_USER_IDS.head;
const AD = SEED_USER_IDS.admin;

/** 撮るときだけ、1日目を今日（Asia/Tokyo）の 35 日後に、受付開始を 10 日前に、申請の締切を 6 日後の 17:00 にする */
async function schedule(s: Scenario): Promise<void> {
  await sql(
    `update public.years
        set festival_start = (now() at time zone 'Asia/Tokyo')::date + 35,
            request_open_at = now() - interval '10 days',
            request_close_at = (((now() at time zone 'Asia/Tokyo')::date + 6)::timestamp + time '17:00') at time zone 'Asia/Tokyo'
      where id = $1`,
    [s.yearId],
  );
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

/**
 * その利用者がシナリオの年度を開くページ（別のブラウザのコンテキスト）。日付・日時の入力欄の見た目はブラウザ（Chromium）の言語で
 * 決まり、E2E の Chromium は英語（LANG が C.UTF-8）なので「11/04/2026, 01:00 PM」の形で写る（使う人の日本語の端末では「2026/11/04 13:00」）。
 * アプリの文と日時の表示はブラウザの言語・タイムゾーンによらない
 */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 一覧を開き、機能の日付まで並ぶのを待つ（n 件） */
async function openList(page: Page, n: number, query = ''): Promise<void> {
  await openCalendar(page, query);
  await expect.poll(() => calendarItemIds(page)).toHaveLength(n);
}

test.describe('T18 一覧とダッシュボードの欄', () => {
  test('T18 締切と予定の一覧（総務部門長・総務部門員・閲覧のみ・店長。PC とスマホ）、過去も表示、ダッシュボードの締切と予定（総務部門長・店長）と読み取りの失敗', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { admin: true, head: true, staff: true, viewer: true },
      repGroup: SMALL.groups.stall,
    });
    const pages: Page[] = [];
    try {
      await schedule(s);
      const today = tokyoToday();
      const d = (n: number) => addDays(today, n);
      const ids = await insertEvents(s.yearId, [
        { kind: 'deadline', audience: 'soumu', title: '備品の貸し出し表の提出', start: `${d(-3)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'all', title: '団体代表の説明会', allDay: true, date: d(-1), note: '第一体育館で 16:30 から', createdBy: H },
        {
          kind: 'event',
          audience: 'soumu',
          title: '総務の定例会',
          start: `${d(0)}T16:00`,
          end: `${d(0)}T17:30`,
          note: '会議室A\n議題：机・椅子の配置図の確認',
          createdBy: H,
        },
        { kind: 'deadline', audience: 'groups', title: '電源の申請の締切', allDay: true, date: d(1), note: '延長コードは各団体で用意してください', createdBy: H },
        { kind: 'event', audience: 'soumu', title: '机・椅子の数の確認', start: `${d(3)}T13:00`, end: `${d(3)}T15:00`, note: '体育館の倉庫と第一棟の倉庫', createdBy: AD },
        {
          kind: 'event',
          audience: 'all',
          title: '看板の搬入',
          allDay: true,
          date: d(8),
          endDate: d(9),
          note: '搬入口は体育館の裏です。\n台車は本部で貸し出します。',
          createdBy: H,
        },
        { kind: 'deadline', audience: 'all', title: '試食の提供の届け出', start: `${d(10)}T09:00`, end: `${d(12)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'soumu', title: '総務の準備日', allDay: true, date: d(16), createdBy: AD },
        { kind: 'event', audience: 'all', title: '片付けの報告会', start: `${d(45)}T16:00`, createdBy: H },
      ]);
      const [overdue, , regular, power, , , tasting, , wrapUp] = ids;

      // 総務部門長：今日から（過ぎた締切・昨日・受付開始は出ない）。今日・明日…と、机椅子の申請の締切・祭の日（35 日後〜）、45 日後。
      // 対象の印・絞り込み・「締切・予定を登録」・操作
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      // 項目 7 件（今日から）と、申請の締切・祭の日 4 日
      await openList(head, 12);
      await expect(calendarItem(head, eventDataId(regular))).toBeVisible();
      await expect(calendarItem(head, eventDataId(tasting)).getByTestId('calendar-item-relative')).toHaveText('あと 12 日');
      await expect(calendarItem(head, eventDataId(overdue))).toHaveCount(0);
      await shoot(head, 'T18', 'calendar-head-pc', { fullPage: true });
      await head.setViewportSize(MOBILE);
      await openList(head, 12);
      await expectNoOverflow(head);
      await shoot(head, 'T18', 'calendar-head-mobile', { fullPage: true });
      await head.setViewportSize(PC);

      // 過去も表示：受付開始（10 日前）・過ぎた締切（3 日前。「締切を過ぎました」）・昨日の説明会（1 日前）から
      await openList(head, 15, '?past=1');
      await expect(calendarItem(head, eventDataId(overdue)).getByTestId('calendar-item-relative')).toHaveText('締切を過ぎました');
      await shoot(head, 'T18', 'calendar-past-head-pc', { fullPage: true });

      // ダッシュボード（総務部門長）：これからの 30 日（7 件）と過ぎた締切の 8 件。祭の日（35 日後〜）と 45 日後は出ない
      await openPortal(head, 'ダッシュボード');
      await expect.poll(() => portalDatedIds(head)).toHaveLength(8);
      expect((await portalDatedIds(head))[0]).toBe(eventDataId(overdue));
      await expect(head.getByTestId('portal-dated-more')).toHaveCount(0);
      await shoot(head, 'T18', 'portal-dated-head-pc', { fullPage: true });

      // 予定と締切の読み取りの失敗：締切と予定の欄にだけ「締切と予定：…」と「もう一度」。机椅子の申請の締切は出たまま
      const route = '**/rest/v1/events*';
      await head.route(route, (r) => r.abort());
      await head.goto('/');
      await expect(head.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
      await expect(head.getByTestId('portal-dated').getByTestId('portal-module-error')).toBeVisible({ timeout: 45_000 });
      await expect.poll(() => portalDatedIds(head)).toEqual(['furniture:request-close']);
      await shoot(head, 'T18', 'portal-dated-error-pc', { fullPage: true });
      await head.unroute(route);

      // 総務部門員：対象の印と絞り込みはあり、操作なし
      const staff = await openAs(browser, 'staff', s);
      pages.push(staff);
      await openList(staff, 12);
      await expect(staff.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
      await shoot(staff, 'T18', 'calendar-staff-pc', { fullPage: true });
      await staff.setViewportSize(MOBILE);
      await openList(staff, 12);
      await expectNoOverflow(staff);
      await shoot(staff, 'T18', 'calendar-staff-mobile', { fullPage: true });

      // 閲覧のみ：団体・全員の項目だけ（今日からは電源の申請・看板の搬入・試食の届け出・片付けの報告会と、機能の日付 5 件）
      const viewer = await openAs(browser, 'viewer', s);
      pages.push(viewer);
      await openList(viewer, 9);
      await expect(calendarItem(viewer, eventDataId(power))).toBeVisible();
      await expect(calendarItem(viewer, eventDataId(regular))).toHaveCount(0);
      await expect(viewer.getByTestId('calendar-item-audience')).toHaveCount(0);
      await shoot(viewer, 'T18', 'calendar-viewer-pc', { fullPage: true });
      await viewer.setViewportSize(MOBILE);
      await openList(viewer, 9);
      await expectNoOverflow(viewer);
      await shoot(viewer, 'T18', 'calendar-viewer-mobile', { fullPage: true });

      // 店長：同じ項目（申請の締切は申請へのリンク）
      const rep = await openAs(browser, 'rep', s);
      pages.push(rep);
      await openList(rep, 9);
      await expect(calendarItem(rep, eventDataId(wrapUp))).toBeVisible();
      await shoot(rep, 'T18', 'calendar-rep-pc', { fullPage: true });
      await rep.setViewportSize(MOBILE);
      await openList(rep, 9);
      await expectNoOverflow(rep);
      await shoot(rep, 'T18', 'calendar-rep-mobile', { fullPage: true });
      // 店長のホーム（スマホ）：締切と予定は団体・全員と申請の締切（これからの 30 日の 4 件）
      await openPortal(rep, 'ホーム');
      await expect.poll(() => portalDatedIds(rep)).toHaveLength(4);
      await expectNoOverflow(rep);
      await shoot(rep, 'T18', 'portal-dated-rep-mobile', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

test.describe('T18 登録・編集のダイアログと衝突', () => {
  test('T18 登録のダイアログ（終日・最後の日・対象の説明。PC）、編集のダイアログ（時刻つき・メモ。スマホ）、編集の衝突の知らせ（入力を残し、今の題名と更新の日時。PC）', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
    const pages: Page[] = [];
    try {
      await schedule(s);
      const today = tokyoToday();
      const [meeting] = await insertEvents(s.yearId, [
        {
          kind: 'event',
          audience: 'soumu',
          title: '机・椅子の数の確認',
          start: `${addDays(today, 3)}T13:00`,
          end: `${addDays(today, 3)}T15:00`,
          note: '体育館の倉庫と第一棟の倉庫\n数え終わったら在庫入力に入れる',
          createdBy: H,
        },
      ]);

      // 登録のダイアログ（PC）：全員あての終日の予定（2日間）。対象ごとの読む人の説明
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openList(head, 6);
      await head.getByRole('button', { name: '締切・予定を登録' }).click();
      const dialog = head.getByRole('dialog', { name: '締切・予定を登録' });
      await dialog.getByRole('radio', { name: '全員', exact: true }).click();
      await dialog.getByLabel('題名', { exact: true }).fill('看板の搬入');
      await dialog.getByRole('checkbox', { name: '終日' }).click();
      await dialog.getByLabel('日付', { exact: true }).fill(addDays(today, 8));
      await dialog.getByLabel('最後の日（任意。2日以上のとき）').fill(addDays(today, 9));
      await dialog.getByLabel('メモ（任意）').fill('搬入口は体育館の裏です。\n台車は本部で貸し出します。');
      await dialog.getByTestId('event-form').evaluate((el) => el.scrollTo({ top: 0 }));
      await shoot(head, 'T18', 'event-dialog-allday-pc');
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await head.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();
      await expect(dialog).toHaveCount(0);

      // 編集のダイアログ（スマホ）：時刻つきの予定とメモ
      await head.setViewportSize(MOBILE);
      await openList(head, 6);
      await calendarItem(head, eventDataId(meeting)).getByRole('button', { name: '「机・椅子の数の確認」を編集' }).click();
      const edit = head.getByRole('dialog', { name: '締切・予定を編集' });
      await expect(edit.getByLabel('開始', { exact: true })).toHaveValue(`${addDays(today, 3)}T13:00`);
      await expectNoOverflow(head);
      await shoot(head, 'T18', 'event-dialog-timed-mobile');
      await edit.getByRole('button', { name: 'やめる' }).click();
      await expect(edit).toHaveCount(0);
      await head.setViewportSize(PC);

      // 編集の衝突（管理者のダイアログ）：管理者が開いた後に、部門長が題名と開始を変えて保存した
      const admin = await openAs(browser, 'admin', s);
      pages.push(admin);
      await openList(admin, 6);
      await calendarItem(admin, eventDataId(meeting)).getByRole('button', { name: '「机・椅子の数の確認」を編集' }).click();
      const ad = admin.getByRole('dialog', { name: '締切・予定を編集' });
      await expect(ad).toBeVisible();
      await openList(head, 6);
      await calendarItem(head, eventDataId(meeting)).getByRole('button', { name: '「机・椅子の数の確認」を編集' }).click();
      const hd = head.getByRole('dialog', { name: '締切・予定を編集' });
      await hd.getByLabel('題名', { exact: true }).fill('机・椅子の数の確認（時間を変更）');
      await hd.getByLabel('開始', { exact: true }).fill(`${addDays(today, 3)}T14:00`);
      await hd.getByRole('button', { name: '保存', exact: true }).click();
      await expect(hd).toHaveCount(0);
      await ad.getByLabel('メモ（任意）').fill('体育館の倉庫と第一棟の倉庫\n数え終わったら在庫入力に入れる\n雨のときは昇降口に集合');
      await ad.getByRole('button', { name: '保存', exact: true }).click();
      await expect(ad.getByTestId('event-conflict')).toContainText('今の題名：机・椅子の数の確認（時間を変更）');
      await shoot(admin, 'T18', 'event-conflict-pc');
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

test.describe('T18 終了した年度', () => {
  test('T18 終了した年度の一覧（総務部門長。帯と、操作なし）', async ({ browser }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'small', roles: { head: true } });
    const pages: Page[] = [];
    try {
      const today = tokyoToday();
      await insertEvents(s.yearId, [
        { kind: 'deadline', audience: 'soumu', title: '片付けの報告の締切', start: `${addDays(today, 3)}T17:00`, note: '各係の報告を総務の共有フォルダに', createdBy: H },
        { kind: 'event', audience: 'all', title: '机と椅子の返却', allDay: true, date: addDays(today, 4), createdBy: H },
        { kind: 'event', audience: 'soumu', title: '来年度への引き継ぎ会', start: `${addDays(today, 10)}T16:30`, end: `${addDays(today, 10)}T18:00`, createdBy: H },
      ]);
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openList(head, 3);
      await expect(head.getByTestId('calendar-closed')).toBeVisible();
      await expect(head.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
      await shoot(head, 'T18', 'calendar-closed-head-pc', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});
