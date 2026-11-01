// T21 テント等の貸し出し（/lending・/lending/records・/request のテント等のタブとダッシュボード）のスクリーンショット（画面の設計 7.4。
// notes/T21.md の「スクリーンショット」）。`pnpm e2e:shots --grep "T21 "` で notes/T21/ に撮る（CI では流さない）。年度をまたぐ表には
// 書かない。テント等の行は SQL で入れる（e2e/support/lending.ts）。データは合成データ r8like（模擬店・部門が多い）。
// 「最新でない年度」の帯を出さず、祭の日を今日のまわりに置くため、撮るときだけシナリオの年度の1日目と受付期間を動かす（T16〜T18 の撮影と
// 同じ考え。撮影は1つずつ流れ〔shots のプロジェクトは workers 1〕、年度は pinYear で開くので、ほかのテストの既定の年度は変わらない。
// 並行の E2E〔e2e/t21-lending.spec.ts〕では seed の利用者の年度を動かさない。D-36）。終了した年度は動かさない（前の年度の形で撮る）。
// 幅 390px のものは撮るときに scrollWidth ≤ 390 を確かめる。書いた人は seed の利用者（画面には出さない）。年度は撮り終えたら消す。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import { createScenario, sql, type Scenario } from '../support/db';
import {
  confirmLending,
  insertLendingAssignments,
  insertLendingItems,
  insertLendingRecords,
  insertLendingRequests,
  itemRow,
  lendingTodoIds,
  openLending,
  openRecords,
  openRequestLending,
  recordsGroup,
  type LendingCountInput,
} from '../support/lending';
import { openPortal } from '../support/notices';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const H = SEED_USER_IDS.head;
const ST = SEED_USER_IDS.staff;
const REP = SEED_USER_IDS.rep;
/** A4 縦（96 dpi）の幅と高さ（印刷用の表を撮る） */
const A4 = { width: 794, height: 1123 } as const;

/** その利用者がシナリオの年度を開くページ（別のブラウザのコンテキスト） */
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

/**
 * 撮るときだけ、1日目を今日（Asia/Tokyo）から days 日の所に、申請の締切を closeDays 日後の 17:00 に（負なら締切を過ぎた形）、受付開始を
 * 締切の 30 日前にする（受付開始は締切より前。years の CHECK）
 */
async function schedule(s: Scenario, days: number, closeDays: number): Promise<void> {
  await sql(
    `with c as (select (((now() at time zone 'Asia/Tokyo')::date + $3::int)::timestamp + time '17:00') at time zone 'Asia/Tokyo' as close_at)
     update public.years
        set festival_start = (now() at time zone 'Asia/Tokyo')::date + $2::int,
            request_open_at = c.close_at - interval '30 days',
            request_close_at = c.close_at
       from c
      where id = $1`,
    [s.yearId, days, closeDays],
  );
}

/** r8like の団体を名前で引く */
const gid = (s: Scenario, name: string): string => {
  const id = s.ids.groups[name];
  if (!id) throw new Error(`団体「${name}」がシナリオにありません`);
  return id;
};
const pad = (n: number) => String(n).padStart(2, '0');
/** 模擬店01〜模擬店12 */
const STALLS = Array.from({ length: 12 }, (_, k) => `模擬店${pad(k + 1)}`);
/** 部門（設営・学科展示・部門01・部門02） */
const DEPTS = ['設営', '学科展示', '部門01', '部門02'];

interface Items {
  tent: string;
  weight: string;
  curtain: string;
  sheet: string;
}

/** 備品4つ（テント 12 張・重し 80 個・三方幕 10 枚〔模擬店だけ〕・ブルーシート 20 枚〔模擬店・部門・休憩所〕） */
async function seedItems(s: Scenario): Promise<Items> {
  const [tent, weight, curtain, sheet] = await insertLendingItems(s.yearId, [
    { name: 'テント', unit: '張', stock: 12 },
    { name: '重し', stock: 80 },
    { name: '三方幕', unit: '枚', stock: 10, categories: ['stall'] },
    { name: 'ブルーシート', unit: '枚', stock: 20, categories: ['stall', 'department', 'rest_area'] },
  ]);
  return { tent, weight, curtain, sheet };
}

/** 模擬店 12・部門 4 の申請（テントは合計 20 で在庫 12 を超える） */
function requestsOf(s: Scenario, it: Items): LendingCountInput[] {
  return [
    ...STALLS.flatMap((n, k) => [
      { groupId: gid(s, n), itemId: it.tent, count: k % 3 === 0 ? 2 : 1, updatedBy: REP },
      { groupId: gid(s, n), itemId: it.weight, count: 4, updatedBy: REP },
      ...(k < 8 ? [{ groupId: gid(s, n), itemId: it.curtain, count: 1, updatedBy: REP }] : []),
    ]),
    ...DEPTS.flatMap((n) => [
      { groupId: gid(s, n), itemId: it.tent, count: 1, updatedBy: REP },
      { groupId: gid(s, n), itemId: it.weight, count: 4, updatedBy: REP },
      { groupId: gid(s, n), itemId: it.sheet, count: 2, updatedBy: REP },
    ]),
  ];
}

// ---------------------------------------------------------------- 備品と割り当て（PC）とダッシュボード（総務部門長）

test.describe('T21 備品と割り当て', () => {
  test('T21 備品と割り当て（総務部門長：受付中・在庫超過・確定のダイアログ・確定中、備品の登録のダイアログ、ダッシュボード）と、総務部門員・閲覧のみ（確定後）', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { head: true, staff: true, viewer: true } });
    const pages: Page[] = [];
    try {
      // 受付中（締切は 6 日後）。祭は 14 日後
      await schedule(s, 14, 6);
      const it = await seedItems(s);
      const requests = requestsOf(s, it);
      await insertLendingRequests(s.yearId, requests);
      // 受付中に、模擬店01〜06 のテントと重しだけ申請どおりに割り当てておく（未入力・同じ・違うが並ぶ）
      await insertLendingAssignments(
        s.yearId,
        requests
          .filter((r) => (r.itemId === it.tent || r.itemId === it.weight) && STALLS.slice(0, 6).some((n) => gid(s, n) === r.groupId))
          .map((r) => ({ ...r, count: r.groupId === gid(s, '模擬店02') && r.itemId === it.weight ? 3 : r.count, updatedBy: H })),
      );

      const head = await openAs(browser, 'head', s);
      pages.push(head);
      await openLending(head);
      await expect(itemRow(head, it.tent)).toHaveAttribute('data-over', 'requested');
      await expect(head.getByTestId('lending-confirm-blockers')).toBeVisible();
      await shoot(head, 'T21', 'lending-before-confirm', { fullPage: true });

      // 備品の登録のダイアログ（入れかけ）
      await head.getByTestId('lending-item-add').click();
      const add = head.getByRole('dialog', { name: '備品を登録' });
      await add.getByLabel('名前', { exact: true }).fill('のぼり旗');
      await add.getByLabel('単位', { exact: true }).fill('本');
      await add.getByLabel('在庫', { exact: true }).fill('30');
      await shoot(head, 'T21', 'lending-item-dialog');
      await add.getByRole('button', { name: 'やめる' }).click();
      await head.getByRole('alertdialog', { name: '保存していない入力を捨てますか' }).getByRole('button', { name: '捨てて閉じる' }).click();
      await expect(add).toHaveCount(0);

      // 締切の後：全部を申請どおりに割り当てた → テントの割り当て合計（20）が在庫（12）を超えて確定できない
      await schedule(s, 14, -1);
      await insertLendingAssignments(
        s.yearId,
        requests.map((r) => ({ ...r, count: r.groupId === gid(s, '模擬店02') && r.itemId === it.weight ? 3 : r.count, updatedBy: H })),
      );
      await openLending(head);
      await expect(itemRow(head, it.tent)).toHaveAttribute('data-over', 'assigned');
      await expect(head.locator('[data-testid="lending-confirm-blockers"] li[data-kind="over_stock"]')).toBeVisible();
      await shoot(head, 'T21', 'lending-over-stock', { fullPage: true });
      // ダッシュボード（総務部門長）：在庫超過の要対応（急ぎ）とカード
      await openPortal(head, 'ダッシュボード');
      expect(await lendingTodoIds(head)).toEqual([`lending:lead:over-stock:${it.tent}`]);
      await shoot(head, 'T21', 'portal-lead', { fullPage: true });

      // テントを直して在庫に収める（2 張の模擬店を 1 張に、部門は 0 張に）→ 確定のダイアログ → 確定
      for (const [k, n] of STALLS.entries()) {
        if (k % 3 === 0) await insertLendingAssignments(s.yearId, [{ groupId: gid(s, n), itemId: it.tent, count: 1, updatedBy: H }]);
      }
      await insertLendingAssignments(
        s.yearId,
        DEPTS.map((n) => ({ groupId: gid(s, n), itemId: it.tent, count: 0, updatedBy: H })),
      );
      await openLending(head);
      await expect(head.getByTestId('lending-confirm')).toBeEnabled();
      await head.getByTestId('lending-confirm').click();
      const confirm = head.getByRole('alertdialog', { name: '割り当てを確定しますか' });
      await expect(confirm.getByTestId('lending-confirm-dialog')).toBeVisible();
      await shoot(head, 'T21', 'lending-confirm-dialog');
      await confirm.getByRole('button', { name: '確定する' }).click();
      await expect(head.getByTestId('lending-status')).toHaveAttribute('data-confirmed', 'true');
      await expect(head.getByRole('alertdialog')).toHaveCount(0);
      // 「割り当てを確定しました」の知らせが消えてから撮る（ヘッダーに重ねない）
      await expect(head.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
      await shoot(head, 'T21', 'lending-confirmed', { fullPage: true });

      // 総務部門員（読むだけと CSV）・閲覧のみ（確定後の備品と割り当てだけ）
      const staff = await openAs(browser, 'staff', s);
      pages.push(staff);
      await openLending(staff);
      await expect(staff.getByTestId('lending-staff-note')).toBeVisible();
      await expect(staff.getByTestId('lending-assignments')).toBeVisible();
      await shoot(staff, 'T21', 'lending-staff', { fullPage: true });
      const viewer = await openAs(browser, 'viewer', s);
      pages.push(viewer);
      await openLending(viewer);
      await expect(viewer.getByTestId('lending-assignments')).toBeVisible();
      await shoot(viewer, 'T21', 'lending-viewer', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 受け渡し・返却（スマホ）とダッシュボード（総務部門員）

test.describe('T21 受け渡し・返却', () => {
  test('T21 受け渡し・返却（総務部門員・390px：一覧・団体の欄・衝突のダイアログ、印刷用の表〔A4〕、2日目のダッシュボード）', async ({ browser }) => {
    test.setTimeout(300_000);
    const s = await createScenario({ status: 'confirmed', dataset: 'synthetic', roles: { head: true, staff: true } });
    const pages: Page[] = [];
    try {
      // 2日目（1日目は昨日）。割り当ては確定
      await schedule(s, -1, -20);
      const it = await seedItems(s);
      const requests = requestsOf(s, it).map((r) =>
        r.itemId === it.tent && r.count === 2 ? { ...r, count: 1 } : r.itemId === it.tent && DEPTS.some((n) => gid(s, n) === r.groupId) ? { ...r, count: 0 } : r,
      );
      await insertLendingRequests(s.yearId, requestsOf(s, it));
      await insertLendingAssignments(
        s.yearId,
        requests.map((r) => ({ ...r, updatedBy: H })),
      );
      await confirmLending(s.yearId, H);
      // 模擬店01〜04 は返却済み、05〜08 は一部が返っていない（05 は重しが 1 つ破損）、09〜12 は渡す前。部門は渡して返っていない
      const lent = requests.filter((r) => r.count > 0);
      const byGroup = (names: string[]) => lent.filter((r) => names.some((n) => gid(s, n) === r.groupId));
      await insertLendingRecords(s.yearId, [
        ...byGroup(STALLS.slice(0, 4)).map((r) => ({ groupId: r.groupId, itemId: r.itemId, lent: r.count, returned: r.count, updatedBy: ST })),
        ...byGroup(STALLS.slice(4, 8)).map((r) => ({
          groupId: r.groupId,
          itemId: r.itemId,
          lent: r.count,
          returned: r.itemId === it.weight ? r.count - 1 : r.count,
          damaged: r.itemId === it.weight && r.groupId === gid(s, '模擬店05') ? 1 : 0,
          note: r.itemId === it.weight && r.groupId === gid(s, '模擬店05') ? '1つ角が割れている（団体に伝えた）' : null,
          updatedBy: ST,
        })),
        ...byGroup(DEPTS).map((r) => ({ groupId: r.groupId, itemId: r.itemId, lent: r.count, updatedBy: ST })),
      ]);

      const staff = await openAs(browser, 'staff', s, MOBILE);
      pages.push(staff);
      await openRecords(staff);
      await expect(staff.getByTestId('records-group')).toHaveCount(16);
      await expectNoOverflow(staff);
      await shoot(staff, 'T21', 'records-list', { fullPage: true });

      // 団体の欄（模擬店05：重しが 1 つ返っておらず、1 つ破損）
      await recordsGroup(staff, gid(s, '模擬店05')).getByRole('button').click();
      await expect(staff.getByTestId('records-panel')).toBeVisible();
      await expect(staff.getByTestId('records-note')).toBeVisible();
      await expectNoOverflow(staff);
      // 画面の高さで撮る（下に固定の「保存」は、ページ全体の絵では途中に重なって写るため。スマホで見える形）
      await shoot(staff, 'T21', 'records-panel');

      // 衝突のダイアログ：模擬店09 の欄を開いた後に、ほかの人（総務部門長）が記録を保存した
      await openRecords(staff, `?group=${gid(s, '模擬店09')}`);
      await expect(staff.getByTestId('records-panel')).toBeVisible();
      const g9 = byGroup(['模擬店09']);
      await insertLendingRecords(
        s.yearId,
        g9.map((r) => ({ groupId: r.groupId, itemId: r.itemId, lent: r.count, updatedBy: H })),
      );
      await staff.getByTestId('records-lend-all').click();
      await staff.getByRole('button', { name: 'テントの返った数を1増やす' }).click();
      await staff.getByTestId('records-save').click();
      const conflict = staff.getByRole('alertdialog', { name: '入力を始めた後に、ほかの人がこの団体の記録を保存しました' });
      await expect(conflict).toBeVisible();
      await expectNoOverflow(staff);
      await shoot(staff, 'T21', 'records-conflict');
      await conflict.getByRole('button', { name: '読み直す' }).click();
      await expect(conflict).toHaveCount(0);

      // 印刷用の表（A4 縦。印刷のメディアで撮る）
      await staff.setViewportSize(A4);
      await openRecords(staff);
      await staff.emulateMedia({ media: 'print' });
      await expect(staff.getByTestId('records-print-sheet')).toBeVisible();
      await shoot(staff, 'T21', 'records-print', { fullPage: true });
      await staff.emulateMedia({ media: 'screen' });
      await staff.setViewportSize(MOBILE);

      // 2日目のダッシュボード（総務部門員・390px）：未返却の要対応とカード
      await openPortal(staff, 'ダッシュボード');
      expect(await lendingTodoIds(staff)).toEqual(['lending:soumu:unreturned']);
      await expectNoOverflow(staff);
      await shoot(staff, 'T21', 'portal-staff-day2', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });

  test('T21 受け渡し・返却（終了した年度・390px）：帯と、読むだけの団体の欄', async ({ browser }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'closed', requestWindow: 'closed', dataset: 'synthetic', roles: { staff: true } });
    const pages: Page[] = [];
    try {
      const it = await seedItems(s);
      const g = gid(s, '模擬店03');
      await insertLendingAssignments(s.yearId, [
        { groupId: g, itemId: it.tent, count: 1, updatedBy: H },
        { groupId: g, itemId: it.weight, count: 4, updatedBy: H },
      ]);
      await insertLendingRecords(s.yearId, [
        { groupId: g, itemId: it.tent, lent: 1, returned: 1, updatedBy: ST },
        { groupId: g, itemId: it.weight, lent: 4, returned: 4, updatedBy: ST },
      ]);
      await confirmLending(s.yearId, H);
      const staff = await openAs(browser, 'staff', s, MOBILE);
      pages.push(staff);
      await openRecords(staff, `?group=${g}`);
      await expect(staff.getByTestId('lending-readonly')).toBeVisible();
      await expect(staff.getByTestId('records-save')).toHaveCount(0);
      await expectNoOverflow(staff);
      await shoot(staff, 'T21', 'records-closed', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});

// ---------------------------------------------------------------- 申請のテント等のタブとホーム（店長・スマホ）

test.describe('T21 申請のテント等のタブ', () => {
  test('T21 申請のテント等のタブ（店長・390px：受付中・締切後・確定後）とホーム（割り当てが決まった・返してください）', async ({ browser }) => {
    test.setTimeout(300_000);
    const s = await createScenario({ status: 'requesting', dataset: 'synthetic', roles: { head: true }, repGroup: '模擬店10' });
    const pages: Page[] = [];
    try {
      // 店長は 部門01 の副店長も務める（ホームに2つの団体の要対応を出す）
      await sql("insert into public.group_members (group_id, user_id, role) values ($1, $2, 'deputy_manager')", [gid(s, '部門01'), REP]);
      await schedule(s, 14, 6);
      const it = await seedItems(s);
      const g = gid(s, '模擬店10');
      await insertLendingRequests(s.yearId, [
        { groupId: g, itemId: it.tent, count: 2, updatedBy: REP },
        { groupId: g, itemId: it.weight, count: 8, updatedBy: REP },
        { groupId: g, itemId: it.curtain, count: 1, updatedBy: REP },
        { groupId: g, itemId: it.sheet, count: 0, updatedBy: REP },
        { groupId: gid(s, '部門01'), itemId: it.tent, count: 1, updatedBy: REP },
      ]);

      // 受付中：保存した数と保存した日時。入れかけの数（重し 8 → 6）でタブに保存していない印
      const rep = await openAs(browser, 'rep', s, MOBILE);
      pages.push(rep);
      await openRequestLending(rep, `?group=${g}&tab=lending`);
      await rep.getByRole('button', { name: '重しの数を1減らす' }).click();
      await rep.getByRole('button', { name: '重しの数を1減らす' }).click();
      await expect(rep.getByTestId('request-tab-lending')).toHaveAttribute('data-unsaved', 'true');
      await expectNoOverflow(rep);
      await shoot(rep, 'T21', 'request-lending-open', { fullPage: true });
      // 入れかけを戻す（離れるときの確かめを出さない）
      await rep.getByRole('button', { name: '重しの数を1増やす' }).click();
      await rep.getByRole('button', { name: '重しの数を1増やす' }).click();
      await expect(rep.getByTestId('request-tab-lending')).not.toHaveAttribute('data-unsaved', 'true');

      // 締切後：読み取り専用
      await schedule(s, 14, -1);
      await rep.reload();
      await expect(rep.getByTestId('lending-request-readonly')).toBeVisible();
      await expect(rep.getByTestId('lending-request')).toBeVisible();
      await expectNoOverflow(rep);
      await shoot(rep, 'T21', 'request-lending-closed', { fullPage: true });

      // 確定後（2日目）：割り当て（重しは申請より少ない・三方幕は 0）と、渡した・返った・未返却
      await schedule(s, -1, -20);
      await insertLendingAssignments(s.yearId, [
        { groupId: g, itemId: it.tent, count: 2, updatedBy: H },
        { groupId: g, itemId: it.weight, count: 6, updatedBy: H },
        { groupId: g, itemId: it.curtain, count: 0, updatedBy: H },
        { groupId: gid(s, '部門01'), itemId: it.tent, count: 1, updatedBy: H },
      ]);
      await insertLendingRecords(s.yearId, [
        { groupId: g, itemId: it.tent, lent: 2, returned: 1, updatedBy: ST },
        { groupId: g, itemId: it.weight, lent: 6, returned: 6, updatedBy: ST },
      ]);
      await confirmLending(s.yearId, H);
      await openRequestLending(rep, `?group=${g}&tab=lending`);
      await expect(rep.getByTestId('lending-request-assigned')).toBeVisible();
      await expect(rep.getByTestId('lending-request-unreturned')).toBeVisible();
      await expectNoOverflow(rep);
      await shoot(rep, 'T21', 'request-lending-confirmed', { fullPage: true });

      // ホーム：模擬店10 は返してください（ふつう）、部門01 は割り当てが決まりました（参考）
      await openPortal(rep, 'ホーム');
      expect(await lendingTodoIds(rep)).toEqual([`lending:rep:${g}:unreturned`, `lending:rep:${gid(s, '部門01')}:assigned`]);
      await expectNoOverflow(rep);
      await shoot(rep, 'T21', 'portal-rep', { fullPage: true });
    } finally {
      for (const p of pages) await p.context().close().catch(() => undefined);
      await s.cleanup();
    }
  });
});
