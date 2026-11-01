// T20 シフト・作業（/shifts・/shift・/shifts/print・/tasks とダッシュボードのシフト・作業）のスクリーンショット（画面の設計 7.4。
// notes/T20.md の「スクリーンショット」）。`pnpm e2e:shots --grep "T20 "` で notes/T20/ に撮る（CI では流さない）。年度をまたぐ表には
// 書かない。持ち場・時間枠・ます・割り当て・作業は SQL で入れる（e2e/support/shifts.ts）。
// 祭の日（前々日〜2日目）の名前を日のタブに出し、「最新でない年度」の帯を出さないため、撮るときだけシナリオの年度の1日目を明日に動かす
// （今日が前日。T16〜T18 の撮影と同じ考え）。撮影は1つずつ流れ（shots のプロジェクトは workers 1）、年度は pinYear で開くので、ほかの
// テストの既定の年度は変わらない（並行の E2E〔e2e/t20-*.spec.ts〕では動かさない。D-36）。今日の時間枠は撮る時刻のまわりの 1 時間ずつ
// （「今」「次」の印が出るように）。終了した年度はふつう前の年度なので動かさない（帯も出る形を撮る）。幅 390px のものは撮るときに
// scrollWidth ≤ 390 を確かめる。人は seed のテストユーザーと「部門員A」〜「部門員E」（個人名を写さない）。年度とユーザーは撮り終えたら消す。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import { addDays, tokyoToday } from '../support/calendar';
import { createScenario, createUser, sql, type Scenario, type TestUser } from '../support/db';
import { openPortal } from '../support/notices';
import {
  expectNoOverflow,
  hhmm,
  insertDuties,
  insertNeeds,
  insertSlots,
  insertTasks,
  openMyShift,
  openShifts,
  openTasks,
  shiftCell,
  shiftsCard,
  slotAt,
  taskItem,
  tokyoMinutesNow,
  type NeedInput,
  type SlotTimes,
} from '../support/shifts';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const H = SEED_USER_IDS.head;
const ST = SEED_USER_IDS.staff;
const AD = SEED_USER_IDS.admin;

/** A4 横・縦を 96dpi にした大きさ（印刷の見た目を撮る） */
const A4_LANDSCAPE = { width: 1123, height: 794 } as const;
const A4_PORTRAIT = { width: 794, height: 1123 } as const;

/** その利用者がシナリオの年度を開くページ（別のブラウザのコンテキスト） */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 撮るときだけ、1日目を明日（Asia/Tokyo）にする（今日が前日） */
async function festivalTomorrow(s: Scenario): Promise<void> {
  await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + 1 where id = $1`, [s.yearId]);
}

interface ShotData {
  today: string;
  /** 今日の時間枠（撮る時刻のまわりの 1 時間ずつ。nowIndex が今の枠） */
  todaySlots: string[];
  nowIndex: number;
  duties: Record<'reception' | 'carry' | 'patrol' | 'office' | 'bike', string>;
  tasks: Record<'sign' | 'map' | 'roster' | 'cords' | 'bikeSign' | 'desks' | 'lost' | 'office', string>;
}

/**
 * 撮影の年度のシフト・作業（持ち場 5・今日の時間枠 5〔撮る時刻のまわり〕・1日目 4・2日目 3・前々日 1、作業 8）。足りない・そろった・多い
 * ますと「—」、今の枠・次の枠・終わった日が出るように入れる
 */
async function seedShots(s: Scenario, u: Record<'a' | 'b' | 'c' | 'd' | 'e', string>): Promise<ShotData> {
  const today = tokyoToday();
  const day1 = addDays(today, 1);
  const day2 = addDays(today, 2);
  const before = addDays(today, -1);
  const [reception, carry, patrol, office, bike] = (await insertDuties(s.yearId, [
    { name: '受付', place: '正門のテント', note: '来場者に案内図とパンフレットを渡す。\n雨の日は体育館の入口に移る。' },
    { name: '運搬', place: '体育館の倉庫', note: '机・椅子を台車で運ぶ。2人1組で動く。' },
    { name: '見回り', place: '校舎の1階〜3階', note: '落とし物は本部へ届ける。' },
    { name: '本部', place: '第一会議室' },
    { name: '駐輪場', place: '北門の横' },
  ])) as [string, string, string, string, string];

  // 今日：撮る時刻を含む 1 時間の枠を真ん中に、前後 2 つずつ（0 時〜24 時に収める）
  const hour = Math.floor(tokyoMinutesNow() / 60);
  const first = Math.max(0, Math.min(hour - 2, 19));
  const todayTimes: SlotTimes[] = Array.from({ length: 5 }, (_, k) => slotAt(today, hhmm((first + k) * 60), hhmm((first + k + 1) * 60)));
  const todaySlots = await insertSlots(s.yearId, todayTimes);
  const nowIndex = hour - first;
  const [x0, x1, x2, x3, x4] = todaySlots as [string, string, string, string, string];
  const day1Slots = (await insertSlots(s.yearId, [
    slotAt(day1, '08:00', '10:00'),
    slotAt(day1, '10:00', '12:00'),
    slotAt(day1, '12:00', '14:00'),
    slotAt(day1, '14:00', '16:00'),
  ])) as [string, string, string, string];
  const day2Slots = (await insertSlots(s.yearId, [slotAt(day2, '08:00', '10:00'), slotAt(day2, '10:00', '12:00'), slotAt(day2, '12:00', '14:00')])) as [
    string,
    string,
    string,
  ];
  const [pastSlot] = (await insertSlots(s.yearId, [slotAt(before, '10:00', '12:00')])) as [string];

  const needs: NeedInput[] = [
    // 今日（前日）：受付 2・運搬 2・見回り 1・本部 1（駐輪場は「—」）
    { slotId: x0, dutyId: reception, required: 2, users: [u.a, u.b] },
    { slotId: x0, dutyId: carry, required: 2, users: [u.c] },
    { slotId: x0, dutyId: patrol, required: 1, users: [u.d] },
    { slotId: x0, dutyId: office, required: 1, users: [u.e] },
    { slotId: x1, dutyId: reception, required: 2, users: [ST, u.a] },
    { slotId: x1, dutyId: carry, required: 2, users: [u.b, u.c, u.d] },
    { slotId: x1, dutyId: patrol, required: 1 },
    { slotId: x1, dutyId: office, required: 1, users: [u.e] },
    { slotId: x2, dutyId: reception, required: 2, users: [ST, u.a] },
    { slotId: x2, dutyId: carry, required: 2, users: [u.b] },
    { slotId: x2, dutyId: patrol, required: 1, users: [u.c] },
    { slotId: x2, dutyId: office, required: 1 },
    { slotId: x3, dutyId: reception, required: 2, users: [u.a] },
    { slotId: x3, dutyId: carry, required: 2, users: [ST, u.b] },
    { slotId: x3, dutyId: patrol, required: 1, users: [u.d] },
    { slotId: x3, dutyId: office, required: 1, users: [u.e] },
    { slotId: x4, dutyId: reception, required: 2 },
    { slotId: x4, dutyId: carry, required: 2, users: [u.c, u.d] },
    { slotId: x4, dutyId: patrol, required: 1, users: [u.a] },
    { slotId: x4, dutyId: office, required: 1, users: [H] },
    // 1日目：受付 3・運搬 2・駐輪場 1
    ...day1Slots.flatMap((id, k): NeedInput[] => [
      { slotId: id, dutyId: reception, required: 3, users: k === 0 ? [u.a, u.b, u.c] : k === 1 ? [ST, u.d] : [u.e] },
      { slotId: id, dutyId: carry, required: 2, users: k === 0 ? [u.d, u.e] : k === 1 ? [u.a] : [] },
      { slotId: id, dutyId: bike, required: 1, users: k < 2 ? [] : [u.b] },
    ]),
    // 2日目：片付け（運搬 3・本部 1）
    ...day2Slots.flatMap((id, k): NeedInput[] => [
      { slotId: id, dutyId: carry, required: 3, users: k === 0 ? [u.a, u.b, ST] : [u.c] },
      { slotId: id, dutyId: office, required: 1, users: [H] },
    ]),
    // 前々日（終わった日）
    { slotId: pastSlot, dutyId: carry, required: 2, users: [ST, u.c] },
  ];
  await insertNeeds(s.yearId, needs);

  const at = (date: string, time: string) => `${date}T${time}:00+09:00`;
  const [sign, map, roster, cords, bikeSign, desks, lost, officeTask] = await insertTasks(s.yearId, [
    { title: '看板の材料を買う', assigneeId: ST, dueAt: at(before, '17:00'), note: 'ベニヤ板 2 枚とペンキ（白・赤）', createdBy: H },
    { title: '配置図を印刷する', assigneeId: ST, dueAt: at(day1, '12:00'), status: 'doing', createdBy: H },
    { title: '受付の名簿を作る', assigneeId: u.a, dueAt: at(day2, '17:00'), createdBy: H },
    { title: '延長コードを数える', assigneeId: u.b, dueAt: at(addDays(today, 3), '17:00'), status: 'doing', createdBy: H },
    { title: '駐輪場の看板を立てる', assigneeId: null, dueAt: at(day1, '09:00'), createdBy: H },
    { title: '机の数を数える', assigneeId: u.c, dueAt: at(before, '12:00'), status: 'done', createdBy: H },
    { title: '落とし物の箱を用意する', assigneeId: H, dueAt: at(addDays(today, 5), '17:00'), note: '本部の入口に置く', createdBy: AD },
    { title: '本部の備品を返す', assigneeId: null, createdBy: H },
  ]);
  return {
    today,
    todaySlots,
    nowIndex,
    duties: { reception, carry, patrol, office, bike },
    tasks: { sign, map, roster, cords, bikeSign, desks, lost, office: officeTask },
  };
}

test.describe('T20 シフト・作業', () => {
  test('T20 シフト表（部門長・部門員。PC とスマホ）、ダイアログ、自分のシフト、作業一覧、ダッシュボード、印刷、衝突、終了した年度', async ({ browser }) => {
    test.setTimeout(420_000);
    const names = ['部門員A', '部門員B', '部門員C', '部門員D', '部門員E'] as const;
    const users: TestUser[] = [];
    for (const n of names) users.push(await createUser({ purpose: 'shotshift', name: n }));
    const [ua, ub, uc, ud, ue] = users as [TestUser, TestUser, TestUser, TestUser, TestUser];
    const s = await createScenario({
      status: 'confirmed',
      dataset: 'small',
      roles: { admin: true, head: true, staff: true },
      grants: users.map((u) => ({ userId: u.id, role: 'staff' as const })),
    });
    const closed = await createScenario({ status: 'closed', dataset: 'small', roles: { head: true, staff: true } });
    const pages: Page[] = [];
    try {
      await festivalTomorrow(s);
      const d = await seedShots(s, { a: ua.id, b: ub.id, c: uc.id, d: ud.id, e: ue.id });
      const nowSlot = d.todaySlots[d.nowIndex]!;

      // ---- シフト表（総務部門長・PC）：日のタブ（前日・1日目・2日目）、ます（あと1人・+1・—）、合計、操作
      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openShifts(head);
      await expect(head.locator(`[data-testid="shifts-day-tab"][data-day="${d.today}"]`)).toHaveAttribute('aria-current', 'page');
      await expect(head.locator(`[data-testid="shifts-day-tab"][data-day="${d.today}"]`)).toContainText('前日');
      await expect(head.locator('[data-testid="shift-cell"][data-state="over"]')).toHaveCount(1);
      await shoot(head, 'T20', 'shifts-head-pc', { fullPage: true });

      // 足りないますだけを目立たせる（ダッシュボードから来るとき）
      await openShifts(head, `?day=${d.today}&filter=short`);
      await expect(head.getByTestId('shifts-filter-short')).toBeChecked();
      await expect(head.locator('[data-testid="shift-cell"][data-short-highlight="true"]').first()).toBeVisible();
      await shoot(head, 'T20', 'shifts-short-head-pc', { fullPage: true });

      // 1日分をまとめて作る（2日目の翌日に 09:00〜15:00。持ち場ごとの必要人数）。撮るだけで作らない
      await openShifts(head);
      await head.getByTestId('shifts-add-day').click();
      const dayDialog = head.getByRole('dialog', { name: '1日分をまとめて作る' });
      await dayDialog.getByTestId('shift-day-date').fill(addDays(d.today, 3));
      await dayDialog.getByTestId('shift-day-start').selectOption('09:00');
      await dayDialog.getByTestId('shift-day-end').selectOption('15:00');
      await dayDialog.getByRole('button', { name: '受付の必要人数を1増やす' }).click();
      await dayDialog.getByRole('button', { name: '運搬の必要人数を1増やす' }).click();
      await dayDialog.getByRole('checkbox', { name: '駐輪場を置く' }).click();
      await expect(dayDialog.getByTestId('shift-day-preview-slot')).toHaveCount(6);
      await shoot(head, 'T20', 'shift-day-dialog-pc');
      await dayDialog.getByRole('button', { name: 'やめる' }).click();
      await head.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();

      // ますのダイアログ（今の枠の運搬。あと1人）：同じ時間枠の受付の人は「受付に入っています」
      await shiftCell(head, nowSlot, d.duties.carry).getByRole('button').click();
      const cellDialog = head.getByRole('dialog').filter({ has: head.getByTestId('shift-member-picker') });
      await expect(cellDialog.locator('[data-testid="shift-member-option"][data-state="busy"]').first()).toBeVisible();
      await shoot(head, 'T20', 'shift-cell-dialog-pc');
      await cellDialog.getByRole('button', { name: '閉じる' }).click();

      // 持ち場を直す（受付。場所と説明）
      await head.getByRole('button', { name: '持ち場「受付」を直す' }).click();
      const dutyDialog = head.getByRole('dialog', { name: '持ち場を直す' });
      await expect(dutyDialog.getByTestId('shift-duty-name')).toHaveValue('受付');
      await shoot(head, 'T20', 'shift-duty-dialog-pc');
      await dutyDialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dutyDialog).toHaveCount(0);

      // ---- シフト表（総務部門員）：読むだけ・自分の名前。PC とスマホ（時間枠ごとのカード）
      const staff = await openAs(browser, 'staff', s);
      pages.push(staff);
      await openShifts(staff);
      await expect(staff.locator('[data-testid="shift-cell-member"][data-me="true"]').first()).toBeVisible();
      await expect(staff.getByTestId('shifts-add-day')).toHaveCount(0);
      await shoot(staff, 'T20', 'shifts-staff-pc', { fullPage: true });
      await staff.setViewportSize(MOBILE);
      await openShifts(staff);
      await expectNoOverflow(staff);
      await shoot(staff, 'T20', 'shifts-staff-mobile', { fullPage: true });

      // ---- 自分のシフト（スマホ）：今・次の印、場所・説明・同じますの人。空（管理者は割り当てがない）
      await openMyShift(staff);
      // 部門員は今日の 2〜4 つ目の枠に入る（撮る時刻が 2 時〜21 時なら、今の枠は 3 つ目）
      await expect(staff.getByTestId('my-shift-now')).toHaveCount(d.nowIndex >= 1 && d.nowIndex <= 3 ? 1 : 0);
      await expectNoOverflow(staff);
      await shoot(staff, 'T20', 'my-shift-staff-mobile', { fullPage: true });
      const admin = await openAs(browser, 'admin', s, MOBILE);
      pages.push(admin);
      await openMyShift(admin);
      await expect(admin.getByTestId('my-shift-empty')).toContainText('あなたのシフトはまだありません');
      await expectNoOverflow(admin);
      await shoot(admin, 'T20', 'my-shift-empty-mobile');

      // ---- 作業一覧（部門長・PC）：進み具合・絞り込み・状態・締切を過ぎた
      await openTasks(head);
      await expect(head.getByTestId('tasks-item')).toHaveCount(8);
      await shoot(head, 'T20', 'tasks-head-pc', { fullPage: true });
      // lg（1024px。左のナビを除いて約 750px）では6つの列が入らないので、カードの縦並び（表の並びは xl から）
      await head.setViewportSize({ width: 1024, height: 800 });
      await expect(head.getByText('題名と説明', { exact: true })).toBeHidden();
      await shoot(head, 'T20', 'tasks-head-lg');
      await head.setViewportSize(PC);
      // 作業を足すダイアログ（担当者・締切の日付と時刻）。撮るだけで足さない
      await head.getByTestId('tasks-add').click();
      const taskDialog = head.getByRole('dialog', { name: '作業を足す' });
      await taskDialog.getByTestId('task-title').fill('ごみ袋を本部に運ぶ');
      await taskDialog.getByTestId('task-note').fill('45 L を 20 枚。\n台車は体育館の倉庫にある。');
      await taskDialog.getByTestId('task-assignee').selectOption(ud.id);
      await taskDialog.getByTestId('task-due-date').fill(addDays(d.today, 1));
      await expect(taskDialog.getByTestId('task-due-time')).toHaveValue('17:00');
      await shoot(head, 'T20', 'task-dialog-pc');
      await taskDialog.getByRole('button', { name: 'やめる' }).click();
      await head.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();

      // ---- 作業一覧（部門員・スマホ）：自分の作業と状態のボタン
      await openTasks(staff);
      await expect(taskItem(staff, d.tasks.sign).getByTestId('tasks-item-status-buttons')).toBeVisible();
      await expectNoOverflow(staff);
      await shoot(staff, 'T20', 'tasks-staff-mobile', { fullPage: true });

      // ---- 編集の衝突（部門長が先に題名を変え、管理者の保存が止まる）
      await admin.setViewportSize(PC);
      for (const p of [head, admin]) {
        await openTasks(p);
        await taskItem(p, d.tasks.roster).getByRole('button', { name: '「受付の名簿を作る」を編集' }).click();
      }
      const hd = head.getByRole('dialog', { name: '作業を編集' });
      await hd.getByTestId('task-title').fill('受付の名簿を作る（2部）');
      await hd.getByTestId('task-submit').click();
      await expect(hd).toHaveCount(0);
      const ad = admin.getByRole('dialog', { name: '作業を編集' });
      await ad.getByTestId('task-note').fill('A4 で 2 部。1 部は本部に置く');
      await ad.getByTestId('task-submit').click();
      await expect(ad.getByTestId('task-conflict')).toBeVisible();
      await shoot(admin, 'T20', 'task-conflict-pc');
      await ad.getByRole('button', { name: 'やめる' }).click();
      await admin.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();

      // ---- ダッシュボード（部門員・スマホ、部門長・PC）
      await staff.setViewportSize(MOBILE);
      await openPortal(staff, 'ダッシュボード');
      await expect(shiftsCard(staff)).toBeVisible();
      await expect(staff.locator('[data-testid="portal-todo"][data-id="shifts:today"]')).toBeVisible();
      await expectNoOverflow(staff);
      await shoot(staff, 'T20', 'portal-shifts-staff-mobile', { fullPage: true });
      await openPortal(head, 'ダッシュボード');
      await expect(shiftsCard(head)).toBeVisible();
      await expect(head.locator('[data-testid="portal-todo"][data-id="shifts:short"]')).toBeVisible();
      await shoot(head, 'T20', 'portal-shifts-head-pc', { fullPage: true });

      // ---- 印刷（日ごとの表は A4 横、人ごとは A4 縦。印刷の見た目〔ヘッダー・ナビ・操作を隠す〕）
      await head.setViewportSize(A4_LANDSCAPE);
      await head.goto(`/shifts/print/?day=${d.today}`);
      await expect(head.getByTestId('shifts-print-table')).toHaveCount(1);
      await head.emulateMedia({ media: 'print' });
      await shoot(head, 'T20', 'shifts-print-table', { fullPage: true });
      await head.emulateMedia({ media: 'screen' });
      await head.setViewportSize(A4_PORTRAIT);
      await head.goto(`/shifts/print/?day=${d.today}&view=people`);
      await expect(head.getByTestId('shifts-print-person').first()).toBeVisible();
      await head.emulateMedia({ media: 'print' });
      await shoot(head, 'T20', 'shifts-print-people', { fullPage: true });
      await head.emulateMedia({ media: 'screen' });

      // ---- 終了した年度（部門長・PC）：帯、操作なし
      const t = await insertTasks(closed.yearId, [
        { title: '片付けの報告を書く', assigneeId: ST, dueAt: `${addDays(d.today, -3)}T17:00:00+09:00`, status: 'done', createdBy: H },
        { title: '借りた机を返す', assigneeId: H, dueAt: `${addDays(d.today, -2)}T12:00:00+09:00`, status: 'doing', createdBy: H },
        { title: '来年への申し送りをまとめる', assigneeId: null, createdBy: H },
      ]);
      expect(t).toHaveLength(3);
      const headClosed = await openAs(browser, 'head', closed);
      pages.push(headClosed);
      await openTasks(headClosed);
      await expect(headClosed.getByTestId('read-only-notice')).toHaveText('終了した年度のため、シフトと作業は読むだけです');
      await expect(headClosed.getByTestId('tasks-item-status-buttons')).toHaveCount(0);
      await shoot(headClosed, 'T20', 'tasks-closed-head-pc', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
      await closed.cleanup();
      for (const u of users) await u.cleanup();
    }
  });
});
