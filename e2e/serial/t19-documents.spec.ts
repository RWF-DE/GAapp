import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from '../support/auth';
import { weekdayOf } from '../support/calendar';
import { createScenario, sql, type Scenario } from '../support/db';
import { SMALL } from '../support/datasets';
import {
  apiToken,
  cleanupDocumentsScenario,
  documentCard,
  documentsCell,
  filesOf,
  insertDocuments,
  makePdf,
  objectsOfYears,
  openDocument,
  openDocuments,
  submissionOf,
  submitAs,
  tokyoDeadline,
  uploadFileAs,
} from '../support/documents';
import { MOBILE, PC } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

// T19 提出物の serial（1つずつ流す。notes/T19.md の計画の 8 の E2E の serial）：前年度から写す（prev_year_id のある年度）と、終了した年度の
// ファイルの削除（その年度の storage.objects が空になる）。並行の E2E は e2e/t19-documents.spec.ts。シナリオの年度（small）で閉じ、
// Storage の物は Storage API で消す（cleanupDocumentsScenario。SQL では消さない）。期待値の文言は 04 のとおりに書く。

const A = SMALL.groups.stall;
const B = SMALL.groups.department;
const H = SEED_USER_IDS.head;

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ */
async function openAs(browser: Browser, user: StoredUser, s: Scenario, viewport: { width: number; height: number } = PC): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 大きさの表示（04「ファイルの扱い」：1 MB 未満は切り上げの KB） */
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

test('T19 前年度から写す：前年度の提出物を締切の順に、ずらした締切（1日目の差の日数。時刻は同じ）と一緒に並べ、同じ題名があるものは選べない。選んだものだけを写し（題名・説明・対象・ファイルが要るか）、監査の理由は「提出物の前年度からの写し」。2回目は写すものがない', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true }, prevYear: { dataset: 'small', status: 'closed' } });
  const page = await openAs(browser, 'head', s);
  try {
    // 1日目は前年度 2000-10-14、今の年度 2001-10-13（364 日の差。曜日も同じ）
    const [plan, food] = await insertDocuments(s.prevYearId!, [
      { title: 'E2E 出店計画書', description: 'E2E 前年度の説明', deadline: '2000-10-05T17:00:00+09:00', categories: ['stall', 'department'], createdBy: H },
      { title: 'E2E 食品の届け', deadline: '2000-10-01T12:00:00+09:00', categories: ['stall'], foodOnly: true, requiresFile: false, createdBy: H },
    ]);
    // この年度にはもう同じ題名（食品の届け）がある
    await insertDocuments(s.yearId, [{ title: 'E2E 食品の届け', deadline: '2001-09-29T12:00:00+09:00', categories: ['stall'], createdBy: H }]);

    await openDocuments(page, '?tab=settings');
    await expect(page.getByTestId('documents-settings-row')).toHaveCount(1);
    await page.getByTestId('documents-settings-copy').click();
    const dialog = page.getByTestId('doc-copy-dialog');
    await expect(dialog.getByRole('heading', { name: '前年度から写す' })).toBeVisible();
    await expect(dialog.getByTestId('doc-copy-item')).toHaveCount(2);
    // 締切の順（食品の届け 10/1 → 出店計画書 10/5）
    expect(await dialog.getByTestId('doc-copy-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-document-id')))).toEqual([food, plan]);
    const foodItem = dialog.locator(`[data-testid="doc-copy-item"][data-document-id="${food}"]`);
    await expect(foodItem).toHaveAttribute('data-exists', 'true');
    await expect(foodItem).toContainText('同じ題名があります（写しません）');
    await expect(foodItem).toContainText('模擬店（飲食の団体だけ）');
    await expect(foodItem.getByTestId('doc-copy-check')).toBeDisabled();
    const planItem = dialog.locator(`[data-testid="doc-copy-item"][data-document-id="${plan}"]`);
    await expect(planItem).toHaveAttribute('data-exists', 'false');
    await expect(planItem.getByTestId('doc-copy-deadline')).toHaveText(
      `前年度 10/5（${weekdayOf('2000-10-05')}）17:00 → 10/4（${weekdayOf('2001-10-04')}）17:00`,
    );
    await expect(planItem).toContainText('模擬店・部門');
    await expect(dialog.getByTestId('doc-copy-submit')).toHaveText('写す（0 件）');
    await expect(dialog.getByTestId('doc-copy-submit')).toBeDisabled();
    await planItem.getByTestId('doc-copy-check').click();
    await expect(dialog.getByTestId('doc-copy-submit')).toHaveText('写す（1 件）');
    await dialog.getByTestId('doc-copy-submit').click();
    await expect(page.getByText('1 件を写しました')).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // 写したもの：ずらした締切（時刻は同じ）、題名・説明・対象・飲食の団体だけ・ファイルが要るか。files_deleted_at は写さない
    const rows = await sql<{ title: string; deadline: string; description: string | null; target_categories: string; food_only: boolean; requires_file: boolean; files_deleted_at: string | null }>(
      `select title, to_char(deadline at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as deadline, description, target_categories::text,
              food_only, requires_file, files_deleted_at::text
         from public.documents where year_id = $1 order by deadline, title`,
      [s.yearId],
    );
    expect(rows).toEqual([
      { title: 'E2E 食品の届け', deadline: '2001-09-29 12:00', description: null, target_categories: '{stall}', food_only: false, requires_file: true, files_deleted_at: null },
      { title: 'E2E 出店計画書', deadline: '2001-10-04 17:00', description: 'E2E 前年度の説明', target_categories: '{stall,department}', food_only: false, requires_file: true, files_deleted_at: null },
    ]);
    const [audit] = await sql<{ reason: string | null; user_id: string | null }>(
      `select reason, user_id from public.audit_logs where table_name = 'documents' and action = 'insert' and year_id = $1 and after ->> 'title' = 'E2E 出店計画書'`,
      [s.yearId],
    );
    expect(audit).toEqual({ reason: '提出物の前年度からの写し', user_id: H });
    await expect(page.getByTestId('documents-settings-row')).toHaveCount(2);

    // 2回目：どちらも同じ題名がこの年度にあるので、写すものはない
    await page.getByTestId('documents-settings-copy').click();
    await expect(dialog.locator('[data-testid="doc-copy-item"][data-exists="true"]')).toHaveCount(2);
    await expect(dialog.getByTestId('doc-copy-submit')).toBeDisabled();
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.context().close();
    await cleanupDocumentsScenario(s);
  }
});

test('T19 終了した年度：管理者が「この年度のファイルをすべて削除」で、ファイルの行と Storage の物を消す（その年度の storage.objects は空になる）。状態・日時・理由は残り、削除した日時が出る。部門長には削除がなく、店長は読むだけ', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true, head: true }, repGroup: A });
  const admin = await openAs(browser, 'admin', s);
  const head = await openAs(browser, 'head', s);
  const rep = await openAs(browser, 'rep', s, MOBILE);
  try {
    const ga = s.ids.groups[A]!;
    const gb = s.ids.groups[B]!;
    const [docId] = await insertDocuments(s.yearId, [{ title: 'E2E 年度末の確かめ', deadline: tokyoDeadline(-2), categories: ['stall', 'department'], createdBy: H }]);
    // 店長が2つ上げて、締切の後に提出する（「締切の後」の印）
    const repToken = await apiToken('rep');
    const p1 = makePdf('E2E T19 closed one');
    const p2 = makePdf('E2E T19 closed two');
    await uploadFileAs(repToken, { documentId: docId, groupId: ga, body: p1 });
    await uploadFileAs(repToken, { documentId: docId, groupId: ga, body: p2 });
    await submitAs(repToken, docId, ga);
    // 年度を終了にする
    await sql("update public.years set status = 'closed' where id = $1", [s.yearId]);
    expect(await objectsOfYears([s.yearId])).toHaveLength(2);
    const size = kb(p1.length + p2.length);

    // 店長：終了した年度は読むだけ（開く・保存はできる。書くためのものは出ない）
    await openDocument(rep);
    await expect(rep.getByTestId('document-closed')).toContainText('終了した年度のため、提出物は読むだけです（ファイルは、総務が年度の終わりに削除します）');
    const card = documentCard(rep, docId);
    await expect(card).toHaveAttribute('data-status', 'submitted');
    await expect(card).toHaveAttribute('data-late', 'true');
    await expect(card.getByTestId('document-file-open')).toHaveCount(2);
    for (const id of ['document-file-add', 'document-file-remove', 'document-submit', 'document-withdraw']) await expect(card.getByTestId(id)).toHaveCount(0);

    // 部門長：帯は出るが、年度のファイルの削除はない（管理者だけ）。シートに操作は出ない
    await openDocuments(head);
    await expect(head.getByTestId('documents-closed')).toContainText('終了した年度のため、提出物は読むだけです');
    await expect(head.getByTestId('documents-delete-files')).toHaveCount(0);
    await documentsCell(head, docId, ga).click();
    await expect(head.getByTestId('documents-sheet-file')).toHaveCount(2);
    for (const id of ['documents-sheet-approve', 'documents-sheet-return', 'documents-sheet-paper', 'documents-sheet-withdraw', 'documents-sheet-file-remove', 'documents-sheet-file-add']) {
      await expect(head.getByTestId(id)).toHaveCount(0);
    }

    // 管理者：「この年度のファイルをすべて削除（2 件・X KB）」→ 確かめ（理由は任意）→ 削除と片付け
    await openDocuments(admin);
    await expect(admin.getByTestId('documents-closed')).toBeVisible();
    await expect(documentsCell(admin, docId, ga)).toHaveAttribute('data-late', 'true');
    await expect(documentsCell(admin, docId, gb)).toHaveAttribute('data-status', 'not_submitted');
    const deleteButton = admin.getByTestId('documents-delete-files');
    await expect(deleteButton).toHaveText(`この年度のファイルをすべて削除（2 件・${size}）`);
    await expect(admin.getByText('削除すると、提出物のファイルは開けなくなります（状態・日時・理由は残ります）。要るファイルは先に「保存」してください。')).toBeVisible();
    await deleteButton.click();
    const confirm = admin.getByRole('alertdialog').filter({ hasText: 'この年度の提出物のファイルをすべて削除しますか' });
    await expect(confirm).toContainText(`2 件（${size}）を削除します。元に戻せません。`);
    await confirm.getByTestId('documents-delete-files-reason').fill('E2E 年度の終わりの片付け');
    await confirm.getByRole('button', { name: 'すべて削除する' }).click();
    await expect(admin.getByText('ファイル 2 件を削除しました')).toBeVisible();
    await expect(admin.getByTestId('documents-files-deleted')).toContainText('この年度のファイルは');
    await expect(admin.getByTestId('documents-files-deleted')).toContainText('に削除しました');
    await expect(admin.getByTestId('documents-delete-files')).toHaveCount(0);
    await expect(admin.getByTestId('documents-cleanup')).toHaveCount(0);

    // DB と Storage：その年度の物とファイルの行はない。提出の状態・日時は残り、files_deleted_at が入る。監査の理由は入れた理由
    expect(await objectsOfYears([s.yearId])).toEqual([]);
    expect(await filesOf(docId, ga)).toEqual([]);
    const sub = await submissionOf(docId, ga);
    expect([sub?.status, sub?.submitted_at !== null]).toEqual(['submitted', true]);
    const [doc] = await sql<{ deleted: boolean }>('select files_deleted_at is not null as deleted from public.documents where id = $1', [docId]);
    expect(doc?.deleted).toBe(true);
    const audits = await sql<{ reason: string | null }>(
      `select reason from public.audit_logs where table_name = 'document_files' and action = 'delete' and year_id = $1`,
      [s.yearId],
    );
    expect(audits.map((a) => a.reason)).toEqual(['E2E 年度の終わりの片付け', 'E2E 年度の終わりの片付け']);

    // 店長の画面からもファイルは消える（状態は残る）
    await openDocument(rep);
    await expect(card).toHaveAttribute('data-status', 'submitted');
    await expect(card.getByTestId('document-file')).toHaveCount(0);
  } finally {
    await admin.context().close();
    await head.context().close();
    await rep.context().close();
    await cleanupDocumentsScenario(s);
  }
});
