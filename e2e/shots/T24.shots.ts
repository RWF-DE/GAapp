// T24 提出物をドライブへ（D-62）のスクリーンショット（画面の設計 7.4。notes/T24.md の「スクリーンショット」）。
// `pnpm e2e:shots --grep T24` で notes/T24/ に撮る（CI では流さない）。年度をまたぐ表には書かない。
// 撮るもの：店長のスマホの「提出先を開く」のカードと、提出先がないカード（T24 の前のファイルつき）、提出状況のシートの提出先、
// 提出物の設定の「提出先」の列、登録のダイアログの「提出先の URL」（誤りの文）。提出物と提出は SQL で入れ、T24 の前のファイルは
// uploadFileAs（SQL で T24 の前の予約を作り、Storage へ上げる）。Storage の物は撮り終えたら Storage API で消す（cleanupDocumentsScenario）。
// 「最新でない年度」の帯を出さないため、撮るときだけシナリオの年度の1日目を今日（Asia/Tokyo）の 35 日後に動かす（T19 の撮影と同じ）。
// 幅 390px のものは撮るときに scrollWidth ≤ 390 を確かめる。団体・題名に個人名は入れない。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
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
  tokyoDeadline,
  uploadFileAs,
} from '../support/documents';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const H = SEED_USER_IDS.head;
const A = SMALL.groups.stall;
const B = SMALL.groups.department;

async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

async function noToasts(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

test('T24 店長のスマホ（「提出先を開く」・提出先がない・T24 の前のファイル）、提出状況のシートの提出先、提出物の設定の「提出先」の列、登録のダイアログの「提出先の URL」', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true }, repGroup: A });
  const pages: Page[] = [];
  try {
    await sql(`update public.years set festival_start = (now() at time zone 'Asia/Tokyo')::date + 35 where id = $1`, [s.yearId]);
    const g = (name: string) => s.ids.groups[name]!;
    const [plan, power, report] = await insertDocuments(s.yearId, [
      {
        title: '出店計画書',
        description: '配置図と、使う机・椅子の数を書いてください。\n様式は提出先のフォルダにあります。',
        deadline: tokyoDeadline(6),
        categories: ['stall', 'department'],
        submitUrl: 'https://drive.google.com/drive/folders/e2e-plan',
        createdBy: H,
      },
      { title: '電気使用届', description: '使う電気機器と消費電力（W）を書いてください。', deadline: tokyoDeadline(3), categories: ['stall', 'department'], createdBy: H },
      { title: '片付けの報告', deadline: tokyoDeadline(14), categories: ['stall'], submitUrl: 'https://forms.gle/e2e-cleanup', createdBy: H },
    ]);
    // 電気使用届：提出先はまだなく、T24 の前に店長が上げたファイルが1つある（開く・保存・外すができる）
    await uploadFileAs(await apiToken('rep'), { documentId: power, groupId: g(A), body: makePdf('E2E T24 legacy power') });
    // 片付けの報告：提出済み（提出先は開ける）。出店計画書：部門1 は承認
    await insertSubmissions(s.yearId, [
      { documentId: report, groupId: g(A), status: 'submitted', submittedAt: hoursAgo(2), submittedBy: SEED_USER_IDS.rep },
      { documentId: plan, groupId: g(B), status: 'approved', submittedAt: hoursAgo(30), reviewedAt: hoursAgo(26), reviewedBy: H },
    ]);

    // ---------------------------------------------------------------- 店長（スマホ）
    const rep = await openAs(browser, 'rep', s, MOBILE);
    pages.push(rep);
    await openDocument(rep);
    await expect(rep.getByTestId('latest-year-switch')).toHaveCount(0);
    await expect(rep.getByTestId('document-card')).toHaveCount(3);
    const planCard = documentCard(rep, plan);
    await expect(planCard.getByTestId('document-card-submit-url')).toBeVisible();
    await expect(documentCard(rep, power).getByTestId('document-file')).toHaveAttribute('data-state', 'uploaded');
    await expectNoOverflow(rep);
    await shoot(rep, 'T24', 'document-rep-list-mobile', { fullPage: true });

    const powerCard = documentCard(rep, power);
    await expect(powerCard.getByTestId('document-card-no-submit-url')).toBeVisible();
    await powerCard.scrollIntoViewIfNeeded();
    await expectNoOverflow(rep);
    await shoot(rep, 'T24', 'document-rep-no-submit-url-mobile');

    // 「提出した」の確かめ（提出先に出してから押す）
    await planCard.scrollIntoViewIfNeeded();
    await planCard.getByTestId('document-submit').click();
    const dialog = rep.getByRole('alertdialog').filter({ hasText: '「出店計画書」を提出しますか' });
    await expect(dialog).toContainText('提出先（ドライブやフォーム）に出してから押してください。');
    await shoot(rep, 'T24', 'document-rep-submit-confirm-mobile');
    await dialog.getByRole('button', { name: '提出する' }).click();
    await expect(planCard).toHaveAttribute('data-status', 'submitted');
    await noToasts(rep);
    await planCard.scrollIntoViewIfNeeded();
    await expectNoOverflow(rep);
    await shoot(rep, 'T24', 'document-rep-submitted-mobile');

    // ---------------------------------------------------------------- 部門長（PC）：シートの提出先、設定の列、登録のダイアログ
    const head = await openAs(browser, 'head', s);
    pages.push(head);
    await openDocuments(head);
    await documentsCell(head, plan, g(A)).click();
    const sheet = head.getByTestId('documents-sheet');
    await expect(sheet.getByTestId('documents-sheet-submit-url')).toBeVisible();
    await expect(sheet.getByTestId('documents-sheet-approve')).toBeVisible();
    await head.mouse.move(0, 0);
    await shoot(head, 'T24', 'documents-sheet-submit-url-pc');
    await head.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await documentsCell(head, power, g(A)).click();
    await expect(sheet.getByTestId('documents-sheet-no-submit-url')).toBeVisible();
    await expect(sheet.getByTestId('documents-sheet-file')).toHaveCount(1);
    await head.mouse.move(0, 0);
    await shoot(head, 'T24', 'documents-sheet-legacy-file-pc');
    await head.keyboard.press('Escape');

    await openDocuments(head, '?tab=settings');
    await expect(head.getByTestId('documents-settings-row')).toHaveCount(3);
    await expect(head.getByTestId('documents-settings-submit-url')).toHaveCount(2);
    await noToasts(head);
    await shoot(head, 'T24', 'documents-settings-pc');

    await head.locator(`[data-testid="documents-settings-row"][data-document-id="${power}"]`).getByTestId('documents-settings-edit').click();
    const form = head.getByTestId('doc-dialog');
    await expect(form.getByRole('heading', { name: '提出物を編集' })).toBeVisible();
    await form.getByTestId('doc-submit-url').fill('https://drive.google.com/drive/folders/e2e-power');
    await form.getByTestId('doc-submit-url').scrollIntoViewIfNeeded();
    await shoot(head, 'T24', 'documents-form-submit-url-pc');
    // https でない URL は送らずに誤りを出す
    await form.getByTestId('doc-submit-url').fill('http://drive.google.com/drive/folders/e2e-power');
    await form.getByTestId('doc-submit').click();
    await expect(form.locator('[data-field-error="submitUrl"]')).toBeVisible();
    await form.getByTestId('doc-submit-url').scrollIntoViewIfNeeded();
    await shoot(head, 'T24', 'documents-form-submit-url-error-pc');
  } finally {
    for (const p of pages) await p.context().close();
    await cleanupDocumentsScenario(s);
  }
});
