import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import { addDays, shortDate, tokyoToday } from './support/calendar';
import { createScenario, type Scenario } from './support/db';
import { MOBILE, PC } from './support/shots';
import {
  expectNoOverflow,
  insertDuties,
  insertNeeds,
  insertSlots,
  insertTasks,
  myShiftItem,
  openMyShift,
  openShifts,
  openTasks,
  shiftCell,
  slotsAroundNow,
  taskIds,
  taskItem,
  tasksOf,
  taskUpdatedLabel,
  taskUpdatedShort,
} from './support/shifts';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T20 作業（/tasks。04「作業一覧」、D-56、notes/T20.md の「テストの計画」の E2E の 4）と、終了した年度で読むだけになること（シフト表も）。
// シナリオの年度（small）で閉じ、年度をまたぐ表には書かない。作業は画面から作るほか、e2e/support/shifts.ts で SQL から入れる（書いた人を
// 入れる）。締切はテストの時計の Asia/Tokyo の今日からの日数で決め、期待値の曜日も同じ今日から作る。期待値の文言は 04 のとおりに書く。

const H = SEED_USER_IDS.head;
const ST = SEED_USER_IDS.staff;
const AD = SEED_USER_IDS.admin;
const CLOSED = '終了した年度のため、シフトと作業は読むだけです';

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 作業の状態のボタン（「未着手」「作業中」「完了」） */
const statusButton = (page: Page, id: string, label: '未着手' | '作業中' | '完了') =>
  taskItem(page, id).getByTestId('tasks-item-status-buttons').getByRole('button', { name: label, exact: true });

test('T20 作業：部門長が作業を足して担当（部門員）と締切を決める（題名の空・時刻だけは誤り。日付を入れると時刻は 17:00）。部門員はスマホの既定「自分の作業」で状態のボタン（作業中・完了）を押せ、部門長の進み具合が変わる。何も変えない編集は送らず、削除は確かめてから', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true } });
  const head = await openAs(browser, 'head', s, PC);
  const staff = await openAs(browser, 'staff', s, MOBILE);
  try {
    const today = tokyoToday();
    const year = Number(today.slice(0, 4));
    const due = addDays(today, 2);
    // 締切を過ぎた、担当者のいない作業（SQL で入れる）
    const overdueTitle = 'E2E 去年の備品の返却';
    const [overdueId] = await insertTasks(s.yearId, [
      { title: overdueTitle, assigneeId: null, dueAt: `${addDays(today, -1)}T17:00:00+09:00`, createdBy: H },
    ]);

    await openTasks(head);
    await expect(head.getByTestId('tasks-progress')).toHaveText('完了 0／1（作業中 0・未着手 1・締切を過ぎた 1）');
    // 部門長の既定の絞り込みは「すべて」
    await expect(head.getByTestId('tasks-filter').locator('[role="radio"][aria-checked="true"]')).toHaveText(['すべて（1）']);
    await expect(head.getByTestId('read-only-notice')).toHaveCount(0);

    // 作業を足す：題名が空・時刻だけは送る前に止める
    await head.getByTestId('tasks-add').click();
    const dialog = head.getByRole('dialog', { name: '作業を足す' });
    await dialog.getByTestId('task-submit').click();
    await expect(dialog.locator('[data-field-error="title"]')).toHaveText('題名を入れてください');
    const title = '看板の材料を買う';
    await dialog.getByTestId('task-title').fill(`  ${title}\u3000`);
    await expect(dialog.getByTestId('task-title-count')).toHaveText(`${[...title].length}/100`);
    await dialog.getByTestId('task-due-time').fill('10:00');
    await dialog.getByTestId('task-submit').click();
    await expect(dialog.locator('[data-field-error="dueDate"]')).toHaveText('締切の日付を入れてください');
    // 時刻を空にして日付を入れると、時刻の既定は 17:00
    await dialog.getByTestId('task-due-time').fill('');
    await dialog.getByTestId('task-due-date').fill(due);
    await expect(dialog.getByTestId('task-due-time')).toHaveValue('17:00');
    // 担当者：最初は「担当者なし」、その年度の総務をロールの表示名つきで
    const assignee = dialog.getByTestId('task-assignee');
    await expect(assignee.locator('option')).toHaveCount(3);
    await expect(assignee.locator('option').first()).toHaveText('担当者なし');
    await expect(assignee.locator(`option[value="${ST}"]`)).toHaveText('テスト部員（総務部門員）');
    await expect(assignee.locator(`option[value="${H}"]`)).toHaveText('テスト部門長（総務部門長）');
    await assignee.selectOption(ST);
    await dialog.getByTestId('task-note').fill('ベニヤ板 2 枚\nペンキ（白・赤）');
    await dialog.getByTestId('task-submit').click();
    await expect(head.getByText(`「${title}」を足しました`)).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // DB：題名は前後の空白を除き、締切は Asia/Tokyo の 17:00、状態は未着手、書いた人は部門長
    const created = (await tasksOf(s.yearId)).find((r) => r.title === title)!;
    expect(created).toMatchObject({
      note: 'ベニヤ板 2 枚\nペンキ（白・赤）',
      assignee_id: ST,
      due: `${due}T17:00`,
      status: 'todo',
      created_by: H,
      updated_by: H,
    });
    const id = created.id;

    // 一覧：完了でないものを締切の早い順。状態・担当者・締切（曜日つき）・説明・直した人と日時。過ぎた締切は「締切を過ぎました」
    await expect.poll(() => taskIds(head)).toEqual([overdueId, id]);
    const item = taskItem(head, id);
    await expect(item.getByTestId('tasks-item-title')).toHaveText(title);
    await expect(item.getByTestId('tasks-item-status')).toHaveText('未着手');
    await expect(item.getByTestId('tasks-item-assignee')).toHaveText('テスト部員');
    await expect(item.getByTestId('tasks-item-due')).toHaveText(`${shortDate(due, year)}17:00`);
    await expect(item.getByTestId('tasks-item-due')).not.toHaveAttribute('data-overdue', 'true');
    expect(await item.getByTestId('tasks-item-note').innerText()).toBe('ベニヤ板 2 枚\nペンキ（白・赤）');
    await expect(item.getByTestId('tasks-item-updated')).toHaveText(`テスト部門長が ${await taskUpdatedShort(id)} に更新`);
    const over = taskItem(head, overdueId);
    await expect(over.getByTestId('tasks-item-assignee')).toHaveText('担当者なし');
    await expect(over.getByTestId('tasks-item-due')).toHaveAttribute('data-overdue', 'true');
    await expect(over.getByTestId('tasks-item-due')).toContainText('締切を過ぎました');
    await expect(head.getByTestId('tasks-progress')).toHaveText('完了 0／2（作業中 0・未着手 2・締切を過ぎた 1）');
    // 部門長には、どの作業にも状態のボタン・編集・削除
    for (const t of [id, overdueId]) {
      await expect(taskItem(head, t).getByTestId('tasks-item-status-buttons')).toBeVisible();
      await expect(taskItem(head, t).getByTestId('tasks-item-edit')).toBeVisible();
      await expect(taskItem(head, t).getByTestId('tasks-item-delete')).toBeVisible();
    }

    // 総務部門員（スマホ）：既定は「自分の作業」（件数つき）。自分の作業だけに状態のボタン。作る・編集・削除は出ない
    await openTasks(staff);
    const filter = staff.getByTestId('tasks-filter');
    await expect(filter.getByRole('radio')).toHaveText(['自分の作業（1）', 'すべて（2）', '未完了（2）', '締切を過ぎた（1）', '締切が近い（1）', '担当者なし（1）']);
    await expect(filter.locator('[role="radio"][aria-checked="true"]')).toHaveText(['自分の作業（1）']);
    expect(await taskIds(staff)).toEqual([id]);
    await expect(staff.getByTestId('tasks-add')).toHaveCount(0);
    const mine = taskItem(staff, id);
    await expect(mine.getByTestId('tasks-item-edit')).toHaveCount(0);
    await expect(mine.getByTestId('tasks-item-delete')).toHaveCount(0);
    const group = mine.getByRole('group', { name: `「${title}」の状態` });
    await expect(group.getByRole('button')).toHaveText(['未着手', '作業中', '完了']);
    await expect(statusButton(staff, id, '未着手')).toHaveAttribute('aria-pressed', 'true');
    await expect(statusButton(staff, id, '未着手')).toBeDisabled();
    await expectNoOverflow(staff);

    // 作業中 → 完了（set_task_status）
    await statusButton(staff, id, '作業中').click();
    await expect(staff.getByText(`「${title}」を作業中にしました`)).toBeVisible();
    await expect(mine.getByTestId('tasks-item-status')).toHaveText('作業中');
    await expect(statusButton(staff, id, '作業中')).toHaveAttribute('aria-pressed', 'true');
    await statusButton(staff, id, '完了').click();
    await expect(staff.getByText(`「${title}」を完了にしました`)).toBeVisible();
    await expect(mine).toHaveAttribute('data-status', 'done');
    expect((await tasksOf(s.yearId)).find((r) => r.id === id)).toMatchObject({ status: 'done', created_by: H, updated_by: ST });
    // 「すべて」：担当者のいない作業には状態のボタンがない（URL に入れる）
    await filter.getByRole('radio', { name: /^すべて/ }).click();
    await expect(staff).toHaveURL(/\/tasks\/?\?filter=all$/);
    await expect.poll(() => taskIds(staff)).toEqual([overdueId, id]);
    await expect(taskItem(staff, overdueId).getByTestId('tasks-item-status-buttons')).toHaveCount(0);
    await expectNoOverflow(staff);

    // 部門長の画面：読み直すと進み具合と直した人が変わる（完了したものは後）
    await head.getByRole('button', { name: '読み直す' }).click();
    await expect(head.getByTestId('tasks-progress')).toHaveText('完了 1／2（作業中 0・未着手 1・締切を過ぎた 1）');
    await expect(item.getByTestId('tasks-item-status')).toHaveText('完了');
    await expect(item.getByTestId('tasks-item-updated')).toHaveText(`テスト部員が ${await taskUpdatedShort(id)} に更新`);
    expect(await taskIds(head)).toEqual([overdueId, id]);

    // 何も変えない編集は送らずに「変更はありません」で閉じる（今の値で開く）
    await item.getByRole('button', { name: `「${title}」を編集` }).click();
    const edit = head.getByRole('dialog', { name: '作業を編集' });
    await expect(edit.getByTestId('task-title')).toHaveValue(title);
    await expect(edit.getByTestId('task-assignee')).toHaveValue(ST);
    await expect(edit.getByTestId('task-due-date')).toHaveValue(due);
    await expect(edit.getByTestId('task-due-time')).toHaveValue('17:00');
    await edit.getByTestId('task-submit').click();
    await expect(head.getByText('変更はありません')).toBeVisible();
    await expect(edit).toHaveCount(0);

    // 削除：確かめてから
    await over.getByRole('button', { name: `「${overdueTitle}」を削除` }).click();
    const confirm = head.getByRole('alertdialog', { name: `「${overdueTitle}」を削除しますか` });
    await expect(confirm).toContainText('元に戻せません。');
    await confirm.getByRole('button', { name: '削除する' }).click();
    await expect(head.getByText(`「${overdueTitle}」を削除しました`)).toBeVisible();
    await expect.poll(() => taskIds(head)).toEqual([id]);
    expect((await tasksOf(s.yearId)).map((r) => r.id)).toEqual([id]);
  } finally {
    await head.context().close().catch(() => undefined);
    await staff.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

test('T20 作業の衝突（2つのページ）：状態のボタンは、ほかの人が先に変えていれば「…読み直しました（今は「作業中」です）」で、もう一度押すと変わる。押したのと同じ状態なら「保存されていました」。編集は、後の保存で今の題名と更新の日時を出して入力を残し、もう一度の保存で上書きできる', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true, staff: true } });
  const head = await openAs(browser, 'head', s, PC);
  const staff = await openAs(browser, 'staff', s, MOBILE);
  const admin = await openAs(browser, 'admin', s, PC);
  try {
    const title = 'E2E 受付の名簿を作る';
    const [id] = await insertTasks(s.yearId, [
      { title, assigneeId: ST, dueAt: `${addDays(tokyoToday(), 5)}T12:00:00+09:00`, note: '元の説明', createdBy: H },
    ]);
    await openTasks(head);
    await openTasks(staff);

    // 部門長が先に「作業中」にする
    await statusButton(head, id, '作業中').click();
    await expect(head.getByText(`「${title}」を作業中にしました`)).toBeVisible();
    // 部員は読んだときの版のまま「完了」：conflict。読み直して今の状態を出し、ボタンも今の状態にする（DB は部門長の書き込みのまま）
    await statusButton(staff, id, '完了').click();
    await expect(staff.getByText('ほかの人がこの作業を先に変えました。読み直しました（今は「作業中」です）')).toBeVisible();
    await expect(taskItem(staff, id).getByTestId('tasks-item-status')).toHaveText('作業中');
    await expect(statusButton(staff, id, '作業中')).toHaveAttribute('aria-pressed', 'true');
    expect((await tasksOf(s.yearId))[0]).toMatchObject({ status: 'doing', updated_by: H });
    // もう一度「完了」：読み直した版で送り、変わる
    await statusButton(staff, id, '完了').click();
    await expect(staff.getByText(`「${title}」を完了にしました`)).toBeVisible();
    expect((await tasksOf(s.yearId))[0]).toMatchObject({ status: 'done', updated_by: ST });
    // 部門長は古い版（作業中）のまま「完了」：止められて読み直すと押した状態なので「保存されていました」（書かない）
    await statusButton(head, id, '完了').click();
    await expect(head.getByText('保存されていました')).toBeVisible();
    await expect(taskItem(head, id).getByTestId('tasks-item-status')).toHaveText('完了');
    expect((await tasksOf(s.yearId))[0]).toMatchObject({ status: 'done', updated_by: ST });

    // 編集の衝突：部門長と管理者が同じ作業の編集を開く
    for (const p of [head, admin]) {
      await openTasks(p);
      await taskItem(p, id).getByRole('button', { name: `「${title}」を編集` }).click();
      await expect(p.getByRole('dialog', { name: '作業を編集' })).toBeVisible();
    }
    const hd = head.getByRole('dialog', { name: '作業を編集' });
    const ad = admin.getByRole('dialog', { name: '作業を編集' });
    // 先に部門長が題名を変えて保存
    await hd.getByTestId('task-title').fill('E2E 受付の名簿を作る（2部）');
    await hd.getByTestId('task-submit').click();
    await expect(head.getByText('「E2E 受付の名簿を作る（2部）」を保存しました')).toBeVisible();
    await expect(hd).toHaveCount(0);
    // 後から管理者が説明を変えて保存：今の題名と更新の日時を出し、入力を残す（ダイアログは開いたまま）
    await ad.getByTestId('task-note').fill('管理者が直した説明');
    await ad.getByTestId('task-submit').click();
    const conflict = ad.getByTestId('task-conflict');
    await expect(conflict).toContainText(
      'ほかの人がこの作業を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）',
    );
    await expect(conflict).toContainText('今の題名：E2E 受付の名簿を作る（2部）');
    await expect(conflict).toContainText(`更新：${await taskUpdatedLabel(id)}`);
    await expect(ad.getByTestId('task-title')).toHaveValue(title);
    await expect(ad.getByTestId('task-note')).toHaveValue('管理者が直した説明');
    expect((await tasksOf(s.yearId))[0]).toMatchObject({ title: 'E2E 受付の名簿を作る（2部）', note: '元の説明', updated_by: H });
    // もう一度「保存」：読み直した版で送り、管理者の入力で上書きする
    await ad.getByTestId('task-submit').click();
    await expect(admin.getByText(`「${title}」を保存しました`)).toBeVisible();
    await expect(ad).toHaveCount(0);
    expect((await tasksOf(s.yearId))[0]).toMatchObject({ title, note: '管理者が直した説明', created_by: H, updated_by: AD, status: 'done' });
    await expect(taskItem(admin, id).getByTestId('tasks-item-title')).toHaveText(title);
  } finally {
    for (const p of [head, staff, admin]) await p.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

test('T20 終了した年度：シフト表と作業一覧は読むだけ（帯「終了した年度のため、シフトと作業は読むだけです」。作る・直す・ますのボタン・状態のボタンが出ない）。自分のシフトには帯を出さない', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const s = await createScenario({ status: 'closed', dataset: 'small', roles: { head: true, staff: true } });
  const head = await openAs(browser, 'head', s, PC);
  const staff = await openAs(browser, 'staff', s, MOBILE);
  try {
    const t = slotsAroundNow();
    const [reception] = (await insertDuties(s.yearId, [{ name: '受付' }])) as [string];
    const [slot] = (await insertSlots(s.yearId, [t.now])) as [string];
    await insertNeeds(s.yearId, [{ slotId: slot, dutyId: reception, required: 2, users: [ST] }]);
    const title = 'E2E 片付けの報告を書く';
    const [id] = await insertTasks(s.yearId, [{ title, assigneeId: ST, dueAt: `${addDays(t.today, 1)}T17:00:00+09:00`, createdBy: H }]);

    // 部門長：シフト表は帯、操作なし、ますは押せない（足りないますの文字は出す）
    await openShifts(head);
    await expect(head.getByTestId('read-only-notice')).toHaveText(CLOSED);
    for (const tid of ['shifts-add-day', 'shifts-add-slot', 'shifts-add-duty', 'shift-slot-edit', 'shift-duty-edit']) await expect(head.getByTestId(tid)).toHaveCount(0);
    await expect(head.getByTestId('shifts-table').getByRole('button')).toHaveCount(0);
    await expect(shiftCell(head, slot, reception).getByTestId('shift-cell-short')).toHaveText('あと1人');
    // 作業一覧も帯。作る・状態のボタン・編集・削除は出ない
    await openTasks(head);
    await expect(head.getByTestId('read-only-notice')).toHaveText(CLOSED);
    await expect(head.getByTestId('tasks-add')).toHaveCount(0);
    await expect(taskItem(head, id).getByTestId('tasks-item-status-buttons')).toHaveCount(0);
    await expect(taskItem(head, id).getByTestId('tasks-item-edit')).toHaveCount(0);
    await expect(taskItem(head, id).getByTestId('tasks-item-delete')).toHaveCount(0);
    await expect(taskItem(head, id).getByTestId('tasks-item-title')).toHaveText(title);

    // 総務部門員：自分の作業でも状態のボタンは出ない（帯つき）。自分のシフトは読める（帯は出さない）
    await openTasks(staff);
    await expect(staff.getByTestId('read-only-notice')).toHaveText(CLOSED);
    await expect(taskItem(staff, id)).toBeVisible();
    await expect(taskItem(staff, id).getByTestId('tasks-item-status-buttons')).toHaveCount(0);
    await expectNoOverflow(staff);
    await openMyShift(staff);
    await expect(myShiftItem(staff, slot)).toBeVisible();
    await expect(staff.getByTestId('read-only-notice')).toHaveCount(0);
    await openShifts(staff);
    await expect(staff.getByTestId('read-only-notice')).toHaveText(CLOSED);
  } finally {
    await head.context().close().catch(() => undefined);
    await staff.context().close().catch(() => undefined);
    await s.cleanup();
  }
});
