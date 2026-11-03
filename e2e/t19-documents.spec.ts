import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { navLabels } from './helpers';
import { storageStateFor, type StoredUser } from './support/auth';
import { addDays, tokyoToday, weekdayOf } from './support/calendar';
import { createScenario, createUser, sql, type Scenario, type TestUser } from './support/db';
import { SMALL } from './support/datasets';
import {
  apiGet,
  apiToken,
  cleanupDocumentsScenario,
  confirmNotLatest,
  documentCard,
  documentsCell,
  documentsModuleCard,
  expectNoOverflow,
  expectNoSignedUrlStored,
  fileTimeLabel,
  filesOf,
  insertDocuments,
  makeJpeg,
  makePdf,
  objectExists,
  objectsOfYears,
  openDocument,
  openDocuments,
  portalDated,
  portalTodo,
  reserveFile,
  shortTimeOf,
  storageDownload,
  storageUpload,
  submissionOf,
  submitAs,
  tokyoDeadline,
  uploadFileAs,
} from './support/documents';
import { openPortal } from './support/notices';
import { loginWith } from './support/roles';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T19 提出物（/document〔店長・副店長。スマホ〕・/documents〔総務。PC〕とダッシュボード。04「提出物」「自団体の提出物」「提出状況」
// 「ダッシュボードに出すもの（提出物）」、D-55、notes/T19.md の計画の 8 の E2E と「パート B・C の約束」15）。シナリオの年度（small。
// 1日目は 2001 年）で閉じる（年度をまたぐ表には書かない）。提出物は画面から登録するほか、e2e/support/documents.ts で SQL から入れる。
// ファイル（PDF・JPEG）はテストの中で作る（個人名なし）。Storage の物は Storage API で消す（cleanupDocumentsScenario。SQL では消さない）。
// 団体は A＝E2E模擬店1（seed の店長〔rep〕が代表する団体）・B＝E2E部門1。シナリオの年度は seed の利用者の最新の年度（R8）より前なので、
// 店長の書き込みの前に「最新でない年度」の確かめが出る（D-31。動詞は、ファイルを足す・外すは「変更」、「提出した」は「提出」）。
// 期待値の文言は 04 のとおりに書く（アプリの定数から引かない）。前年度から写すと、終了した年度のファイルの削除は
// e2e/serial/t19-documents.spec.ts。

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

/** 使い捨てのユーザーで、別のコンテキストから画面でログインしたページ（その人の年度はシナリオの年度だけなので、最新の年度として開く） */
async function loginAsUser(browser: Browser, u: TestUser, viewport: { width: number; height: number } = MOBILE): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await loginWith(page, u);
  return page;
}

/** 締切の列・カードの日付（「11/8（日）17:00」の日付の部分。年が今年と違えば「2027/1/5（火）」。04「締切と予定」の日付の出し方） */
function shortDay(date: string): string {
  const md = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${weekdayOf(date)}）`;
  return Number(date.slice(0, 4)) === Number(tokyoToday().slice(0, 4)) ? md : `${Number(date.slice(0, 4))}/${md}`;
}

/** JPEG の幅と高さ（SOF0〜SOF2 の印から読む。読めなければ null） */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// ---------------------------------------------------------------- 通しの流れ

test('T19 通しの流れ：部門長が提出物を登録し、店長（スマホ）が PDF を上げて「提出した」。部門長が開く（新しいタブ）・保存（名前と中身）・差し戻すと、店長のホームの要対応に理由の2行目。店長が外して PDF と写真（縮める）を足して出し直し、部門長が承認する。ダッシュボードの要対応・締切と予定・カードと CSV', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true }, repGroup: A });
  const head = await openAs(browser, 'head', s);
  const rep = await openAs(browser, 'rep', s, MOBILE);
  try {
    const ga = s.ids.groups[A]!;
    const gb = s.ids.groups[B]!;
    const title = 'E2E 出店計画書';
    const description = '表紙に団体名と日付を書いてください。\n様式は総務の共有フォルダにあります';
    const deadlineDate = addDays(tokyoToday(), 7);
    const deadlineIso = `${deadlineDate}T17:00:00+09:00`;
    const deadlineShort = await shortTimeOf(deadlineIso);

    // 1. 部門長が提出物を登録する（提出物の設定のタブ。対象は模擬店と部門。ファイルが要る〔既定〕）
    await openDocuments(head, '?tab=settings');
    await expect(head.getByTestId('documents-settings-empty')).toContainText('提出物はまだありません');
    await head.getByTestId('documents-settings-add').click();
    const form = head.getByTestId('doc-dialog');
    await expect(form.getByRole('heading', { name: '提出物を登録' })).toBeVisible();
    await form.getByTestId('doc-title').fill(title);
    await form.getByTestId('doc-description').fill(description);
    await form.getByTestId('doc-deadline-date').fill(deadlineDate);
    await expect(form.getByTestId('doc-deadline-time')).toHaveValue('17:00');
    await form.locator('[data-testid="doc-category"][data-category="stall"]').click();
    await form.locator('[data-testid="doc-category"][data-category="department"]').click();
    await expect(form.getByTestId('doc-food-only')).not.toBeChecked();
    await expect(form.getByTestId('doc-requires-file')).toBeChecked();
    await expect(form.getByTestId('doc-target-count')).toHaveText('対象の団体：2 団体');
    await form.getByTestId('doc-submit').click();
    await expect(head.getByText(`「${title}」を登録しました`)).toBeVisible();
    await expect(form).toHaveCount(0);
    const [doc] = await sql<{ id: string; deadline: string; target_categories: string; requires_file: boolean; created_by: string }>(
      `select id, to_char(deadline at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as deadline, target_categories::text, requires_file, created_by
         from public.documents where year_id = $1`,
      [s.yearId],
    );
    expect(doc).toEqual({ id: expect.any(String), deadline: `${deadlineDate} 17:00`, target_categories: '{stall,department}', requires_file: true, created_by: H });
    const docId = doc!.id;
    const row = head.locator(`[data-testid="documents-settings-row"][data-document-id="${docId}"]`);
    await expect(row).toContainText(title);
    await expect(row).toContainText(`${shortDay(deadlineDate)}17:00`);
    await expect(row).toContainText('模擬店・部門');
    await expect(row).toContainText('要る');
    await expect(row).toContainText('承認 0／2');

    // 2. 店長（390px）：自団体の提出物。読むのは提出の状況とファイルの2本（版は読まない）
    const reads: string[] = [];
    rep.on('request', (r) => {
      const m = /\/rest\/v1\/(.+)$/.exec(new URL(r.url()).pathname);
      if (m && r.method() !== 'OPTIONS') reads.push(`${r.method()} ${m[1]}${new URL(r.url()).searchParams.get('select') === 'allocation_version' ? '?select=allocation_version' : ''}`);
    });
    await openDocument(rep);
    await expect(rep.getByTestId('document-group-name')).toHaveText(A);
    await expect(rep.getByTestId('latest-year-switch')).toBeVisible();
    const card = documentCard(rep, docId);
    await expect(card).toHaveAttribute('data-status', 'not_submitted');
    await expect(card.getByTestId('document-card-title')).toHaveText(title);
    await expect(card.getByTestId('document-card-status')).toHaveText('未提出');
    await expect(card.getByTestId('document-card-deadline')).toHaveText(`締切 ${shortDay(deadlineDate)}17:00あと 7 日`);
    expect(await card.getByTestId('document-card-description').innerText()).toBe(description);
    await expect(card.getByTestId('document-file-hint')).toHaveText('PDF・JPEG・PNG。1つ 10 MB まで、5 つまで。写真は送る前に縮めます');
    await expect(card.getByTestId('document-submit')).toBeDisabled();
    await expect(card.getByTestId('document-submit-hint')).toHaveText('ファイルを1つ以上足してください');
    expect(reads).toContain('GET v_document_status');
    expect(reads).toContain('GET v_document_files');
    expect(reads.filter((r) => r.endsWith('allocation_version')), '版だけの読み取り').toEqual([]);

    // テストの中で作った小さな PDF を上げる（元のファイル名は送らない・残さない。Q16）
    const pdf1 = makePdf('E2E T19 first');
    await card.getByTestId('document-file-input').setInputFiles({ name: 'e2e-original-scan.pdf', mimeType: 'application/pdf', buffer: pdf1 });
    await confirmNotLatest(rep, '変更');
    await expect(card.getByTestId('document-file')).toHaveCount(1);
    await expect(card.getByTestId('document-file')).toHaveAttribute('data-state', 'uploaded', { timeout: 20_000 });
    const [f1] = await filesOf(docId, ga);
    expect(f1!.object_path).toBe(`${s.yearId}/${ga}/${docId}/${f1!.id}.pdf`);
    expect([f1!.content_type, f1!.size, f1!.uploaded, f1!.created_by]).toEqual(['application/pdf', pdf1.length, true, SEED_USER_IDS.rep]);
    expect(f1!.metadata?.mimetype).toBe('application/pdf');
    expect(JSON.stringify([f1!.metadata, f1!.user_metadata])).not.toContain('e2e-original-scan');
    await expect(card.getByTestId('document-file-label')).toHaveText(`ファイル 1（PDF・1 KB・${await fileTimeLabel(f1!.id)}）`);
    await expect(card.getByTestId('document-submit')).toBeEnabled();

    // 「提出した」：最新でない年度の確かめ → 提出の確かめ（ファイルの数）→ 提出済み（取り消しだけ）
    await card.getByTestId('document-submit').click();
    await confirmNotLatest(rep, '提出');
    const submitDialog = rep.getByRole('alertdialog').filter({ hasText: `「${title}」を提出しますか` });
    await expect(submitDialog).toContainText('提出すると、総務が確かめるまでファイルを変えられません（確かめる前なら「提出を取り消す」で戻せます）。');
    await expect(submitDialog.getByTestId('document-submit-confirm')).toHaveText('ファイル 1 つを提出します。');
    await submitDialog.getByRole('button', { name: '提出する' }).click();
    await expect(rep.getByText(`「${title}」を提出しました`)).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'submitted');
    await expect(card.getByTestId('document-card-status')).toHaveText('提出済み（総務の確認待ち）');
    const sub1 = await submissionOf(docId, ga);
    expect([sub1?.status, sub1?.proxy, sub1?.submitted_by]).toEqual(['submitted', false, SEED_USER_IDS.rep]);
    await expect(card.getByTestId('document-submitted-at')).toHaveText(`提出しました（${await shortTimeOf(sub1!.submitted_at!)}）`);
    await expect(card.getByTestId('document-withdraw')).toBeVisible();
    await expect(card.getByTestId('document-submit')).toHaveCount(0);
    await expect(card.getByTestId('document-file-add')).toHaveCount(0);
    await expect(card.getByTestId('document-file-remove')).toHaveCount(0);
    await expectNoOverflow(rep);

    // 3. 部門長：提出状況の表（承認待ち・ファイル 1）→ セルのシートで開く（新しいタブ）・保存（名前と中身）
    await openDocuments(head);
    const cellA = documentsCell(head, docId, ga);
    await expect(cellA).toHaveAttribute('data-status', 'submitted');
    await expect(cellA.getByTestId('documents-cell-files')).toHaveText('ファイル 1');
    // 読み上げの名前は、見えている印とファイルの数も含む（レビューの UX-3）
    await expect(cellA).toHaveAccessibleName(`${A}・${title}：承認待ち、ファイル 1`);
    await expect(documentsCell(head, docId, gb)).toHaveAttribute('data-status', 'not_submitted');
    await expect(head.locator('[data-testid="documents-filter-item"][data-status="submitted"]')).toHaveAttribute('data-count', '1');
    await expect(head.locator('[data-testid="documents-col"]')).toContainText(['承認 0／2']);
    await cellA.click();
    await expect(head).toHaveURL(new RegExp(`document=${docId}`));
    await expect(head).toHaveURL(new RegExp(`group=${ga}`));
    const sheet = head.getByTestId('documents-sheet');
    await expect(sheet.getByTestId('documents-sheet-title')).toHaveText(`${A}・${title}`);
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'submitted');
    await expect(sheet.getByTestId('documents-sheet-history')).toContainText(`提出 `);
    await expect(sheet.getByTestId('documents-sheet-history')).toContainText('（テスト団体代表）');
    const sheetFile = sheet.getByTestId('documents-sheet-file');
    await expect(sheetFile).toHaveCount(1);
    await expect(sheetFile).toHaveAttribute('data-state', 'uploaded');

    // 開く：押したときに先に空のタブを開き、60 秒の署名つき URL を入れる（その URL で同じ中身が読める）
    const signedNav = head.context().waitForEvent('request', (r) => r.method() === 'GET' && r.url().includes('/storage/v1/object/sign/documents/') && r.url().includes('token='));
    const popupPromise = head.waitForEvent('popup');
    await sheetFile.getByTestId('documents-sheet-file-open').click();
    const popup = await popupPromise;
    const signed = await signedNav;
    expect(decodeURIComponent(new URL(signed.url()).pathname)).toBe(`/storage/v1/object/sign/documents/${f1!.object_path}`);
    const opened = await head.request.get(signed.url());
    expect(opened.status()).toBe(200);
    expect(Buffer.from(await opened.body()).equals(pdf1)).toBe(true);
    await popup.close();
    await expect(head).toHaveURL(/\/documents\/?\?/);

    // 保存：「{提出物}_{団体}_{n}.pdf」の名前で、同じ中身（Storage が Content-Disposition: attachment で返す。画面は離れない）
    const downloadPromise = head.waitForEvent('download');
    await sheetFile.getByTestId('documents-sheet-file-save').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`${title}_${A}_1.pdf`);
    expect((await readFile((await download.path())!)).equals(pdf1)).toBe(true);
    await expect(sheet).toBeVisible();
    // 署名つき URL は残さない（キャッシュ・下書き・ログ・画面の URL に入れない）
    await expectNoSignedUrlStored(head);
    expect(head.url()).not.toContain('token=');

    // 4. 差し戻す（理由は必須。団体のホームと履歴に残る）
    await sheet.getByTestId('documents-sheet-return').click();
    const returnDialog = head.getByTestId('documents-return-dialog');
    await expect(returnDialog.getByRole('heading', { name: '差し戻す' })).toBeVisible();
    await expect(returnDialog).toContainText(`${A}・${title}`);
    await expect(returnDialog).toContainText('理由は団体のホームと履歴に残ります。個人の名前は書かないでください。');
    const reason = '表紙の日付が空欄です。\n日付を書いて、もう一度出してください';
    await returnDialog.getByTestId('documents-return-reason').fill(reason);
    await expect(returnDialog.getByTestId('documents-return-reason-count')).toHaveText(`${[...reason].length}/1000`);
    await returnDialog.getByTestId('documents-return-submit').click();
    await expect(head.getByText('差し戻しました')).toBeVisible();
    await expect(returnDialog).toHaveCount(0);
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'returned');
    const sheetNote = sheet.getByTestId('documents-sheet-note');
    await expect(sheetNote.locator('p').first()).toHaveText('差し戻しの理由');
    expect(await sheetNote.locator('p').nth(1).innerText()).toBe(reason);
    const sub2 = await submissionOf(docId, ga);
    expect([sub2?.status, sub2?.review_note, sub2?.reviewed_by]).toEqual(['returned', reason, H]);

    // 5. 店長のホーム：要対応に差し戻し（急ぎ。2行目に理由を書いたとおり）。押すとそのカードへ
    await openPortal(rep, 'ホーム');
    const returnedTodo = portalTodo(rep, `documents:rep:${ga}:returned:${docId}`);
    await expect(returnedTodo).toHaveAttribute('data-severity', 'urgent');
    await expect(returnedTodo).toHaveAttribute('data-module', 'documents');
    await expect(returnedTodo).toContainText(`${A}：提出物「${title}」が差し戻されました`);
    expect(await returnedTodo.getByTestId('portal-todo-detail').innerText()).toBe(`理由：${reason}`);
    await expect(returnedTodo.getByTestId('portal-todo-due')).toHaveText(`締切 ${deadlineShort}`);
    await expect(returnedTodo.getByRole('link')).toHaveAttribute('href', new RegExp(`/document/?\\?group=${ga}&document=${docId}$`));
    await expect(portalTodo(rep, `documents:rep:${ga}:pending`)).toHaveCount(0);
    await expect(portalDated(rep, `documents:deadline:${docId}`).getByRole('link')).toHaveAttribute(
      'href',
      new RegExp(`/document/?\\?group=${ga}&document=${docId}$`),
    );
    await expectNoOverflow(rep);
    await returnedTodo.getByRole('link').click();
    await expect(rep.getByRole('heading', { level: 1, name: '自団体の提出物' })).toBeVisible();
    await expect(card).toHaveAttribute('data-highlighted', 'true');
    await expect(card).toHaveAttribute('data-status', 'returned');
    expect(await card.getByTestId('document-returned-reason').innerText()).toBe(`理由：${reason}`);
    await expect(card.getByTestId('document-returned')).toContainText('直してから、もう一度「提出した」を押してください');

    // 6. 差し替え：届いたファイルを外す（確かめる。Storage からもすぐ消える）→ PDF と写真（3200×2000。長い辺 2500px に縮める）を足す
    await card.getByTestId('document-file-remove').click();
    await confirmNotLatest(rep, '変更');
    const removeDialog = rep.getByRole('alertdialog').filter({ hasText: 'ファイル 1 を外しますか' });
    await expect(removeDialog).toContainText('外したファイルは消えます。元に戻せません。');
    await removeDialog.getByRole('button', { name: '外す' }).click();
    await expect(rep.getByText('ファイル 1 を外しました')).toBeVisible();
    await expect(card.getByTestId('document-file')).toHaveCount(0);
    expect(await filesOf(docId, ga)).toEqual([]);
    await expect.poll(() => objectExists(f1!.object_path)).toBe(false);

    const pdf2 = makePdf('E2E T19 second');
    const photo = await makeJpeg(rep, 3200, 2000);
    await card.getByTestId('document-file-input').setInputFiles([
      { name: 'e2e-scan-2.pdf', mimeType: 'application/pdf', buffer: pdf2 },
      { name: 'e2e-photo.jpg', mimeType: 'image/jpeg', buffer: photo },
    ]);
    await confirmNotLatest(rep, '変更');
    await expect(card.getByTestId('document-file')).toHaveCount(2, { timeout: 20_000 });
    for (const k of [0, 1]) await expect(card.getByTestId('document-file').nth(k)).toHaveAttribute('data-state', 'uploaded', { timeout: 20_000 });
    const files2 = await filesOf(docId, ga);
    expect(files2.map((f) => [f.content_type, f.uploaded])).toEqual([
      ['application/pdf', true],
      ['image/jpeg', true],
    ]);
    expect(files2[1]!.object_path).toMatch(/\.jpg$/);
    const repToken = await apiToken('rep');
    const storedPhoto = await storageDownload(repToken, files2[1]!.object_path);
    expect(storedPhoto.bytes?.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    const dims = jpegSize(storedPhoto.bytes!);
    expect(dims && Math.max(dims.width, dims.height)).toBe(2500);
    expect(dims && Math.min(dims.width, dims.height)).toBe(1563);
    expect(files2[1]!.size).toBe(storedPhoto.bytes!.length);
    expect(JSON.stringify(files2.map((f) => [f.metadata, f.user_metadata]))).not.toMatch(/e2e-scan-2|e2e-photo/);
    await expect(card.getByTestId('document-file-label').nth(1)).toHaveText(new RegExp(`^ファイル 2（JPEG・(\\d+ KB|\\d\\.\\d MB)・${await fileTimeLabel(files2[1]!.id)}）$`));

    await card.getByTestId('document-submit').click();
    await confirmNotLatest(rep, '提出');
    await expect(submitDialog.getByTestId('document-submit-confirm')).toHaveText('ファイル 2 つを提出します。');
    await submitDialog.getByRole('button', { name: '提出する' }).click();
    await expect(rep.getByText(`「${title}」を提出しました`)).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'submitted');
    expect(await card.getByTestId('document-previous-reason').innerText()).toBe(`前回の差し戻しの理由：${reason}`);
    await expectNoOverflow(rep);

    // 7. 部門長のダッシュボード（承認の前）：要対応「承認待ち 1 件」、締切と予定、カード
    await openPortal(head, 'ダッシュボード');
    const submittedTodo = portalTodo(head, 'documents:lead:submitted');
    await expect(submittedTodo).toHaveAttribute('data-severity', 'normal');
    await expect(submittedTodo).toContainText('承認待ち 1 件');
    await expect(submittedTodo.getByRole('link')).toHaveAttribute('href', /\/documents\/?\?status=submitted$/);
    const dated = portalDated(head, `documents:deadline:${docId}`);
    await expect(dated).toHaveAttribute('data-kind', 'deadline');
    await expect(dated).toContainText(`提出物「${title}」の締切`);
    await expect(dated.getByRole('link')).toHaveAttribute('href', new RegExp(`/documents/?\\?document=${docId}$`));
    const moduleCard = documentsModuleCard(head);
    await expect(moduleCard.getByRole('heading', { name: '提出物' })).toBeVisible();
    await expect(moduleCard.getByRole('listitem')).toHaveText([`提出物 1 件（次の締切 ${deadlineShort}）`, '承認 0／2・承認待ち 1・差し戻し 0・未提出 1']);
    await expect(moduleCard.getByRole('link', { name: '提出状況へ' })).toHaveAttribute('href', /\/documents\/?$/);

    // 8. 部門長が承認する（要対応から開く。シートは URL の2つで開く）
    await submittedTodo.getByRole('link').click();
    await expect(head.locator('[data-testid="documents-filter-item"][data-status="submitted"]')).toHaveAttribute('data-state', 'on');
    await documentsCell(head, docId, ga).click();
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'submitted');
    await expect(sheetNote.locator('p').first()).toHaveText('前回の差し戻しの理由');
    expect(await sheetNote.locator('p').nth(1).innerText()).toBe(reason);
    await expect(sheet.getByTestId('documents-sheet-file')).toHaveCount(2);
    await sheet.getByTestId('documents-sheet-approve').click();
    const approveDialog = head.getByTestId('documents-approve-dialog');
    await expect(approveDialog).toContainText('メモは団体にも見えます。個人の名前は書かないでください。');
    await approveDialog.getByTestId('documents-approve-submit').click();
    await expect(head.getByText('承認しました')).toBeVisible();
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'approved');
    await expect(sheet.getByTestId('documents-sheet-file-remove')).toHaveCount(0);
    const sub3 = await submissionOf(docId, ga);
    expect([sub3?.status, sub3?.review_note, sub3?.reviewed_by]).toEqual(['approved', null, H]);

    // CSV（部門長以上。絞り込みによらず全部の行。BOM・CRLF。理由・ファイル・した人は入れない）。シートを閉じると URL から2つが外れる
    await head.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(head).not.toHaveURL(/document=/);
    const csvPromise = head.waitForEvent('download');
    await head.getByTestId('documents-csv').click();
    const csv = await csvPromise;
    expect(csv.suggestedFilename()).toBe(`${s.label}_提出状況.csv`);
    const csvText = await readFile((await csv.path())!, 'utf8');
    expect(csvText.startsWith('﻿団体,区分,提出物,締切,状態,提出日時,代理,承認／差し戻しの日時\r\n')).toBe(true);
    const csvLines = csvText.slice(1).trimEnd().split('\r\n');
    expect(csvLines).toHaveLength(3);
    expect(csvLines[1]).toMatch(new RegExp(`^${A},模擬店,${title},${deadlineDate.replace(/-/g, '/')} 17:00,承認,\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2},,\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}$`));
    expect(csvLines[2]).toBe(`${B},部門,${title},${deadlineDate.replace(/-/g, '/')} 17:00,未提出,,,`);
    expect(csvText).not.toContain(reason.split('\n')[0]!);

    // 9. 承認の後：部門長のダッシュボードのカードと要対応、店長のカードとホーム
    await openPortal(head, 'ダッシュボード');
    await expect(portalTodo(head, 'documents:lead:submitted')).toHaveCount(0);
    await expect(moduleCard.getByRole('listitem')).toHaveText([`提出物 1 件（次の締切 ${deadlineShort}）`, '承認 1／2・承認待ち 0・差し戻し 0・未提出 1']);
    await openDocument(rep);
    await expect(card).toHaveAttribute('data-status', 'approved');
    await expect(card.getByTestId('document-card-status')).toHaveText('承認');
    await expect(card.getByTestId('document-approved')).toContainText(`承認されました（${await shortTimeOf(sub3!.reviewed_at!)}）`);
    await expect(card.getByTestId('document-withdraw')).toHaveCount(0);
    await expect(card.getByTestId('document-submit')).toHaveCount(0);
    await expect(card.getByTestId('document-file-remove')).toHaveCount(0);
    await expect(card.getByTestId('document-file-open')).toHaveCount(2);
    await openPortal(rep, 'ホーム');
    await expect(rep.locator('[data-testid="portal-todo"][data-module="documents"]')).toHaveCount(0);
    await expect(portalDated(rep, `documents:deadline:${docId}`)).toContainText(`提出物「${title}」の締切`);
  } finally {
    await head.context().close();
    await rep.context().close();
    await cleanupDocumentsScenario(s);
  }
});

// ---------------------------------------------------------------- 守り（立場）

test('T19 守り：総務部門員は提出状況だけ（ファイルの数・ファイル・CSV・操作・設定は出ず、REST と Storage も読めない）。閲覧のみにはナビの見出しがなく、URL で開いても権限がない（何も読めない）', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true, staff: true, viewer: true }, repGroup: A });
  const staff = await openAs(browser, 'staff', s);
  const viewer = await openAs(browser, 'viewer', s);
  try {
    const ga = s.ids.groups[A]!;
    const [docId] = await insertDocuments(s.yearId, [{ title: 'E2E 保健所の届け', deadline: tokyoDeadline(5), categories: ['stall'], createdBy: H }]);
    const repToken = await apiToken('rep');
    const pdf = makePdf('E2E T19 staff');
    const file = await uploadFileAs(repToken, { documentId: docId, groupId: ga, body: pdf });
    await submitAs(repToken, docId, ga);

    // 総務部門員：状況は見える（承認待ち）。ファイルの数・CSV・設定のタブは出ない
    await openDocuments(staff);
    const cell = documentsCell(staff, docId, ga);
    await expect(cell).toHaveAttribute('data-status', 'submitted');
    await expect(cell.getByTestId('documents-cell-files')).toHaveCount(0);
    await expect(staff.getByTestId('documents-csv')).toHaveCount(0);
    await expect(staff.getByTestId('documents-tab-status')).toBeVisible();
    await expect(staff.getByTestId('documents-tab-settings')).toHaveCount(0);
    // シート：ファイルの欄の代わりに「ファイルを開けるのは部門長以上です」。操作は出ない
    await cell.click();
    const sheet = staff.getByTestId('documents-sheet');
    await expect(sheet.getByTestId('documents-sheet-status')).toHaveAttribute('data-status', 'submitted');
    await expect(sheet.getByTestId('documents-sheet-staff-note')).toHaveText('ファイルを開けるのは部門長以上です');
    await expect(sheet.getByTestId('documents-sheet-files')).toHaveCount(0);
    for (const id of ['documents-sheet-approve', 'documents-sheet-return', 'documents-sheet-paper', 'documents-sheet-submit', 'documents-sheet-withdraw']) {
      await expect(sheet.getByTestId(id)).toHaveCount(0);
    }
    // ?tab=settings を URL で開いても提出状況（設定は部門長以上）
    await openDocuments(staff, '?tab=settings');
    await expect(staff.getByTestId('documents-settings')).toHaveCount(0);
    await expect(staff.getByTestId('documents-table')).toBeVisible();

    // DB と Storage（RLS とポリシー）：部門員はファイルの行も物も読めない（Q4）。状況は読める。部門長は読める
    const [staffToken, headToken, viewerToken] = await Promise.all([apiToken('staff'), apiToken('head'), apiToken('viewer')]);
    expect((await apiGet(staffToken, `v_document_files?select=id&year_id=eq.${s.yearId}`)).data).toEqual([]);
    expect((await apiGet(staffToken, `document_files?select=id&year_id=eq.${s.yearId}`)).data).toEqual([]);
    expect((await apiGet(staffToken, `v_document_status?select=status&year_id=eq.${s.yearId}&group_id=eq.${ga}`)).data).toEqual([{ status: 'submitted' }]);
    expect((await storageDownload(staffToken, file.object_path)).statusCode).toBe('404');
    expect((await apiGet(headToken, `v_document_files?select=id,uploaded&year_id=eq.${s.yearId}`)).data).toEqual([{ id: file.id, uploaded: true }]);
    expect((await storageDownload(headToken, file.object_path)).bytes?.equals(pdf)).toBe(true);

    // 閲覧のみ（Q5）：ナビに提出物の見出しも項目もなく、URL で開くと権限がない。DB と Storage も何も読めない
    await openPortal(viewer, 'ホーム');
    await expect(viewer.getByTestId('current-year')).toHaveText(`${s.label}・申請受付中`);
    const labels = await navLabels(viewer);
    expect(labels).not.toContain('提出状況');
    expect(labels).not.toContain('自団体の提出物');
    await expect(viewer.getByRole('navigation', { name: 'メインメニュー' }).getByRole('group', { name: '提出物' })).toHaveCount(0);
    await expect(viewer.locator('[data-testid="portal-todo"][data-module="documents"], [data-testid="portal-dated-item"][data-module="documents"]')).toHaveCount(0);
    for (const path of ['/documents/', '/document/']) {
      await viewer.goto(path);
      await expect(viewer.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    }
    expect((await apiGet(viewerToken, `documents?select=id&year_id=eq.${s.yearId}`)).data).toEqual([]);
    expect((await apiGet(viewerToken, `v_document_status?select=document_id&year_id=eq.${s.yearId}`)).data).toEqual([]);
    expect((await storageDownload(viewerToken, file.object_path)).statusCode).toBe('404');
  } finally {
    await staff.context().close();
    await viewer.context().close();
    await cleanupDocumentsScenario(s);
  }
});

test('T19 守り（Storage を REST で直接）：ほかの団体の予約・予約していない path には上げられない。10 MB を超える物・許さない形・申告より大きい物は止まり、物は残らない。予約した path へは上げられ、2回目は 409（上書きしない）', async () => {
  const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { head: true }, repGroup: A });
  try {
    const ga = s.ids.groups[A]!;
    const gb = s.ids.groups[B]!;
    const [docId] = await insertDocuments(s.yearId, [{ title: 'E2E 守りの確かめ', deadline: tokyoDeadline(5), categories: ['stall', 'department'], createdBy: H }]);
    const [repToken, headToken] = await Promise.all([apiToken('rep'), apiToken('head')]);
    const body = makePdf('E2E T19 guard');

    // ほかの団体（B）の予約（部門長の代理）の path に、A の店長は上げられない（insert のポリシー。403）
    const forB = await reserveFile(headToken, { documentId: docId, groupId: gb, contentType: 'application/pdf', size: body.length });
    expect(forB.error).toBeNull();
    expect(forB.data!.object_path.startsWith(`${s.yearId}/${gb}/`)).toBe(true);
    expect((await storageUpload(repToken, forB.data!.object_path, body, 'application/pdf')).statusCode).toBe('403');
    // 自団体のフォルダでも、予約していない path には上げられない（403）
    expect((await storageUpload(repToken, `${s.yearId}/${ga}/${docId}/${randomUUID()}.pdf`, body, 'application/pdf')).statusCode).toBe('403');
    // 10 MiB（10,485,760 バイト）を超える物は bucket が止める（413）。予約の申告は上限まで
    const big = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'application/pdf', size: 10 * 1024 * 1024 });
    expect(big.error).toBeNull();
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    tooBig.write('%PDF-1.4\n', 0, 'latin1');
    expect((await storageUpload(repToken, big.data!.object_path, tooBig, 'application/pdf')).statusCode).toBe('413');
    // 3つの形（PDF・JPEG・PNG）のほかは bucket が止める（415）
    const plain = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'application/pdf', size: 9 });
    expect((await storageUpload(repToken, plain.data!.object_path, Buffer.from('not a pdf'), 'text/plain')).statusCode).toBe('415');
    // 申告より大きい物はトリガーが止める（403。申告で数える容量を実際より小さく見せない）
    const small = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'application/pdf', size: 10 });
    expect((await storageUpload(repToken, small.data!.object_path, body, 'application/pdf')).statusCode).toBe('403');
    // 予約もそもそも 10 MiB を超える申告と3つのほかの形を止める（invalid_input）
    const over = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'application/pdf', size: 10 * 1024 * 1024 + 1 });
    expect([over.error?.message, JSON.parse(over.error?.details ?? '{}').field]).toEqual(['invalid_input', 'size']);
    const wrongType = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'text/plain' as 'application/pdf', size: 9 });
    expect([wrongType.error?.message, JSON.parse(wrongType.error?.details ?? '{}').field]).toEqual(['invalid_input', 'content_type']);
    // 止まった物は1つも残らない
    expect(await objectsOfYears([s.yearId])).toEqual([]);

    // 予約した path へは上げられる。同じ path の2回目は 409（もう届いていた。上書きしない）で、中身は最初のまま
    const ok = await reserveFile(repToken, { documentId: docId, groupId: ga, contentType: 'application/pdf', size: body.length });
    expect((await storageUpload(repToken, ok.data!.object_path, body, 'application/pdf')).ok).toBe(true);
    const again = await storageUpload(repToken, ok.data!.object_path, makePdf('E2E T19 again'), 'application/pdf');
    expect(again.statusCode).toBe('409');
    expect((await storageDownload(repToken, ok.data!.object_path)).bytes?.equals(body)).toBe(true);
    expect(await objectsOfYears([s.yearId])).toEqual([ok.data!.object_path]);
  } finally {
    await cleanupDocumentsScenario(s);
  }
});

// ---------------------------------------------------------------- 同時の操作と通信の失敗

test('T19 同時の操作：店長と副店長が同時に「提出した」を押すと、片方は提出でき、もう片方は「すでに提出されています。読み直しました」。ファイルが足された後に古い版で押すと conflict の文言と読み直し、もう一度で提出できる', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const deputy = await createUser({ purpose: 'deputy', name: 'E2E 副店長' });
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    repGroup: A,
    groupMembers: [{ userId: deputy.id, group: A, role: 'deputy_manager' }],
  });
  const rep = await openAs(browser, 'rep', s, MOBILE);
  let dep: Page | null = null;
  try {
    const ga = s.ids.groups[A]!;
    const [same, stale] = await insertDocuments(s.yearId, [
      { title: 'E2E 同時の提出', deadline: tokyoDeadline(3), categories: ['stall'], createdBy: H },
      { title: 'E2E 古い版の提出', deadline: tokyoDeadline(4), categories: ['stall'], createdBy: H },
    ]);
    const repToken = await apiToken('rep');
    await uploadFileAs(repToken, { documentId: same, groupId: ga, body: makePdf('E2E T19 same') });
    await uploadFileAs(repToken, { documentId: stale, groupId: ga, body: makePdf('E2E T19 stale') });

    const deputyPage = await loginAsUser(browser, deputy);
    dep = deputyPage;
    await openDocument(deputyPage);
    await expect(deputyPage.getByTestId('document-group-name')).toHaveText(A);
    await expect(deputyPage.getByTestId('latest-year-switch')).toHaveCount(0);
    await openDocument(rep);

    // 1. 同じ操作が重なる：両方が確かめのダイアログを開いてから、同時に「提出する」
    const repCard = documentCard(rep, same);
    const depCard = documentCard(deputyPage, same);
    await repCard.getByTestId('document-submit').click();
    await confirmNotLatest(rep, '提出');
    await depCard.getByTestId('document-submit').click();
    const repDialog = rep.getByRole('alertdialog').filter({ hasText: '「E2E 同時の提出」を提出しますか' });
    const depDialog = deputyPage.getByRole('alertdialog').filter({ hasText: '「E2E 同時の提出」を提出しますか' });
    await expect(repDialog).toBeVisible();
    await expect(depDialog).toBeVisible();
    const done = '「E2E 同時の提出」を提出しました';
    await Promise.all([repDialog.getByRole('button', { name: '提出する' }).click(), depDialog.getByRole('button', { name: '提出する' }).click()]);
    // 片方だけが「提出しました」（知らせは数秒で消えるので、先に見る）、もう片方は読み直して「すでに提出されています」
    await expect.poll(async () => (await rep.getByText(done).count()) + (await deputyPage.getByText(done).count()), { timeout: 20_000 }).toBe(1);
    const winner = (await rep.getByText(done).count()) === 1 ? rep : deputyPage;
    await expect(repCard).toHaveAttribute('data-status', 'submitted');
    await expect(depCard).toHaveAttribute('data-status', 'submitted');
    const loserCard = winner === rep ? depCard : repCard;
    const winnerCard = winner === rep ? repCard : depCard;
    await expect(loserCard.getByTestId('document-error')).toHaveText('すでに提出されています。読み直しました');
    await expect(winnerCard.getByTestId('document-error')).toHaveCount(0);
    // どちらの確かめのダイアログも閉じた（題で探すので、閉じる動きの途中でも 0。閉じる途中で同じダイアログを開き直しても覆いは中身の上に
    // 来ないので、閉じきるのは待たない。04「共通レイアウト」のダイアログの重なり、D-52 の T19 の直し・3）
    await expect(repDialog).toHaveCount(0);
    await expect(depDialog).toHaveCount(0);
    expect((await submissionOf(same, ga))?.status).toBe('submitted');

    // 2. 古い版：副店長が読んだ後に、店長がファイルを足す（提出の版が進む）。副店長の「提出した」は conflict → 読み直して 2 つ → もう一度で提出
    const depStale = documentCard(deputyPage, stale);
    await expect(depStale.getByTestId('document-file')).toHaveCount(1);
    await uploadFileAs(repToken, { documentId: stale, groupId: ga, body: makePdf('E2E T19 stale 2') });
    await depStale.getByTestId('document-submit').click();
    const staleDialog = deputyPage.getByRole('alertdialog').filter({ hasText: '「E2E 古い版の提出」を提出しますか' });
    await expect(staleDialog.getByTestId('document-submit-confirm')).toHaveText('ファイル 1 つを提出します。');
    await staleDialog.getByRole('button', { name: '提出する' }).click();
    await expect(depStale.getByTestId('document-error')).toHaveText(
      'ほかの人がこの提出を先に変えました（ファイルを足す・外すなど）。読み直しました。確かめてから、もう一度押してください',
    );
    await expect(depStale.getByTestId('document-file')).toHaveCount(2);
    await expect(depStale).toHaveAttribute('data-status', 'not_submitted');
    expect((await submissionOf(stale, ga))?.status).toBe('not_submitted');
    // すぐに押し直す（前の確かめのダイアログが閉じる途中でもよい。CI では、この押し直しが覆いだけが消えて中身が残る間に当たり、付け直した
    // 覆いが中身の上に来て次の「提出する」が押せなかった。共有の部品で直した。notes/T19.md の「CI の E2E の失敗の直し（2026-11-03）」）
    await depStale.getByTestId('document-submit').click();
    await expect(staleDialog.getByTestId('document-submit-confirm')).toHaveText('ファイル 2 つを提出します。');
    await staleDialog.getByRole('button', { name: '提出する' }).click();
    await expect(deputyPage.getByText('「E2E 古い版の提出」を提出しました')).toBeVisible();
    await expect(depStale).toHaveAttribute('data-status', 'submitted');
    await expect(depStale.getByTestId('document-error')).toHaveCount(0);
    const sub = await submissionOf(stale, ga);
    expect([sub?.status, sub?.submitted_by, sub?.proxy]).toEqual(['submitted', deputy.id, false]);
  } finally {
    await rep.context().close();
    await dep?.context().close();
    await cleanupDocumentsScenario(s);
    await deputy.cleanup();
  }
});

test('T19 確かめのダイアログの開き直し：閉じる動きの途中（覆いは消え、中身が残る間）に同じ確かめを開き直しても、覆いは中身の上に来ず「提出する」を押せる（共有の部品。04「共通レイアウト」のダイアログの重なり、D-52 の T19 の直し・3）', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const deputy = await createUser({ purpose: 'deputy', name: 'E2E 副店長' });
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    repGroup: A,
    groupMembers: [{ userId: deputy.id, group: A, role: 'deputy_manager' }],
  });
  let page: Page | null = null;
  try {
    const ga = s.ids.groups[A]!;
    const [docId] = await insertDocuments(s.yearId, [{ title: 'E2E 開き直しの提出', deadline: tokyoDeadline(3), categories: ['stall'], createdBy: H }]);
    await uploadFileAs(await apiToken('rep'), { documentId: docId, groupId: ga, body: makePdf('E2E T19 reopen') });
    // 副店長の年度はシナリオの年度だけ（最新の年度）なので、「提出した」の前に最新でない年度の確かめは出ない
    page = await loginAsUser(browser, deputy);
    await openDocument(page);
    const card = documentCard(page, docId);
    const overlay = page.locator('body > [data-slot="alert-dialog-overlay"]');
    const content = page.locator('body > [data-slot="alert-dialog-content"]');
    // 中身の閉じる動きだけを長くする（覆いの 150 ms はそのまま）。覆いが先に消えて中身が残る間（ふだんは 50 ms ほど。CI では
    // Playwright の押し直しがちょうどここに当たった）を、時間によらずに作る
    await page.addStyleTag({ content: '[data-slot="alert-dialog-content"][data-state="closed"] { animation-duration: 600s !important; }' });
    await card.getByTestId('document-submit').click();
    await expect(content).toContainText('「E2E 開き直しの提出」を提出しますか');
    await content.getByRole('button', { name: 'やめる' }).click();
    await expect(overlay).toHaveCount(0);
    await expect(content).toHaveAttribute('data-state', 'closed');
    // 閉じる途中の中身がまだ画面の真ん中に残っているので、カードのボタンには押下のイベントを直接送る（React の onClick に届く）
    await card.getByTestId('document-submit').dispatchEvent('click');
    await expect(content).toHaveAttribute('data-state', 'open');
    await expect(overlay).toHaveCount(1);
    // 「提出する」の真ん中でいちばん上にあるのはそのボタン。覆いは中身の前（同じ z-50 なので、body の中で後ろの中身が上）
    // （直す前は、付け直した覆いが body の最後〔中身の後ろ〕に付いて中身の上に来て、押下を受けていた）
    const confirm = content.getByRole('button', { name: '提出する' });
    const onTop = await confirm.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const top = button.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return button.contains(top) ? '提出する' : (top?.getAttribute('data-slot') ?? top?.tagName ?? null);
    });
    expect(onTop).toBe('提出する');
    const order = await content.evaluate((el) => {
      const slots: string[] = [];
      const children = el.ownerDocument.body.children;
      for (let i = 0; i < children.length; i++) {
        const slot = children[i]?.getAttribute('data-slot') ?? '';
        if (slot.startsWith('alert-dialog-')) slots.push(slot);
      }
      return slots;
    });
    expect(order).toEqual(['alert-dialog-overlay', 'alert-dialog-content']);
    await confirm.click({ timeout: 10_000 });
    await expect(page.getByText('「E2E 開き直しの提出」を提出しました')).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'submitted');
    expect((await submissionOf(docId, ga))?.status).toBe('submitted');
  } finally {
    await page?.context().close();
    await cleanupDocumentsScenario(s);
    await deputy.cleanup();
  }
});

test('T19 通信の失敗：オフラインで足したファイルは「アップロードできませんでした」になり（読み直しはつながるまで待つ）、つながってから「もう一度」で送れる。上げた応答も読み直しも届かなくても、もう一度で「もう届いていた」（409）として済む。「提出した」の応答が届かなくても「提出されていました」', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: A });
  const rep = await openAs(browser, 'rep', s, MOBILE);
  try {
    const ga = s.ids.groups[A]!;
    const [docId] = await insertDocuments(s.yearId, [{ title: 'E2E 通信の確かめ', deadline: tokyoDeadline(6), categories: ['stall'], createdBy: H }]);
    await openDocument(rep);
    const card = documentCard(rep, docId);
    const pdf1 = makePdf('E2E T19 offline');

    // 1. オフライン：予約が届かない → そのタブの失敗（予約の日時なし）と「もう一度」「外す」。DB には何も残らない。終わった後の読み直しは、
    //    つながるまで待つ（オフラインの間は TanStack Query が止める）ので、その間は「アップロード中…」のまま（古い版で提出しない。04）
    await rep.context().setOffline(true);
    await card.getByTestId('document-file-input').setInputFiles({ name: 'e2e-offline.pdf', mimeType: 'application/pdf', buffer: pdf1 });
    await confirmNotLatest(rep, '変更');
    const failed = card.getByTestId('document-file');
    await expect(failed).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    await expect(failed).toContainText('アップロードできませんでした');
    await expect(card.getByTestId('document-file-label')).toHaveText('ファイル 1（PDF・1 KB）');
    await expect(card.getByTestId('document-file-error')).toHaveText('通信できませんでした。電波の良い所でもう一度');
    await expect(card.getByTestId('document-uploading')).toBeVisible();
    await expect(card.getByTestId('document-submit-hint')).toHaveText('アップロードが終わるまでお待ちください');
    await expect(card.getByTestId('document-file-retry')).toBeDisabled();
    expect(await filesOf(docId, ga)).toEqual([]);
    // つながると読み直しが届き、「もう一度」を押せる（同じ file_id で予約し、上げる）
    await rep.context().setOffline(false);
    await expect(card.getByTestId('document-uploading')).toHaveCount(0, { timeout: 20_000 });
    await expect(card.getByTestId('document-submit-hint')).toHaveText('届いていないファイルがあります。外すか、もう一度送ってください');
    await expect(failed).toHaveAttribute('data-state', 'failed');
    await card.getByTestId('document-file-retry').click();
    await confirmNotLatest(rep, '変更');
    await expect(failed).toHaveAttribute('data-state', 'uploaded', { timeout: 20_000 });
    const [f1] = await filesOf(docId, ga);
    expect([f1?.uploaded, f1?.size]).toEqual([true, pdf1.length]);

    // 2. 上げた応答が届かず（物は届いた）、続けて読み直しも通信で落ちる（電波が途切れた。navigator.onLine は真のまま）→ 失敗のまま
    //    「もう一度」。通信が戻ってから「もう一度」は、同じ予約（同じ行）と同じ path への2回目の upload で 409（もう届いていた）になり、
    //    成功と同じに扱う
    const pdf2 = makePdf('E2E T19 lost response');
    const uploadRoute = '**/storage/v1/object/documents/**';
    const readRoutes = ['**/rest/v1/v_document_status*', '**/rest/v1/v_document_files*'];
    let uploads = 0;
    const statuses: number[] = [];
    // 上げている間を確かめるため、upload を止めておく（下の確かめの後に放す）
    let releaseUpload: () => void = () => {};
    const uploadHeld = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    await rep.route(uploadRoute, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      uploads++;
      await uploadHeld;
      const res = await route.fetch();
      statuses.push(res.status());
      await route.abort('failed');
    });
    for (const r of readRoutes) await rep.route(r, (route) => route.abort('failed'));
    await card.getByTestId('document-file-input').setInputFiles({ name: 'e2e-lost.pdf', mimeType: 'application/pdf', buffer: pdf2 });
    await confirmNotLatest(rep, '変更');
    const second = card.getByTestId('document-file').nth(1);
    // 上げている間（レビューの UX-1・UX-2・F2）：上げているファイルは届く前から行として出し、読み上げの欄（role="status"）の中身が変わる。
    // 「保存」は押せず理由を出す（ページを離れる確かめを出さない）。年度を切り替える前は「アップロード中です。離れると、残りのファイルは
    // 送られません」で確かめ（下書きの文は出さない）、やめれば切り替えない
    await expect(second).toHaveAttribute('data-state', 'uploading');
    await expect(second.getByTestId('document-file-label')).toHaveText('ファイル 2（PDF・1 KB）');
    await expect(card.getByRole('status')).toContainText('アップロード中…（1/1）');
    await expect(card.getByTestId('document-file-save').first()).toBeDisabled();
    await expect(card).toContainText('アップロード中は「保存」を押せません（終わってから押してください）');
    const yearSelect = rep.getByTestId('year-select');
    const otherYear = await yearSelect.locator('option').evaluateAll((os, cur) => os.map((o) => o.getAttribute('value')).find((v) => v && v !== cur), s.yearId);
    await yearSelect.selectOption(otherYear!);
    const leave = rep.getByRole('alertdialog').filter({ hasText: 'アップロード中です' });
    await expect(leave).toContainText('離れると、残りのファイルは送られません。');
    await expect(leave).not.toContainText('下書き');
    await expect(leave.getByRole('button', { name: '切り替える' })).toBeVisible();
    await leave.getByRole('button', { name: 'やめる（アップロードを続ける）' }).click();
    await expect(leave).toHaveCount(0);
    await expect(yearSelect).toHaveValue(s.yearId);
    releaseUpload();
    await expect(second).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    await expect(card.getByTestId('document-file-retry')).toBeEnabled({ timeout: 20_000 });
    expect([uploads, statuses]).toEqual([1, [200]]);
    const lost = (await filesOf(docId, ga))[1]!;
    expect(lost.uploaded).toBe(true);
    await rep.unroute(uploadRoute);
    for (const r of readRoutes) await rep.unroute(r);
    const resend = rep.waitForResponse((r) => r.url().includes('/storage/v1/object/documents/') && r.request().method() === 'POST');
    await card.getByTestId('document-file-retry').click();
    await confirmNotLatest(rep, '変更');
    const resent = await resend;
    expect(((await resent.json()) as { statusCode?: string }).statusCode).toBe('409');
    await expect(second).toHaveAttribute('data-state', 'uploaded', { timeout: 20_000 });
    await expect(card.getByTestId('document-file-error')).toHaveCount(0);
    const files = await filesOf(docId, ga);
    expect(files.map((f) => [f.id, f.uploaded])).toEqual([
      [f1!.id, true],
      [lost.id, true],
    ]);
    expect(await objectsOfYears([s.yearId])).toHaveLength(2);

    // 3. 「提出した」の応答が届かない（DB には届いた）→ 読み直して「提出されていました」（成功と同じ）
    const submitRoute = '**/rest/v1/rpc/submit_document*';
    await rep.route(submitRoute, async (route) => {
      await route.fetch();
      await route.abort('failed');
    });
    await card.getByTestId('document-submit').click();
    await confirmNotLatest(rep, '提出');
    await rep.getByRole('alertdialog').filter({ hasText: '「E2E 通信の確かめ」を提出しますか' }).getByRole('button', { name: '提出する' }).click();
    await expect(rep.getByText('提出されていました')).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'submitted');
    await expect(card.getByTestId('document-error')).toHaveCount(0);
    await rep.unroute(submitRoute);
    expect((await submissionOf(docId, ga))?.status).toBe('submitted');
  } finally {
    await rep.context().close();
    await cleanupDocumentsScenario(s);
  }
});
