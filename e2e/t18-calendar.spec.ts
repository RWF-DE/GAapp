import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import {
  addDays,
  calendarDates,
  calendarDay,
  calendarItem,
  calendarItemIds,
  datedWidget,
  dayHeading,
  daysFrom,
  eventDataId,
  eventsOf,
  eventUpdatedLabel,
  insertEvents,
  noteText,
  openCalendar,
  portalDatedIds,
  portalDatedItem,
  relativeDays,
  requestCloseOf,
  shortDate,
  tokyoToday,
} from './support/calendar';
import { createScenario, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import { openPortal } from './support/notices';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T18 締切と予定（/calendar とダッシュボードの「締切と予定」。04「締切と予定」「ダッシュボード」、D-54、notes/T18.md の
// 「後半のテストの計画」の E2E の 1〜8 と (B1)）。シナリオの年度（small。1日目は 2001 年。受付開始は昨日、申請の締切は今＋30 日）で
// 閉じる。項目は画面から登録するほか、e2e/support/calendar.ts で SQL から入れる（書いた人を入れる。年度をまたぐ表には書かない）。
// 日付はテストの時計の Asia/Tokyo の今日からの日数で決め、期待値の曜日・日の見出し・相対の言い方も同じ今日から作る。
// 団体は A＝E2E模擬店1（seed の店長が代表する団体）。期待値の文言は 04 の「締切と予定」のとおりに書く（アプリの定数から引かない）。

const A = SMALL.groups.stall;
const H = SEED_USER_IDS.head;

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ（PC） */
async function openAs(browser: Browser, user: StoredUser, s: Scenario): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport: PC });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

const thisYear = (today: string) => Number(today.slice(0, 4));

// ---------------------------------------------------------------- 総務部門長：登録と、一覧・ダッシュボードの出し方

test.describe('T18 総務部門長', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T18 総務部門長：終日の締切（明日・全員）と時刻つきの予定（あと 3 日の 13:00〜15:00・総務。メモつき）を登録できる。一覧は日ごとに曜日と相対の言い方、時刻・種類・対象の印と「編集」「削除」、机椅子の申請の締切（「机椅子」の印と申請一覧へのリンク）。何も変えない編集は送らない。ダッシュボードの締切と予定にも曜日と相対の言い方で出て、1件から一覧のその項目へ', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true } });
    try {
      const today = tokyoToday();
      const year = thisYear(today);
      const tomorrow = addDays(today, 1);
      const in3 = addDays(today, 3);
      const close = await requestCloseOf(s.yearId);
      const closeRelative = relativeDays(daysFrom(today, close.date));
      await pinYear(page, H, s.yearId);
      await openCalendar(page);

      // 項目のない年度：机椅子の申請の締切だけ（受付開始は昨日、祭の日は 2001 年なので、既定の「今日から」には出ない）
      await expect.poll(() => calendarItemIds(page)).toEqual(['furniture:request-close']);
      const closeItem = calendarItem(page, 'furniture:request-close');
      await expect(closeItem).toHaveAttribute('data-kind', 'deadline');
      await expect(closeItem).toHaveAttribute('data-module', 'furniture');
      await expect(closeItem.getByTestId('calendar-item-time')).toHaveText(close.time);
      await expect(closeItem.getByTestId('calendar-item-kind')).toHaveText('締切');
      await expect(closeItem.getByTestId('calendar-item-module')).toHaveText('机椅子');
      await expect(closeItem.getByTestId('calendar-item-audience')).toHaveCount(0);
      // 期限の日と日の見出しの相対の言い方が同じなので、1件には相対の言い方を出さない
      await expect(closeItem.getByTestId('calendar-item-relative')).toHaveCount(0);
      await expect(closeItem.getByRole('link', { name: '机椅子の申請の締切' })).toHaveAttribute('href', /\/requests\/?$/);
      await expect(closeItem.getByRole('button')).toHaveCount(0);
      await expect(calendarDay(page, close.date).getByTestId('calendar-day-heading')).toHaveText(dayHeading(close.date, year));
      await expect(calendarDay(page, close.date).getByTestId('calendar-day-relative')).toHaveText(closeRelative);
      // 総務部門長には絞り込み・「過去も表示」と「締切・予定を登録」。帯はない
      await expect(page.getByTestId('calendar-kind-filter')).toBeVisible();
      await expect(page.getByTestId('calendar-audience-filter')).toBeVisible();
      await expect(page.getByRole('checkbox', { name: '過去も表示' })).not.toBeChecked();
      await expect(page.getByTestId('calendar-closed')).toHaveCount(0);

      // 登録のダイアログ：既定は種類「予定」・対象「総務」・終日なし。対象ごとの読む人の説明
      await page.getByRole('button', { name: '締切・予定を登録' }).click();
      const dialog = page.getByRole('dialog', { name: '締切・予定を登録' });
      await expect(dialog.getByText('対象の人は、締切と予定の一覧とダッシュボードで見られます。')).toBeVisible();
      await expect(dialog.getByRole('radio', { name: '予定', exact: true })).toBeChecked();
      await expect(dialog.getByRole('radio', { name: '総務', exact: true })).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: '終日' })).not.toBeChecked();
      await expect(dialog.getByText('総務だけが見ます')).toBeVisible();
      await expect(dialog.getByText('団体の店長・副店長に向けた項目です。総務と閲覧のみの人も見ます')).toBeVisible();
      await expect(dialog.getByText('全員に向けた項目です。総務・閲覧のみの人と、団体の店長・副店長が見ます')).toBeVisible();
      await expect(dialog.getByText('日時は日本時間（Asia/Tokyo）として読みます')).toBeVisible();
      // 空のまま「登録」：欄の下に誤り（送らない）
      await dialog.getByRole('button', { name: '登録', exact: true }).click();
      await expect(dialog.locator('[data-field-error="title"]')).toHaveText('題名を入れてください');
      await expect(dialog.locator('[data-field-error="start"]')).toHaveText('開始の日時を入れてください');
      expect(await eventsOf(s.yearId)).toEqual([]);

      // 終日の締切（明日・全員）。題名の前後の空白は除いて数え、除いて送る
      await dialog.getByRole('radio', { name: '締切', exact: true }).click();
      await dialog.getByRole('radio', { name: '全員', exact: true }).click();
      const title = 'E2E 机と椅子の数の確定';
      await dialog.getByLabel('題名', { exact: true }).fill(`  ${title}\u3000`);
      await expect(dialog.getByTestId('event-title-count')).toHaveText(`${[...title].length}/100`);
      await dialog.getByRole('checkbox', { name: '終日' }).click();
      await expect(dialog.getByText('日時は日本時間（Asia/Tokyo）として読みます。締切に終わりを入れると、終わりが期限になります')).toBeVisible();
      await dialog.getByLabel('日付', { exact: true }).fill(tomorrow);
      await dialog.getByRole('button', { name: '登録', exact: true }).click();
      await expect(page.getByText(`「${title}」を登録しました`)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // 時刻つきの予定（あと 3 日の 13:00〜15:00・総務）。メモは改行と行頭の空白を残す
      await page.getByRole('button', { name: '締切・予定を登録' }).click();
      await expect(dialog.getByRole('radio', { name: '予定', exact: true })).toBeChecked();
      const meeting = 'E2E 総務の打ち合わせ';
      await dialog.getByLabel('題名', { exact: true }).fill(meeting);
      await dialog.getByLabel('開始', { exact: true }).fill(`${in3}T13:00`);
      await dialog.getByLabel('終わり（任意）', { exact: true }).fill(`${in3}T15:00`);
      await dialog.getByLabel('メモ（任意）').fill('会議室A\n  持ち物：配置図');
      await expect(dialog.getByTestId('event-note-count')).toHaveText('14/1000');
      await dialog.getByRole('button', { name: '登録', exact: true }).click();
      await expect(page.getByText(`「${meeting}」を登録しました`)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // DB：終日は Asia/Tokyo の 00:00（最後の日がなければ終わりは null）、時刻つきは Asia/Tokyo の日時。書いた人は部門長
      const rows = await eventsOf(s.yearId);
      const deadline = rows.find((r) => r.title === title)!;
      const timed = rows.find((r) => r.title === meeting)!;
      expect(deadline).toMatchObject({ kind: 'deadline', audience: 'all', all_day: true, starts: `${tomorrow}T00:00`, ends: null, note: null, created_by: H, updated_by: H });
      expect(timed).toMatchObject({
        kind: 'event',
        audience: 'soumu',
        all_day: false,
        starts: `${in3}T13:00`,
        ends: `${in3}T15:00`,
        note: '会議室A\n  持ち物：配置図',
        created_by: H,
      });

      // 一覧：日の早い順（明日・あと 3 日・申請の締切）。日の見出しは日付と曜日と相対の言い方
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(deadline.id), eventDataId(timed.id), 'furniture:request-close']);
      expect(await calendarDates(page)).toEqual([tomorrow, in3, close.date]);
      await expect(calendarDay(page, tomorrow).getByTestId('calendar-day-heading')).toHaveText(dayHeading(tomorrow, year));
      await expect(calendarDay(page, tomorrow).getByTestId('calendar-day-relative')).toHaveText('明日');
      await expect(calendarDay(page, in3).getByTestId('calendar-day-heading')).toHaveText(dayHeading(in3, year));
      await expect(calendarDay(page, in3).getByTestId('calendar-day-relative')).toHaveText('あと 3 日');
      const d = calendarItem(page, eventDataId(deadline.id));
      await expect(d).toHaveAttribute('data-kind', 'deadline');
      await expect(d).toHaveAttribute('data-module', 'calendar');
      await expect(d).toHaveAttribute('data-audience', 'all');
      await expect(d.getByTestId('calendar-item-time')).toHaveText('終日');
      await expect(d.getByTestId('calendar-item-kind')).toHaveText('締切');
      await expect(d.getByTestId('calendar-item-audience')).toHaveText('全員');
      await expect(d.getByTestId('calendar-item-title')).toHaveText(title);
      await expect(d.getByTestId('calendar-item-relative')).toHaveCount(0);
      await expect(d.getByTestId('calendar-item-note')).toHaveCount(0);
      await expect(d.getByTestId('calendar-item-module')).toHaveCount(0);
      await expect(d.getByRole('button')).toHaveText(['編集', '削除']);
      const t = calendarItem(page, eventDataId(timed.id));
      await expect(t.getByTestId('calendar-item-time')).toHaveText('13:00〜15:00');
      await expect(t.getByTestId('calendar-item-kind')).toHaveText('予定');
      await expect(t.getByTestId('calendar-item-audience')).toHaveText('総務');
      expect(await noteText(t)).toBe('会議室A\n  持ち物：配置図');
      await expect(t.getByRole('button', { name: `「${meeting}」を編集` })).toBeVisible();
      await expect(t.getByRole('button', { name: `「${meeting}」を削除` })).toBeVisible();

      // 何も変えない編集は送らずに「変更はありません」で閉じる（DB の版は変わらない）。編集は今の値で開く
      await d.getByRole('button', { name: `「${title}」を編集` }).click();
      const edit = page.getByRole('dialog', { name: '締切・予定を編集' });
      await expect(edit.getByText('保存すると、対象の人にすぐ見えます。')).toBeVisible();
      await expect(edit.getByRole('radio', { name: '締切', exact: true })).toBeChecked();
      await expect(edit.getByRole('radio', { name: '全員', exact: true })).toBeChecked();
      await expect(edit.getByRole('checkbox', { name: '終日' })).toBeChecked();
      await expect(edit.getByLabel('日付', { exact: true })).toHaveValue(tomorrow);
      await expect(edit.getByLabel('最後の日（任意。2日以上のとき）')).toHaveValue('');
      await expect(edit.getByLabel('題名', { exact: true })).toHaveValue(title);
      await edit.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('変更はありません')).toBeVisible();
      await expect(edit).toHaveCount(0);
      expect((await eventsOf(s.yearId)).find((r) => r.id === deadline.id)!.updated_at).toBe(deadline.updated_at);

      // スマホの幅：1件ずつ縦に重ね、横にはみ出さない（操作のボタンも画面の中）
      await page.setViewportSize(MOBILE);
      await openCalendar(page);
      await expect.poll(() => calendarItemIds(page)).toHaveLength(3);
      await expectNoOverflow(page);
      const box = await t.getByRole('button', { name: `「${meeting}」を削除` }).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
      await page.setViewportSize(PC);

      // ダッシュボード：締切と予定に2件と申請の締切が早い順。日付は曜日つき（終日は日付だけ）、相対の言い方、種類の印。
      // 1件は一覧のその項目（?event=）へのリンク。欄の下に「締切と予定の一覧へ」
      await openPortal(page, 'ダッシュボード');
      await expect.poll(() => portalDatedIds(page)).toEqual([eventDataId(deadline.id), eventDataId(timed.id), 'furniture:request-close']);
      const p1 = portalDatedItem(page, eventDataId(deadline.id));
      await expect(p1).toHaveAttribute('data-kind', 'deadline');
      await expect(p1).toHaveAttribute('data-module', 'calendar');
      await expect(p1.getByTestId('portal-dated-when')).toHaveText(shortDate(tomorrow, year));
      await expect(p1.getByTestId('portal-dated-relative')).toHaveText('明日');
      await expect(p1).toContainText('締切');
      await expect(p1).toContainText(title);
      await expect(p1.getByRole('link')).toHaveAttribute('href', new RegExp(`/calendar/?\\?event=${deadline.id}$`));
      const p2 = portalDatedItem(page, eventDataId(timed.id));
      await expect(p2).toHaveAttribute('data-kind', 'event');
      await expect(p2.getByTestId('portal-dated-when')).toHaveText(`${shortDate(in3, year)}13:00〜15:00`);
      await expect(p2.getByTestId('portal-dated-relative')).toHaveText('あと 3 日');
      await expect(p2).toContainText('予定');
      const p3 = portalDatedItem(page, 'furniture:request-close');
      await expect(p3.getByTestId('portal-dated-when')).toHaveText(`${shortDate(close.date, year)}${close.time}`);
      await expect(p3.getByTestId('portal-dated-relative')).toHaveText(closeRelative);
      await expect(p3.getByRole('link')).toHaveAttribute('href', /\/requests\/?$/);
      await expect(datedWidget(page).getByTestId('portal-dated-more')).toHaveCount(0);
      const link = datedWidget(page).getByTestId('portal-dated-link');
      await expect(link).toHaveText('締切と予定の一覧へ');
      await expect(link).toHaveAttribute('href', /\/calendar\/?$/);

      await p2.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/calendar/?\\?event=${timed.id}$`));
      await expect(calendarItem(page, eventDataId(timed.id))).toHaveAttribute('data-highlighted', 'true');
      await expect(page.locator('[data-testid="calendar-item"][data-highlighted]')).toHaveCount(1);
      await expect(page.getByTestId('calendar-item')).toHaveCount(3);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 総務部門員

test.describe('T18 総務部門員', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T18 総務部門員：一覧は読め（総務の項目と対象の印も）、種類・対象で絞り込める（URL の ?kind=・?audience=。対象で絞ると机椅子の日付は出ない）。「締切・予定を登録」「編集」「削除」と帯は出ない', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { staff: true, head: true } });
    try {
      const today = tokyoToday();
      const [soumu, groups, all] = await insertEvents(s.yearId, [
        { kind: 'event', audience: 'soumu', title: 'E2E 総務の打ち合わせ', start: `${addDays(today, 2)}T10:00`, createdBy: H },
        { kind: 'deadline', audience: 'groups', title: 'E2E 電源の申請の締切', start: `${addDays(today, 4)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'all', title: 'E2E 搬入日', allDay: true, date: addDays(today, 6), createdBy: H },
      ]);
      const everything = [eventDataId(soumu), eventDataId(groups), eventDataId(all), 'furniture:request-close'];
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openCalendar(page);
      await expect.poll(() => calendarItemIds(page)).toEqual(everything);
      await expect(calendarItem(page, eventDataId(soumu)).getByTestId('calendar-item-audience')).toHaveText('総務');
      await expect(calendarItem(page, eventDataId(groups)).getByTestId('calendar-item-audience')).toHaveText('団体');
      await expect(calendarItem(page, eventDataId(all)).getByTestId('calendar-item-audience')).toHaveText('全員');
      await expect(calendarItem(page, eventDataId(groups)).getByTestId('calendar-item-time')).toHaveText('17:00');
      await expect(calendarItem(page, eventDataId(all)).getByTestId('calendar-item-time')).toHaveText('終日');
      // 書くためのもの（ボタン・帯）は出ない。机椅子の申請の締切は申請一覧へ（部員も開ける）
      await expect(page.getByRole('button', { name: '締切・予定を登録' })).toHaveCount(0);
      await expect(page.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('calendar-closed')).toHaveCount(0);
      await expect(calendarItem(page, 'furniture:request-close').getByRole('link')).toHaveAttribute('href', /\/requests\/?$/);

      // 絞り込み（URL に入れる）
      const kind = page.getByTestId('calendar-kind-filter');
      const audience = page.getByTestId('calendar-audience-filter');
      await expect(kind.getByRole('radio')).toHaveText(['すべて', '締切', '予定']);
      await expect(audience.getByRole('radio')).toHaveText(['すべて', '総務', '団体', '全員']);
      // 押されているのは「すべて」だけ（対象の「全員」と取り違えない）
      await expect(kind.locator('[role="radio"][aria-checked="true"]')).toHaveText(['すべて']);
      await expect(audience.locator('[role="radio"][aria-checked="true"]')).toHaveText(['すべて']);
      await kind.getByRole('radio', { name: '締切' }).click();
      await expect(page).toHaveURL(/\/calendar\/?\?kind=deadline$/);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(groups), 'furniture:request-close']);
      await audience.getByRole('radio', { name: '団体' }).click();
      await expect(page).toHaveURL(/\/calendar\/?\?kind=deadline&audience=groups$/);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(groups)]);
      await audience.getByRole('radio', { name: '総務' }).click();
      await expect(page.getByTestId('calendar-empty')).toContainText('条件に合う締切と予定はありません');
      await kind.getByRole('radio', { name: 'すべて' }).click();
      await expect(page).toHaveURL(/\/calendar\/?\?audience=soumu$/);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(soumu)]);
      await audience.getByRole('radio', { name: '全員' }).click();
      await expect(page).toHaveURL(/\/calendar\/?\?audience=all$/);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(all)]);
      await expect(audience.locator('[role="radio"][aria-checked="true"]')).toHaveText(['全員']);
      await audience.getByRole('radio', { name: 'すべて' }).click();
      await expect(page).toHaveURL(/\/calendar\/?$/);
      await expect.poll(() => calendarItemIds(page)).toEqual(everything);
      // 開いたときの知らない値は「すべて」
      await openCalendar(page, '?kind=unknown&audience=everyone');
      await expect(kind.getByRole('radio', { name: 'すべて' })).toHaveAttribute('aria-checked', 'true');
      await expect(audience.getByRole('radio', { name: 'すべて' })).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => calendarItemIds(page)).toEqual(everything);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 店長・閲覧のみ

test.describe('T18 店長', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: PC });

  test('T18 店長：対象が団体・全員の項目だけが一覧とホームの締切と予定に出て、総務の項目は出ない（一覧の読み取りの応答にもない）。対象の印・絞り込み・書くためのものはなく、机椅子の申請の締切は申請へ', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true }, repGroup: A });
    try {
      const today = tokyoToday();
      const [, groups, all] = await insertEvents(s.yearId, [
        { kind: 'event', audience: 'soumu', title: 'E2E 総務の打ち合わせ', start: `${addDays(today, 2)}T10:00`, note: '総務だけのメモ', createdBy: H },
        { kind: 'deadline', audience: 'groups', title: 'E2E 電源の申請の締切', start: `${addDays(today, 4)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'all', title: 'E2E 搬入日', allDay: true, date: addDays(today, 6), endDate: addDays(today, 7), createdBy: H },
      ]);
      const visible = [eventDataId(groups), eventDataId(all), 'furniture:request-close'];
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      // 一覧の読み取り（対象・メモ・updated_at も読む）の応答は RLS が返したもの（団体・全員だけ）
      const listRead = page.waitForResponse((r) => {
        const u = new URL(r.url());
        return u.pathname.endsWith('/rest/v1/events') && r.request().method() === 'GET' && (u.searchParams.get('select') ?? '').includes('audience');
      });
      await openCalendar(page);
      const body = (await (await listRead).json()) as { audience: string }[];
      expect(body.map((r) => r.audience).sort()).toEqual(['all', 'groups']);
      await expect.poll(() => calendarItemIds(page)).toEqual(visible);
      await expect(page.getByText('E2E 総務の打ち合わせ')).toHaveCount(0);
      await expect(page.getByText('総務だけのメモ')).toHaveCount(0);
      await expect(calendarItem(page, eventDataId(all)).getByTestId('calendar-item-time')).toHaveText(`終日（〜${shortDate(addDays(today, 7), thisYear(today))}）`);
      // 対象の印・絞り込み・書くためのもの（ボタン・帯）はない。「過去も表示」はある
      await expect(page.getByTestId('calendar-item-audience')).toHaveCount(0);
      await expect(page.getByTestId('calendar-kind-filter')).toHaveCount(0);
      await expect(page.getByTestId('calendar-audience-filter')).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: '過去も表示' })).toBeVisible();
      await expect(page.getByRole('button', { name: '締切・予定を登録' })).toHaveCount(0);
      await expect(page.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('calendar-closed')).toHaveCount(0);
      // 机椅子の日付には「机椅子」の印。申請の締切は申請（団体代表の画面）へ
      await expect(calendarItem(page, 'furniture:request-close').getByTestId('calendar-item-module')).toHaveText('机椅子');
      await expect(calendarItem(page, 'furniture:request-close').getByRole('link')).toHaveAttribute('href', /\/request\/?$/);
      // ?kind=・?audience= を付けても絞らない
      await openCalendar(page, '?audience=soumu&kind=deadline');
      await expect.poll(() => calendarItemIds(page)).toEqual(visible);

      // スマホの幅：横にはみ出さない
      await page.setViewportSize(MOBILE);
      await openCalendar(page);
      await expect.poll(() => calendarItemIds(page)).toEqual(visible);
      await expectNoOverflow(page);
      await page.setViewportSize(PC);

      // ホーム：締切と予定も団体・全員と申請の締切だけ
      await openPortal(page, 'ホーム');
      await expect.poll(() => portalDatedIds(page)).toEqual(visible);
      await expect(datedWidget(page)).not.toContainText('E2E 総務の打ち合わせ');
      await expect(portalDatedItem(page, eventDataId(all)).getByTestId('portal-dated-when')).toHaveText(
        `${shortDate(addDays(today, 6), thisYear(today))}〜${shortDate(addDays(today, 7), thisYear(today))}`,
      );
      await expect(portalDatedItem(page, eventDataId(all)).getByTestId('portal-dated-relative')).toHaveText('あと 6 日');
      await expect(portalDatedItem(page, 'furniture:request-close').getByRole('link')).toHaveAttribute('href', /\/request\/?$/);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T18 閲覧のみ', () => {
  test.use({ storageState: storageStateFor('viewer'), viewport: PC });

  test('T18 閲覧のみ：対象が団体・全員の項目だけ（総務の項目は出ない）。対象の印・絞り込み・書くためのものはなく、机椅子の日付はリンクにしない。ホームの締切と予定の1件から一覧のその項目へ', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { viewer: true, head: true } });
    try {
      const today = tokyoToday();
      const [, groups, all] = await insertEvents(s.yearId, [
        { kind: 'event', audience: 'soumu', title: 'E2E 総務の打ち合わせ', start: `${addDays(today, 2)}T10:00`, createdBy: H },
        { kind: 'deadline', audience: 'groups', title: 'E2E 電源の申請の締切', start: `${addDays(today, 4)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'all', title: 'E2E 搬入日', allDay: true, date: addDays(today, 6), createdBy: H },
      ]);
      const visible = [eventDataId(groups), eventDataId(all), 'furniture:request-close'];
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await openCalendar(page);
      await expect.poll(() => calendarItemIds(page)).toEqual(visible);
      await expect(page.getByText('E2E 総務の打ち合わせ')).toHaveCount(0);
      await expect(page.getByTestId('calendar-item-audience')).toHaveCount(0);
      await expect(page.getByTestId('calendar-kind-filter')).toHaveCount(0);
      await expect(page.getByTestId('calendar-audience-filter')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '締切・予定を登録' })).toHaveCount(0);
      await expect(page.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
      // 閲覧のみは申請一覧も申請も、机椅子の状況も開けないので、机椅子の日付は文字だけ（リンクに見える下線も付けない）
      const closeItem = calendarItem(page, 'furniture:request-close');
      await expect(closeItem.getByTestId('calendar-item-title')).toHaveText('机椅子の申請の締切');
      await expect(closeItem.getByRole('link')).toHaveCount(0);
      await expect(closeItem.getByTestId('calendar-item-title').locator('.underline')).toHaveCount(0);

      // ホーム：締切と予定の1件を押すと、一覧でその項目が目立つ（?event=）
      await openPortal(page, 'ホーム');
      await expect.poll(() => portalDatedIds(page)).toEqual(visible);
      await expect(portalDatedItem(page, 'furniture:request-close').getByRole('link')).toHaveCount(0);
      await portalDatedItem(page, eventDataId(all)).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/calendar/?\\?event=${all}$`));
      await expect(calendarItem(page, eventDataId(all))).toHaveAttribute('data-highlighted', 'true');
      await expect(page.locator('[data-testid="calendar-item"][data-highlighted]')).toHaveCount(1);
      await expect(page.getByTestId('calendar-item')).toHaveCount(3);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 編集の衝突・削除（2つのセッション）

test('T18 編集の衝突：2つのセッション（総務部門長と管理者）で同じ項目を直すと、後の保存は「ほかの人がこの項目を先に変えました…」と今の題名・更新の日時を出して入力を残し、もう一度の保存で上書きできる', async ({
  browser,
}) => {
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
  const head = await openAs(browser, 'head', s);
  const admin = await openAs(browser, 'admin', s);
  try {
    const today = tokyoToday();
    const [id] = await insertEvents(s.yearId, [
      {
        kind: 'event',
        audience: 'all',
        title: 'E2E 衝突する予定',
        start: `${addDays(today, 3)}T13:00`,
        end: `${addDays(today, 3)}T15:00`,
        note: '元のメモ',
        createdBy: H,
      },
    ]);
    for (const p of [head, admin]) {
      await openCalendar(p);
      await calendarItem(p, eventDataId(id)).getByRole('button', { name: '「E2E 衝突する予定」を編集' }).click();
      await expect(p.getByRole('dialog', { name: '締切・予定を編集' })).toBeVisible();
    }

    // 先に総務部門長が題名を変えて保存
    const hd = head.getByRole('dialog', { name: '締切・予定を編集' });
    await expect(hd.getByLabel('開始', { exact: true })).toHaveValue(`${addDays(today, 3)}T13:00`);
    await hd.getByLabel('題名', { exact: true }).fill('E2E 部門長が直した予定');
    await hd.getByRole('button', { name: '保存', exact: true }).click();
    await expect(head.getByText('「E2E 部門長が直した予定」を保存しました')).toBeVisible();
    await expect(hd).toHaveCount(0);

    // 後から管理者がメモを変えて保存 → 読み直して、今の題名と更新の日時を出す。入力は残し、ダイアログは開いたまま
    const ad = admin.getByRole('dialog', { name: '締切・予定を編集' });
    await ad.getByLabel('メモ（任意）').fill('管理者が直したメモ');
    await ad.getByRole('button', { name: '保存', exact: true }).click();
    const conflict = ad.getByTestId('event-conflict');
    await expect(conflict).toContainText(
      'ほかの人がこの項目を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）',
    );
    await expect(conflict).toContainText('今の題名：E2E 部門長が直した予定');
    await expect(conflict).toContainText(`更新：${await eventUpdatedLabel(id)}`);
    await expect(ad.getByLabel('題名', { exact: true })).toHaveValue('E2E 衝突する予定');
    await expect(ad.getByLabel('メモ（任意）')).toHaveValue('管理者が直したメモ');
    // DB は総務部門長の保存のまま。管理者の一覧（ダイアログの後ろ）も読み直している
    expect((await eventsOf(s.yearId))[0]).toMatchObject({ title: 'E2E 部門長が直した予定', note: '元のメモ', updated_by: H });
    await expect(calendarItem(admin, eventDataId(id)).getByTestId('calendar-item-title')).toHaveText('E2E 部門長が直した予定');

    // もう一度「保存」：読み直した版で送り、管理者の入力で上書きする
    await ad.getByRole('button', { name: '保存', exact: true }).click();
    await expect(admin.getByText('「E2E 衝突する予定」を保存しました')).toBeVisible();
    await expect(ad).toHaveCount(0);
    await expect(calendarItem(admin, eventDataId(id)).getByTestId('calendar-item-title')).toHaveText('E2E 衝突する予定');
    expect(await noteText(calendarItem(admin, eventDataId(id)))).toBe('管理者が直したメモ');
    expect((await eventsOf(s.yearId))[0]).toMatchObject({
      title: 'E2E 衝突する予定',
      note: '管理者が直したメモ',
      starts: `${addDays(today, 3)}T13:00`,
      ends: `${addDays(today, 3)}T15:00`,
      created_by: H,
      updated_by: SEED_USER_IDS.admin,
    });
    // 総務部門長が開き直すと後の内容
    await openCalendar(head);
    await expect(calendarItem(head, eventDataId(id)).getByTestId('calendar-item-title')).toHaveText('E2E 衝突する予定');
    expect(await noteText(calendarItem(head, eventDataId(id)))).toBe('管理者が直したメモ');
  } finally {
    await head.context().close().catch(() => undefined);
    await admin.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

test('T18 削除：確かめてから削除すると一覧とダッシュボードの欄から消える。もう消えた項目を別のセッションで削除すると「すでに削除されていました」', async ({
  browser,
}) => {
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true } });
  const head = await openAs(browser, 'head', s);
  const admin = await openAs(browser, 'admin', s);
  try {
    const today = tokyoToday();
    const [keep, del] = await insertEvents(s.yearId, [
      { kind: 'event', audience: 'soumu', title: 'E2E 残す予定', allDay: true, date: addDays(today, 2), createdBy: H },
      { kind: 'deadline', audience: 'soumu', title: 'E2E 消す締切', start: `${addDays(today, 4)}T17:00`, note: '消すメモ', createdBy: H },
    ]);
    // 管理者は、消す前の一覧で同じ項目の削除の確かめを開いておく
    await openCalendar(admin);
    await calendarItem(admin, eventDataId(del)).getByRole('button', { name: '「E2E 消す締切」を削除' }).click();
    const adminConfirm = admin.getByRole('alertdialog', { name: '「E2E 消す締切」を削除しますか' });
    await expect(adminConfirm).toBeVisible();

    // 総務部門長：ダッシュボードの欄に2件 → 一覧で削除（「やめる」なら消さない）
    await openPortal(head, 'ダッシュボード');
    await expect.poll(() => portalDatedIds(head)).toEqual([eventDataId(keep), eventDataId(del), 'furniture:request-close']);
    await openCalendar(head);
    await calendarItem(head, eventDataId(del)).getByRole('button', { name: '「E2E 消す締切」を削除' }).click();
    const confirm = head.getByRole('alertdialog', { name: '「E2E 消す締切」を削除しますか' });
    await expect(confirm).toContainText('この項目は、一覧とダッシュボードの締切と予定から消えます。元に戻せません。');
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(calendarItem(head, eventDataId(del))).toBeVisible();
    await calendarItem(head, eventDataId(del)).getByRole('button', { name: '「E2E 消す締切」を削除' }).click();
    await confirm.getByRole('button', { name: '削除する' }).click();
    await expect(head.getByText('「E2E 消す締切」を削除しました')).toBeVisible();
    await expect(confirm).toHaveCount(0);
    await expect(calendarItem(head, eventDataId(del))).toHaveCount(0);
    await expect(calendarItem(head, eventDataId(keep))).toBeVisible();
    expect((await eventsOf(s.yearId)).map((r) => r.id)).toEqual([keep]);

    // ダッシュボードの欄からも消える（アプリの中で移る。書いた後に欄を読み直す）
    await head.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: 'ホーム' }).click();
    await expect(head.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    await expect.poll(() => portalDatedIds(head)).toEqual([eventDataId(keep), 'furniture:request-close']);

    // 管理者が開いていた確かめで「削除する」→ もうないので「すでに削除されていました」。一覧からも消える
    await adminConfirm.getByRole('button', { name: '削除する' }).click();
    await expect(admin.getByText('すでに削除されていました（ほかの人が削除した可能性があります）')).toBeVisible();
    await expect(adminConfirm).toHaveCount(0);
    await expect(calendarItem(admin, eventDataId(del))).toHaveCount(0);
    await expect(calendarItem(admin, eventDataId(keep))).toBeVisible();
  } finally {
    await head.context().close().catch(() => undefined);
    await admin.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- 終了した年度

test('T18 終了した年度：一覧は読めるが「締切・予定を登録」「編集」「削除」が出ず、総務部門長には読み取り専用の帯。閲覧のみには帯も出ない', async ({ browser }) => {
  const s = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'small', roles: { head: true, viewer: true } });
  const head = await openAs(browser, 'head', s);
  const viewer = await openAs(browser, 'viewer', s);
  try {
    const today = tokyoToday();
    const [soumu, all] = await insertEvents(s.yearId, [
      { kind: 'deadline', audience: 'soumu', title: 'E2E 片付けの報告の締切', start: `${addDays(today, 3)}T17:00`, createdBy: H },
      { kind: 'event', audience: 'all', title: 'E2E 机と椅子の返却', allDay: true, date: addDays(today, 4), createdBy: H },
    ]);
    // 申請の締切は昨日（受付は終わっている）なので、既定の「今日から」には項目だけ
    await openCalendar(head);
    await expect(head.getByTestId('calendar-closed')).toHaveText('終了した年度のため、締切と予定は読むだけです');
    await expect.poll(() => calendarItemIds(head)).toEqual([eventDataId(soumu), eventDataId(all)]);
    await expect(head.getByRole('button', { name: '締切・予定を登録' })).toHaveCount(0);
    await expect(head.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
    await expect(head.getByTestId('calendar-kind-filter')).toBeVisible();
    await expect(calendarItem(head, eventDataId(soumu)).getByTestId('calendar-item-audience')).toHaveText('総務');

    await openCalendar(viewer);
    await expect.poll(() => calendarItemIds(viewer)).toEqual([eventDataId(all)]);
    await expect(viewer.getByTestId('calendar-closed')).toHaveCount(0);
    await expect(viewer.getByTestId('read-only-notice')).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: '締切・予定を登録' })).toHaveCount(0);
    await expect(viewer.getByTestId('calendar-days').getByRole('button')).toHaveCount(0);
  } finally {
    await head.context().close().catch(() => undefined);
    await viewer.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- ダッシュボード（選び方と欄の失敗）

test.describe('T18 ダッシュボード（総務部門員）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: PC });

  test('T18 ダッシュボード：締切と予定は、これからの 30 日の項目と過ぎた締切（「締切を過ぎました」）と机椅子の申請の締切を早い順に（過ぎた予定と 31 日より先は出さない）。予定と締切の読み取りが通信で失敗すると、この欄にだけ「締切と予定：…」と「もう一度」が出て、机椅子の申請の締切とほかの欄は出たまま。もう一度で直る', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { staff: true } });
    const route = '**/rest/v1/events*';
    try {
      const today = tokyoToday();
      const year = thisYear(today);
      const close = await requestCloseOf(s.yearId);
      const [overdue, twoDays, deadline] = await insertEvents(s.yearId, [
        { kind: 'deadline', audience: 'soumu', title: 'E2E 過ぎた締切', start: `${addDays(today, -2)}T17:00`, createdBy: H },
        { kind: 'event', audience: 'all', title: 'E2E 2日間の搬入', allDay: true, date: addDays(today, 1), endDate: addDays(today, 2), createdBy: H },
        { kind: 'deadline', audience: 'groups', title: 'E2E 電源の申請の締切', start: `${addDays(today, 5)}T12:00`, createdBy: H },
        { kind: 'event', audience: 'soumu', title: 'E2E 45 日後の予定', start: `${addDays(today, 45)}T10:00`, createdBy: H },
        { kind: 'event', audience: 'soumu', title: 'E2E 昨日の予定', allDay: true, date: addDays(today, -1), createdBy: H },
      ]);
      const shown = [eventDataId(overdue), eventDataId(twoDays), eventDataId(deadline), 'furniture:request-close'];
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openPortal(page, 'ダッシュボード');
      await expect.poll(() => portalDatedIds(page)).toEqual(shown);
      const o = portalDatedItem(page, eventDataId(overdue));
      await expect(o.getByTestId('portal-dated-when')).toHaveText(`${shortDate(addDays(today, -2), year)}17:00`);
      await expect(o.getByTestId('portal-dated-relative')).toHaveText('締切を過ぎました');
      await expect(portalDatedItem(page, eventDataId(twoDays)).getByTestId('portal-dated-when')).toHaveText(
        `${shortDate(addDays(today, 1), year)}〜${shortDate(addDays(today, 2), year)}`,
      );
      await expect(portalDatedItem(page, eventDataId(twoDays)).getByTestId('portal-dated-relative')).toHaveText('明日');
      await expect(portalDatedItem(page, eventDataId(deadline)).getByTestId('portal-dated-when')).toHaveText(`${shortDate(addDays(today, 5), year)}12:00`);
      await expect(portalDatedItem(page, eventDataId(deadline)).getByTestId('portal-dated-relative')).toHaveText('あと 5 日');
      await expect(portalDatedItem(page, 'furniture:request-close').getByTestId('portal-dated-relative')).toHaveText(relativeDays(daysFrom(today, close.date)));
      await expect(datedWidget(page)).not.toContainText('E2E 45 日後の予定');
      await expect(datedWidget(page)).not.toContainText('E2E 昨日の予定');
      await expect(datedWidget(page).getByTestId('portal-dated-more')).toHaveCount(0);

      // 欄の失敗：予定と締切の読み取りを通信の失敗にする（supabase-js と TanStack Query の読み直しの後に出る）
      await page.route(route, (r) => r.abort());
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
      const error = datedWidget(page).getByTestId('portal-module-error');
      await expect(error).toBeVisible({ timeout: 45_000 });
      await expect(error).toHaveAttribute('data-module', 'calendar');
      await expect(error).toContainText('締切と予定：通信できませんでした。電波の良い所でもう一度');
      await expect(error.getByRole('button', { name: 'もう一度' })).toBeVisible();
      // 机椅子の申請の締切（年度の行から）と欄の下のリンクは出たまま。予定と締切の項目は出ない
      expect(await portalDatedIds(page)).toEqual(['furniture:request-close']);
      await expect(datedWidget(page).getByTestId('portal-dated-link')).toBeVisible();
      await expect(datedWidget(page).getByTestId('portal-loading')).toHaveCount(0);
      // ほかの欄（要対応・総務内のお知らせ・カード）は出たまま。失敗も読み込み中も出ない（欄の失敗の表示は1つだけ）
      for (const w of ['portal-todos', 'portal-soumu-notices', 'portal-cards']) {
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
      await expect.poll(() => portalDatedIds(page)).toEqual(shown);
      await expect(page.getByTestId('portal-module-error')).toHaveCount(0);
    } finally {
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 過去も表示と ?event=

test.describe('T18 過去も表示', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T18 過去も表示：既定は今日から（昨日の予定・過ぎた締切・受付開始は出ない）。「過去も表示」（?past=1）で日の見出しの「N 日前」と過ぎた締切の「締切を過ぎました」、祭の日（2001 年）も出る。ダッシュボードの過ぎた締切から来た ?event= は過去も表示にして目立たせる', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true } });
    try {
      const today = tokyoToday();
      const close = await requestCloseOf(s.yearId);
      const yesterday = addDays(today, -1);
      const threeAgo = addDays(today, -3);
      const [yesterdayMeeting, overdue, soon] = await insertEvents(s.yearId, [
        { kind: 'event', audience: 'all', title: 'E2E 昨日の打ち合わせ', allDay: true, date: yesterday, createdBy: H },
        { kind: 'deadline', audience: 'soumu', title: 'E2E 過ぎた締切', start: `${threeAgo}T17:00`, createdBy: H },
        { kind: 'event', audience: 'soumu', title: 'E2E あさっての予定', allDay: true, date: addDays(today, 2), createdBy: H },
      ]);
      await pinYear(page, H, s.yearId);
      await openCalendar(page);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(soon), 'furniture:request-close']);
      const past = page.getByRole('checkbox', { name: '過去も表示' });
      await expect(past).not.toBeChecked();

      // 過去も表示：祭の日（前々日〜2日目。2001 年なので年つきの見出し）→ 3 日前 → 昨日 → あさって → 申請の締切
      await past.click();
      await expect(page).toHaveURL(/\/calendar\/?\?past=1$/);
      await expect(past).toBeChecked();
      await expect
        .poll(() => calendarDates(page))
        .toEqual(['2001-10-11', '2001-10-12', '2001-10-13', '2001-10-14', threeAgo, yesterday, addDays(today, 2), close.date]);
      await expect(calendarDay(page, '2001-10-13').getByTestId('calendar-day-heading')).toHaveText(dayHeading('2001-10-13', thisYear(today)));
      await expect(calendarDay(page, '2001-10-13').getByTestId('calendar-item-title')).toHaveText('電波祭 1日目');
      await expect(calendarDay(page, threeAgo).getByTestId('calendar-day-relative')).toHaveText('3 日前');
      const o = calendarItem(page, eventDataId(overdue));
      await expect(o.getByTestId('calendar-item-time')).toHaveText('17:00');
      await expect(o.getByTestId('calendar-item-relative')).toHaveText('締切を過ぎました');
      // 昨日：終日の項目が先、時刻のある受付開始が後。相対の言い方は日の見出しだけ
      await expect(calendarDay(page, yesterday).getByTestId('calendar-day-relative')).toHaveText('1 日前');
      expect(
        await calendarDay(page, yesterday)
          .getByTestId('calendar-item')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-id'))),
      ).toEqual([eventDataId(yesterdayMeeting), 'furniture:request-open']);
      await expect(calendarDay(page, yesterday).getByTestId('calendar-item-relative')).toHaveCount(0);
      await expect(calendarItem(page, 'furniture:request-open').getByTestId('calendar-item-title')).toHaveText('机椅子の申請の受付開始');
      // 外すと今日からに戻る
      await past.click();
      await expect(page).toHaveURL(/\/calendar\/?$/);
      await expect.poll(() => calendarItemIds(page)).toEqual([eventDataId(soon), 'furniture:request-close']);

      // ダッシュボードの過ぎた締切（「締切を過ぎました」）から一覧へ：過去も表示にして、その項目を目立たせる
      await openPortal(page, 'ダッシュボード');
      await expect.poll(() => portalDatedIds(page)).toEqual([eventDataId(overdue), eventDataId(soon), 'furniture:request-close']);
      const item = portalDatedItem(page, eventDataId(overdue));
      await expect(item.getByTestId('portal-dated-relative')).toHaveText('締切を過ぎました');
      await item.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/calendar/?\\?event=${overdue}$`));
      await expect(calendarItem(page, eventDataId(overdue))).toHaveAttribute('data-highlighted', 'true');
      await expect(page.locator('[data-testid="calendar-item"][data-highlighted]')).toHaveCount(1);
      await expect(page.getByRole('checkbox', { name: '過去も表示' })).toBeChecked();
      await expect(calendarItem(page, eventDataId(yesterdayMeeting))).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 応答が届かない（(B1)）

test.describe('T18 応答が届かない', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T18 応答が届かない（(B1)）：登録の応答を落とし読み直しも失敗すると「登録できたか分かりません…」。もう一度「登録」で同じ id を送り、23505 から読み直して「「…」は登録されていました」（1件だけ）。保存・削除の応答を落とすと読み直して「保存されていました」「「…」を削除しました」', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true } });
    const pattern = '**/rest/v1/events*';
    try {
      const today = tokyoToday();
      // 書き込みの応答を落とす（DB には届ける）。読み直し（readEvent。id で1行）も、指定した間は通信の失敗にする
      let drop: 'POST' | 'PATCH' | 'DELETE' | null = null;
      let blockReread = false;
      const dropped: string[] = [];
      await page.route(pattern, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (drop !== null && req.method() === drop) {
          drop = null;
          dropped.push(req.method());
          await route.fetch();
          await route.abort('failed');
          return;
        }
        if (blockReread && req.method() === 'GET' && url.searchParams.has('id')) {
          await route.abort('failed');
          return;
        }
        await route.continue();
      });
      await pinYear(page, H, s.yearId);
      await openCalendar(page);

      // 登録：応答が届かず、読み直しもできない → 分からない（入力を残す）
      const title = 'E2E 応答が届かない予定';
      await page.getByRole('button', { name: '締切・予定を登録' }).click();
      const dialog = page.getByRole('dialog', { name: '締切・予定を登録' });
      await dialog.getByLabel('題名', { exact: true }).fill(title);
      await dialog.getByLabel('開始', { exact: true }).fill(`${addDays(today, 5)}T10:00`);
      drop = 'POST';
      blockReread = true;
      await dialog.getByRole('button', { name: '登録', exact: true }).click();
      const unknown = dialog.locator('[data-testid="event-error"][data-kind="unknown"]');
      await expect(unknown).toHaveText('登録できたか分かりません。もう一度「登録」を押すと、確かめてから送ります', { timeout: 45_000 });
      await expect(dialog.getByLabel('題名', { exact: true })).toHaveValue(title);
      // insert は DB に届いていた
      const rows = await eventsOf(s.yearId);
      expect(rows.map((r) => r.title)).toEqual([title]);
      const id = rows[0]!.id;

      // もう一度「登録」：同じ id で送り、主キーの重複（23505・409）で止まって読み直し、入力と同じなので「登録されていました」
      blockReread = false;
      const resend = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/rest/v1/events') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: '登録', exact: true }).click();
      const res = await resend;
      expect(res.status()).toBe(409);
      const sentBody = JSON.parse(res.request().postData() ?? 'null') as { id: string } | { id: string }[];
      expect(Array.isArray(sentBody) ? sentBody[0]!.id : sentBody.id).toBe(id);
      await expect(page.getByText(`「${title}」は登録されていました`)).toBeVisible();
      await expect(dialog).toHaveCount(0);
      expect(await eventsOf(s.yearId)).toHaveLength(1);
      await expect.poll(() => calendarItemIds(page)).toContain(eventDataId(id));

      // 保存：応答が届かない → 読み直すと入力と同じなので「保存されていました」
      await calendarItem(page, eventDataId(id)).getByRole('button', { name: `「${title}」を編集` }).click();
      const edit = page.getByRole('dialog', { name: '締切・予定を編集' });
      await edit.getByLabel('メモ（任意）').fill('応答が届かなくても保存されている');
      drop = 'PATCH';
      await edit.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('保存されていました')).toBeVisible();
      await expect(edit).toHaveCount(0);
      expect((await eventsOf(s.yearId))[0]).toMatchObject({ id, note: '応答が届かなくても保存されている' });
      await expect(calendarItem(page, eventDataId(id)).getByTestId('calendar-item-note')).toHaveText('応答が届かなくても保存されている');

      // 削除：応答が届かない → 読み直すとないので「削除しました」
      await calendarItem(page, eventDataId(id)).getByRole('button', { name: `「${title}」を削除` }).click();
      const confirm = page.getByRole('alertdialog', { name: `「${title}」を削除しますか` });
      drop = 'DELETE';
      await confirm.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText(`「${title}」を削除しました`)).toBeVisible();
      await expect(confirm).toHaveCount(0);
      await expect(calendarItem(page, eventDataId(id))).toHaveCount(0);
      expect(await eventsOf(s.yearId)).toEqual([]);
      expect(dropped).toEqual(['POST', 'PATCH', 'DELETE']);
    } finally {
      await page.unroute(pattern).catch(() => undefined);
      await s.cleanup();
    }
  });
});
