import { expect, test, type Locator, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql, type Scenario } from './support/db';
import { syntheticDataset } from './support/datasets';
import { remapRuleParams } from './support/scenario-rows';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T12 ルール（/rules。画面の設計 3.8・7.2 の表の T12 の行）。シナリオの年度（createScenario）で閉じる。

interface DbRule {
  code: string;
  kind: string;
  params: unknown;
  enabled: boolean;
  memo: string | null;
}

async function rulesOf(yearId: string): Promise<DbRule[]> {
  return sql<DbRule & Record<string, unknown>>('select code, kind, params, enabled, memo from public.rules where year_id = $1 order by code', [yearId]);
}

/** 合成データの rules.json を、シナリオの年度の id に直したもの */
function expectedRules(s: Scenario): DbRule[] {
  const group = (n: string) => s.ids.groups[n] ?? `missing-group:${n}`;
  const room = (n: string) => s.ids.rooms[n] ?? `missing-room:${n}`;
  return syntheticDataset()
    .rules.map((r) => ({ code: r.code, kind: r.kind, params: remapRuleParams(r, group, room), enabled: r.enabled, memo: r.memo ?? null }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
}

/**
 * EntitySelect（cmdk の Combobox）で名前を選ぶ。選んだ後、ポップオーバーが閉じきるまで待つ
 * （閉じる途中で次の EntitySelect を開くと、前のポップオーバーが閉じたときにフォーカスを元のボタンに戻し、次のポップオーバーが閉じる）。
 */
async function pick(page: Page, scope: Locator, label: string, name: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(scope.getByRole('combobox', { name: label, exact: true })).toHaveText(name);
  await expect(page.locator('[cmdk-root]')).toHaveCount(0);
}

async function openAdd(page: Page, kind: '代替' | '運び元の制限' | '固定の申請' | '残す'): Promise<Locator> {
  await page.getByRole('button', { name: 'ルールを追加' }).first().click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: `${kind}のルールを追加` })).toBeVisible();
  return sheet;
}

async function openTemplate(page: Page, code: string): Promise<Locator> {
  await page.getByRole('button', { name: 'R8 の初期ルールから追加' }).first().click();
  await page.getByRole('menuitem', { name: new RegExp(`^${code}`) }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: new RegExp(`R8 の初期ルール ${code}`) })).toBeVisible();
  return sheet;
}

/**
 * 開いているシート・ダイアログの裏で、一覧が読み直されるのを起こす（つながり直したときの refetchOnReconnect。
 * staleTime の 30 秒を過ぎた後だけ読み直すので、page.clock で時計を進める。page.clock.install() を goto の前に呼んでおく）。
 * 一覧の行に、読み直した内容（expectInRow）が出るまで待つ。
 */
async function refetchBehind(page: Page, row: Locator, expectInRow: string): Promise<void> {
  await page.clock.fastForward('00:31');
  const reloaded = page.waitForResponse((r) => r.url().includes('/rest/v1/rules') && r.request().method() === 'GET');
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await reloaded;
  await expect(row).toContainText(expectInRow);
}

async function save(page: Page, sheet: Locator, code: string): Promise<void> {
  await sheet.getByRole('button', { name: '保存', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-row-id]').filter({ hasText: code }).first()).toBeVisible();
}

async function fillSubstitute(
  page: Page,
  sheet: Locator,
  r: { code: string; from: string; to: string; categories: string[]; cost: string; prefer?: string; indoorOnly?: boolean; needsConsent?: boolean; memo: string },
): Promise<void> {
  await sheet.getByLabel('コード').fill(r.code);
  await pick(page, sheet, '元の品目', r.from);
  await pick(page, sheet, '先の品目', r.to);
  const cats = sheet.getByRole('group', { name: '区分' });
  for (const c of r.categories) await cats.getByRole('checkbox', { name: c, exact: true }).check();
  await sheet.getByLabel(/^重さ/).fill(r.cost);
  if (r.prefer) await sheet.getByLabel('優先する区分').selectOption({ label: r.prefer });
  if (r.indoorOnly) await sheet.getByRole('checkbox', { name: /屋内の団体だけ/ }).check();
  if (r.needsConsent) await sheet.getByRole('checkbox', { name: '団体の了承が要る' }).check();
  await sheet.getByLabel(/^メモ/).fill(r.memo);
}

test.describe('T12 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T12 ルールのない年度で S01〜S08 を画面から入れると、保存した params が合成データの rules.json（id に直したもの）と同じ', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', rules: 'none', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      await expect(page.getByText('ルールがありません')).toBeVisible();
      const fx = Object.fromEntries(syntheticDataset().rules.map((r) => [r.code, r]));

      // 代替（S01・S02・S04・S07）は種別のフォームから
      let sheet = await openAdd(page, '代替');
      await fillSubstitute(page, sheet, { code: 'S01', from: '机(木)', to: '不可机', categories: ['模擬店'], cost: '0', memo: fx.S01!.memo! });
      await save(page, sheet, 'S01');

      sheet = await openAdd(page, '代替');
      await fillSubstitute(page, sheet, {
        code: 'S02',
        from: '椅子(木)',
        to: '不可椅子',
        categories: ['休憩所', '模擬店'],
        cost: '0',
        prefer: '休憩所',
        memo: fx.S02!.memo!,
      });
      await save(page, sheet, 'S02');

      sheet = await openAdd(page, '代替');
      await fillSubstitute(page, sheet, { code: 'S04', from: '長机(3人掛)', to: '長机(2人掛)', categories: ['企業'], cost: '1', memo: fx.S04!.memo! });
      await save(page, sheet, 'S04');

      sheet = await openAdd(page, '代替');
      await fillSubstitute(page, sheet, {
        code: 'S07',
        from: '机(木)',
        to: 'キャスター机',
        categories: ['模擬店'],
        cost: '3',
        indoorOnly: true,
        needsConsent: true,
        memo: fx.S07!.memo!,
      });
      await save(page, sheet, 'S07');

      // 運び元の制限（S05）：団体は名前で選び、場所は保管場所のチェック
      sheet = await openAdd(page, '運び元の制限');
      await sheet.getByLabel('コード').fill('S05');
      await pick(page, sheet, '団体', '設営');
      await sheet.getByRole('group', { name: '申請品目' }).getByRole('checkbox', { name: '机(木)', exact: true }).check();
      const rooms = sheet.getByRole('group', { name: '運び元の場所' });
      for (const r of ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3']) await rooms.getByRole('checkbox', { name: r, exact: true }).check();
      await sheet.getByLabel(/^メモ/).fill(fx.S05!.memo!);
      await save(page, sheet, 'S05');

      // 固定の申請（S06）と残す（S08）は R8 の初期ルールのひな形から（団体を選ぶ。残すの場所は団体の使用場所が入る）
      sheet = await openTemplate(page, 'S06');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.group"]')).toContainText('団体を選んでください');
      await pick(page, sheet, '団体', '設営');
      await save(page, sheet, 'S06');

      sheet = await openTemplate(page, 'S08');
      await pick(page, sheet, '団体', '学科展示');
      await expect(sheet.getByRole('combobox', { name: '場所', exact: true })).toHaveText('第一多目的室');
      await save(page, sheet, 'S08');

      // ひな形は全部入ったので押せない
      await expect(page.getByRole('button', { name: 'R8 の初期ルールから追加' })).toBeDisabled();
      await expect(page.locator('[data-row-id]')).toHaveCount(7);
      await expect(page.getByText('設営の机(木)は 1-1・1-2・1-3・2-1・2-2・2-3 からだけ出す')).toBeVisible();

      expect(await rulesOf(s.yearId)).toEqual(expectedRules(s));
    } finally {
      await s.cleanup();
    }
  });

  test('T12 重なる・参照の切れたルールは欄の下にエラーで保存できない。?code=S05 で開く。削除はなく、無効にできる', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      // S06 の団体を存在しない id にする（団体を消した後など。参照の切れ）
      await sql(`update public.rules set params = jsonb_set(params, '{group}', '"99999999-9999-4999-8999-999999999999"') where year_id = $1 and code = 'S06'`, [
        s.yearId,
      ]);
      const before = await rulesOf(s.yearId);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);

      // ?code=S05：その行が目立ち、編集のシートが開く
      await page.goto('/rules/?code=S05');
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: 'ルール S05（運び元の制限）を編集' })).toBeVisible();
      await expect(page.locator(`[data-row-id="${s.ids.rules['S05']}"]`)).toHaveAttribute('data-highlighted', 'true');
      await expect(sheet.getByRole('combobox', { name: '団体', exact: true })).toHaveText('設営');
      await sheet.getByRole('button', { name: '閉じる' }).click();
      await expect(sheet).toBeHidden();

      // 振り分け中の帯、参照の切れた印
      await expect(page.getByTestId('rules-allocating-notice')).toHaveText('ルールを変えると、振り分け画面で再実行が要ります');
      const s06 = page.locator(`[data-row-id="${s.ids.rules['S06']}"]`);
      await expect(s06.getByTestId('rule-problem')).toContainText('参照が切れています（団体が見つかりません）');

      // 削除のボタンはどこにもない
      await expect(page.getByRole('button', { name: /削除/ })).toHaveCount(0);

      // 参照の切れたルールは、保存しようとすると団体の欄の下にエラー
      await s06.getByRole('button', { name: 'S06 を編集' }).click();
      await expect(sheet.getByRole('button', { name: /削除/ })).toHaveCount(0);
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.locator('[data-field="params.group"] [data-field-error]')).toHaveText('団体がありません');
      await expect(sheet).toBeVisible();
      // 団体を選び直すと保存できる
      await pick(page, sheet, '団体', '設営');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet).toBeHidden();
      await expect(s06.getByTestId('rule-problem')).toHaveCount(0);

      // ほかの有効なルールと重なる代替は、区分の欄の下にエラーが出て保存できない
      const add = await openAdd(page, '代替');
      await fillSubstitute(page, add, { code: 'S01b', from: '机(木)', to: '不可机', categories: ['模擬店'], cost: '0', memo: '' });
      await add.getByRole('button', { name: '保存', exact: true }).click();
      await expect(add.locator('[data-field="params.categories"] [data-field-error]')).toHaveText(
        '同じ代替（desk→desk_ng）で区分が重なるルール S01 があります',
      );
      // 同じコードも欄の下に出る
      await add.getByLabel('コード').fill('S01');
      await add.getByRole('button', { name: '保存', exact: true }).click();
      await expect(add.locator('[data-field="code"] [data-field-error]')).toHaveText('同じコードのルールがあります');
      // 閉じるときは入力を捨てるか確かめる
      await add.getByRole('button', { name: '閉じる' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '捨てて閉じる' }).click();
      await expect(add).toBeHidden();
      expect((await rulesOf(s.yearId)).map((r) => r.code)).toEqual(before.map((r) => r.code));

      // 無効にする（理由をメモに）。行は残る
      const s04 = page.locator(`[data-row-id="${s.ids.rules['S04']}"]`);
      await s04.getByRole('switch', { name: 'S04 を有効にする' }).click();
      const dlg = page.getByRole('alertdialog');
      await expect(dlg.getByRole('heading', { name: 'ルール S04 を無効にしますか' })).toBeVisible();
      await dlg.getByLabel('メモ').fill('E2E：今年は企業の長机が足りるため');
      await dlg.getByRole('button', { name: '無効にする' }).click();
      await expect(dlg).toBeHidden();
      await expect(s04.getByRole('switch', { name: 'S04 を有効にする' })).not.toBeChecked();
      await expect(s04).toContainText('無効');
      const s04row = (await rulesOf(s.yearId)).find((r) => r.code === 'S04')!;
      expect(s04row).toMatchObject({ enabled: false, memo: 'E2E：今年は企業の長机が足りるため' });

      // 重なる無効のルールは有効にできない（理由が出る）
      await sql(
        `insert into public.rules (year_id, code, kind, params, enabled, memo) values ($1, 'S01x', 'substitute', '{"from":"desk","to":"desk_ng","categories":["stall"],"cost":0}', false, null)`,
        [s.yearId],
      );
      await page.getByRole('button', { name: '読み直す' }).first().click();
      const s01x = page.locator('[data-row-id]').filter({ hasText: 'S01x' });
      await s01x.getByRole('switch', { name: 'S01x を有効にする' }).click();
      await expect(page.getByRole('alertdialog').getByRole('heading', { name: 'ルール S01x を有効にできません' })).toBeVisible();
      await expect(page.getByTestId('enable-blocked-messages')).toContainText('同じ代替（desk→desk_ng）で区分が重なるルール S01 があります');
      await page.getByRole('alertdialog').getByRole('button', { name: '閉じる' }).click();
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S01x')!.enabled).toBe(false);

      // S04 は有効に戻せる
      await s04.getByRole('switch', { name: 'S04 を有効にする' }).click();
      await expect(s04.getByRole('switch', { name: 'S04 を有効にする' })).toBeChecked();
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S04')!.enabled).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test('T12 シートを開いたまま読み直しが通信の失敗になっても、シートと入力が残る（ErrorState に置き換えない）', async ({ page }) => {
    // supabase-js の GET の再試行と React Query の再試行で、失敗が出るまで十数秒かかる
    test.setTimeout(150_000);
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/?code=S05');
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: 'ルール S05（運び元の制限）を編集' })).toBeVisible();
      await sheet.getByLabel(/^メモ/).fill('E2E：通信が切れても残るメモ');

      // ここから rules への通信が切れる（保存も、保存されたかの確かめも、一覧の読み直しも通らない）
      await page.route('**/rest/v1/rules*', (route) => route.abort('internetdisconnected'));
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      const notice = sheet.getByTestId('unknown-outcome');
      await expect(notice).toBeVisible({ timeout: 60_000 });
      // 通信が戻らないまま「読み直す」を押す
      await notice.getByRole('button', { name: '読み直す' }).click();
      // 読み直しが終わる（失敗の知らせか、画面全体の ErrorState のどちらか）まで待つ
      await expect(page.getByText(/ルールを読み直せませんでした/).or(page.getByRole('button', { name: 'もう一度読み込む' })).first()).toBeVisible({
        timeout: 90_000,
      });
      // シートと入力は残る。一覧の上に読み直しの失敗の帯が出る
      await expect(sheet.getByRole('heading', { name: 'ルール S05（運び元の制限）を編集' })).toBeVisible();
      await expect(sheet.getByLabel(/^メモ/)).toHaveValue('E2E：通信が切れても残るメモ');
      await expect(page.getByTestId('rules-reload-error')).toBeAttached();
      await expect(page.getByRole('button', { name: 'もう一度読み込む' })).toHaveCount(0);

      // 通信が戻って読み直すと、帯が消え、入力はそのまま
      await page.unroute('**/rest/v1/rules*');
      await notice.getByRole('button', { name: '読み直す' }).click();
      await expect(page.getByTestId('rules-reload-error')).toHaveCount(0, { timeout: 30_000 });
      await expect(sheet.getByLabel(/^メモ/)).toHaveValue('E2E：通信が切れても残るメモ');
      // 保存は届いていない
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S05')!.memo).not.toBe('E2E：通信が切れても残るメモ');
    } finally {
      await s.cleanup();
    }
  });

  test('T12 無効にするダイアログを開いている間にほかの人がルールを変えたら、ダイアログを閉じて読み直す（古い行・古いメモで送り続けない）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      const s04 = page.locator(`[data-row-id="${s.ids.rules['S04']}"]`);
      const toggle = s04.getByRole('switch', { name: 'S04 を有効にする' });
      await toggle.click();
      const dlg = page.getByRole('alertdialog');
      await expect(dlg.getByRole('heading', { name: 'ルール S04 を無効にしますか' })).toBeVisible();
      await dlg.getByLabel('メモ').fill('E2E：古い画面のメモ');

      // ダイアログを開いている間に、ほかの人がメモを直す（updated_at が変わる）
      await sql(`update public.rules set memo = 'E2E：ほかの人のメモ' where year_id = $1 and code = 'S04'`, [s.yearId]);
      await dlg.getByRole('button', { name: '無効にする' }).click();
      // conflict：ダイアログを閉じ、読み直した一覧にほかの人のメモが出る
      await expect(dlg).toBeHidden();
      await expect(s04).toContainText('E2E：ほかの人のメモ');
      await expect(toggle).toBeChecked();
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S04')).toMatchObject({ enabled: true, memo: 'E2E：ほかの人のメモ' });

      // 開き直すと今のメモが入っていて、無効にできる
      await toggle.click();
      await expect(dlg.getByLabel('メモ')).toHaveValue('E2E：ほかの人のメモ');
      await dlg.getByLabel('メモ').fill('E2E：ほかの人のメモ。今年は使わない');
      await dlg.getByRole('button', { name: '無効にする' }).click();
      await expect(dlg).toBeHidden();
      await expect(toggle).not.toBeChecked();
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S04')).toMatchObject({ enabled: false, memo: 'E2E：ほかの人のメモ。今年は使わない' });
    } finally {
      await s.cleanup();
    }
  });

  test('T12 シートを開いた後に一覧が読み直されても、開いたときの版で保存する（ほかの人の変更を黙って上書きせず conflict。もう一度保存すると上書き）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await page.clock.install();
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/?code=S05');
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: 'ルール S05（運び元の制限）を編集' })).toBeVisible();
      const rooms = sheet.getByRole('group', { name: '運び元の場所' });
      await expect(rooms.getByRole('checkbox', { name: '2-3', exact: true })).toBeChecked();

      // シートを開いている間に、ほかの人が S05 の運び元の場所から 2-3 を外し、メモを直す。裏で一覧が読み直される
      await sql(`update public.rules set params = jsonb_set(params, '{rooms}', (params->'rooms') - 5), memo = 'E2E：ほかの人が 2-3 を外した' where year_id = $1 and code = 'S05'`, [
        s.yearId,
      ]);
      const s05 = page.locator(`[data-row-id="${s.ids.rules['S05']}"]`);
      await refetchBehind(page, s05, 'E2E：ほかの人が 2-3 を外した');
      // シートは開いたときの値のまま
      await expect(rooms.getByRole('checkbox', { name: '2-3', exact: true })).toBeChecked();

      // メモだけ直して保存すると、開いたときの版で送るので conflict（ほかの人の変更を黙って戻さない）。入力は残る
      await sheet.getByLabel(/^メモ/).fill('E2E：古いシートのメモ');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet.getByText('他の人が先に変更しました。読み直しました')).toBeVisible();
      await expect(sheet.getByLabel(/^メモ/)).toHaveValue('E2E：古いシートのメモ');
      const afterConflict = (await rulesOf(s.yearId)).find((r) => r.code === 'S05')!;
      expect(afterConflict.memo).toBe('E2E：ほかの人が 2-3 を外した');
      expect((afterConflict.params as { rooms: string[] }).rooms).toHaveLength(5);

      // conflict を見た後にもう一度保存すると、読み直した版で送り、シートの内容で上書きする（2.5）
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet).toBeHidden();
      const overwritten = (await rulesOf(s.yearId)).find((r) => r.code === 'S05')!;
      expect(overwritten.memo).toBe('E2E：古いシートのメモ');
      expect((overwritten.params as { rooms: string[] }).rooms).toHaveLength(6);
    } finally {
      await s.cleanup();
    }
  });

  test('T12 無効にするダイアログを開いた後に一覧が読み直されても、開いたときの版で送る（ほかの人のメモを黙って上書きしない）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', roles: { admin: true } });
    try {
      await page.clock.install();
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      const s04 = page.locator(`[data-row-id="${s.ids.rules['S04']}"]`);
      const toggle = s04.getByRole('switch', { name: 'S04 を有効にする' });
      await toggle.click();
      const dlg = page.getByRole('alertdialog');
      await expect(dlg.getByRole('heading', { name: 'ルール S04 を無効にしますか' })).toBeVisible();
      await dlg.getByLabel('メモ').fill('E2E：古い画面のメモ');

      // ダイアログを開いている間に、ほかの人がメモを直し、裏で一覧が読み直される
      await sql(`update public.rules set memo = 'E2E：ほかの人のメモ' where year_id = $1 and code = 'S04'`, [s.yearId]);
      await refetchBehind(page, s04, 'E2E：ほかの人のメモ');

      // 開いたときの版で送るので conflict：ダイアログを閉じ、ほかの人のメモが残る
      await dlg.getByRole('button', { name: '無効にする' }).click();
      await expect(dlg).toBeHidden();
      await expect(toggle).toBeChecked();
      expect((await rulesOf(s.yearId)).find((r) => r.code === 'S04')).toMatchObject({ enabled: true, memo: 'E2E：ほかの人のメモ' });
    } finally {
      await s.cleanup();
    }
  });

  test('T12 確定中はメモだけ直せる（追加・有効の切り替え・params は出さない）', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { admin: true } });
    try {
      const before = await rulesOf(s.yearId);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/rules/');
      await expect(page.getByTestId('read-only-notice')).toHaveText('確定中です。ルールは確定を解除してから変えてください（メモだけ直せます）');
      await expect(page.getByRole('button', { name: 'ルールを追加' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'R8 の初期ルールから追加' })).toHaveCount(0);
      const s05 = page.locator(`[data-row-id="${s.ids.rules['S05']}"]`);
      await expect(s05.getByRole('switch', { name: 'S05 を有効にする' })).toBeDisabled();

      await s05.getByRole('button', { name: 'S05 のメモを直す' }).click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: 'ルール S05 のメモを直す' })).toBeVisible();
      await expect(sheet.getByLabel('コード')).toBeDisabled();
      await expect(sheet.getByRole('combobox', { name: '団体', exact: true })).toBeDisabled();
      await expect(sheet.getByRole('group', { name: '運び元の場所' }).getByRole('checkbox', { name: '1-1', exact: true })).toBeDisabled();
      await sheet.getByLabel(/^メモ/).fill('E2E：来年は 3-1 も候補');
      await sheet.getByRole('button', { name: '保存', exact: true }).click();
      await expect(sheet).toBeHidden();
      await expect(s05).toContainText('E2E：来年は 3-1 も候補');

      const after = await rulesOf(s.yearId);
      expect(after).toEqual(before.map((r) => (r.code === 'S05' ? { ...r, memo: 'E2E：来年は 3-1 も候補' } : r)));
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T12 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T12 部員がルールを URL で開くと「権限がありません」', async ({ page }) => {
    await page.goto('/rules/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await expect(page.getByTestId('rules-screen')).toHaveCount(0);
  });
});
