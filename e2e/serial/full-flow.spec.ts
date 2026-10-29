// T14 通しの流れ（SPEC「E2E の検証手順」の 3〜7、画面の設計 7.3）。合成データ r8like のシナリオの年度（2001 年）で閉じる。
// 在庫 → 申請・取り込み → 締切 → 自動振り分け → 確定 → Excel 出力（LibreOffice で再計算）→ 確定の解除 → 使用不可にして最小変更。
// 数え直し・提出・取り込みは需要を増やさない（e2e/full-flow/flow.ts）。この入力で full と最小変更が解け、D-08 の判定が通ることは
// e2e/full-flow/data.test.ts（Vitest）が先に確かめる。年度の作成と複製は e2e/serial/year-create.spec.ts（T09）が確かめる。
// serial で流す（seed の団体代表をシナリオの団体の代表にし、seed の部員・管理者にもシナリオの年度のロールを付ける）。
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { checkMinimalChange, getHighs, sumByKey } from '@gaapp/allocator/testing';
import type { AllocationRow, StoredAllocationRow } from '@gaapp/shared';
import { countText, findErrors, libreOfficeAvailable, recalcWithLibreOffice } from '../../packages/exporter/src/testing/recalc';
import { readAllocateInput } from '../full-flow/db-input';
import { GROUP_A, GROUP_B, GROUP_C, ROOM_M, STALL_CSV_PATH, UNMATCHED_ROW, importedCounts, requestOf } from '../full-flow/flow';
import { storageStateFor, type StoredUser } from '../support/auth';
import { createScenario, sql, type Scenario } from '../support/db';
import { syntheticDataset } from '../support/datasets';
import { MOBILE, PC } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

/** 数え直す部屋（r8like の保管場所） */
const RECOUNT_ROOM = '1-1';
/** r8like で使用不可の部屋 */
const UNUSABLE_ROOM = '第一セミナー';

async function openAs(
  browser: Browser,
  user: StoredUser,
  s: Scenario,
  viewport: { width: number; height: number } = PC,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return { context, page };
}

async function countsOf(groupId: string): Promise<Record<string, number>> {
  const rows = await sql<{ code: string; count: number }>(
    'select i.code, r.count from public.requests r join public.items i on i.id = r.item_id where r.group_id = $1 and r.count > 0',
    [groupId],
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.count]));
}

async function submittedAtOf(groupId: string): Promise<Date | null> {
  const rows = await sql<{ at: Date | null }>('select submitted_at as at from public.request_submissions where group_id = $1', [groupId]);
  return rows[0]?.at ?? null;
}

async function stocksOf(yearId: string, roomId: string): Promise<{ item_id: string; count: number; counted_by: string | null; counted_at: Date }[]> {
  return sql('select item_id, count, counted_by, counted_at from public.stocks where year_id = $1 and room_id = $2 order by item_id', [yearId, roomId]);
}

/** 自動の行（origin = auto）。AllocationRow の列だけ */
async function autoRows(yearId: string): Promise<{ rows: AllocationRow[]; stored: StoredAllocationRow[] }> {
  const { stored } = await readAllocateInput(yearId);
  const auto = stored.filter((r) => r.origin === 'auto');
  return {
    rows: auto.map((r) => ({ sourceRoomId: r.sourceRoomId, groupId: r.groupId, itemId: r.itemId, requestedItemId: r.requestedItemId, count: r.count, isKeep: r.isKeep })),
    stored,
  };
}

const sorted = (m: Map<string, number>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

async function waitEngineReady(page: Page): Promise<void> {
  await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
}

/** 自動振り分け・最小変更で再実行を確かめて実行し、保存まで待つ。計算時間（result.elapsedMs）を返す */
async function runAuto(page: Page, mode: '自動振り分け' | '最小変更で再実行'): Promise<{ elapsed: number }> {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
  await expect(page.getByTestId('allocate-saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('allocate-failure')).toHaveCount(0);
  const el = page.getByTestId('allocate-elapsed');
  await expect(el).toBeVisible();
  return { elapsed: Number(await el.getAttribute('data-elapsed-ms')) };
}

/** LibreOffice での再計算をするか。ない環境（ローカルの開発者）では飛ばして記録する。CI と REQUIRE_LIBREOFFICE=1 では必須 */
function recalcMode(): 'run' | 'skip' {
  if (libreOfficeAvailable()) return 'run';
  if (process.env.CI || process.env.REQUIRE_LIBREOFFICE === '1') {
    throw new Error('LibreOffice（soffice と python3-uno）がありません。CI と REQUIRE_LIBREOFFICE=1 では Excel の再計算を飛ばせません');
  }
  return 'skip';
}

test('T14 通しの流れ：在庫 → 申請・取り込み → 締切 → 自動振り分け → 確定 → Excel（再計算）→ 確定の解除 → 使用不可にして最小変更（D-08）', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const note = (type: string, description: string) => {
    testInfo.annotations.push({ type, description });
    console.log(`[T14 full-flow] ${type}：${description}`);
  };
  const recalc = recalcMode();
  const fx = syntheticDataset();
  const s = await createScenario({ dataset: 'synthetic', status: 'requesting', roles: { admin: true, staff: true }, repGroup: GROUP_A });
  const contexts: BrowserContext[] = [];
  try {
    const gid = (name: string) => s.ids.groups[name]!;
    const rid = (name: string) => s.ids.rooms[name]!;
    const startedAt = new Date(Date.now() - 1000);

    // ---------------------------------------------------------------- 3. 在庫（管理者で在庫一覧、部員で同じ数のまま数え直す）
    const admin = await openAs(browser, 'admin', s);
    contexts.push(admin.context);
    const page = admin.page;
    await page.goto('/stocks/');
    const usableDesk = fx.stocks
      .filter((st) => fx.rooms.find((r) => r.name === st.room)!.usable)
      .reduce((a, st) => a + st.counts.desk, 0);
    await expect(page.getByTestId('stock-total-usable').locator(`td[data-item-id="${s.ids.items.desk}"]`)).toHaveText(String(usableDesk));
    const seminar = page.locator(`[data-testid="stock-matrix-row"][data-room-id="${rid(UNUSABLE_ROOM)}"]`);
    await expect(seminar).toHaveAttribute('data-usable', 'false');
    await expect(seminar.getByTestId('unusable-badge')).toBeVisible();

    const room = rid(RECOUNT_ROOM);
    const stockBefore = await stocksOf(s.yearId, room);
    const staff = await openAs(browser, 'staff', s, MOBILE);
    contexts.push(staff.context);
    await staff.page.goto(`/stock/?room=${room}`);
    await expect(staff.page.getByTestId('stock-room-name')).toHaveText(RECOUNT_ROOM);
    const deskBefore = stockBefore.find((r) => r.item_id === s.ids.items.desk)!.count;
    await expect(staff.page.getByRole('textbox', { name: '机(木)の数' })).toHaveValue(String(deskBefore));
    await expect(staff.page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
    await staff.page.getByRole('button', { name: '保存', exact: true }).click();
    const notLatest = staff.page.getByRole('alertdialog');
    await expect(notLatest).toContainText('最新でない年度');
    await notLatest.getByRole('button', { name: 'この年度に保存する' }).click();
    await expect(staff.page.getByTestId('stock-saved')).toContainText('保存しました');
    await expect(staff.page.getByTestId('last-counted')).toContainText('テスト部員');
    const stockAfter = await stocksOf(s.yearId, room);
    expect(stockAfter.map((r) => [r.item_id, r.count])).toEqual(stockBefore.map((r) => [r.item_id, r.count]));
    for (const r of stockAfter) {
      expect(r.counted_by).toBe(SEED_USER_IDS.staff);
      expect(r.counted_at.getTime()).toBeGreaterThan(startedAt.getTime());
    }

    // ---------------------------------------------------------------- 4. 団体代表が今の数のまま再提出し、管理者が CSV を取り込む
    const a = gid(GROUP_A);
    const countsA = await countsOf(a);
    expect(countsA).toEqual(requestOf(fx, GROUP_A));
    const submittedA = await submittedAtOf(a);
    const rep = await openAs(browser, 'rep', s, MOBILE);
    contexts.push(rep.context);
    await rep.page.goto('/request/');
    await expect(rep.page.getByTestId('request-group-name')).toHaveText(GROUP_A);
    await expect(rep.page.getByTestId('request-submitted')).toHaveText(/^提出済み（/);
    await expect(rep.page.getByRole('textbox', { name: '机(木)の数', exact: true })).toHaveValue(String(countsA.desk));
    await rep.page.getByRole('button', { name: '修正して再提出' }).click();
    await rep.page.getByRole('alertdialog').getByRole('button', { name: 'この年度に提出する' }).click();
    await rep.page.getByRole('alertdialog').getByRole('button', { name: '提出する' }).click();
    await expect(rep.page.getByText(/^提出しました（/)).toBeVisible();
    await expect.poll(async () => (await submittedAtOf(a))!.getTime()).toBeGreaterThan(Math.max(submittedA!.getTime(), startedAt.getTime()));
    expect(await countsOf(a)).toEqual(countsA);

    await page.goto('/requests/');
    await page.getByRole('button', { name: 'Googleフォームの回答を取り込む' }).click();
    const imp = page.getByRole('dialog');
    await imp.getByLabel('CSV ファイル').setInputFiles(STALL_CSV_PATH);
    await expect(imp.getByTestId('import-counts')).toContainText('回答 4・対応した 3・対応しない 1');
    await expect(imp.getByTestId(`unmatched-row-${UNMATCHED_ROW}`)).toBeVisible();
    await expect(imp.getByTestId('import-superseded')).toContainText(`${GROUP_C}：行4`);
    await imp.getByRole('combobox', { name: `行${UNMATCHED_ROW}の団体` }).click();
    await page.getByRole('option', { name: GROUP_B, exact: true }).click();
    await expect(imp.getByTestId('import-counts')).toContainText('対応した 4・対応しない 0');
    await expect(imp.getByTestId('import-superseded')).toContainText(`${GROUP_B}：行${UNMATCHED_ROW}`);
    await expect(imp.getByRole('checkbox', { name: `${GROUP_B}を上書きする` })).toBeChecked();
    await expect(imp.getByRole('checkbox', { name: `${GROUP_C}を上書きする` })).toBeChecked();
    await imp.getByRole('button', { name: '取り込む（2 団体）' }).click();
    await expect(imp.getByTestId('import-results')).toContainText(`${GROUP_B}：取り込みました`);
    await expect(imp.getByTestId('import-results')).toContainText(`${GROUP_C}：取り込みました`);
    await imp.getByRole('button', { name: '閉じる' }).first().click();
    const imported = importedCounts(fx);
    expect(await countsOf(gid(GROUP_B))).toEqual(imported.get(GROUP_B));
    expect(await countsOf(gid(GROUP_C))).toEqual(imported.get(GROUP_C));
    // 団体 A（団体代表の提出）は上書きしない
    expect(await countsOf(a)).toEqual(countsA);

    // ---------------------------------------------------------------- 5. 締切 → 自動振り分け → error 0 → 確定
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    const actions = page.getByTestId('year-status-actions');
    await actions.getByRole('button', { name: '締切（振り分けを始める）' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '締切（振り分けを始める）' }).click();
    await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（振り分け中）`);

    await page.goto('/allocation/');
    await expect(page.getByRole('heading', { level: 1, name: '振り分け' })).toBeVisible();
    await waitEngineReady(page);
    const engineLoad = await page.getByTestId('engine-state').getAttribute('data-load-ms');
    const full = await runAuto(page, '自動振り分け');
    note('自動振り分けの計算時間（result.elapsedMs）', `${full.elapsed} ms（計算エンジンの読み込み〔Worker の中の loadHighs〕${engineLoad} ms は含まない）`);
    expect(full.elapsed).toBeGreaterThan(0);
    expect(full.elapsed).toBeLessThan(2000);
    await expect(page.getByTestId('issue-counts').locator('[data-severity="error"]')).toHaveText('error 0 件');
    const step5 = await autoRows(s.yearId);
    expect(step5.rows.length).toBeGreaterThan(0);
    expect(step5.stored.filter((r) => r.origin !== 'auto' || r.pinned)).toEqual([]);

    await actions.getByRole('button', { name: '確定', exact: true }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByLabel('理由（必須）').fill('E2E 通し：確定');
    const check = confirm.getByLabel('warning を確認しました');
    if (await check.count()) await check.check();
    await confirm.getByRole('button', { name: '確定', exact: true }).click();
    await expect(page.getByText('確定中です。直すときは「確定を解除」してください。')).toBeVisible({ timeout: 15_000 });

    // ---------------------------------------------------------------- 6. Excel 出力 → LibreOffice で再計算
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel出力' }).click()]);
    expect(download.suggestedFilename()).toBe(`${s.label}_椅子机振り分け_部門員共有用.xlsx`);
    const xlsxPath = testInfo.outputPath('full-flow.xlsx');
    await download.saveAs(xlsxPath);
    if (recalc === 'run') {
      const r = recalcWithLibreOffice(readFileSync(xlsxPath));
      expect(findErrors(r), '数式エラーのセル').toEqual([]);
      expect(countText(r, '在庫超過'), '「在庫超過」のセル').toBe(0);
      expect(countText(r, '要確認'), '「要確認」のセル').toBe(0);
      note('Excel の再計算（LibreOffice）', `シート ${Object.keys(r).length}、数式エラー 0・在庫超過 0・要確認 0`);
    } else {
      note('Excel の再計算（LibreOffice）', '飛ばした（soffice と python3-uno がない。REQUIRE_LIBREOFFICE=1 か CI では失敗にする）');
      console.warn('[T14 full-flow] LibreOffice がないため、Excel の再計算を飛ばしました');
    }

    // ---------------------------------------------------------------- 7. 確定の解除 → DB から入力を控える → MER を使用不可 → 最小変更
    await actions.getByRole('button', { name: '確定を解除' }).click();
    const unconfirm = page.getByRole('dialog');
    await unconfirm.getByLabel('理由（必須）').fill('E2E 通し：確定を解除');
    await unconfirm.getByRole('button', { name: '確定を解除' }).click();
    await expect(page.getByText('確定中です。直すときは「確定を解除」してください。')).toHaveCount(0, { timeout: 15_000 });
    await waitEngineReady(page);

    const M = rid(ROOM_M);
    const db = await readAllocateInput(s.yearId);
    expect(db.problems).toEqual([]);
    expect(db.input.rooms.find((r) => r.id === M)!.usable).toBe(true);
    expect(db.input.fixedRows).toEqual([]);

    const fromM = step5.stored.find((r) => r.sourceRoomId === M);
    if (!fromM) throw new Error(`${ROOM_M} から運ぶ自動の行がありません（D-08 を確かめられません）`);
    await page.goto(`/allocation/?row=${fromM.id}`);
    await expect(page.locator(`[data-row-id="${fromM.id}"]`)).toBeVisible({ timeout: 15_000 });
    await waitEngineReady(page);
    await page.locator(`[data-room-block="${M}"]`).getByRole('button', { name: `${ROOM_M}のメニュー` }).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const unusable = page.getByRole('dialog');
    await expect(unusable.getByTestId('unusable-checklist').or(unusable.getByTestId('unusable-checklist-empty')).first()).toBeVisible();
    if (!(await unusable.getByTestId('unusable-checklist-empty').isVisible())) {
      const listed = await unusable.getByTestId('unusable-checklist').locator('[data-row-id]').allInnerTexts();
      throw new Error(`${ROOM_M} からの固定・手動の行があります（この流れでは自動の行だけのはず）：\n${listed.join('\n')}`);
    }
    await unusable.getByLabel('理由のメモ（任意）').fill('E2E 通し：工事');
    await unusable.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByRole('button', { name: '最小変更で再実行', exact: true })).toHaveAttribute('data-emphasized', 'true');
    const mc = await runAuto(page, '最小変更で再実行');
    note('最小変更の計算時間（result.elapsedMs）', `${mc.elapsed} ms`);
    await expect(page.getByTestId('issues-panel').locator('[data-issue-code="E002"]')).toHaveCount(0);
    const after = await autoRows(s.yearId);
    expect(after.rows.filter((r) => r.sourceRoomId === M)).toEqual([]);

    // D-08 の判定：控えた入力で checkMinimalChange（allocate は決定的なので、同じ入力なら画面と同じ結果）
    const d08 = checkMinimalChange(db.input, M, await getHighs());
    if (!d08.ok) throw new Error(`checkMinimalChange が解けません：${d08.reason}（full ${d08.fullOk ? '解けた' : '解けない'}）`);
    // (a) before が 5 で保存した自動の行と同じ
    expect(sorted(sumByKey(d08.before)), '(a) full の結果と 5 の自動の行').toEqual(sorted(sumByKey(step5.rows)));
    // (b) after が画面の最小変更で保存された自動の行と同じ
    expect(sorted(sumByKey(d08.after)), '(b) 最小変更の結果と保存された自動の行').toEqual(sorted(sumByKey(after.rows)));
    // (c) 補えるつながりで、前回の M 以外の行が減らず、無関係な行が変わらず、M の行を含まないつながりも変わらない
    expect(d08.decreased, '(c) decreased').toEqual([]);
    expect(d08.unrelatedChanged, '(c) unrelatedChanged').toEqual([]);
    expect(d08.untouchedChanged, '(c) untouchedChanged').toEqual([]);
    note(
      'D-08（MER を使用不可にした最小変更）',
      `MER から ${d08.fromM} 行、つながり ${d08.comps}（補える ${d08.good}・補えない ${d08.bad}）、補えないつながりで変わった行 ${d08.changedInBad}、` +
        `前回の行が増えた ${d08.increased.length}・新しい行 ${d08.appeared.length}`,
    );

    // 履歴：年度の状態の変更（理由つき）と MER の使用不可が出る（段 1 の /history）
    const logs = await sql<{ id: string; table_name: string; reason: string | null }>(
      `select id::text, table_name, reason from public.audit_logs
        where year_id = $1 and table_name in ('years', 'room_years') and at >= $2 order by at, id`,
      [s.yearId, startedAt],
    );
    const reasons = logs.filter((l) => l.table_name === 'years').map((l) => l.reason);
    expect(reasons).toEqual(expect.arrayContaining(['E2E 通し：確定', 'E2E 通し：確定を解除']));
    expect(logs.some((l) => l.table_name === 'room_years')).toBe(true);
    await page.goto('/history/?table=years,room_years');
    for (const l of logs) {
      const row = page.locator(`[data-testid="history-row"][data-row-id="${l.id}"]`);
      await expect(row).toBeVisible();
      if (l.reason) await expect(row.getByTestId('history-reason')).toHaveText(l.reason);
    }
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await s.cleanup();
    // シナリオの年度の履歴を消す（audit_logs を膨らませない。e2e/t14-history.spec.ts と同じ）
    await sql('delete from public.audit_logs where year_id = $1', [s.yearId]);
  }
});
