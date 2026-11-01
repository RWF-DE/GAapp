import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { addDays, calendarItem, calendarItemIds, openCalendar, portalDatedIds, portalDatedItem, shortDate } from './support/calendar';
import { createScenario } from './support/db';
import { openPortal } from './support/notices';
import { MOBILE, PC } from './support/shots';
import {
  expectNoOverflow,
  insertDuties,
  insertNeeds,
  insertSlots,
  insertTasks,
  portalTodo,
  portalTodoIds,
  shiftCell,
  shiftsCard,
  slotAt,
  slotLabel,
  slotsAroundNow,
  slotStart,
} from './support/shifts';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T20 ダッシュボードに出すもの（シフト・作業。04「ダッシュボードに出すもの（シフト・作業）」、D-52・D-56、notes/T20.md の「テストの計画」の
// E2E の 5）。シナリオの年度（small）で閉じ、時間枠・作業は e2e/support/shifts.ts で SQL から入れる。今日・今の枠は テストの時計の
// Asia/Tokyo で決め、期待値も同じ時計から作る（23 時より後は次の枠が明日になる）。期待値の文言は 04 のとおりに書く（アプリの定数から
// 引かない）。立場の読み込みと同じ表（year_roles）を読むので、e2e/t16-portal.spec.ts の「立場の読み込みのほか」には出ない。ここで
// select ごと確かめる。

const H = SEED_USER_IDS.head;
const ST = SEED_USER_IDS.staff;

/** 総務の全員：自分の割り当てと、自分が担当の完了でない作業を year_roles の自分の行に埋め込んだ1本 */
const MINE_READ =
  'year_roles?select=user_id,shift_assignments(slot_id,duty_id,shift_needs(shift_slots(starts_at,ends_at),shift_duties(name))),tasks(id,title,status,due_at)';
/** 部門長以上：時間枠ごとのます（割り当てた人のロール）と、作業の全部（担当者のロール） */
const LEAD_SLOTS_READ = 'shift_slots?select=id,starts_at,ends_at,shift_needs(duty_id,required_count,shift_assignments(user_id,year_roles(role)))';
const LEAD_TASKS_READ = 'tasks?select=id,title,status,due_at,assignee_id,year_roles(role)';

interface RestRead {
  /** `{表}?select={select}` */
  read: string;
  params: URLSearchParams;
}

/** ページが Supabase の /rest/v1/ に送った GET（CORS の preflight を除く）。goto の前に呼ぶ */
function watchReads(page: Page): RestRead[] {
  const out: RestRead[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') return;
    const u = new URL(r.url());
    const m = /\/rest\/v1\/(.+)$/.exec(u.pathname);
    if (!m) return;
    out.push({ read: `${m[1]}?select=${u.searchParams.get('select') ?? ''}`, params: u.searchParams });
  });
  return out;
}

/**
 * その年度のシフト・作業の読み取り（5表を読むものと、year_roles に割り当てを埋め込んだもの）。storageState が覚えている年度（ログインの
 * 準備で開いた seed の年度）の読み取り（先読みと、覚えたリクエストの先送り）は数えない（シナリオの年度を pinYear で開くと、覚えた年度の
 * 分も先に読むため。e2e/t16-portal.spec.ts の rememberYear と同じ事情）
 */
const shiftReads = (reads: readonly RestRead[], yearId: string) =>
  reads.filter(
    (r) =>
      r.params.get('year_id') === `eq.${yearId}` &&
      (/^(shift_|tasks\?)/.test(r.read) || (r.read.startsWith('year_roles?') && r.read.includes('shift_assignments'))),
  );

/** 日付の短い形（「11/3」。要対応の「締切 11/3 17:00」と足りない枠の日） */
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---------------------------------------------------------------- 総務部門員（スマホ）

test.describe('T20 ダッシュボード（総務部門員・スマホ）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: MOBILE });

  test('T20 総務部門員の /：要対応に今日のシフト（今の枠と「今日あと N 枠」）と自分の作業（締切を過ぎたら急ぎ・3日以内はふつう）、カード「シフト・作業」（自分のシフトへ）、締切と予定に作業の締切と自分のシフトの日。/calendar の機能の日付にも出る。読むのは year_roles に埋め込んだ1本だけ', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true } });
    try {
      const t = slotsAroundNow();
      const year = Number(t.today.slice(0, 4));
      const tomorrow = addDays(t.today, 1);
      const [reception, carry] = (await insertDuties(s.yearId, [{ name: '受付', place: '正門のテント' }, { name: '運搬' }])) as [string, string];
      const [sNow, sNext] = (await insertSlots(s.yearId, [t.now, t.next])) as [string, string];
      await insertNeeds(s.yearId, [
        { slotId: sNow, dutyId: reception, required: 1, users: [ST] },
        { slotId: sNext, dutyId: carry, required: 1, users: [ST] },
      ]);
      const overdueDue = `${addDays(t.today, -1)}T17:00:00+09:00`;
      const soonDay = addDays(t.today, 2);
      const [overdue, soon] = await insertTasks(s.yearId, [
        { title: 'E2E 看板の材料を買う', assigneeId: ST, dueAt: overdueDue, createdBy: H },
        { title: 'E2E 配置図を印刷する', assigneeId: ST, dueAt: `${soonDay}T12:00:00+09:00`, status: 'doing', createdBy: H },
        { title: 'E2E 机の数を数える', assigneeId: ST, dueAt: overdueDue, status: 'done', createdBy: H },
        { title: 'E2E 部門長の作業', assigneeId: H, dueAt: `${soonDay}T12:00:00+09:00`, createdBy: H },
      ]);
      const reads = watchReads(page);
      await pinYear(page, ST, s.yearId);
      await openPortal(page, 'ダッシュボード');

      // 要対応：締切を過ぎた自分の作業（急ぎ）→ 3日以内の自分の作業（ふつう・期日）→ 今日のシフト（ふつう・期日なし）。完了した作業と
      // ほかの人の作業は出ない
      await expect.poll(async () => (await portalTodoIds(page)).filter((id) => id.startsWith('shifts:'))).toEqual([
        `shifts:task:${overdue}`,
        `shifts:task:${soon}`,
        'shifts:today',
      ]);
      const o = portalTodo(page, `shifts:task:${overdue}`);
      await expect(o).toHaveAttribute('data-severity', 'urgent');
      await expect(o).toHaveAttribute('data-module', 'shifts');
      await expect(o).toContainText('シフト・作業');
      await expect(o).toContainText('急ぎ');
      await expect(o).toContainText('作業「E2E 看板の材料を買う」（未着手）');
      await expect(o.getByTestId('portal-todo-due')).toHaveText(`締切 ${md(addDays(t.today, -1))} 17:00 を過ぎました`);
      await expect(o.getByRole('link')).toHaveAttribute('href', new RegExp(`/tasks/?\\?task=${overdue}$`));
      const so = portalTodo(page, `shifts:task:${soon}`);
      await expect(so).toHaveAttribute('data-severity', 'normal');
      await expect(so).toContainText('作業「E2E 配置図を印刷する」（作業中）');
      await expect(so.getByTestId('portal-todo-due')).toHaveText(`締切 ${md(soonDay)} 12:00`);
      const today = portalTodo(page, 'shifts:today');
      await expect(today).toHaveAttribute('data-severity', 'normal');
      await expect(today).toContainText(`今日のシフト：今 ${slotLabel(t.now)} 受付${t.nextIsToday ? '（今日あと 1 枠）' : ''}`);
      await expect(today.getByTestId('portal-todo-due')).toHaveCount(0);
      await expect(today.getByRole('link')).toHaveAttribute('href', /\/shift\/?$/);
      await expect(page.getByTestId('portal-todos')).not.toContainText('E2E 机の数を数える');
      await expect(page.getByTestId('portal-todos')).not.toContainText('E2E 部門長の作業');

      // カード：今日のあなたのシフト（今の枠）と自分の作業。リンクは「自分のシフトへ」
      const card = shiftsCard(page);
      await expect(card.getByRole('heading', { level: 3 })).toHaveText('シフト・作業');
      await expect(card.getByRole('listitem')).toHaveText([
        `今日のあなたのシフト ${t.nextIsToday ? 2 : 1} 枠（今 ${slotStart(t.now)}〜 受付）`,
        '自分の作業 2 件（作業中 1・未着手 1）',
      ]);
      await expect(card.getByRole('link', { name: '自分のシフトへ' })).toHaveAttribute('href', /\/shift\/?$/);

      // 締切と予定：自分が担当の完了でない作業の締切（過ぎたものは「締切を過ぎました」）と、自分のシフトのある日（日付だけ。予定）
      const days = t.nextIsToday ? [`shifts:day:${t.today}`] : [`shifts:day:${t.today}`, `shifts:day:${tomorrow}`];
      await expect
        .poll(async () => (await portalDatedIds(page)).filter((id) => id.startsWith('shifts:')))
        .toEqual([`shifts:task-due:${overdue}`, ...days, `shifts:task-due:${soon}`]);
      const overItem = portalDatedItem(page, `shifts:task-due:${overdue}`);
      await expect(overItem).toHaveAttribute('data-kind', 'deadline');
      await expect(overItem).toContainText('作業の締切：E2E 看板の材料を買う');
      await expect(overItem.getByTestId('portal-dated-relative')).toHaveText('締切を過ぎました');
      const dayItem = portalDatedItem(page, `shifts:day:${t.today}`);
      await expect(dayItem).toHaveAttribute('data-kind', 'event');
      await expect(dayItem).toHaveAttribute('data-module', 'shifts');
      await expect(dayItem).toContainText(
        t.nextIsToday ? `自分のシフト（2 枠。${slotStart(t.now)}〜 受付 ほか）` : `自分のシフト（1 枠。${slotStart(t.now)}〜 受付）`,
      );
      await expect(dayItem.getByTestId('portal-dated-when')).toHaveText(shortDate(t.today, year));
      await expect(dayItem.getByTestId('portal-dated-relative')).toHaveText('今日');
      await expect(dayItem.getByRole('link')).toHaveAttribute('href', new RegExp(`/shift/?\\?day=${t.today}$`));
      const soonItem = portalDatedItem(page, `shifts:task-due:${soon}`);
      await expect(soonItem).toHaveAttribute('data-kind', 'deadline');
      await expect(soonItem).toContainText('作業の締切：E2E 配置図を印刷する');
      await expect(soonItem.getByTestId('portal-dated-when')).toHaveText(`${shortDate(soonDay, year)}12:00`);
      await expect(soonItem.getByTestId('portal-dated-relative')).toHaveText('あと 2 日');
      await expect(soonItem.getByRole('link')).toHaveAttribute('href', new RegExp(`/tasks/?\\?task=${soon}$`));
      await expectNoOverflow(page);

      // 読むのは year_roles の自分の行に割り当てと完了でない作業を埋め込んだ1本だけ（先読みと3つの欄が同じキー）。ほかの人のロールを
      // 埋め込む部門長以上の読み取り（shift_slots・tasks）は送らない
      await page.waitForLoadState('networkidle');
      const mine = shiftReads(reads, s.yearId);
      expect(mine.map((r) => r.read)).toEqual([MINE_READ]);
      expect(mine[0]!.params.get('year_id')).toBe(`eq.${s.yearId}`);
      expect(mine[0]!.params.get('user_id')).toBe(`eq.${ST}`);
      expect(mine[0]!.params.get('tasks.status')).toBe('neq.done');

      // 作業の締切から作業一覧へ：その作業を目立たせ、絞り込みは「すべて」
      await soonItem.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/tasks/?\\?task=${soon}$`));
      await expect(page.locator(`[data-testid="tasks-item"][data-id="${soon}"]`)).toHaveAttribute('data-highlighted', 'true');
      await expect(page.locator('[data-testid="tasks-item"][data-highlighted]')).toHaveCount(1);
      await expect(page.getByTestId('tasks-filter').locator('[role="radio"][aria-checked="true"]')).toHaveText([/^すべて/]);

      // 締切と予定の一覧（/calendar）の機能の日付にも出る（既定は今日から：過ぎた締切は出ない）
      await openCalendar(page);
      await expect
        .poll(async () => (await calendarItemIds(page)).filter((id) => id.startsWith('shifts:')))
        .toEqual([...days, `shifts:task-due:${soon}`]);
      const calDay = calendarItem(page, `shifts:day:${t.today}`);
      await expect(calDay.getByTestId('calendar-item-module')).toHaveText('シフト・作業');
      await expect(calDay.getByTestId('calendar-item-kind')).toHaveText('予定');
      await expect(calDay.getByRole('link')).toHaveAttribute('href', new RegExp(`/shift/?\\?day=${t.today}$`));
      await expect(calendarItem(page, `shifts:task-due:${soon}`).getByTestId('calendar-item-kind')).toHaveText('締切');

      // 今日のシフトの要対応から自分のシフトへ
      await openPortal(page, 'ダッシュボード');
      await portalTodo(page, 'shifts:today').getByRole('link').click();
      await expect(page).toHaveURL(/\/shift\/?$/);
      await expect(page.getByRole('heading', { level: 1, name: '自分のシフト' })).toBeVisible();
      await expect(page.locator(`[data-testid="my-shift-item"][data-slot-id="${sNow}"]`).getByTestId('my-shift-now')).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 総務部門長（PC）

test.describe('T20 ダッシュボード（総務部門長・PC）', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T20 総務部門長の /：要対応に人数が足りない枠（日ごとの数。24 時間以内の枠があれば急ぎ）・締切を過ぎた作業（急ぎ）・締切が近い作業・担当者のいない作業、カードに足りない枠と作業の進み具合（シフト表へ）。足りない枠から ?filter=short のシフト表へ。読むのは3本を1回ずつ。シフト・作業の読み取りが通信で失敗すると、要対応・締切と予定・カードにその分だけ失敗と「もう一度」が出て、ほかは出たまま。もう一度で直る', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true } });
    const route = '**/rest/v1/shift_slots*';
    try {
      const t = slotsAroundNow();
      const year = Number(t.today.slice(0, 4));
      const d1 = addDays(t.today, 2);
      const d2 = addDays(t.today, 3);
      const yesterday = addDays(t.today, -1);
      const [reception, carry] = (await insertDuties(s.yearId, [{ name: '受付' }, { name: '運搬' }])) as [string, string];
      const [a1, b1, p1] = (await insertSlots(s.yearId, [slotAt(d1, '09:00', '10:00'), slotAt(d2, '09:00', '10:00'), slotAt(yesterday, '09:00', '10:00')])) as [
        string,
        string,
        string,
      ];
      await insertNeeds(s.yearId, [
        // d1：受付 1/2・運搬 0/1（どちらも足りない）
        { slotId: a1, dutyId: reception, required: 2, users: [ST] },
        { slotId: a1, dutyId: carry, required: 1 },
        // d2：受付 0/1（足りない）・運搬は人数を決めない（0。足りないに数えない）
        { slotId: b1, dutyId: reception, required: 1 },
        { slotId: b1, dutyId: carry, required: 0 },
        // 昨日の枠は終わっているので数えない
        { slotId: p1, dutyId: reception, required: 3 },
      ]);
      await insertTasks(s.yearId, [
        { title: 'E2E 看板の材料を買う', assigneeId: ST, dueAt: `${yesterday}T17:00:00+09:00`, createdBy: H },
        { title: 'E2E 配置図を印刷する', assigneeId: ST, dueAt: `${d1}T17:00:00+09:00`, status: 'doing', createdBy: H },
        { title: 'E2E 受付の名簿を作る', assigneeId: null, createdBy: H },
        { title: 'E2E 机の数を数える', assigneeId: H, dueAt: `${yesterday}T12:00:00+09:00`, status: 'done', createdBy: H },
      ]);
      const reads = watchReads(page);
      await pinYear(page, H, s.yearId);
      await openPortal(page, 'ダッシュボード');

      // 要対応：締切を過ぎた（急ぎ）→ 締切が近い（ふつう・期日）→ 足りない枠・担当者なし（ふつう）
      await expect
        .poll(async () => (await portalTodoIds(page)).filter((id) => id.startsWith('shifts:')))
        .toEqual(['shifts:overdue', 'shifts:due-soon', 'shifts:short', 'shifts:unassigned']);
      const overdue = portalTodo(page, 'shifts:overdue');
      await expect(overdue).toHaveAttribute('data-severity', 'urgent');
      await expect(overdue).toContainText('締切を過ぎた作業 1 件');
      await expect(overdue.getByRole('link')).toHaveAttribute('href', /\/tasks\/?\?filter=overdue$/);
      const soon = portalTodo(page, 'shifts:due-soon');
      await expect(soon).toHaveAttribute('data-severity', 'normal');
      await expect(soon).toContainText('締切が近い作業 1 件（3日以内）');
      await expect(soon.getByTestId('portal-todo-due')).toHaveText(`締切 ${md(d1)} 17:00`);
      await expect(soon.getByRole('link')).toHaveAttribute('href', /\/tasks\/?\?filter=due-soon$/);
      const short = portalTodo(page, 'shifts:short');
      await expect(short).toHaveAttribute('data-severity', 'normal');
      await expect(short).toContainText(`人数が足りない枠 3（${md(d1)} 2・${md(d2)} 1）`);
      await expect(short.getByRole('link')).toHaveAttribute('href', new RegExp(`/shifts/?\\?day=${d1}&filter=short$`));
      const unassigned = portalTodo(page, 'shifts:unassigned');
      await expect(unassigned).toContainText('担当者のいない作業 1 件');
      await expect(unassigned.getByRole('link')).toHaveAttribute('href', /\/tasks\/?\?filter=unassigned$/);

      // カード：自分のシフト（ない）・足りない枠・作業の進み具合。リンクは「シフト表へ」
      const card = shiftsCard(page);
      await expect(card.getByRole('listitem')).toHaveText([
        'あなたのシフトはまだありません',
        '人数が足りない枠 3（これからの枠）',
        '作業 1／4 件が完了（締切を過ぎた 1 件）',
      ]);
      await expect(card.getByRole('link', { name: 'シフト表へ' })).toHaveAttribute('href', /\/shifts\/?$/);
      // 締切と予定：部門長以上にも、作業全体の締切は出さない（自分の作業と自分のシフトだけ。ここではどちらもない）
      expect((await portalDatedIds(page)).filter((id) => id.startsWith('shifts:'))).toEqual([]);

      // 読むのは3本（自分の分・時間枠のます・作業の全部）を1回ずつ（先読みと3つの欄が同じキー）
      await page.waitForLoadState('networkidle');
      expect(shiftReads(reads, s.yearId).map((r) => r.read).sort()).toEqual([LEAD_SLOTS_READ, LEAD_TASKS_READ, MINE_READ].sort());

      // 今の枠に足りないますがあると、足りない枠は急ぎ（開始まで 24 時間を切った枠。今の枠を含む）。日ごとの数は日の早い順で、行き先は最初の日
      const [nowSlot] = (await insertSlots(s.yearId, [t.now])) as [string];
      await insertNeeds(s.yearId, [{ slotId: nowSlot, dutyId: reception, required: 1 }]);
      await openPortal(page, 'ダッシュボード');
      await expect
        .poll(async () => (await portalTodoIds(page)).filter((id) => id.startsWith('shifts:')))
        .toEqual(['shifts:short', 'shifts:overdue', 'shifts:due-soon', 'shifts:unassigned']);
      await expect(short).toHaveAttribute('data-severity', 'urgent');
      await expect(short).toContainText(`人数が足りない枠 4（${md(t.today)} 1・${md(d1)} 2・${md(d2)} 1）`);
      await expect(short.getByRole('link')).toHaveAttribute('href', new RegExp(`/shifts/?\\?day=${t.today}&filter=short$`));
      await expect(card.getByRole('listitem').nth(1)).toHaveText('人数が足りない枠 4（これからの枠）');

      // 足りない枠からシフト表へ：「足りないますだけを目立たせる」で、これからの足りないますを目立たせる
      await short.getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/shifts/?\\?day=${t.today}&filter=short$`));
      await expect(page.getByTestId('shifts-filter-short')).toBeChecked();
      await expect(shiftCell(page, nowSlot, reception)).toHaveAttribute('data-short-highlight', 'true');
      await expect(shiftCell(page, nowSlot, carry)).not.toHaveAttribute('data-short-highlight', 'true');
      await page.locator(`[data-testid="shifts-day-tab"][data-day="${d1}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/shifts/?\\?day=${d1}&filter=short$`));
      await expect(shiftCell(page, a1, reception)).toHaveAttribute('data-short-highlight', 'true');
      await expect(shiftCell(page, a1, carry)).toHaveAttribute('data-short-highlight', 'true');
      await expect(page.locator(`[data-testid="shifts-day-tab"][data-day="${d1}"]`)).toHaveText(shortDate(d1, year));
      // 外すと目立たせない（URL から filter を外す）
      await page.getByTestId('shifts-filter-short').click();
      await expect(page).toHaveURL(new RegExp(`/shifts/?\\?day=${d1}$`));
      await expect(page.locator('[data-testid="shift-cell"][data-short-highlight]')).toHaveCount(0);

      // 欄の失敗：部門長以上の時間枠の読み取りを通信の失敗にする（supabase-js と TanStack Query の読み直しの後に出る）
      await page.route(route, (r) => r.abort());
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
      const errors = page.locator('[data-testid="portal-module-error"][data-module="shifts"]');
      await expect(errors).toHaveCount(3, { timeout: 60_000 });
      for (const w of ['portal-todos', 'portal-dated', 'portal-cards']) {
        const e = page.getByTestId(w).getByTestId('portal-module-error');
        await expect(e).toHaveCount(1);
        await expect(e).toHaveAttribute('data-module', 'shifts');
        await expect(e).toContainText('通信できませんでした。電波の良い所でもう一度');
        await expect(e.getByRole('button', { name: 'もう一度' })).toBeVisible();
      }
      await expect(page.getByTestId('portal-todos').getByTestId('portal-module-error')).toContainText('シフト・作業：通信できませんでした');
      // カードの欄は見出し「シフト・作業」と入口（シフト表へ）を出す
      await expect(page.getByTestId('portal-cards').getByRole('heading', { level: 3, name: 'シフト・作業' })).toBeVisible();
      await expect(page.getByTestId('portal-cards').getByRole('link', { name: 'シフト表へ' })).toHaveAttribute('href', /\/shifts\/?$/);
      await expect(shiftsCard(page)).toHaveCount(0);
      // ほかの機能は出たまま（机椅子のカード・締切と予定の机椅子の日付）。欄ごとの例外の表示にはならない
      await expect(page.locator('[data-testid="module-card"][data-module="furniture"]')).toBeVisible();
      await expect(portalDatedItem(page, 'furniture:request-close')).toBeVisible();
      await expect(page.getByTestId('portal-module-error')).toHaveCount(3);
      await expect(page.getByTestId('portal-widget-error')).toHaveCount(0);
      await expect(page.locator('[data-testid="portal-todo"][data-module="shifts"]')).toHaveCount(0);

      // 通信が戻って「もう一度」を押すと、3つの欄とも出る（同じ読み込み）
      await page.unroute(route);
      await page.getByTestId('portal-todos').getByTestId('portal-module-error').getByRole('button', { name: 'もう一度' }).click();
      await expect(shiftsCard(page)).toBeVisible();
      await expect(page.getByTestId('portal-module-error')).toHaveCount(0);
      await expect
        .poll(async () => (await portalTodoIds(page)).filter((id) => id.startsWith('shifts:')))
        .toEqual(['shifts:short', 'shifts:overdue', 'shifts:due-soon', 'shifts:unassigned']);
    } finally {
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});
