import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import { addDays, tokyoToday } from './support/calendar';
import { createScenario, createUser, sql, type Scenario, type TestUser } from './support/db';
import { SMALL } from './support/datasets';
import {
  assignmentGroupIds,
  assignmentRow,
  blockerKinds,
  closeLabel,
  confirmedLabel,
  confirmLending,
  fillCell,
  fillRecord,
  insertLendingAssignments,
  insertLendingItems,
  insertLendingRecords,
  insertLendingRequests,
  itemRow,
  lendingAssignmentsOf,
  lendingAuditOf,
  lendingCard,
  lendingCell,
  lendingConfirmationOf,
  lendingItemsOf,
  lendingRecordsOf,
  lendingRequestsOf,
  lendingTodoIds,
  openLending,
  openRecords,
  openRequestLending,
  portalTodo,
  recordsCount,
  recordsGroup,
  recordsGroupStates,
  recordsItem,
  requestCount,
  requestItem,
  setFestivalStart,
  type LendingCountDbRow,
  type LendingRecordDbRow,
} from './support/lending';
import { openPortal } from './support/notices';
import { loginWith } from './support/roles';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T21 テント等の貸し出し（/lending・/lending/records・/request のテント等のタブとダッシュボード。04「テント等の貸し出し」、D-57、
// notes/T21.md の「承認した計画」6 の E2E の 1〜8）。シナリオの年度（small。1日目は 2001 年なので、祭の2日目も祭の後も過ぎている）で
// 閉じる。テント等の行は e2e/support/lending.ts で SQL から入れる（年度をまたぐ表には書かない。書いた人は入れた値のまま）。
// 団体は A＝E2E模擬店1（使用場所 E2E教室1。seed の店長が代表する団体）、B＝E2E部門1（E2E教室2）、C＝E2E企業1（使用場所なし）。
// シナリオの年度は seed の利用者の最新の年度（R8）より前なので、受け渡し・返却とテント等のタブの保存の前に「最新でない年度」の確かめが
// 出る（/lending〔PC〕は出さない）。2日目の前後の確かめ（ダッシュボード）は、1日目を今日・昨日・2日前に動かすので、使い捨てのユーザー
// だけがロールを持つ年度で行う（seed の利用者の最新の年度を変えない。D-36）。期待値の文言は 04 のとおりに書く（アプリの定数から引かない）。

const A = SMALL.groups.stall;
const B = SMALL.groups.department;
const C = SMALL.groups.company;
const H = SEED_USER_IDS.head;
const REP = SEED_USER_IDS.rep;

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** ページが横にはみ出していない（スマホの幅） */
async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);
}

/** 最新でない年度の確かめに「この年度に保存する」で答える（シナリオの年度は seed の利用者の最新の年度ではない） */
async function confirmNotLatest(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog', { name: /^最新でない年度（.+）に保存します。よろしいですか$/ });
  await dialog.getByRole('button', { name: 'この年度に保存する' }).click();
  await expect(dialog).toHaveCount(0);
}

/** 備品のテントと重し（テントは 3 張で模擬店・部門、重しは 20 個で既定の区分） */
async function tentAndWeight(s: Scenario): Promise<{ tent: string; weight: string }> {
  const [tent, weight] = await insertLendingItems(s.yearId, [
    { name: 'テント', unit: '張', stock: 3 },
    { name: '重し', stock: 20 },
  ]);
  return { tent, weight };
}

/** 数の行を「団体:備品 → 数」にする（行の並びによらず比べる） */
function countsOf(rows: readonly LendingCountDbRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [`${r.group_id}:${r.lending_item_id}`, r.count]));
}

/** 記録の行を「団体:備品 → 渡した・返った・破損（とメモ）」にする */
function recordsMap(rows: readonly LendingRecordDbRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((r) => [`${r.group_id}:${r.lending_item_id}`, `${r.lent_count}/${r.returned_count}/${r.damaged_count}${r.note ? ` ${r.note}` : ''}`]),
  );
}

/** 備品の表の1行の欄の文字（先頭の n 個。操作の欄を除くため。名前の欄の印は名前に続けて読む〔空白・改行を除く〕） */
async function itemCells(page: Page, id: string, n: number): Promise<string[]> {
  return (await itemRow(page, id).locator('td').allInnerTexts()).slice(0, n).map((t) => t.replace(/\s+/g, ''));
}

// ---------------------------------------------------------------- 1. 備品と在庫の登録（総務部門長）

test.describe('T21 総務部門長（備品）', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T21 総務部門長：準備中で備品がないとダッシュボードに「備品と在庫を登録してください」が出て /lending へ。前年度から読み込み、在庫と区分を直し、登録・削除できる。名前が空・同じ名前は欄の下に出し、申請のある備品は削除できない', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'preparing', dataset: 'small', roles: { head: true }, prevYear: { dataset: 'small' } });
    try {
      await insertLendingItems(s.prevYearId!, [
        { name: 'テント', unit: '張', stock: 12, categories: ['stall', 'department', 'rest_area'] },
        { name: '重し', stock: 40 },
      ]);
      await pinYear(page, H, s.yearId);

      // ダッシュボード：準備中で備品が 0 件 → 要対応（ふつう）とカード
      await openPortal(page, 'ダッシュボード');
      expect(await lendingTodoIds(page)).toEqual(['lending:lead:no-items']);
      const todo = portalTodo(page, 'lending:lead:no-items');
      await expect(todo).toHaveAttribute('data-severity', 'normal');
      await expect(todo).toContainText('テント等の貸し出し');
      await expect(todo).toContainText('テント等の貸し出す備品と在庫を登録してください');
      await expect(lendingCard(page).getByRole('heading', { level: 3, name: 'テント等の貸し出し' })).toBeVisible();
      await expect(lendingCard(page).getByRole('listitem')).toHaveText(['貸し出す備品がまだ登録されていません']);
      await expect(lendingCard(page).getByRole('link', { name: '備品と割り当てへ' })).toHaveAttribute('href', /\/lending\/?$/);
      await todo.getByRole('link').click();
      await expect(page).toHaveURL(/\/lending\/?$/);
      await expect(page.getByRole('heading', { level: 1, name: '備品と割り当て' })).toBeVisible();

      // 備品がない：「備品を登録」「前年度から読み込む」（前年度に備品があるので押せる）
      const empty = page.getByTestId('lending-items-empty');
      await expect(empty).toContainText('貸し出す備品がまだありません');
      await expect(empty).toContainText('「備品を登録」か「前年度から読み込む」で足してください。');
      await expect(page.getByTestId('lending-status')).toContainText('割り当て：確定前');
      const importButton = page.getByTestId('lending-item-import');
      await expect(importButton).toBeEnabled();

      // 前年度から読み込む：確かめのダイアログに前年度の一覧（名前・単位・在庫・申請できる区分）
      await importButton.click();
      const imp = page.getByRole('alertdialog', { name: '前年度の備品を読み込みますか' });
      await expect(imp).toContainText('在庫は前年度の数のまま入ります。読み込んだ後に確かめて直してください。');
      const rows = imp.getByTestId('lending-import-dialog').locator('tbody tr');
      await expect(rows.nth(0).locator('td')).toHaveText(['テント', '張', '12', '模擬店・部門・休憩所']);
      await expect(rows.nth(1).locator('td')).toHaveText(['重し', '個', '40', '模擬店・部門']);
      await imp.getByRole('button', { name: '読み込む' }).click();
      await expect(page.getByText('前年度から 2 件を読み込みました。在庫を確かめて直してください')).toBeVisible();
      await expect(imp).toHaveCount(0);
      const items = await lendingItemsOf(s.yearId);
      expect(items.map(({ name, unit, stock, requestable_categories, sort_order }) => ({ name, unit, stock, requestable_categories, sort_order }))).toEqual([
        { name: 'テント', unit: '張', stock: 12, requestable_categories: ['stall', 'department', 'rest_area'], sort_order: 1 },
        { name: '重し', unit: '個', stock: 40, requestable_categories: ['stall', 'department'], sort_order: 2 },
      ]);
      const tent = items[0]!.id;
      const weight = items[1]!.id;
      // 表：名前・単位・在庫・申請できる区分・申請合計・割り当て合計・残り・操作。前年度から読み込むは備品がある間は出さない
      await expect(page.getByTestId('lending-items').locator('thead th')).toHaveText(['名前', '単位', '在庫', '申請できる区分', '申請合計', '割り当て合計', '残り', '操作']);
      await expect.poll(() => itemCells(page, tent, 7)).toEqual(['テント', '張', '12', '模擬店・部門・休憩所', '0', '0', '12']);
      await expect.poll(() => itemCells(page, weight, 7)).toEqual(['重し', '個', '40', '模擬店・部門', '0', '0', '40']);
      await expect(page.getByTestId('lending-item-import')).toHaveCount(0);

      // 編集：在庫 12 → 3、休憩所を外す（今の値で開く）
      await itemRow(page, tent).getByTestId('lending-item-edit').click();
      const edit = page.getByRole('dialog', { name: '備品を編集' });
      await expect(edit.getByLabel('名前', { exact: true })).toHaveValue('テント');
      await expect(edit.getByLabel('単位', { exact: true })).toHaveValue('張');
      await expect(edit.getByLabel('在庫', { exact: true })).toHaveValue('12');
      await expect(edit.getByRole('checkbox', { name: '休憩所' })).toBeChecked();
      await edit.getByLabel('在庫', { exact: true }).fill('3');
      await edit.getByRole('checkbox', { name: '休憩所' }).click();
      await edit.getByTestId('lending-item-submit').click();
      await expect(page.getByText('「テント」を保存しました')).toBeVisible();
      await expect(edit).toHaveCount(0);
      await expect.poll(() => itemCells(page, tent, 7)).toEqual(['テント', '張', '3', '模擬店・部門', '0', '0', '3']);

      // 登録：既定は単位「個」・在庫 0・模擬店と部門・並びは最大＋1。名前が空 → 欄の下。同じ名前（前後の空白は除く）→ 欄の下
      await page.getByTestId('lending-item-add').click();
      const add = page.getByRole('dialog', { name: '備品を登録' });
      await expect(add.getByLabel('単位', { exact: true })).toHaveValue('個');
      await expect(add.getByLabel('在庫', { exact: true })).toHaveValue('0');
      await expect(add.getByLabel('並び', { exact: true })).toHaveValue('3');
      await expect(add.getByRole('checkbox', { name: '模擬店' })).toBeChecked();
      await expect(add.getByRole('checkbox', { name: '部門' })).toBeChecked();
      await expect(add.getByRole('checkbox', { name: '企業' })).not.toBeChecked();
      await expect(add.getByRole('checkbox', { name: '休憩所' })).not.toBeChecked();
      await add.getByTestId('lending-item-submit').click();
      await expect(add.locator('[data-field-error="name"]')).toHaveText('名前を入れてください');
      await add.getByLabel('名前', { exact: true }).fill('  重し　');
      await add.getByTestId('lending-item-submit').click();
      await expect(add.locator('[data-field-error="name"]')).toHaveText('同じ名前の備品がすでにあります');
      expect(await lendingItemsOf(s.yearId)).toHaveLength(2);
      await add.getByLabel('名前', { exact: true }).fill('三方幕');
      await add.getByLabel('単位', { exact: true }).fill('枚');
      await add.getByLabel('在庫', { exact: true }).fill('4');
      await add.getByRole('checkbox', { name: '部門' }).click();
      await add.getByRole('checkbox', { name: '企業' }).click();
      await add.getByTestId('lending-item-submit').click();
      await expect(page.getByText('「三方幕」を登録しました')).toBeVisible();
      await expect(add).toHaveCount(0);
      const curtain = (await lendingItemsOf(s.yearId)).find((i) => i.name === '三方幕')!;
      expect(curtain).toMatchObject({ unit: '枚', stock: 4, requestable_categories: ['stall', 'company'], sort_order: 3 });
      await expect.poll(() => itemCells(page, curtain.id, 4)).toEqual(['三方幕', '枚', '4', '模擬店・企業']);

      // 削除：申請のある備品（テント）は消せない（23503）。申請のない三方幕は消せる
      await insertLendingRequests(s.yearId, [{ groupId: s.ids.groups[A]!, itemId: tent, count: 1, updatedBy: REP }]);
      await itemRow(page, tent).getByTestId('lending-item-delete').click();
      const del = page.getByRole('alertdialog', { name: '「テント」を削除しますか' });
      await expect(del).toContainText('申請・割り当て・記録のある備品は削除できません。元に戻せません。');
      await del.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('申請・割り当て・記録のある備品は削除できません', { exact: true })).toBeVisible();
      // 閉じ終わるまで待つ（同じ確かめのダイアログを閉じる途中で開き直さない。題は閉じた時点で空になるので、名前では待てない）
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await itemRow(page, curtain.id).getByTestId('lending-item-delete').click();
      await page.getByRole('alertdialog', { name: '「三方幕」を削除しますか' }).getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('「三方幕」を削除しました')).toBeVisible();
      await expect(itemRow(page, curtain.id)).toHaveCount(0);
      expect((await lendingItemsOf(s.yearId)).map((i) => i.name)).toEqual(['テント', '重し']);

      // ダッシュボード：備品ができたので要対応は消える（準備中は確定の要対応も出さない）
      await openPortal(page, 'ダッシュボード');
      expect(await lendingTodoIds(page)).toEqual([]);
      await expect(lendingCard(page).getByRole('listitem')).toHaveText(['割り当て：確定前', '申請 1 団体・割り当て 0 団体']);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 2. 申請のテント等のタブ（店長・スマホ）

test.describe('T21 店長（申請のテント等のタブ）', () => {
  test.use({ storageState: storageStateFor('rep'), viewport: MOBILE });

  test('T21 店長（スマホ）：/request に「机・椅子」「テント等」のタブ。机・椅子の提出はこれまでどおり通り、テント等は区分で申請できる備品だけを別に保存する（すべて 0 の確かめ・ほかの人の変更の上書きの確かめ）。タブを行き来しても入力は残り、締切後は読み取り専用', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: A });
    try {
      const gid = s.ids.groups[A]!;
      const [tent, weight, curtain] = await insertLendingItems(s.yearId, [
        { name: 'テント', unit: '張', stock: 3 },
        { name: '重し', stock: 20 },
        { name: '三方幕', unit: '枚', stock: 2, categories: ['stall'] },
        { name: '休憩所のベンチ', unit: '脚', stock: 30, categories: ['rest_area'] },
      ]);
      await sql('delete from public.request_submissions where group_id = $1', [gid]);
      await pinYear(page, REP, s.yearId);
      await page.goto('/request/');

      // タブ：机・椅子が選ばれ、机椅子の画面はこれまでどおり。テント等のパネルはまだ作らない（開いたときに読む）
      const tabs = page.getByRole('tablist', { name: '申請の種類' });
      await expect(tabs.getByRole('tab')).toHaveText(['机・椅子', 'テント等']);
      await expect(page.getByTestId('request-tab-furniture')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('request-group-name')).toHaveText(A);
      await expect(page.getByTestId('request-submitted')).toHaveText('未提出');
      await expect(page.getByTestId('lending-request')).toHaveCount(0);
      // 机・椅子の入力（まだ提出しない）
      await page.getByRole('button', { name: '机(木)の数を1増やす' }).click();
      await expect(page.getByRole('textbox', { name: '机(木)の数', exact: true })).toHaveValue('4');

      // テント等のタブ（?tab=lending）：模擬店で申請できる備品だけ（休憩所だけの備品は出ない）。団体と締切
      await page.getByTestId('request-tab-lending').click();
      await expect(page).toHaveURL(/\/request\/?\?tab=lending$/);
      const panel = page.getByTestId('lending-request');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('request-group-name')).toBeHidden();
      await expect(panel.getByTestId('lending-request-item')).toHaveCount(3);
      await expect(requestItem(page, tent)).toContainText('テント');
      await expect(requestItem(page, tent)).toContainText('単位：張');
      await expect(requestItem(page, curtain)).toContainText('三方幕');
      await expect(panel).not.toContainText('休憩所のベンチ');
      await expect(panel).toContainText(A);
      await expect(panel.getByTestId('lending-request-saved-at')).toHaveText('まだ保存していません');
      await expect(panel.getByTestId('lending-request-readonly')).toHaveCount(0);
      await expect(panel.getByTestId('lending-request-assigned')).toHaveCount(0);
      await expect(requestCount(page, tent)).toHaveValue('0');
      await expectNoOverflow(page);

      // すべて 0 のまま保存：最新でない年度の確かめ → 「テント等を借りない申請として保存しますか」
      await panel.getByTestId('lending-request-save').click();
      await confirmNotLatest(page);
      const confirm = page.getByRole('alertdialog', { name: 'テント等の申請を保存しますか' });
      await expect(confirm).toContainText('テント等を借りない申請として保存しますか');
      await confirm.getByRole('button', { name: '保存する' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(panel.getByTestId('lending-request-saved-at')).toHaveText(/^保存済み（\d{1,2}\/\d{1,2} \d{2}:\d{2}）$/);
      await expect.poll(async () => countsOf(await lendingRequestsOf(s.yearId))).toEqual({ [`${gid}:${tent}`]: 0, [`${gid}:${weight}`]: 0, [`${gid}:${curtain}`]: 0 });
      expect((await lendingRequestsOf(s.yearId)).map((r) => r.updated_by)).toEqual([REP, REP, REP]);

      // 数を入れる（＋－と数字）。タブに保存していない入力の印
      await page.getByRole('button', { name: 'テントの数を1増やす' }).click();
      await page.getByRole('button', { name: 'テントの数を1増やす' }).click();
      await requestCount(page, weight).fill('8');
      await requestCount(page, weight).press('Enter');
      await expect(page.getByTestId('request-tab-lending')).toHaveAttribute('data-unsaved', 'true');

      // 机・椅子へ戻ると机椅子の入力は残っている → これまでどおり提出できる
      await page.getByTestId('request-tab-furniture').click();
      await expect(page).toHaveURL(/\/request\/?$/);
      await expect(page.getByRole('textbox', { name: '机(木)の数', exact: true })).toHaveValue('4');
      await page.getByRole('button', { name: '提出' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'この年度に提出する' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '提出する' }).click();
      await expect(page.getByText(/^提出しました（/)).toBeVisible();
      await expect(page.getByTestId('request-submitted')).toHaveText(/^提出済み（/);
      const [desk] = await sql<{ count: number }>(
        "select r.count from public.requests r join public.items i on i.id = r.item_id where r.group_id = $1 and i.code = 'desk'",
        [gid],
      );
      expect(desk!.count).toBe(4);

      // テント等へ戻ると入力は残っている（パネルを作り直さない）
      await page.getByTestId('request-tab-lending').click();
      await expect(requestCount(page, tent)).toHaveValue('2');
      await expect(requestCount(page, weight)).toHaveValue('8');

      // 入力を始めた後に、ほかの人（総務部門長）がテントを 1 にした → 保存の前の読み直しで見つけ、変わった備品（前 → 今）を出して確かめる
      await sql('update public.lending_requests set count = 1, updated_by = $3 where group_id = $1 and lending_item_id = $2', [gid, tent, H]);
      await panel.getByTestId('lending-request-save').click();
      await confirmNotLatest(page);
      await expect(confirm.getByTestId('lending-request-summary').getByRole('listitem')).toHaveText(['テント2 張', '重し8 個']);
      await confirm.getByRole('button', { name: '保存する' }).click();
      const overwrite = page.getByRole('alertdialog', { name: 'ほかの人がこの団体のテント等の申請を変えました。上書きしますか' });
      await expect(overwrite.getByTestId('lending-request-conflicts').getByRole('listitem')).toHaveText(['テント（0 → 1）']);
      expect(countsOf(await lendingRequestsOf(s.yearId))[`${gid}:${tent}`]).toBe(1);
      await overwrite.getByRole('button', { name: '上書きして保存する' }).click();
      await expect(overwrite).toHaveCount(0);
      await expect
        .poll(async () => countsOf(await lendingRequestsOf(s.yearId)))
        .toEqual({ [`${gid}:${tent}`]: 2, [`${gid}:${weight}`]: 8, [`${gid}:${curtain}`]: 0 });
      expect((await lendingRequestsOf(s.yearId)).map((r) => r.updated_by)).toEqual([REP, REP, REP]);
      await expect(page.getByTestId('request-tab-lending')).not.toHaveAttribute('data-unsaved', 'true');

      // 締切を過ぎる → テント等も読み取り専用（机・椅子と同じ文）。数は保存したまま
      await sql("update public.years set request_close_at = now() - interval '1 minute' where id = $1", [s.yearId]);
      await openRequestLending(page);
      await expect(panel.getByTestId('lending-request-readonly')).toHaveText('締切を過ぎました。変更は総務へ');
      await expect(panel.getByTestId('lending-request-save')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'テントの数を1増やす' })).toBeDisabled();
      await expect(requestCount(page, tent)).toHaveValue('2');
      await expect(requestCount(page, weight)).toHaveValue('8');
      await expect(panel.getByTestId('lending-request-assigned')).toHaveCount(0);
      await expectNoOverflow(page);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 3. 在庫超過 → 割り当て → 確定（総務部門長）

test.describe('T21 総務部門長（割り当てと確定）', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T21 総務部門長：申請が在庫を超えると印が出て確定できない。「申請どおりに入れる」とセルの直し（保存の応答が届かなくても「保存されていました」）・すべての団体（企業）→ 押せない理由がなくなって確定（ダイアログに割り当て合計／在庫）。確定中は読むだけで、在庫を割り当て合計より減らせない', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', dataset: 'small', roles: { head: true } });
    const route = '**/rest/v1/rpc/save_lending_assignments*';
    try {
      const a = s.ids.groups[A]!;
      const b = s.ids.groups[B]!;
      const c = s.ids.groups[C]!;
      const { tent, weight } = await tentAndWeight(s);
      await insertLendingRequests(s.yearId, [
        { groupId: a, itemId: tent, count: 2, updatedBy: REP },
        { groupId: b, itemId: tent, count: 2 },
        { groupId: a, itemId: weight, count: 8, updatedBy: REP },
        { groupId: b, itemId: weight, count: 4 },
      ]);
      await pinYear(page, H, s.yearId);
      await openLending(page);
      const status = page.getByTestId('lending-status');
      await expect(status).toHaveAttribute('data-confirmed', 'false');
      await expect(status).toContainText('割り当て：確定前');
      await expect(status).toContainText(`受付の締切 ${await closeLabel(s.yearId)}`);

      // 申請合計（4）が在庫（3）を超えた備品に印。割り当てはまだない
      await expect(itemRow(page, tent)).toHaveAttribute('data-over', 'requested');
      await expect(itemRow(page, tent).getByTestId('lending-item-over')).toHaveText('申請が在庫を超えています');
      await expect(itemRow(page, weight)).toHaveAttribute('data-over', 'none');
      await expect.poll(() => itemCells(page, tent, 7)).toEqual(['テント申請が在庫を超えています', '張', '3', '模擬店・部門', '4', '0', '3']);
      // 割り当ての表：申請のある団体だけ（企業は出ない）。未入力のセルに印
      await expect.poll(() => assignmentGroupIds(page)).toEqual([a, b]);
      await expect(lendingCell(page, a, tent)).toHaveAttribute('data-state', 'unassigned');
      await expect(lendingCell(page, b, weight)).toHaveAttribute('data-state', 'unassigned');
      await expect(assignmentRow(page, a).getByRole('rowheader')).toContainText('E2E教室1');
      // 確定は押せない（理由：未入力）
      await expect(page.getByTestId('lending-confirm')).toBeDisabled();
      await expect.poll(() => blockerKinds(page)).toEqual(['unassigned']);
      await expect(page.getByTestId('lending-confirm-blockers')).toHaveText('申請があるのに割り当てていない組があります：テント 2 団体・重し 2 団体');

      // テントの「申請どおりに入れる」：割り当てのないセルに申請の数を、未保存の変更として入れる → 保存（2件）
      await page.locator(`[data-testid="lending-fill-requested"][data-item-id="${tent}"]`).click();
      await expect(page.getByText('申請の数を 2 か所に入れました（まだ保存していません）')).toBeVisible();
      await expect(lendingCell(page, a, tent)).toHaveAttribute('data-unsaved', 'true');
      await expect(lendingCell(page, a, tent).getByTestId('lending-cell-input')).toHaveValue('2');
      await expect(lendingCell(page, b, tent).getByTestId('lending-cell-input')).toHaveValue('2');
      await expect.poll(() => blockerKinds(page)).toEqual(['unassigned', 'unsaved']);
      await expect(page.getByText('保存していない変更が 2 件あります')).toBeVisible();
      await expect(page.getByTestId('lending-save')).toHaveText('保存（2件）');
      await page.getByTestId('lending-save').click();
      await expect(page.getByText('割り当てを保存しました（2件）')).toBeVisible();
      // 割り当て合計（4）が在庫（3）を超えた → 「在庫を超えています（確定できません）」
      await expect(itemRow(page, tent)).toHaveAttribute('data-over', 'assigned');
      await expect(itemRow(page, tent).getByTestId('lending-item-over')).toHaveText('在庫を超えています（確定できません）');
      await expect.poll(() => blockerKinds(page)).toEqual(['over_stock', 'unassigned']);
      await expect(page.locator('[data-testid="lending-confirm-blockers"] li[data-kind="over_stock"]')).toHaveText('在庫を超えている備品があります：テント');
      await expect(page.locator('[data-testid="lending-confirm-blockers"] li[data-kind="unassigned"]')).toHaveText(
        '申請があるのに割り当てていない組があります：重し 2 団体',
      );

      // 重しの「申請どおりに入れる」→ 保存の応答が届かない（DB には届く）→ 送った組を読み直し、入力と同じなので「保存されていました」
      let drop = true;
      await page.route(route, async (r) => {
        if (drop) {
          drop = false;
          await r.fetch();
          await r.abort('failed');
          return;
        }
        await r.continue();
      });
      await page.locator(`[data-testid="lending-fill-requested"][data-item-id="${weight}"]`).click();
      await page.getByTestId('lending-save').click();
      await expect(page.getByText('保存されていました')).toBeVisible();
      expect(drop).toBe(false);
      await page.unroute(route);
      await expect.poll(() => blockerKinds(page)).toEqual(['over_stock']);
      expect(countsOf(await lendingAssignmentsOf(s.yearId))).toEqual({
        [`${a}:${tent}`]: 2,
        [`${b}:${tent}`]: 2,
        [`${a}:${weight}`]: 8,
        [`${b}:${weight}`]: 4,
      });

      // すべての団体（?view=all）：申請のない企業にも入れられる。区分で絞れる（?category=）
      await page.getByTestId('lending-view-all').click();
      await expect(page).toHaveURL(/\/lending\/?\?view=all$/);
      await expect.poll(() => assignmentGroupIds(page)).toEqual([a, b, c]);
      await expect(lendingCell(page, c, weight)).toHaveAttribute('data-state', 'empty');
      await expect(assignmentRow(page, c).getByRole('rowheader')).toContainText('校内に分散');
      await fillCell(page, c, weight, '2');
      await expect(lendingCell(page, c, weight)).toHaveAttribute('data-unsaved', 'true');
      await page.getByTestId('lending-category-filter').selectOption('company');
      await expect(page).toHaveURL(/\/lending\/?\?view=all&category=company$/);
      await expect.poll(() => assignmentGroupIds(page)).toEqual([c]);
      await page.getByTestId('lending-category-filter').selectOption('');
      await expect.poll(() => assignmentGroupIds(page)).toEqual([a, b, c]);
      // テントを直す（部門1：2 → 1。申請と違う印）、重しも直す（模擬店1：8 → 7）→ 保存（3件）
      await fillCell(page, b, tent, '1');
      await fillCell(page, a, weight, '7');
      await expect(lendingCell(page, b, tent)).toHaveAttribute('data-state', 'differs');
      await expect(page.getByTestId('lending-save')).toHaveText('保存（3件）');
      await page.getByTestId('lending-save').click();
      await expect(page.getByText('割り当てを保存しました（3件）')).toBeVisible();
      // 割り当ては在庫に収まった（申請は超えたまま）。押せない理由はなくなる
      await expect(itemRow(page, tent)).toHaveAttribute('data-over', 'requested');
      await expect(page.getByTestId('lending-confirm-blockers')).toHaveCount(0);
      await expect(page.getByTestId('lending-confirm')).toBeEnabled();

      // 確定：ダイアログに備品ごとの割り当て合計／在庫
      await page.getByTestId('lending-confirm').click();
      const dialog = page.getByRole('alertdialog', { name: '割り当てを確定しますか' });
      await expect(dialog).toContainText('確定すると、店長・副店長と閲覧のみの人が割り当てを見られます。');
      await expect(dialog.getByTestId('lending-confirm-dialog').locator('tbody tr')).toHaveText(['テント3／3', '重し13／20']);
      await dialog.getByRole('button', { name: '確定する' }).click();
      await expect(page.getByText('割り当てを確定しました')).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(status).toHaveAttribute('data-confirmed', 'true');
      await expect(status).toContainText(`割り当て：確定（${await confirmedLabel(s.yearId)}）`);
      expect(await lendingConfirmationOf(s.yearId)).toEqual({ confirmed: true, confirmed_by: H });
      expect(countsOf(await lendingAssignmentsOf(s.yearId))).toEqual({
        [`${a}:${tent}`]: 2,
        [`${b}:${tent}`]: 1,
        [`${a}:${weight}`]: 7,
        [`${b}:${weight}`]: 4,
        [`${c}:${weight}`]: 2,
      });
      // 監査の理由：割り当ては「テント等の割り当て」、確定は「テント等の割り当ての確定」
      expect(new Set((await lendingAuditOf(s.yearId, 'lending_assignments')).map((r) => r.reason))).toEqual(new Set(['テント等の割り当て']));
      expect((await lendingAuditOf(s.yearId, 'lending_years')).map((r) => r.reason)).toEqual(['テント等の割り当ての確定']);

      // 確定中は読むだけ：帯、セルは数だけ（欄・申請どおりに入れるがない）、「確定を解除」
      await expect(page.getByTestId('lending-confirmed-note')).toHaveText('確定中です。直すときは「確定を解除」してください');
      await expect(page.getByTestId('lending-cell-input')).toHaveCount(0);
      await expect(page.getByTestId('lending-fill-requested')).toHaveCount(0);
      await expect(page.getByTestId('lending-confirm')).toHaveCount(0);
      await expect(page.getByTestId('lending-unconfirm')).toBeVisible();
      await expect(lendingCell(page, b, tent)).toHaveText('1');

      // 確定中は、在庫を割り当て合計（3）より少なくできない（DB の守り）
      await itemRow(page, tent).getByTestId('lending-item-edit').click();
      const edit = page.getByRole('dialog', { name: '備品を編集' });
      await edit.getByLabel('在庫', { exact: true }).fill('2');
      await edit.getByTestId('lending-item-submit').click();
      await expect(edit.getByTestId('lending-item-error')).toContainText('割り当ての確定中は、在庫を割り当ての合計（3）より少なくできません');
      await edit.getByRole('button', { name: 'やめる' }).click();
      await page.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();
      await expect(edit).toHaveCount(0);
      expect((await lendingItemsOf(s.yearId)).find((i) => i.id === tent)!.stock).toBe(3);
    } finally {
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 4. 確定後の見え方（閲覧のみ・総務部門員・店長）

test('T21 確定後：閲覧のみは確定前は「割り当ては確定後に表示されます」、確定後は備品と割り当てだけ（申請・記録は読まない）。総務部門員は直せず CSV を出せる（BOM・メールの置き換え）。店長はテント等のタブで割り当てと渡した・返った・未返却を見て、ダッシュボードに「返してください」', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const s = await createScenario({
    status: 'requesting',
    requestWindow: 'closed',
    dataset: 'small',
    roles: { head: true, staff: true, viewer: true },
    repGroup: A,
  });
  const viewer = await openAs(browser, 'viewer', s);
  const staff = await openAs(browser, 'staff', s);
  const rep = await openAs(browser, 'rep', s, MOBILE);
  try {
    const a = s.ids.groups[A]!;
    const b = s.ids.groups[B]!;
    const { tent, weight } = await tentAndWeight(s);
    await insertLendingRequests(s.yearId, [
      { groupId: a, itemId: tent, count: 2, updatedBy: REP },
      { groupId: a, itemId: weight, count: 8, updatedBy: REP },
      { groupId: b, itemId: tent, count: 2 },
    ]);
    await insertLendingAssignments(s.yearId, [
      { groupId: a, itemId: tent, count: 2, updatedBy: H },
      { groupId: a, itemId: weight, count: 8, updatedBy: H },
      { groupId: b, itemId: tent, count: 1, updatedBy: H },
    ]);
    await insertLendingRecords(s.yearId, [
      { groupId: a, itemId: tent, lent: 2, returned: 1, note: 'E2E 連絡は e2e-csv@example.test まで', updatedBy: SEED_USER_IDS.staff },
    ]);
    // 閲覧のみが読む表（申請・記録は読まない）
    const viewerReads: string[] = [];
    viewer.on('request', (r) => {
      const m = /\/rest\/v1\/([^?]+)$/.exec(new URL(r.url()).pathname);
      if (m && r.method() === 'GET') viewerReads.push(m[1]!);
    });

    // 確定前：閲覧のみは表を出さない。店長のタブに割り当ては出ない（記録は確定の前でも出す）
    await openLending(viewer);
    await expect(viewer.getByTestId('lending-before-confirm')).toHaveText('割り当ては確定後に表示されます');
    await expect(viewer.getByTestId('lending-items')).toHaveCount(0);
    await expect(viewer.getByTestId('lending-assignments')).toHaveCount(0);
    await openRequestLending(rep);
    await expect(rep.getByTestId('lending-request-assigned')).toHaveCount(0);
    await expect(rep.getByTestId('lending-request-records').getByRole('listitem')).toHaveText(['渡した：テント 2 張', '返った：テント 1 張', '未返却：テント 1 張']);

    await confirmLending(s.yearId, H);
    const label = await confirmedLabel(s.yearId);

    // 閲覧のみ：確定後の備品（名前・単位・在庫・割り当て合計）と割り当てだけ。CSV・確定・帯はない
    await openLending(viewer);
    await expect(viewer.getByTestId('lending-status')).toContainText(`割り当て：確定（${label}）`);
    await expect(viewer.getByTestId('lending-before-confirm')).toHaveCount(0);
    await expect(viewer.getByTestId('lending-items').locator('thead th')).toHaveText(['名前', '単位', '在庫', '割り当て合計']);
    await expect(itemRow(viewer, tent).locator('td')).toHaveText(['テント', '張', '3', '3']);
    await expect(viewer.getByTestId('lending-assignments').locator('thead th')).toHaveText(['団体', 'テント', '重し']);
    await expect(assignmentRow(viewer, a).locator('td')).toHaveText(['2', '8']);
    await expect(assignmentRow(viewer, b).locator('td')).toHaveText(['1', '—']);
    for (const id of ['lending-csv', 'lending-confirm', 'lending-unconfirm', 'lending-item-add', 'lending-cell-input', 'lending-staff-note', 'lending-confirmed-note']) {
      await expect(viewer.getByTestId(id)).toHaveCount(0);
    }
    expect(viewerReads).toContain('lending_assignments');
    expect(viewerReads.filter((t) => t === 'lending_requests' || t === 'lending_records')).toEqual([]);

    // 総務部門員：読むだけ（帯。登録・編集・削除・確定の解除・セルの欄はない）。申請｜割り当ての列。CSV を出せる
    await openLending(staff);
    await expect(staff.getByTestId('lending-staff-note')).toHaveText(
      '総務部門員は備品と割り当てを見るだけです（登録・割り当て・確定は管理者・総務部門長・総務副部門長が行います）。',
    );
    for (const id of ['lending-item-add', 'lending-item-edit', 'lending-item-delete', 'lending-unconfirm', 'lending-cell-input', 'lending-fill-requested', 'lending-confirmed-note']) {
      await expect(staff.getByTestId(id)).toHaveCount(0);
    }
    await expect(assignmentRow(staff, a).locator('td')).toHaveText(['2', '2', '8', '8']);
    await expect(assignmentRow(staff, b).locator('td')).toHaveText(['2', '1', '—', '—']);
    const [download] = await Promise.all([staff.waitForEvent('download'), staff.getByTestId('lending-csv').click()]);
    expect(download.suggestedFilename()).toBe(`${s.label}_テント等の貸し出し.csv`);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      '区分,団体,使用場所,テントの申請,テントの割り当て,テントの渡した数,テントの返った数,テントの破損,重しの申請,重しの割り当て,重しの渡した数,重しの返った数,重しの破損,メモ',
      `模擬店,${A},${SMALL.rooms.class1},2,2,2,1,0,8,8,,,,テント：E2E 連絡は (メールアドレス削除) まで`,
      `部門,${B},${SMALL.rooms.class2},2,1,,,,,,,,,`,
      '',
    ]);

    // 総務部門員のダッシュボード：カード（確定・団体の数・渡した／未返却）と、未返却の要対応（祭の後なので急ぎ）
    await openPortal(staff, 'ダッシュボード');
    await expect(lendingCard(staff).getByRole('listitem')).toHaveText([`割り当て：確定（${label}）`, '申請 2 団体・割り当て 2 団体', '渡した 1／2 団体・未返却 1 団体']);
    expect(await lendingTodoIds(staff)).toEqual(['lending:soumu:unreturned']);
    const unreturned = portalTodo(staff, 'lending:soumu:unreturned');
    await expect(unreturned).toHaveAttribute('data-severity', 'urgent');
    await expect(unreturned).toContainText('テント等の未返却 1 団体');
    await expect(unreturned.getByRole('link')).toHaveAttribute('href', /\/lending\/records\/?\?filter=unreturned$/);

    // 店長：タブに割り当て（確定）と、渡した・返った・未返却。締切後なので読み取り専用
    await openRequestLending(rep);
    await expect(rep.getByTestId('lending-request-assigned').getByRole('listitem')).toHaveText(['割り当て：テント 2 張（申請 2）', '割り当て：重し 8 個（申請 8）']);
    await expect(rep.getByTestId('lending-request-readonly')).toHaveText('締切を過ぎました。変更は総務へ');
    await expect(rep.getByTestId('lending-request-unreturned')).toHaveText('未返却：テント 1 張');
    await expectNoOverflow(rep);
    // 店長のダッシュボード（ホーム）：返してください（祭の後なので急ぎ）→ タブへ
    await openPortal(rep, 'ホーム');
    expect(await lendingTodoIds(rep)).toEqual([`lending:rep:${a}:unreturned`]);
    const back = portalTodo(rep, `lending:rep:${a}:unreturned`);
    await expect(back).toHaveAttribute('data-severity', 'urgent');
    await expect(back).toContainText(`${A}：テント等を返してください（テント 1）`);
    await expect(lendingCard(rep)).toHaveCount(0);
    await back.getByRole('link').click();
    await expect(rep).toHaveURL(new RegExp(`/request/?\\?group=${a}&tab=lending$`));
    await expect(rep.getByTestId('request-tab-lending')).toHaveAttribute('aria-selected', 'true');
    await expect(rep.getByTestId('lending-request-assigned')).toBeVisible();
  } finally {
    for (const p of [viewer, staff, rep]) await p.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- 5. 受け渡し・返却の記録（部門員・スマホ）

test.describe('T21 部門員（受け渡し・返却）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: MOBILE });

  test('T21 部門員（スマホ）：確定の前でも記録できる（帯）。一覧（割り当ての要約・状態・件数つきのチップ・探す欄）→ 団体の欄で「割り当てどおり渡した」・返った・破損とメモを保存（入力の誤りは送らない）。割り当てより多く渡すときは確かめてから記録し、「全部返った」で返却済み', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const s = await createScenario({ status: 'confirmed', dataset: 'small', roles: { staff: true } });
    try {
      const a = s.ids.groups[A]!;
      const b = s.ids.groups[B]!;
      const c = s.ids.groups[C]!;
      const { tent, weight } = await tentAndWeight(s);
      await insertLendingAssignments(s.yearId, [
        { groupId: a, itemId: tent, count: 2, updatedBy: H },
        { groupId: a, itemId: weight, count: 8, updatedBy: H },
        { groupId: b, itemId: tent, count: 1, updatedBy: H },
      ]);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await openRecords(page);
      await expect(page.getByTestId('records-before-confirm')).toHaveText('割り当ては確定前です（数は変わることがあります）');
      await expect(page.getByTestId('lending-readonly')).toHaveCount(0);

      // 一覧：割り当て（1以上）か記録のある団体。割り当ての要約・使用場所・状態
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${a}:before`, `${b}:before`]);
      await expect(recordsGroup(page, a)).toContainText('テント 2・重し 8');
      await expect(recordsGroup(page, a)).toContainText(SMALL.rooms.class1);
      await expect(recordsGroup(page, a).getByTestId('records-state')).toHaveText('渡す前');
      await expect(recordsGroup(page, b)).toContainText('テント 1');
      await expect(page.getByTestId('records-filter').getByRole('radio')).toHaveText(['すべて（2）', '渡す前（2）', '貸し出し中（0）', '未返却（0）', '返却済み（0）']);
      // 探す欄：その年度の全部の団体から（割り当てのない企業も）
      await page.getByTestId('records-search').fill('企業');
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${c}:before`]);
      await expect(recordsGroup(page, c)).toContainText('割り当てなし');
      await expect(recordsGroup(page, c)).toContainText('校内に分散');
      await page.getByTestId('records-search').fill('');
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${a}:before`, `${b}:before`]);
      await expectNoOverflow(page);

      // 団体の欄（?group=）：備品ごとに割り当て（確定前）と、渡した・返った・うち破損の ＋－（44px）
      await recordsGroup(page, a).getByRole('button').click();
      await expect(page).toHaveURL(new RegExp(`/lending/records/?\\?group=${a}$`));
      const panel = page.getByTestId('records-panel');
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(A);
      await expect(recordsItem(page, tent).getByTestId('records-assigned')).toHaveText('割り当て 2 張（確定前）');
      await expect(recordsItem(page, weight).getByTestId('records-assigned')).toHaveText('割り当て 8 個（確定前）');
      const plus = await page.getByRole('button', { name: 'テントの渡した数を1増やす' }).boundingBox();
      expect(plus!.height).toBeGreaterThanOrEqual(44);
      expect(plus!.width).toBeGreaterThanOrEqual(44);
      await expect(recordsItem(page, weight).getByTestId('records-note')).toHaveCount(0);
      await expectNoOverflow(page);

      // 割り当てどおり渡した → 保存（最新でない年度の確かめ）
      await page.getByTestId('records-lend-all').click();
      await expect(recordsCount(page, tent, 'lent')).toHaveValue('2');
      await expect(recordsCount(page, weight, 'lent')).toHaveValue('8');
      await page.getByTestId('records-save').click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('records-saved')).toHaveText('保存しました');
      expect(recordsMap(await lendingRecordsOf(s.yearId))).toEqual({ [`${a}:${tent}`]: '2/0/0', [`${a}:${weight}`]: '8/0/0' });
      expect((await lendingRecordsOf(s.yearId)).map((r) => r.updated_by)).toEqual([SEED_USER_IDS.staff, SEED_USER_IDS.staff]);

      // 返った・破損：返った数が渡した数を超えると欄の下に出して送らない
      await fillRecord(page, tent, 'returned', 2);
      await fillRecord(page, weight, 'returned', 9);
      await page.getByTestId('records-save').click();
      await expect(recordsItem(page, weight).getByTestId('records-returned').locator('[data-field-error]')).toHaveText('返った数は渡した数以下にしてください');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      // 重しは 8 のうち 7 が返り、1 つ破損（破損があるとメモの欄）
      await fillRecord(page, weight, 'returned', 7);
      await fillRecord(page, weight, 'damaged', 1);
      await recordsItem(page, weight).getByTestId('records-note').fill('E2E 1つ穴があいた');
      await page.getByTestId('records-save').click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('records-saved')).toHaveText('保存しました');
      await expect
        .poll(async () => recordsMap(await lendingRecordsOf(s.yearId)))
        .toEqual({ [`${a}:${tent}`]: '2/2/0', [`${a}:${weight}`]: '8/7/1 E2E 1つ穴があいた' });

      // 一覧へ：模擬店1 は未返却（祭の2日目を過ぎた年度で、重しが 1 つ返っていない）
      await panel.getByRole('button', { name: '一覧へ' }).click();
      await expect(page).toHaveURL(/\/lending\/records\/?$/);
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${a}:unreturned`, `${b}:before`]);
      await expect(recordsGroup(page, a).getByTestId('records-state')).toHaveText('未返却');

      // 部門1：割り当て（1）より多く渡す（2）→ 確かめてから記録（事実の記録は止めない）
      await recordsGroup(page, b).getByRole('button').click();
      await page.getByRole('button', { name: 'テントの渡した数を1増やす' }).click();
      await page.getByRole('button', { name: 'テントの渡した数を1増やす' }).click();
      await page.getByTestId('records-save').click();
      await confirmNotLatest(page);
      const over = page.getByRole('alertdialog', { name: '割り当てより多く渡します' });
      await expect(over.getByTestId('records-over-assigned')).toHaveText('割り当てより多く渡します：テント（割り当て 1・渡した 2）。記録してよいですか');
      await over.getByRole('button', { name: '記録する' }).click();
      await expect(page.getByTestId('records-saved')).toHaveText('保存しました');
      expect(recordsMap(await lendingRecordsOf(s.yearId))[`${b}:${tent}`]).toBe('2/0/0');
      // 全部返った（返った数を渡した数に）→ 返却済み
      await page.getByTestId('records-return-all').click();
      await expect(recordsCount(page, tent, 'returned')).toHaveValue('2');
      await page.getByTestId('records-save').click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('records-saved')).toHaveText('保存しました');
      expect(recordsMap(await lendingRecordsOf(s.yearId))[`${b}:${tent}`]).toBe('2/2/0');

      // 一覧の状態とチップ。「未返却」で絞る（?filter=unreturned）
      await page.getByTestId('records-panel').getByRole('button', { name: '一覧へ' }).click();
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${a}:unreturned`, `${b}:returned`]);
      const chips = page.getByTestId('records-filter');
      await expect(chips.getByRole('radio')).toHaveText(['すべて（2）', '渡す前（0）', '貸し出し中（0）', '未返却（1）', '返却済み（1）']);
      await chips.getByRole('radio', { name: '未返却（1）' }).click();
      await expect(page).toHaveURL(/\/lending\/records\/?\?filter=unreturned$/);
      await expect.poll(() => recordsGroupStates(page)).toEqual([`${a}:unreturned`]);
    } finally {
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 5b. 受け渡し・返却の衝突（2つのセッション）

test('T21 受け渡し・返却の衝突：2つのセッション（部門員と総務部門長）で同じ団体の欄を開き、先に部門員が保存すると、後の保存は相手と自分の数を並べて「上書きする」「読み直す」を選べる', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'requesting', requestWindow: 'closed', dataset: 'small', roles: { staff: true, head: true } });
  const staff = await openAs(browser, 'staff', s, MOBILE);
  const head = await openAs(browser, 'head', s, MOBILE);
  try {
    const a = s.ids.groups[A]!;
    const { tent, weight } = await tentAndWeight(s);
    await insertLendingAssignments(s.yearId, [
      { groupId: a, itemId: tent, count: 2, updatedBy: H },
      { groupId: a, itemId: weight, count: 8, updatedBy: H },
    ]);
    await confirmLending(s.yearId, H);
    for (const p of [staff, head]) {
      await openRecords(p, `?group=${a}`);
      await expect(p.getByTestId('records-panel')).toBeVisible();
      await expect(recordsItem(p, tent).getByTestId('records-assigned')).toHaveText('割り当て 2 張');
      await expect(p.getByTestId('records-before-confirm')).toHaveCount(0);
    }

    // 先に部門員が「割り当てどおり渡した」で保存
    await staff.getByTestId('records-lend-all').click();
    await staff.getByTestId('records-save').click();
    await confirmNotLatest(staff);
    await expect(staff.getByTestId('records-saved')).toHaveText('保存しました');

    // 総務部門長は保存の前に開いていた欄で、テントを 1 渡したと入れて保存 → 送らずに衝突のダイアログ（相手と自分の数）
    await head.getByRole('button', { name: 'テントの渡した数を1増やす' }).click();
    await head.getByTestId('records-save').click();
    await confirmNotLatest(head);
    const conflict = head.getByRole('alertdialog', { name: '入力を始めた後に、ほかの人がこの団体の記録を保存しました' });
    await expect(conflict).toContainText('上書きするか、ほかの人の数を読み直すかを選んでください。');
    const rows = conflict.getByTestId('records-conflict-row');
    await expect(rows.nth(0).locator('td')).toHaveText(['テント', '渡2・返0・破0', '渡1・返0・破0']);
    await expect(rows.nth(1).locator('td')).toHaveText(['重し', '渡8・返0・破0', '渡0・返0・破0']);
    expect(recordsMap(await lendingRecordsOf(s.yearId))).toEqual({ [`${a}:${tent}`]: '2/0/0', [`${a}:${weight}`]: '8/0/0' });
    // 上書きする → 総務部門長の数で保存
    await conflict.getByRole('button', { name: '上書きする' }).click();
    await expect(head.getByTestId('records-saved')).toHaveText('保存しました');
    await expect.poll(async () => recordsMap(await lendingRecordsOf(s.yearId))).toEqual({ [`${a}:${tent}`]: '1/0/0', [`${a}:${weight}`]: '0/0/0' });
    expect((await lendingRecordsOf(s.yearId)).map((r) => r.updated_by)).toEqual([H, H]);

    // 部門員は自分の保存の後の欄のまま、テントの返った数を入れて保存 → 衝突 →「読み直す」でほかの人の数にする（送らない）
    await fillRecord(staff, tent, 'returned', 1);
    await staff.getByTestId('records-save').click();
    await confirmNotLatest(staff);
    const again = staff.getByRole('alertdialog', { name: '入力を始めた後に、ほかの人がこの団体の記録を保存しました' });
    await expect(again.getByTestId('records-conflict-row').nth(0).locator('td')).toHaveText(['テント', '渡1・返0・破0', '渡2・返1・破0']);
    await again.getByRole('button', { name: '読み直す' }).click();
    await expect(staff.getByText('ほかの人が保存した数を読み直しました')).toBeVisible();
    await expect(again).toHaveCount(0);
    await expect(recordsCount(staff, tent, 'lent')).toHaveValue('1');
    await expect(recordsCount(staff, tent, 'returned')).toHaveValue('0');
    await expect(recordsCount(staff, weight, 'lent')).toHaveValue('0');
    expect(recordsMap(await lendingRecordsOf(s.yearId))).toEqual({ [`${a}:${tent}`]: '1/0/0', [`${a}:${weight}`]: '0/0/0' });
  } finally {
    for (const p of [staff, head]) await p.context().close().catch(() => undefined);
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- 6. ダッシュボード（2日目の前後）

test('T21 ダッシュボード（2日目）：1日目は在庫超過の要対応だけ（貸し出し中は未返却にしない）。2日目から総務に「未返却 N 団体」、店長に「返してください」（ふつう）。在庫超過を直すと「確定を押してください」、確定すると店長に「割り当てが決まりました」。祭の後は未返却が急ぎ', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // 1日目を動かすので、使い捨てのユーザーだけがロールを持つ年度にする（seed の利用者の最新の年度を変えない）
  const users: TestUser[] = [];
  const staffU = await createUser({ purpose: 'lendstaff' });
  users.push(staffU);
  const headU = await createUser({ purpose: 'lendhead' });
  users.push(headU);
  const repU = await createUser({ purpose: 'lendrep' });
  users.push(repU);
  const s = await createScenario({
    status: 'requesting',
    requestWindow: 'closed',
    dataset: 'small',
    grants: [
      { userId: staffU.id, role: 'staff' },
      { userId: headU.id, role: 'head' },
    ],
    groupMembers: [
      { userId: repU.id, group: A },
      { userId: repU.id, group: B, role: 'deputy_manager' },
    ],
  });
  const pages: Page[] = [];
  const open = async (u: TestUser, viewport: { width: number; height: number }): Promise<Page> => {
    const context = await browser.newContext({ viewport });
    const p = await context.newPage();
    pages.push(p);
    await loginWith(p, u);
    return p;
  };
  try {
    const a = s.ids.groups[A]!;
    const b = s.ids.groups[B]!;
    const today = tokyoToday();
    await setFestivalStart(s.yearId, today);
    const { tent, weight } = await tentAndWeight(s);
    await insertLendingRequests(s.yearId, [
      { groupId: a, itemId: tent, count: 2, updatedBy: repU.id },
      { groupId: b, itemId: tent, count: 2, updatedBy: repU.id },
      { groupId: a, itemId: weight, count: 8, updatedBy: repU.id },
    ]);
    await insertLendingAssignments(s.yearId, [
      { groupId: a, itemId: tent, count: 2, updatedBy: headU.id },
      { groupId: a, itemId: weight, count: 8, updatedBy: headU.id },
    ]);
    await insertLendingRecords(s.yearId, [
      { groupId: a, itemId: tent, lent: 2, returned: 1, updatedBy: staffU.id },
      { groupId: a, itemId: weight, lent: 8, returned: 8, updatedBy: staffU.id },
    ]);
    const head = await open(headU, PC);
    const staff = await open(staffU, MOBILE);
    const rep = await open(repU, MOBILE);

    // 1日目（今日）：部門長に直していない在庫超過（割り当て 2＋未入力の申請 2 ＞ 在庫 3）。未返却はまだ出さない
    await openPortal(head, 'ダッシュボード');
    expect(await lendingTodoIds(head)).toEqual([`lending:lead:over-stock:${tent}`]);
    const overTodo = portalTodo(head, `lending:lead:over-stock:${tent}`);
    await expect(overTodo).toHaveAttribute('data-severity', 'urgent');
    await expect(overTodo).toContainText('テント等が在庫を超えています：テント（申請 4・割り当て 2／在庫 3）');
    await expect(overTodo.getByRole('link')).toHaveAttribute('href', /\/lending\/?$/);
    await expect(lendingCard(head).getByRole('listitem')).toHaveText(['割り当て：確定前（在庫を超える備品 1）', '申請 2 団体・割り当て 1 団体']);
    await openPortal(staff, 'ダッシュボード');
    expect(await lendingTodoIds(staff)).toEqual([]);
    await openRecords(staff);
    await expect.poll(() => recordsGroupStates(staff)).toEqual([`${a}:lent`]);
    await expect(recordsGroup(staff, a).getByTestId('records-state')).toHaveText('貸し出し中');
    await openPortal(rep, 'ホーム');
    expect(await lendingTodoIds(rep)).toEqual([]);

    // 2日目（1日目を昨日に）：総務に未返却（ふつう）→ 受け渡し・返却の未返却へ。店長に「返してください」（ふつう）
    await setFestivalStart(s.yearId, addDays(today, -1));
    await openPortal(staff, 'ダッシュボード');
    expect(await lendingTodoIds(staff)).toEqual(['lending:soumu:unreturned']);
    const unreturned = portalTodo(staff, 'lending:soumu:unreturned');
    await expect(unreturned).toHaveAttribute('data-severity', 'normal');
    await expect(unreturned).toContainText('テント等の未返却 1 団体');
    await unreturned.getByRole('link').click();
    await expect(staff).toHaveURL(/\/lending\/records\/?\?filter=unreturned$/);
    await expect(staff.getByRole('heading', { level: 1, name: '受け渡し・返却' })).toBeVisible();
    await expect.poll(() => recordsGroupStates(staff)).toEqual([`${a}:unreturned`]);
    await openPortal(rep, 'ホーム');
    expect(await lendingTodoIds(rep)).toEqual([`lending:rep:${a}:unreturned`]);
    const back = portalTodo(rep, `lending:rep:${a}:unreturned`);
    await expect(back).toHaveAttribute('data-severity', 'normal');
    await expect(back).toContainText(`${A}：テント等を返してください（テント 1）`);
    await openPortal(head, 'ダッシュボード');
    expect(await lendingTodoIds(head)).toEqual([`lending:lead:over-stock:${tent}`, 'lending:soumu:unreturned']);

    // 在庫超過を直す（部門1 にテント 1）→ 部門長に「確定を押してください」（ふつう）
    await insertLendingAssignments(s.yearId, [{ groupId: b, itemId: tent, count: 1, updatedBy: headU.id }]);
    await openPortal(head, 'ダッシュボード');
    expect(await lendingTodoIds(head)).toEqual(['lending:lead:confirm', 'lending:soumu:unreturned']);
    await expect(portalTodo(head, 'lending:lead:confirm')).toHaveAttribute('data-severity', 'normal');
    await expect(portalTodo(head, 'lending:lead:confirm')).toContainText('テント等の割り当てを確かめて「確定」を押してください');
    await expect(lendingCard(head).getByRole('listitem')).toHaveText(['割り当て：確定前', '申請 2 団体・割り当て 2 団体']);

    // 確定 → 店長に「割り当てが決まりました」（参考。まだ渡していない部門1）。総務のカードに渡した・未返却
    await confirmLending(s.yearId, headU.id);
    const label = await confirmedLabel(s.yearId);
    await openPortal(rep, 'ホーム');
    expect(await lendingTodoIds(rep)).toEqual([`lending:rep:${a}:unreturned`, `lending:rep:${b}:assigned`]);
    const assigned = portalTodo(rep, `lending:rep:${b}:assigned`);
    await expect(assigned).toHaveAttribute('data-severity', 'info');
    await expect(assigned).toContainText(`${B}：テント等の割り当てが決まりました（テント 1）`);
    await expect(assigned.getByRole('link')).toHaveAttribute('href', new RegExp(`/request/?\\?group=${b}&tab=lending$`));
    await openPortal(staff, 'ダッシュボード');
    await expect(lendingCard(staff).getByRole('listitem')).toHaveText([`割り当て：確定（${label}）`, '申請 2 団体・割り当て 2 団体', '渡した 1／2 団体・未返却 1 団体']);
    await openPortal(head, 'ダッシュボード');
    expect(await lendingTodoIds(head)).toEqual(['lending:soumu:unreturned']);

    // 祭の後（1日目を2日前に）：未返却は急ぎ
    await setFestivalStart(s.yearId, addDays(today, -2));
    await openPortal(staff, 'ダッシュボード');
    await expect(portalTodo(staff, 'lending:soumu:unreturned')).toHaveAttribute('data-severity', 'urgent');
    await openPortal(rep, 'ホーム');
    await expect(portalTodo(rep, `lending:rep:${a}:unreturned`)).toHaveAttribute('data-severity', 'urgent');
    await expect(portalTodo(rep, `lending:rep:${b}:assigned`)).toHaveAttribute('data-severity', 'info');
  } finally {
    for (const p of pages) await p.context().close().catch(() => undefined);
    await s.cleanup();
    for (const u of users) await u.cleanup();
  }
});

// ---------------------------------------------------------------- 7. 確定の解除（理由）→ 直す → 確定

test.describe('T21 確定の解除', () => {
  test.use({ storageState: storageStateFor('head'), viewport: PC });

  test('T21 確定を解除（理由が要る）→ 割り当てを直す → 確定し直す。解除の間は店長のタブに割り当てが出ず、監査に理由が残る', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', dataset: 'small', roles: { head: true }, repGroup: A });
    const rep = await openAs(browser, 'rep', s, MOBILE);
    try {
      const a = s.ids.groups[A]!;
      const { tent, weight } = await tentAndWeight(s);
      await insertLendingRequests(s.yearId, [
        { groupId: a, itemId: tent, count: 2, updatedBy: REP },
        { groupId: a, itemId: weight, count: 8, updatedBy: REP },
      ]);
      await insertLendingAssignments(s.yearId, [
        { groupId: a, itemId: tent, count: 2, updatedBy: H },
        { groupId: a, itemId: weight, count: 8, updatedBy: H },
      ]);
      await confirmLending(s.yearId, H);
      await openRequestLending(rep);
      await expect(rep.getByTestId('lending-request-assigned').getByRole('listitem')).toHaveText(['割り当て：テント 2 張（申請 2）', '割り当て：重し 8 個（申請 8）']);

      await pinYear(page, H, s.yearId);
      await openLending(page);
      await expect(page.getByTestId('lending-status')).toHaveAttribute('data-confirmed', 'true');
      // 解除：理由が空なら送らない
      await page.getByTestId('lending-unconfirm').click();
      const dialog = page.getByRole('dialog', { name: '割り当ての確定を解除しますか' });
      await expect(dialog).toContainText('解除すると、店長・副店長と閲覧のみの人は割り当てを見られなくなります。');
      await dialog.getByRole('button', { name: '確定を解除する' }).click();
      await expect(dialog).toContainText('理由を入れてください');
      expect(await lendingConfirmationOf(s.yearId)).toEqual({ confirmed: true, confirmed_by: H });
      await dialog.getByLabel('理由（必須）').fill('E2E 重しを1つ減らす');
      await dialog.getByRole('button', { name: '確定を解除する' }).click();
      await expect(page.getByText('確定を解除しました')).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('lending-status')).toHaveAttribute('data-confirmed', 'false');
      await expect(page.getByTestId('lending-status')).toContainText('割り当て：確定前');
      expect(await lendingConfirmationOf(s.yearId)).toEqual({ confirmed: false, confirmed_by: null });
      // 解除の間は、店長のタブに割り当てが出ない
      await openRequestLending(rep);
      await expect(rep.getByTestId('lending-request-assigned')).toHaveCount(0);

      // 直す（重し 8 → 7）→ 保存 → 確定し直す
      await fillCell(page, a, weight, '7');
      await page.getByTestId('lending-save').click();
      await expect(page.getByText('割り当てを保存しました（1件）')).toBeVisible();
      await expect(page.getByTestId('lending-confirm')).toBeEnabled();
      await page.getByTestId('lending-confirm').click();
      const confirm = page.getByRole('alertdialog', { name: '割り当てを確定しますか' });
      await expect(confirm.getByTestId('lending-confirm-dialog').locator('tbody tr')).toHaveText(['テント2／3', '重し7／20']);
      await confirm.getByRole('button', { name: '確定する' }).click();
      await expect(page.getByText('割り当てを確定しました')).toBeVisible();
      await expect(page.getByTestId('lending-status')).toHaveAttribute('data-confirmed', 'true');
      expect(await lendingConfirmationOf(s.yearId)).toEqual({ confirmed: true, confirmed_by: H });
      await openRequestLending(rep);
      await expect(rep.getByTestId('lending-request-assigned').getByRole('listitem')).toHaveText(['割り当て：テント 2 張（申請 2）', '割り当て：重し 7 個（申請 8）']);

      // 監査：確定の印は SQL で入れた確定（理由なし）→ 解除（入れた理由）→ 確定（決まった文）。割り当ては「テント等の割り当て」
      const years = await lendingAuditOf(s.yearId, 'lending_years');
      expect(years.map((r) => r.reason)).toEqual([null, 'E2E 重しを1つ減らす', 'テント等の割り当ての確定']);
      expect(years.slice(1).map((r) => r.user_id)).toEqual([H, H]);
      const assignments = await lendingAuditOf(s.yearId, 'lending_assignments');
      expect(assignments.at(-1)).toMatchObject({ action: 'update', reason: 'テント等の割り当て', user_id: H });
    } finally {
      await rep.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 8. 終了した年度

test('T21 終了した年度：/lending・/lending/records・/request のテント等は読むだけ（帯と、書くためのものがない）。ダッシュボードにテント等の要対応を出さない（未返却があっても）', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'small', roles: { head: true, staff: true }, repGroup: A });
  const head = await openAs(browser, 'head', s);
  const staff = await openAs(browser, 'staff', s, MOBILE);
  const rep = await openAs(browser, 'rep', s, MOBILE);
  try {
    const a = s.ids.groups[A]!;
    const { tent } = await tentAndWeight(s);
    await insertLendingRequests(s.yearId, [{ groupId: a, itemId: tent, count: 2, updatedBy: REP }]);
    await insertLendingAssignments(s.yearId, [{ groupId: a, itemId: tent, count: 2, updatedBy: H }]);
    await insertLendingRecords(s.yearId, [{ groupId: a, itemId: tent, lent: 2, returned: 1, updatedBy: SEED_USER_IDS.staff }]);
    await confirmLending(s.yearId, H);
    const closed = '終了した年度のため、テント等の貸し出しは読むだけです';

    // /lending：帯と CSV だけ（登録・編集・削除・確定・解除・セルの欄・申請どおりに入れるはない）
    await openLending(head);
    await expect(head.getByTestId('lending-readonly')).toHaveText(closed);
    await expect(head.getByTestId('lending-csv')).toBeVisible();
    for (const id of [
      'lending-item-add',
      'lending-item-import',
      'lending-item-edit',
      'lending-item-delete',
      'lending-confirm',
      'lending-unconfirm',
      'lending-cell-input',
      'lending-fill-requested',
      'lending-confirmed-note',
    ]) {
      await expect(head.getByTestId(id)).toHaveCount(0);
    }
    await expect(lendingCell(head, a, tent)).toHaveText('2');
    // ダッシュボード：終了の年度ではテント等の要対応を作らない。カードは出す
    await openPortal(head, 'ダッシュボード');
    expect(await lendingTodoIds(head)).toEqual([]);
    await expect(lendingCard(head).getByRole('listitem').first()).toHaveText(`割り当て：確定（${await confirmedLabel(s.yearId)}）`);

    // /lending/records：帯。団体の欄は読むだけ（保存・割り当てどおり渡した・全部返ったがなく、＋－と数の欄は押せない）
    await openRecords(staff, `?group=${a}`);
    await expect(staff.getByTestId('lending-readonly')).toHaveText(closed);
    for (const id of ['records-save', 'records-lend-all', 'records-return-all']) await expect(staff.getByTestId(id)).toHaveCount(0);
    await expect(staff.getByRole('button', { name: 'テントの渡した数を1増やす' })).toBeDisabled();
    await expect(recordsCount(staff, tent, 'lent')).toHaveValue('2');
    await expect(recordsCount(staff, tent, 'lent')).toBeDisabled();
    await expectNoOverflow(staff);

    // /request のテント等：読み取り専用（机・椅子と同じ文）。割り当てと記録は見える
    await openRequestLending(rep);
    await expect(rep.getByTestId('lending-request-readonly')).toHaveText('締切を過ぎました。変更は総務へ');
    await expect(rep.getByTestId('lending-request-save')).toHaveCount(0);
    await expect(rep.getByRole('button', { name: 'テントの数を1増やす' })).toBeDisabled();
    await expect(rep.getByTestId('lending-request-assigned').getByRole('listitem')).toHaveText(['割り当て：テント 2 張（申請 2）']);
    await expect(rep.getByTestId('lending-request-unreturned')).toHaveText('未返却：テント 1 張');
  } finally {
    for (const p of [head, staff, rep]) await p.context().close().catch(() => undefined);
    await s.cleanup();
  }
});
