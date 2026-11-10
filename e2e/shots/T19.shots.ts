// T19 提出物（/document・/documents とダッシュボード）のスクリーンショット（画面の設計 7.4。notes/T19.md の「スクリーンショット」）。
// `pnpm e2e:shots --grep "T19 "` で notes/T19/ に撮る（CI では流さない）。年度をまたぐ表には書かない。
// 提出物と提出は SQL で入れ、ファイル（テストの中で作る PDF）は T24 の前のファイルとして上げる（uploadFileAs が SQL で T24 の前の予約を
// 作り、Storage へ上げる。T24 から画面にファイルを上げる欄はないので「アップロード中」は撮らない。D-62）。Storage の物は撮り終えたら
// Storage API で消す（cleanupDocumentsScenario。SQL では消さない）。
// 「最新でない年度」の帯を出さず、締切を今日のまわりに並べるため、撮るときだけシナリオの年度の1日目を今日（Asia/Tokyo）の 35 日後に、
// 前年度の1日目をその 364 日前に動かす（T18 の撮影と同じ考え。撮影は1つずつ流れ〔shots のプロジェクトは workers 1〕、年度は pinYear で
// 開くので、ほかのテストの既定の年度は変わらない。並行の E2E では動かさない。D-36）。終了した年度はふつう前の年度なので動かさない
// （帯も出る形を撮る）。幅 390px のものは撮るときに scrollWidth ≤ 390 を確かめる。団体・題名・理由に個人名は入れない。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import { addDays, tokyoToday } from '../support/calendar';
import { createScenario, sql, type Scenario } from '../support/db';
import { SMALL } from '../support/datasets';
import {
  apiToken,
  cleanupDocumentsScenario,
  documentCard,
  documentsCell,
  expectNoOverflow,
  insertDocuments,
  insertSubmissions,
  makePdf,
  openDocument,
  openDocuments,
  submitAs,
  tokyoDeadline,
  uploadFileAs,
} from '../support/documents';
import { openPortal } from '../support/notices';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const H = SEED_USER_IDS.head;
const REP = SEED_USER_IDS.rep;
const A = SMALL.groups.stall;
const B = SMALL.groups.department;
const C = SMALL.groups.company;
/** 撮るときに足す団体（模擬店2〔飲食〕・模擬店3・休憩所1） */
const EXTRA = { stall2: 'E2E模擬店2', stall3: 'E2E模擬店3', rest: 'E2E休憩所1' } as const;

/** 撮るときだけ、1日目を今日（Asia/Tokyo）の 35 日後に、前年度の1日目をその 364 日前にする */
async function schedule(s: Scenario): Promise<void> {
  await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + 35 where id = $1`, [s.yearId]);
  if (s.prevYearId) {
    await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + 35 - 364 where id = $1`, [s.prevYearId]);
  }
}

/** その利用者がシナリオの年度を開くページ（別のブラウザのコンテキスト） */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 知らせ（sonner）が消えるのを待つ（画像に重ねない） */
async function noToasts(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
}

/** 今から何時間前の日時（timestamptz の文字列） */
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

test('T19 店長のスマホ（一覧・提出済み・差し戻し）とホームの要対応、提出状況（表・シート・差し戻しのダイアログ）、提出物の設定・前年度から写す、部門員の見え方、管理者のダッシュボードのカード', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    roles: { admin: true, head: true, staff: true },
    repGroup: A,
    extraGroups: [
      { name: EXTRA.stall2, category: 'stall' },
      { name: EXTRA.stall3, category: 'stall' },
      { name: EXTRA.rest, category: 'rest_area' },
    ],
    prevYear: { dataset: 'small', status: 'closed' },
  });
  const pages: Page[] = [];
  try {
    await schedule(s);
    const g = (name: string) => s.ids.groups[name]!;
    // 飲食の団体（模擬店1・模擬店2）
    await sql('update public.groups set is_food = true where id = any($1::uuid[])', [[g(A), g(EXTRA.stall2)]]);
    const today = tokyoToday();
    const [power, food, plan, layout] = await insertDocuments(s.yearId, [
      {
        title: '電気使用届',
        description: '使う電気機器と消費電力（W）を書いてください。',
        deadline: tokyoDeadline(-2),
        categories: ['stall', 'department', 'company'],
        createdBy: H,
      },
      {
        title: '食品の取り扱い届',
        description: '保健所に出す届けの写しです。\n様式は総務の共有フォルダにあります。',
        deadline: tokyoDeadline(3),
        categories: ['stall'],
        foodOnly: true,
        createdBy: H,
      },
      {
        title: '出店計画書',
        description: '配置図と、使う机・椅子の数を書いてください。',
        deadline: tokyoDeadline(6),
        categories: ['stall', 'department'],
        submitUrl: 'https://drive.google.com/drive/folders/e2e-plan',
        createdBy: H,
      },
      { title: '企業ブースの配置図', deadline: tokyoDeadline(12, '12:00'), categories: ['company', 'rest_area'], submitUrl: 'https://forms.gle/e2e-layout', createdBy: H },
    ]);
    // 前年度の提出物（前年度から写す）。同じ題名の「出店計画書」は写さない
    await insertDocuments(s.prevYearId!, [
      { title: '出店計画書', deadline: `${addDays(today, 6 - 364)}T17:00:00+09:00`, categories: ['stall', 'department'], createdBy: H },
      { title: '衛生講習の受講報告', deadline: `${addDays(today, 10 - 364)}T17:00:00+09:00`, categories: ['stall'], foodOnly: true, createdBy: H },
      { title: '備品の借用書', deadline: `${addDays(today, 14 - 364)}T12:00:00+09:00`, categories: ['stall', 'department', 'company', 'rest_area'], createdBy: H },
    ]);

    // T24 の前のファイル：店長が「出店計画書」に1つ（まだ提出しない）、部門長が模擬店2 の「食品の取り扱い届」を代わりに上げて提出（代理）
    const [repToken, headToken] = await Promise.all([apiToken('rep'), apiToken('head')]);
    await uploadFileAs(repToken, { documentId: plan, groupId: g(A), body: makePdf('E2E T19 plan draft') });
    await uploadFileAs(headToken, { documentId: food, groupId: g(EXTRA.stall2), body: makePdf('E2E T19 food proxy') });
    await submitAs(headToken, food, g(EXTRA.stall2));
    // 提出の状況（SQL。ファイルなし）
    await insertSubmissions(s.yearId, [
      // 電気使用届（締切は2日前）：模擬店1 は締切の後に提出、模擬店2 は承認、模擬店3 は差し戻し、部門1・企業1 は未提出（締切を過ぎた）
      { documentId: power, groupId: g(A), status: 'submitted', submittedAt: hoursAgo(20), submittedBy: REP },
      { documentId: power, groupId: g(EXTRA.stall2), status: 'approved', submittedAt: hoursAgo(80), reviewedAt: hoursAgo(70), reviewedBy: H },
      {
        documentId: power,
        groupId: g(EXTRA.stall3),
        status: 'returned',
        submittedAt: hoursAgo(90),
        reviewedAt: hoursAgo(60),
        reviewedBy: H,
        reviewNote: 'ドライヤーの消費電力が書かれていません。書き足してから出してください。',
      },
      // 食品の取り扱い届：模擬店1 は承認（メモつき）
      { documentId: food, groupId: g(A), status: 'approved', submittedAt: hoursAgo(30), submittedBy: REP, reviewedAt: hoursAgo(26), reviewedBy: H, reviewNote: '保健所の受付印を確認しました' },
      // 出店計画書：部門1 は紙で受け取って承認、模擬店2 は差し戻し、模擬店3 は提出済み
      { documentId: plan, groupId: g(B), status: 'approved', reviewedAt: hoursAgo(5), reviewedBy: H, reviewNote: '紙で受け取りました（総務の受付）' },
      {
        documentId: plan,
        groupId: g(EXTRA.stall2),
        status: 'returned',
        submittedAt: hoursAgo(48),
        reviewedAt: hoursAgo(24),
        reviewedBy: H,
        reviewNote: '配置図に出入口がありません。',
      },
      { documentId: plan, groupId: g(EXTRA.stall3), status: 'submitted', submittedAt: hoursAgo(3) },
      // 企業ブースの配置図（提出先は Google フォーム）：企業1 は提出済み
      { documentId: layout, groupId: g(C), status: 'submitted', submittedAt: hoursAgo(2) },
    ]);

    // ---------------------------------------------------------------- 店長（スマホ）
    const rep = await openAs(browser, 'rep', s, MOBILE);
    pages.push(rep);
    await openDocument(rep);
    await expect(rep.getByTestId('latest-year-switch')).toHaveCount(0);
    await expect(rep.getByTestId('document-card')).toHaveCount(3);
    await expect(documentCard(rep, plan).getByTestId('document-file')).toHaveAttribute('data-state', 'uploaded');
    await expectNoOverflow(rep);
    await shoot(rep, 'T19', 'document-rep-list-mobile', { fullPage: true });

    const planCard = documentCard(rep, plan);

    // 提出済み（「提出を取り消す」）
    await planCard.getByTestId('document-submit').click();
    await rep.getByRole('alertdialog').filter({ hasText: '「出店計画書」を提出しますか' }).getByRole('button', { name: '提出する' }).click();
    await expect(planCard).toHaveAttribute('data-status', 'submitted');
    await noToasts(rep);
    await planCard.scrollIntoViewIfNeeded();
    await expectNoOverflow(rep);
    await shoot(rep, 'T19', 'document-rep-submitted-mobile');

    // ---------------------------------------------------------------- 部門長（PC）：提出状況・シート・差し戻しのダイアログ
    const head = await openAs(browser, 'head', s);
    pages.push(head);
    await openDocuments(head);
    await expect(documentsCell(head, plan, g(A))).toHaveAttribute('data-status', 'submitted');
    await expect(documentsCell(head, power, g(A))).toHaveAttribute('data-late', 'true');
    await expect(documentsCell(head, food, g(EXTRA.stall2))).toHaveAttribute('data-proxy', 'true');
    await expect(documentsCell(head, plan, g(B))).toHaveAttribute('data-paper', 'true');
    await shoot(head, 'T19', 'documents-status-head-pc');

    await documentsCell(head, plan, g(A)).click();
    const sheet = head.getByTestId('documents-sheet');
    await expect(sheet.getByTestId('documents-sheet-file')).toHaveCount(1);
    await expect(sheet.getByTestId('documents-sheet-submit-url')).toBeVisible();
    await expect(sheet.getByTestId('documents-sheet-approve')).toBeVisible();
    // マス目を押した位置にマウスが残ると、その下に開いたシートのボタンが hover の見た目で写る
    await head.mouse.move(0, 0);
    await shoot(head, 'T19', 'documents-sheet-head-pc');

    await sheet.getByTestId('documents-sheet-return').click();
    const returnDialog = head.getByTestId('documents-return-dialog');
    await returnDialog.getByTestId('documents-return-reason').fill('2ページ目の配置図に出入口と通路の幅がありません。\n書き足してから、もう一度出してください。');
    await shoot(head, 'T19', 'documents-return-dialog-pc');
    await returnDialog.getByTestId('documents-return-submit').click();
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'returned');

    // ---------------------------------------------------------------- 店長：差し戻しのカードとホームの要対応
    await openDocument(rep, `?document=${plan}`);
    await expect(planCard).toHaveAttribute('data-status', 'returned');
    await expect(planCard.getByTestId('document-returned-reason')).toBeVisible();
    await planCard.scrollIntoViewIfNeeded();
    await expectNoOverflow(rep);
    await shoot(rep, 'T19', 'document-rep-returned-mobile');

    await openPortal(rep, 'ホーム');
    await expect(rep.locator(`[data-testid="portal-todo"][data-id="documents:rep:${g(A)}:returned:${plan}"]`).getByTestId('portal-todo-detail')).toBeVisible();
    await expectNoOverflow(rep);
    await shoot(rep, 'T19', 'portal-documents-returned-rep-mobile', { fullPage: true });

    // ---------------------------------------------------------------- 提出物の設定・前年度から写す
    await openDocuments(head, '?tab=settings');
    await expect(head.getByTestId('documents-settings-row')).toHaveCount(4);
    await noToasts(head);
    await shoot(head, 'T19', 'documents-settings-head-pc');
    await head.getByTestId('documents-settings-copy').click();
    const copyDialog = head.getByTestId('doc-copy-dialog');
    await expect(copyDialog.getByTestId('doc-copy-item')).toHaveCount(3);
    await copyDialog.locator('[data-testid="doc-copy-item"][data-exists="false"]').first().getByTestId('doc-copy-check').click();
    await shoot(head, 'T19', 'documents-copy-previous-pc');
    await copyDialog.getByRole('button', { name: 'やめる' }).click();

    // ---------------------------------------------------------------- 総務部門員：状況だけ（シートはファイルの代わりに注意の1行）
    const staff = await openAs(browser, 'staff', s);
    pages.push(staff);
    await openDocuments(staff);
    await documentsCell(staff, power, g(A)).click();
    await expect(staff.getByTestId('documents-sheet-staff-note')).toBeVisible();
    await shoot(staff, 'T19', 'documents-status-staff-pc');

    // ---------------------------------------------------------------- 管理者のダッシュボード（要対応とカード〔使った量を含む〕）
    const admin = await openAs(browser, 'admin', s);
    pages.push(admin);
    await openPortal(admin, 'ダッシュボード');
    const card = admin.locator('[data-testid="module-card"][data-module="documents"]');
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(admin.locator('[data-testid="portal-todo"][data-id="documents:lead:submitted"]')).toBeVisible();
    await shoot(admin, 'T19', 'portal-documents-card-admin-pc', { fullPage: true });
  } finally {
    for (const p of pages) await p.context().close();
    await cleanupDocumentsScenario(s);
  }
});

test('T19 終了した年度：管理者の「この年度のファイルをすべて削除」（件数と大きさ。先に要るものを保存するよう書く）', async ({ browser }) => {
  test.setTimeout(180_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true }, repGroup: A });
  let admin: Page | null = null;
  try {
    const g = (name: string) => s.ids.groups[name]!;
    const [plan, power] = await insertDocuments(s.yearId, [
      { title: '出店計画書', deadline: tokyoDeadline(-40), categories: ['stall', 'department'], createdBy: H },
      { title: '電気使用届', deadline: tokyoDeadline(-45), categories: ['stall', 'department', 'company'], createdBy: H },
    ]);
    const repToken = await apiToken('rep');
    await uploadFileAs(repToken, { documentId: plan, groupId: g(A), body: makePdf('E2E T19 closed plan') });
    await uploadFileAs(repToken, { documentId: power, groupId: g(A), body: makePdf('E2E T19 closed power') });
    await submitAs(repToken, plan, g(A));
    await submitAs(repToken, power, g(A));
    await insertSubmissions(s.yearId, [
      { documentId: plan, groupId: g(B), status: 'approved', reviewedAt: hoursAgo(900), reviewedBy: H, reviewNote: '紙で受け取りました' },
      { documentId: power, groupId: g(C), status: 'approved', submittedAt: hoursAgo(1100), reviewedAt: hoursAgo(1090), reviewedBy: H },
    ]);
    await sql("update public.years set status = 'closed' where id = $1", [s.yearId]);
    admin = await openAs(browser, 'admin', s);
    await openDocuments(admin);
    await expect(admin.getByTestId('documents-closed')).toBeVisible();
    await expect(admin.getByTestId('documents-delete-files')).toContainText('この年度のファイルをすべて削除（2 件・');
    await shoot(admin, 'T19', 'documents-closed-admin-pc');
  } finally {
    await admin?.context().close();
    await cleanupDocumentsScenario(s);
  }
});
