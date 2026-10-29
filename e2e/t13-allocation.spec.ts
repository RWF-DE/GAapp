import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T13 振り分け（段 1：計算エンジンと自動振り分け。画面の設計 3.9・4 章・7.2 の T13 の行）。
// シナリオの年度（createScenario）で閉じる。seed の R8 は変えない。

// ダウンロードの日本語のファイル名を確かめる。Chromium を LANG=C.UTF-8 で起こすのは playwright.config.ts（T09a）が行う。

/** 計算エンジンの読み込みが終わり、自動振り分けを押せるまで待つ */
async function waitEngineReady(page: Page): Promise<void> {
  // 中止の後（engine が idle）もボタンは押せるので、読み込みが済んだことは engine-state で見る
  await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
}

async function runAuto(page: Page, mode: '自動振り分け' | '最小変更で再実行' = '自動振り分け'): Promise<void> {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
}

test.describe('T13 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T13 自動振り分け → 検証の error 0 件 → 確定 → Excel 出力。計算は 2 秒未満、計算中は画面がロックされる', async ({ page }, testInfo) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      const wasmResponse = page.waitForResponse((r) => r.url().includes('/highs.wasm'), { timeout: 30_000 });
      await page.goto('/allocation/');
      await expect(page.getByRole('heading', { level: 1, name: '振り分け' })).toBeVisible();
      await expect(page.getByText('まだ自動振り分けをしていません')).toBeVisible();
      await waitEngineReady(page);
      // wasm の読み込み（初回）の時間は計算時間と別に記録する（D-21）
      const res = await wasmResponse;
      expect(res.status()).toBe(200);
      expect(new URL(res.url()).search).toMatch(/^\?v=/);
      const t = res.request().timing();
      const engineLoad = await page.getByTestId('engine-state').getAttribute('data-load-ms');
      testInfo.annotations.push({
        type: 'highs.wasm の読み込み',
        description: `${new URL(res.url()).pathname}${new URL(res.url()).search}：応答まで ${Math.round(t.responseEnd)} ms、計算エンジンの読み込み（Worker の中の loadHighs）${engineLoad} ms`,
      });

      // 保存の応答を止めて、計算中のロック（④保存）を確かめる。この段階では「中止」を出さない
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/rest/v1/rpc/save_auto_allocations', async (route) => {
        await held;
        await route.continue();
      });
      await runAuto(page);
      const lock = page.getByTestId('allocate-lock');
      await expect(lock).toBeVisible();
      await expect(lock).toHaveAttribute('data-phase', 'saving');
      await expect(lock.getByText('（保存中…）')).toBeVisible();
      await expect(lock.getByRole('button', { name: '中止' })).toHaveCount(0);
      // キーボードで抜けられない（B5）：フォーカスはロックにあり、Tab・Shift+Tab でも外へ出ない。本体は inert、確定は押せない
      await expect(lock).toBeFocused();
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab']) {
        await page.keyboard.press(key);
        await expect(page.locator('[data-testid="allocate-lock"]:focus-within')).toHaveCount(1);
      }
      await expect(page.getByTestId('run-inert')).toHaveAttribute('inert', '');
      await expect(page.locator('[data-testid="year-status-fieldset"] button', { hasText: '確定' })).toBeDisabled();
      release();
      await expect(lock).toBeHidden({ timeout: 30_000 });
      await page.unroute('**/rest/v1/rpc/save_auto_allocations');

      const elapsed = page.getByTestId('allocate-elapsed');
      await expect(elapsed).toBeVisible();
      const ms = Number(await elapsed.getAttribute('data-elapsed-ms'));
      const loadMs = Number(await elapsed.getAttribute('data-load-ms'));
      testInfo.annotations.push({ type: '計算時間（result.elapsedMs）', description: `${ms} ms（読み込み ${loadMs} ms は含まない）` });
      console.log(testInfo.annotations.map((a) => `[T13] ${a.type}：${a.description}`).join('\n'));
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThan(2000);

      // 検証の error 0 件
      await expect(page.getByTestId('issue-counts').locator('[data-severity="error"]')).toHaveText('error 0 件');
      await expect(page.getByText('まだ自動振り分けをしていません')).toHaveCount(0);
      await expect(page.getByTestId('auto-allocated-at')).not.toContainText('まだ実行していません');
      // 品目タブに行が出る
      await expect(page.locator('[data-row-id]').first()).toBeVisible();

      // 確定前の Excel は確かめてから「_確定前」のファイル名で出す（Q3）
      await page.getByRole('button', { name: 'Excel出力' }).click();
      const pre = page.getByRole('alertdialog');
      await expect(pre.getByText('確定前の振り分けです')).toBeVisible();
      const [preDownload] = await Promise.all([page.waitForEvent('download'), pre.getByRole('button', { name: '出力する' }).click()]);
      expect(preDownload.suggestedFilename()).toBe(`${s.label}_椅子机振り分け_部門員共有用_確定前.xlsx`);

      // 確定（理由必須。warning があれば確認のチェック）
      await page.getByTestId('year-status-actions').getByRole('button', { name: '確定', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('理由（必須）').fill('E2E：確定');
      const check = dialog.getByLabel('warning を確認しました');
      if (await check.count()) await check.check();
      await dialog.getByRole('button', { name: '確定', exact: true }).click();
      await expect(page.getByText('確定中です。直すときは「確定を解除」してください。')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toHaveCount(0);

      // 確定後の Excel は確かめずに共有用のファイル名
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel出力' }).click()]);
      expect(download.suggestedFilename()).toBe(`${s.label}_椅子机振り分け_部門員共有用.xlsx`);
    } finally {
      await s.cleanup();
    }
  });

  test('T13 解けない入力（S05 が原因）では振り分けを書き換えず、不足と原因のルール S05 を出す', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic-infeasible-s05', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await waitEngineReady(page);
      await runAuto(page);
      const panel = page.getByTestId('allocate-failure');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toHaveAttribute('data-reason', 'infeasible');
      await expect(panel.getByRole('heading', { name: '解けません' })).toBeVisible();
      await expect(panel.getByText(/設営の机\(木\)：需要 \d+、使える在庫 \d+/)).toBeVisible();
      await expect(panel.getByText(/原因のルール S05/)).toBeVisible();
      // 管理者にはルール画面へのリンク
      await expect(panel.getByRole('link', { name: 'ルール S05' })).toHaveAttribute('href', /\/rules\/?\?code=S05/);
      await expect(panel.getByText('ルールを変えるか、申請や固定行を直すかを決めてください')).toBeVisible();
      await expect(page.getByText('まだ自動振り分けをしていません')).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });

  test('T13 受付中の年度では「締切の後に振り分けます」と出し、計算エンジンを読み込まない', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { admin: true } });
    try {
      const wasm: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('highs.wasm')) wasm.push(r.url());
      });
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByText('締切の後に振り分けます')).toBeVisible();
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeDisabled();
      await page.waitForTimeout(500);
      expect(wasm).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 部員（Q1：いつでも読み取り専用）', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T13 部員は読み取りだけ：自動振り分けのボタンがなく、計算エンジンを読み込まず、検証の一覧からルール画面へのリンクがない', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { staff: true } });
    try {
      // ルールつきの検証の項目を必ず出す：キャスター机への置き換えがある団体（模擬店01）の了承を未依頼にする → W102（S07）
      const g = s.ids.groups['模擬店01']!;
      const caster = await sql<{ n: string }>(
        `select count(*) as n from public.allocations a join public.items i on i.id = a.item_id join public.items r on r.id = a.requested_item_id
          where a.year_id = $1 and a.group_id = $2 and i.code = 'caster_desk' and r.code = 'desk'`,
        [s.yearId, g],
      );
      expect(Number(caster[0]!.n)).toBeGreaterThan(0);
      await sql(`update public.substitution_consents set status = 'not_asked', count = null where group_id = $1`, [g]);
      const wasm: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('highs.wasm')) wasm.push(r.url());
      });
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/allocation/');
      await expect(page.getByTestId('issues-panel')).toBeVisible();
      await expect(page.getByTestId('read-only-notice')).toContainText('部員は振り分けを見るだけです');
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '最小変更で再実行' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Excel出力' })).toBeEnabled();
      await expect(page.getByTestId('year-status-actions')).toHaveCount(0);
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      // ルール画面（admin だけ）へのリンクを出さない
      await expect(page.getByRole('link', { name: /^ルール .* を開く$/ })).toHaveCount(0);
      await expect(page.locator('a[href*="/rules"]')).toHaveCount(0);
      // ルールのある項目は、押すとコードと内容の文をその場で出す。項目がないと何も確かめずに通るので、
      // シナリオで了承待ち（W102。ルール S07）を必ず出し、項目が 1 件以上あることを表明してから押す
      const w102 = page.locator('[data-issue-code="W102"]');
      expect(await w102.count()).toBeGreaterThan(0);
      const ruleButton = w102.first().getByRole('button', { name: 'ルール S07 の内容' });
      await expect(ruleButton).toBeVisible();
      await expect(page.getByTestId('rule-text')).toHaveCount(0);
      await ruleButton.click();
      await expect(ruleButton).toHaveAttribute('aria-expanded', 'true');
      const ruleText = w102.first().getByTestId('rule-text');
      await expect(ruleText).toBeVisible();
      await expect(ruleText).not.toHaveText(/内容を読めません/);
      await expect(ruleText).toContainText('キャスター机');
      // 団体別の表示
      await page.getByRole('button', { name: '団体別' }).click();
      await expect(page).toHaveURL(/view=group/);
      await expect(page.locator('[data-group-block]').first()).toBeVisible();
      expect(wasm).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T13 閲覧のみ（Q1：確定後だけ行の一覧）', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('T13 閲覧のみは確定後に行の一覧だけ（在庫・余り・検証・Excel なし）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { viewer: true } });
    try {
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await page.goto('/allocation/');
      await expect(page.locator('[data-row-id]').first()).toBeVisible();
      await expect(page.getByTestId('issues-panel')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Excel出力' })).toHaveCount(0);
      await expect(page.getByText('余り', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '団体別' })).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });
});
