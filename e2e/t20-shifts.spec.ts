import { expect, test, type Browser, type Page } from '@playwright/test';
import { navLabels } from './helpers';
import { accessToken, restGet, storageStateFor, type StoredUser } from './support/auth';
import { addDays, dayHeading, shortDate, tokyoToday } from './support/calendar';
import { createScenario, createUser, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import { MOBILE, PC } from './support/shots';
import {
  assignmentsOf,
  cellMembers,
  dutiesOf,
  expectNoOverflow,
  insertDuties,
  insertNeeds,
  insertSlots,
  insertTasks,
  memberOption,
  myShiftDays,
  myShiftItem,
  needsOf,
  openMyShift,
  openShifts,
  shiftCell,
  shiftRow,
  shiftRowIds,
  shiftsCard,
  slotAt,
  slotLabel,
  slotsAroundNow,
  slotsOf,
} from './support/shifts';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T20 シフト（/shifts・/shift・/shifts/print。04「シフト表」「自分のシフト」「シフト表の印刷」、D-56、notes/T20.md の「テストの計画」の
// E2E の 1〜3）。シナリオの年度（small。1日目は 2001 年）で閉じ、年度をまたぐ表には書かない。人は seed の総務部門長・総務部門員と、
// createUser の「部門員A」「部門員B」（個人名を使わない）。時間枠は画面から作るほか、e2e/support/shifts.ts で SQL から入れる。日付・時刻は
// テストの時計の Asia/Tokyo で決め、期待値も同じ時計から作る（今の枠・次の枠は slotsAroundNow。23 時より後は次の枠が明日になる）。
// 期待値の文言は 04 のとおりに書く（アプリの定数から引かない）。

const H = SEED_USER_IDS.head;
const ST = SEED_USER_IDS.staff;

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 開いているダイアログの「保存していない入力を捨てますか」を「捨てて閉じる」で閉じる */
async function discard(page: Page): Promise<void> {
  await page.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();
}

// ---------------------------------------------------------------- 総務部門長：作る・割り当てる

test.describe('T20 シフト表（総務部門長）', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T20 総務部門長：持ち場を2つ足し（同じ名前は止まる）、1日分（区切り 60 分・受付 2 人・運搬 1 人）を作って部門員を割り当てる。「あと1人」と合計、同じ時間枠のほかのますにいる人は選べない（「受付に入っています」）、移す・外す、印刷（日ごとの表・人ごと）、時間枠を直して重ねると「ほかの時間枠と時間が重なっています（09:00〜10:00）」、削除の確かめに人数', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const a = await createUser({ purpose: 'shifta', name: '部門員A' });
    const b = await createUser({ purpose: 'shiftb', name: '部門員B' });
    const s = await createScenario({
      status: 'requesting',
      dataset: 'small',
      roles: { head: true, staff: true },
      grants: [
        { userId: a.id, role: 'staff' },
        { userId: b.id, role: 'staff' },
      ],
    });
    try {
      const today = tokyoToday();
      const year = Number(today.slice(0, 4));
      const day = addDays(today, 3);
      await pinYear(page, H, s.yearId);
      await openShifts(page);

      // 空：時間枠も持ち場もない（部門長以上には作り方を添える）。帯はない
      const empty = page.getByTestId('shifts-empty');
      await expect(empty).toContainText('シフトの時間枠はまだありません');
      await expect(empty).toContainText('「1日分をまとめて作る」から作れます。');
      await expect(empty).toContainText('「持ち場を足す」から持ち場を作ってください');
      await expect(page.getByTestId('read-only-notice')).toHaveCount(0);

      // 持ち場を足す：名前の前後の空白（全角も）は除いて数え、除いて送る。並び順の既定は 0、次は今の最大＋1
      const dutyDialog = page.getByRole('dialog', { name: '持ち場を足す' });
      await page.getByTestId('shifts-add-duty').click();
      await dutyDialog.getByTestId('shift-duty-name').fill('  受付\u3000');
      await expect(dutyDialog.getByTestId('shift-duty-name-count')).toHaveText('2/50');
      await dutyDialog.getByTestId('shift-duty-place').fill('正門のテント');
      await dutyDialog.getByTestId('shift-duty-note').fill('来場者に案内図を渡す\n雨の日は体育館の入口');
      await expect(dutyDialog.getByTestId('shift-duty-order')).toHaveValue('0');
      await dutyDialog.getByTestId('shift-duty-submit').click();
      await expect(page.getByText('「受付」を足しました')).toBeVisible();
      await expect(dutyDialog).toHaveCount(0);
      await page.getByTestId('shifts-add-duty').click();
      await dutyDialog.getByTestId('shift-duty-name').fill('運搬');
      await expect(dutyDialog.getByTestId('shift-duty-order')).toHaveValue('1');
      await dutyDialog.getByTestId('shift-duty-submit').click();
      await expect(page.getByText('「運搬」を足しました')).toBeVisible();
      await expect(dutyDialog).toHaveCount(0);
      // 同じ名前は DB が止め（23505）、同じ id の持ち場はないので「同じ名前の持ち場があります」（入力は残す）
      await page.getByTestId('shifts-add-duty').click();
      await dutyDialog.getByTestId('shift-duty-name').fill('受付');
      await dutyDialog.getByTestId('shift-duty-submit').click();
      await expect(dutyDialog.locator('[data-field-error="name"]')).toHaveText('同じ名前の持ち場があります');
      await expect(dutyDialog.getByTestId('shift-duty-name')).toHaveValue('受付');
      await dutyDialog.getByRole('button', { name: 'やめる' }).click();
      await discard(page);
      await expect(dutyDialog).toHaveCount(0);
      const duties = await dutiesOf(s.yearId);
      expect(duties.map((d) => ({ name: d.name, place: d.place, note: d.note, sort_order: d.sort_order }))).toEqual([
        { name: '受付', place: '正門のテント', note: '来場者に案内図を渡す\n雨の日は体育館の入口', sort_order: 0 },
        { name: '運搬', place: null, note: null, sort_order: 1 },
      ]);
      const [reception, carry] = duties.map((d) => d.id) as [string, string];
      // 持ち場はできたので、空の表示から持ち場の案内は消える
      await expect(empty).toContainText('シフトの時間枠はまだありません');
      await expect(empty).not.toContainText('「持ち場を足す」から持ち場を作ってください');

      // 1日分をまとめて作る：日付・09:00〜12:00・区切り 60 分（既定）。持ち場ごとの必要人数（既定は全部に 1 人）を受付だけ 2 人に。
      // 並ぶ時間枠を見てから「作る」
      await page.getByTestId('shifts-add-day').click();
      const dayDialog = page.getByRole('dialog', { name: '1日分をまとめて作る' });
      await dayDialog.getByTestId('shift-day-date').fill(day);
      await dayDialog.getByTestId('shift-day-start').selectOption('09:00');
      await dayDialog.getByTestId('shift-day-end').selectOption('12:00');
      await expect(dayDialog.getByTestId('shift-day-step')).toHaveValue('60');
      await dayDialog.getByRole('button', { name: '受付の必要人数を1増やす' }).click();
      await expect(dayDialog.getByRole('textbox', { name: '受付の必要人数' })).toHaveValue('2');
      await expect(dayDialog.getByRole('textbox', { name: '運搬の必要人数' })).toHaveValue('1');
      await expect(dayDialog.getByRole('checkbox', { name: '受付を置く' })).toBeChecked();
      await expect(dayDialog.getByRole('checkbox', { name: '運搬を置く' })).toBeChecked();
      const preview = dayDialog.getByTestId('shift-day-preview');
      await expect(preview.getByRole('heading', { level: 3 })).toHaveText('並ぶ時間枠（3 枠）');
      await expect(preview.getByTestId('shift-day-preview-slot')).toHaveText(['09:00〜10:00', '10:00〜11:00', '11:00〜12:00']);
      await dayDialog.getByTestId('shift-day-submit').click();
      await expect(page.getByText(`${shortDate(day, year)} の時間枠を 3 作りました`)).toBeVisible();
      await expect(dayDialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/shifts/?\\?day=${day}$`));

      // DB：時間枠は Asia/Tokyo の時刻、ますは時間枠ごとに持ち場の数（必要人数は入れたとおり）
      const slots = await slotsOf(s.yearId);
      expect(slots.map((x) => [x.starts, x.ends])).toEqual([
        [`${day}T09:00`, `${day}T10:00`],
        [`${day}T10:00`, `${day}T11:00`],
        [`${day}T11:00`, `${day}T12:00`],
      ]);
      const [s1, s2, s3] = slots.map((x) => x.id) as [string, string, string];
      expect(await needsOf(s.yearId)).toEqual(
        [s1, s2, s3].flatMap((id) => [
          { slot_id: id, duty_id: reception, required_count: 2 },
          { slot_id: id, duty_id: carry, required_count: 1 },
        ]),
      );

      // 表：日のタブ（祭の日でない日は「11/4（水）」）、行は時間枠、列は持ち場。ますは「0/2」と「あと2人」（文字で）、合計は行の終わりと列の下
      const tab = page.locator(`[data-testid="shifts-day-tab"][data-day="${day}"]`);
      await expect(tab).toHaveText(shortDate(day, year));
      await expect(tab).toHaveAttribute('aria-current', 'page');
      expect(await shiftRowIds(page)).toEqual([s1, s2, s3]);
      await expect(page.getByTestId('shifts-table').locator('thead th')).toHaveText(['時間枠', /^受付正門のテント/, /^運搬/, '合計']);
      for (const [k, id] of [s1, s2, s3].entries()) {
        await expect(shiftRow(page, id).getByRole('rowheader')).toHaveText(['09:00〜10:00', '10:00〜11:00', '11:00〜12:00'][k]!);
        await expect(shiftCell(page, id, reception)).toHaveAttribute('data-state', 'short');
        await expect(shiftCell(page, id, reception).getByTestId('shift-cell-count')).toHaveText('0/2');
        await expect(shiftCell(page, id, reception).getByTestId('shift-cell-short')).toHaveText('あと2人');
        await expect(shiftCell(page, id, carry).getByTestId('shift-cell-count')).toHaveText('0/1');
        await expect(shiftCell(page, id, carry).getByTestId('shift-cell-short')).toHaveText('あと1人');
        await expect(shiftRow(page, id).getByTestId('shift-row-total')).toHaveText('0/3', { useInnerText: true });
      }
      await expect(page.getByTestId('shift-col-total')).toHaveText(['0/6', '0/3']);
      // 読み上げ：ますのボタンの名前は「09:00〜10:00 受付 0/2 人、あと2人」の形
      await expect(page.getByRole('button', { name: '09:00〜10:00 受付 0/2 人、あと2人', exact: true })).toBeVisible();

      // ますのダイアログ（09:00 の受付）：必要人数と、その年度の総務（表示名・ロール・その日の枠の数）。部門員Aを入れる
      const reception1 = page.getByRole('dialog', { name: '09:00〜10:00 受付' });
      await shiftCell(page, s1, reception).getByRole('button').click();
      await expect(reception1.getByRole('textbox', { name: '必要人数' })).toHaveValue('2');
      await expect(reception1.getByTestId('shift-member-option')).toHaveCount(4);
      for (const id of [H, ST, a.id, b.id]) await expect(memberOption(reception1, id)).toHaveAttribute('data-state', 'free');
      await expect(memberOption(reception1, a.id)).toContainText('部門員A');
      await expect(memberOption(reception1, a.id)).toContainText('総務部門員');
      await expect(memberOption(reception1, a.id)).toContainText('この日 0 枠');
      await expect(memberOption(reception1, H)).toContainText('総務部門長');
      await reception1.getByRole('button', { name: '部門員Aを入れる' }).click();
      await expect(page.getByText('部門員Aを受付に入れました')).toBeVisible();
      await expect(memberOption(reception1, a.id)).toHaveAttribute('data-state', 'in');
      await expect(memberOption(reception1, a.id)).toContainText('この日 1 枠');
      await reception1.getByRole('button', { name: '閉じる' }).click();
      await expect(reception1).toHaveCount(0);
      await expect(shiftCell(page, s1, reception).getByTestId('shift-cell-count')).toHaveText('1/2');
      await expect(shiftCell(page, s1, reception).getByTestId('shift-cell-short')).toHaveText('あと1人');
      expect(await cellMembers(shiftCell(page, s1, reception))).toEqual(['部門員A']);

      // 同じ時間枠の運搬：部門員Aは「受付に入っています」で選べない（入れるボタンがない）。部門員Bを入れる
      const carry1 = page.getByRole('dialog', { name: '09:00〜10:00 運搬' });
      await shiftCell(page, s1, carry).getByRole('button').click();
      await expect(memberOption(carry1, a.id)).toHaveAttribute('data-state', 'busy');
      await expect(memberOption(carry1, a.id).getByTestId('shift-member-busy')).toHaveText('受付に入っています');
      await expect(memberOption(carry1, a.id).getByRole('button')).toHaveCount(0);
      await carry1.getByRole('button', { name: '部門員Bを入れる' }).click();
      await expect(page.getByText('部門員Bを運搬に入れました')).toBeVisible();
      await carry1.getByRole('button', { name: '閉じる' }).click();
      await expect(shiftCell(page, s1, carry)).toHaveAttribute('data-state', 'ok');
      await expect(shiftCell(page, s1, carry).getByTestId('shift-cell-count')).toHaveText('1/1');
      await expect(shiftCell(page, s1, carry).getByTestId('shift-cell-short')).toHaveCount(0);
      await expect(shiftRow(page, s1).getByTestId('shift-row-total')).toHaveText('2/3', { useInnerText: true });
      await expect(page.getByTestId('shift-col-total')).toHaveText(['1/6', '1/3']);

      // 移す：受付の部門員Aを同じ時間枠の運搬へ（割り当ての更新1回）。運搬は「2/1」と「+1」、受付は「0/2」
      await shiftCell(page, s1, reception).getByRole('button').click();
      await reception1.getByRole('combobox', { name: '部門員Aをほかの持ち場へ移す' }).selectOption({ label: '運搬' });
      await expect(page.getByText('部門員Aを運搬に移しました')).toBeVisible();
      await expect(memberOption(reception1, a.id)).toHaveAttribute('data-state', 'busy');
      await reception1.getByRole('button', { name: '閉じる' }).click();
      await expect(shiftCell(page, s1, carry)).toHaveAttribute('data-state', 'over');
      await expect(shiftCell(page, s1, carry).getByTestId('shift-cell-count')).toHaveText('2/1');
      await expect(shiftCell(page, s1, carry).getByTestId('shift-cell-over')).toHaveText('+1');
      expect(await cellMembers(shiftCell(page, s1, carry))).toEqual(['部門員A', '部門員B']);
      await expect(shiftCell(page, s1, reception).getByTestId('shift-cell-count')).toHaveText('0/2');

      // 外す：運搬の部門員B。運搬は「1/1」に戻る
      await shiftCell(page, s1, carry).getByRole('button').click();
      await carry1.getByRole('button', { name: '部門員Bを外す' }).click();
      await expect(page.getByText('部門員Bを外しました')).toBeVisible();
      await expect(memberOption(carry1, b.id)).toHaveAttribute('data-state', 'free');
      await carry1.getByRole('button', { name: '閉じる' }).click();
      await expect(shiftCell(page, s1, carry).getByTestId('shift-cell-count')).toHaveText('1/1');
      expect(await cellMembers(shiftCell(page, s1, carry))).toEqual(['部門員A']);
      expect(await assignmentsOf(s.yearId)).toEqual([{ slot_id: s1, duty_id: carry, user_id: a.id }]);

      // 印刷：シフト表の「印刷」から、開いている日の日ごとの表（年度名・日付）。人ごとに切り替えると、割り当てのある人のカード
      await page.getByTestId('shifts-print-link').click();
      await expect(page).toHaveURL(new RegExp(`/shifts/print/?\\?day=${day}$`));
      await expect(page.getByRole('heading', { level: 1, name: 'シフト表の印刷' })).toBeVisible();
      const printTable = page.getByTestId('shifts-print-table');
      await expect(printTable).toHaveCount(1);
      await expect(printTable.getByRole('heading', { level: 2 })).toHaveText(`${s.label} シフト表 ${shortDate(day, year)}`);
      await expect(printTable.getByRole('rowheader')).toHaveText(['09:00〜10:00', '10:00〜11:00', '11:00〜12:00']);
      await expect(printTable.getByRole('row').nth(1)).toContainText('部門員A');
      await expect(printTable.getByRole('row').nth(2)).toContainText('あと2人');
      await page.getByTestId('shifts-print-view').selectOption('people');
      await expect(page).toHaveURL(new RegExp(`/shifts/print/?\\?day=${day}&view=people$`));
      const person = page.getByTestId('shifts-print-person');
      await expect(person).toHaveCount(1);
      await expect(person.getByRole('heading', { level: 2 })).toHaveText('部門員A');
      await expect(person).toContainText(`${s.label} ${shortDate(day, year)}`);
      await expect(person.getByRole('listitem')).toHaveText(['09:00〜10:00 運搬']);
      await page.getByRole('link', { name: 'シフト表へ戻る' }).click();
      await expect(page).toHaveURL(new RegExp(`/shifts/?\\?day=${day}$`));
      await expect(page.getByTestId('shifts-table')).toBeVisible();

      // 時間枠を直して重ねる：10:00〜11:00 を 09:30 からにすると、DB が止めて「ほかの時間枠と時間が重なっています（09:00〜10:00）」
      // （重なる時間枠の時刻）。入力は残す。やめると確かめてから閉じ、DB は変わらない
      await page.getByRole('button', { name: '時間枠 10:00〜11:00 を直す' }).click();
      const slotDialog = page.getByRole('dialog', { name: '時間枠を直す' });
      await expect(slotDialog.getByTestId('shift-slot-date')).toHaveValue(day);
      await expect(slotDialog.getByTestId('shift-slot-start')).toHaveValue('10:00');
      await expect(slotDialog.getByTestId('shift-slot-end')).toHaveValue('11:00');
      await slotDialog.getByTestId('shift-slot-start').fill('09:30');
      await slotDialog.getByTestId('shift-slot-submit').click();
      await expect(slotDialog.getByTestId('shift-slot-error')).toContainText('ほかの時間枠と時間が重なっています（09:00〜10:00）');
      await expect(slotDialog.getByTestId('shift-slot-start')).toHaveValue('09:30');
      await slotDialog.getByRole('button', { name: 'やめる' }).click();
      await discard(page);
      await expect(slotDialog).toHaveCount(0);
      expect((await slotsOf(s.yearId)).map((x) => x.starts)).toEqual([`${day}T09:00`, `${day}T10:00`, `${day}T11:00`]);

      // 1日分を同じ日・同じ時刻でもう一度：今ある時間枠と重なるので、送る前に重なる時間枠を出して「作る」を押せない
      await page.getByTestId('shifts-add-day').click();
      await expect(dayDialog.getByTestId('shift-day-date')).toHaveValue(day);
      await dayDialog.getByTestId('shift-day-end').selectOption('12:00');
      await expect(dayDialog.getByTestId('shift-day-overlap')).toHaveText('今ある時間枠と重なっています：09:00〜10:00・10:00〜11:00・11:00〜12:00');
      await expect(dayDialog.getByTestId('shift-day-submit')).toBeDisabled();
      await dayDialog.getByRole('button', { name: 'やめる' }).click();
      await discard(page);
      await expect(dayDialog).toHaveCount(0);

      // 持ち場の削除の確かめ：ますと割り当ての数（やめる）
      await page.getByRole('button', { name: '持ち場「受付」を削除' }).click();
      const dutyConfirm = page.getByRole('alertdialog', { name: '「受付」を削除しますか' });
      await expect(dutyConfirm).toContainText('この持ち場の 3 のますと 0 人の割り当ても消えます。元に戻せません。');
      await dutyConfirm.getByRole('button', { name: 'やめる' }).click();
      await expect(dutyConfirm).toHaveCount(0);

      // 時間枠の削除：確かめに時刻と割り当ての人数。消すと割り当ても消える
      await page.getByRole('button', { name: '時間枠 09:00〜10:00 を削除' }).click();
      const slotConfirm = page.getByRole('alertdialog', { name: 'この時間枠を削除しますか' });
      await expect(slotConfirm).toContainText('09:00〜10:00。この時間枠の 1 人の割り当ても消えます。元に戻せません。');
      await slotConfirm.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('この時間枠を削除しました')).toBeVisible();
      await expect(slotConfirm).toHaveCount(0);
      await expect.poll(() => shiftRowIds(page)).toEqual([s2, s3]);
      expect((await slotsOf(s.yearId)).map((x) => x.id)).toEqual([s2, s3]);
      expect(await assignmentsOf(s.yearId)).toEqual([]);
    } finally {
      await s.cleanup();
      await a.cleanup();
      await b.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 総務部門員（スマホ）

test.describe('T20 自分のシフトとシフト表（総務部門員・スマホ）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: MOBILE });

  test('T20 総務部門員：/shift に日ごとの自分の枠（今日 → これから → 終わった日は畳む）。今の枠に「今」、次の枠に「次」、場所・説明・同じますの人。シフト表は読むだけ（操作なし・ますは押せない・自分の名前を目立たせる）で、スマホでは時間枠ごとのカード（横にはみ出さない）', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const a = await createUser({ purpose: 'shifta', name: '部門員A' });
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true }, grants: [{ userId: a.id, role: 'staff' }] });
    try {
      const t = slotsAroundNow();
      const year = Number(t.today.slice(0, 4));
      const tomorrow = addDays(t.today, 1);
      const yesterday = addDays(t.today, -1);
      const later = slotAt(tomorrow, '10:00', '11:00');
      const past = slotAt(yesterday, '10:00', '11:00');
      const [reception, carry] = (await insertDuties(s.yearId, [
        { name: '受付', place: '正門のテント', note: '来場者に案内図を渡す\n雨の日は体育館の入口' },
        { name: '運搬' },
      ])) as [string, string];
      const [sNow, sNext, sLater, sPast] = (await insertSlots(s.yearId, [t.now, t.next, later, past])) as [string, string, string, string];
      await insertNeeds(s.yearId, [
        { slotId: sNow, dutyId: reception, required: 2, users: [ST, a.id] },
        { slotId: sNow, dutyId: carry, required: 1 },
        { slotId: sNext, dutyId: carry, required: 1, users: [ST] },
        { slotId: sLater, dutyId: reception, required: 1, users: [a.id] },
        { slotId: sLater, dutyId: carry, required: 1, users: [ST] },
        { slotId: sPast, dutyId: carry, required: 2, users: [ST, H] },
      ]);
      await pinYear(page, ST, s.yearId);
      await openMyShift(page);

      // 日：今日 → これからの日（終わった日は畳む）。次の枠は 23 時より後に流すと明日になる
      await expect.poll(() => myShiftDays(page)).toEqual([t.today, tomorrow]);
      const todaySection = page.locator(`[data-testid="my-shift-day"][data-day="${t.today}"]`);
      await expect(todaySection.getByRole('heading', { level: 2 })).toHaveText(`${dayHeading(t.today, year)}今日`);
      await expect(page.locator(`[data-testid="my-shift-day"][data-day="${tomorrow}"]`).getByRole('heading', { level: 2 })).toHaveText(
        `${dayHeading(tomorrow, year)}明日`,
      );
      const inToday = t.nextIsToday ? [sNow, sNext] : [sNow];
      expect(await todaySection.getByTestId('my-shift-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-slot-id')))).toEqual(inToday);

      // 今の枠：時刻・「今」・持ち場・場所・説明（改行を残す）・同じますの人（自分を除く）
      const now = myShiftItem(page, sNow);
      await expect(now.getByTestId('my-shift-time')).toHaveText(slotLabel(t.now));
      await expect(now.getByTestId('my-shift-now')).toHaveText('今');
      await expect(now.getByTestId('my-shift-next')).toHaveCount(0);
      await expect(now.getByTestId('my-shift-duty')).toHaveText('受付');
      await expect(now.getByTestId('my-shift-place')).toContainText('正門のテント');
      expect(await now.getByTestId('my-shift-note').innerText()).toBe('来場者に案内図を渡す\n雨の日は体育館の入口');
      await expect(now.getByTestId('my-shift-mates')).toContainText('部門員A');
      await expect(now.getByTestId('my-shift-mates')).not.toContainText('テスト部員');
      // 次の枠（これからの最初の枠）：「次」・同じますの人がいない
      const next = myShiftItem(page, sNext);
      await expect(next.getByTestId('my-shift-time')).toHaveText(slotLabel(t.next));
      await expect(next.getByTestId('my-shift-next')).toHaveText('次');
      await expect(next.getByTestId('my-shift-now')).toHaveCount(0);
      await expect(next.getByTestId('my-shift-duty')).toHaveText('運搬');
      await expect(next.getByTestId('my-shift-place')).toHaveCount(0);
      await expect(next.getByTestId('my-shift-mates')).toContainText('ほかの人はいません');
      // 明日の 10:00 の運搬（同じ時間枠の受付の部門員Aは同じますの人ではない）
      const laterItem = myShiftItem(page, sLater);
      await expect(laterItem.getByTestId('my-shift-time')).toHaveText('10:00〜11:00');
      await expect(laterItem.getByTestId('my-shift-mates')).toContainText('ほかの人はいません');
      await expect(page.getByTestId('my-shift-now')).toHaveCount(1);
      await expect(page.getByTestId('my-shift-next')).toHaveCount(1);
      await expect(myShiftItem(page, sPast)).toHaveCount(0);
      await expectNoOverflow(page);

      // 終わった日は畳む（「終わった日（1 日）」）。開くと昨日の枠と同じますの人
      const toggle = page.getByTestId('my-shift-past-toggle');
      await expect(toggle).toHaveText('終わった日（1 日）');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const pastDay = page.locator(`[data-testid="my-shift-day"][data-day="${yesterday}"]`);
      await expect(pastDay).toHaveAttribute('data-past', 'true');
      await expect(myShiftItem(page, sPast).getByTestId('my-shift-mates')).toContainText('テスト部門長');
      await expect.poll(() => myShiftDays(page)).toEqual([t.today, tomorrow, yesterday]);
      // 書き込みはない（帯も出さない）
      await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
      await expect(page.getByTestId('my-shift-list').getByRole('button', { name: /作る|直す|削除|入れる|外す/ })).toHaveCount(0);

      // ?day= の終わった日は畳みを開いて出す（ダッシュボードの締切と予定から来るとき）
      await openMyShift(page, `?day=${yesterday}`);
      await expect(page.getByTestId('my-shift-past-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(myShiftItem(page, sPast)).toBeVisible();

      // シフト表を見る：総務部門員は読むだけ。既定の日は今日（時間枠のある日のタブ）。スマホでは時間枠ごとのカード（列の見出しは隠し、
      // ますの中に持ち場の名前）。自分の名前は目立たせる（data-me）。印刷へのリンクはある
      await page.getByTestId('my-shift-board-link').click();
      await expect(page).toHaveURL(/\/shifts\/?$/);
      await expect(page.getByRole('heading', { level: 1, name: 'シフト表', exact: true })).toBeVisible();
      await expect(page.getByTestId('shifts-board')).toBeVisible();
      const days = [yesterday, t.today, tomorrow];
      await expect(page.getByTestId('shifts-day-tab')).toHaveText(days.map((d) => shortDate(d, year)));
      await expect(page.locator(`[data-testid="shifts-day-tab"][data-day="${t.today}"]`)).toHaveAttribute('aria-current', 'page');
      for (const id of ['shifts-add-day', 'shifts-add-slot', 'shifts-add-duty', 'shift-slot-edit', 'shift-slot-delete', 'shift-duty-edit', 'shift-duty-delete']) {
        await expect(page.getByTestId(id)).toHaveCount(0);
      }
      await expect(page.getByTestId('shifts-table').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('shifts-print-link')).toBeVisible();
      await expect(page.getByTestId('shifts-table').locator('thead')).toBeHidden();
      const mineCell = shiftCell(page, sNow, reception);
      await expect(mineCell.locator('[data-testid="shift-cell-member"][data-me="true"]')).toHaveText('テスト部員（あなた）');
      await expect(mineCell.locator('[data-testid="shift-cell-member"]:not([data-me])')).toHaveText('部門員A');
      await expect(mineCell.getByTestId('shift-cell-count')).toHaveText('2/2');
      await expect(mineCell).toContainText('受付');
      await expect(shiftCell(page, sNow, carry).getByTestId('shift-cell-short')).toHaveText('あと1人');
      await expectNoOverflow(page);
      // PC の幅では見出しのある表（ますは押せないまま）
      await page.setViewportSize(PC);
      await expect(page.getByTestId('shifts-table').locator('thead')).toBeVisible();
      await expect(page.getByTestId('shifts-table').getByRole('button')).toHaveCount(0);
    } finally {
      await s.cleanup();
      await a.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 閲覧のみ・店長

test('T20 閲覧のみ・店長：ナビに「シフト・作業」の見出しがなく、ダッシュボードにカードもない。/shift・/shifts・/shifts/print・/tasks を URL で開くと「権限がありません」。API でも5表は 0 行（総務部門員は読める）', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true, viewer: true }, repGroup: SMALL.groups.stall });
  try {
    const t = slotsAroundNow();
    const [duty] = (await insertDuties(s.yearId, [{ name: '受付' }])) as [string];
    const [slot] = (await insertSlots(s.yearId, [t.now])) as [string];
    await insertNeeds(s.yearId, [{ slotId: slot, dutyId: duty, required: 1, users: [ST] }]);
    await insertTasks(s.yearId, [{ title: 'E2E 看板を作る', assigneeId: ST, createdBy: H }]);

    for (const user of ['viewer', 'rep'] as const) {
      const page = await openAs(browser, user, s);
      try {
        await page.goto('/');
        await expect(page.getByRole('heading', { level: 1, name: 'ホーム' })).toBeVisible();
        const nav = page.getByRole('navigation', { name: 'メインメニュー' });
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('group', { name: 'シフト・作業' })).toHaveCount(0);
        const labels = await navLabels(page);
        for (const l of ['自分のシフト', 'シフト表', '作業一覧']) expect(labels).not.toContain(l);
        await expect(page.getByTestId('portal-dated')).toBeVisible();
        await expect(page.getByTestId('portal-loading')).toHaveCount(0);
        await expect(shiftsCard(page)).toHaveCount(0);
        await expect(page.locator('[data-module="shifts"]')).toHaveCount(0);
        for (const path of ['/shift/', '/shifts/', '/shifts/print/', '/tasks/']) {
          await page.goto(path);
          await expect(page.getByRole('alert').filter({ has: page.getByText('権限がありません', { exact: true }) })).toBeVisible();
          await expect(page.getByText('E2E 看板を作る')).toHaveCount(0);
          await expect(page.getByTestId('shifts-board')).toHaveCount(0);
          await expect(page.getByTestId('my-shift-list')).toHaveCount(0);
        }
      } finally {
        await page.context().close();
      }
    }

    // API（PostgREST）でも、閲覧のみ・店長には5表とも 0 行。総務部門員は読める（空振りでない）
    const tables = ['shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks'];
    for (const user of ['viewer', 'rep'] as const) {
      const token = await accessToken(request, user);
      for (const table of tables) {
        const r = await restGet<unknown[]>(request, token, `${table}?select=year_id&year_id=eq.${s.yearId}`);
        expect(r.status, `${user} ${table}`).toBe(200);
        expect(r.data, `${user} ${table}`).toEqual([]);
      }
    }
    const staffToken = await accessToken(request, 'staff');
    for (const table of tables) {
      const r = await restGet<unknown[]>(request, staffToken, `${table}?select=year_id&year_id=eq.${s.yearId}`);
      expect(r.data?.length, `staff ${table}`).toBeGreaterThan(0);
    }
  } finally {
    await s.cleanup();
  }
});
