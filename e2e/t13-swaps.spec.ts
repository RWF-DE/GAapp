import { expect, test, type Locator, type Page } from '@playwright/test';
import { accessToken, rpc, storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T13 キャスター机交換 /swaps（画面の設計 3.10・7.2 の T13 の行、04「キャスター机交換」）。
// 依頼済みにする・拒否 → 最小変更で置き換えが消える・「未依頼に戻す」は了承の行に出ない・依頼の後に増えたときの注意、
// 団体代表が回答を変えると /swaps に出る（Q4）、確定中は読み取り、置き換えがないとき、交換依頼一覧（Excel）。
// シナリオの年度で閉じる。

// 交換依頼一覧のファイル名（日本語）を確かめる。Chromium を LANG=C.UTF-8 で起こすのは playwright.config.ts（T09a）が行う
test.use({ storageState: storageStateFor('admin') });

const SUBS = `requested_item_id = (select id from public.items where code = 'desk')
  and item_id = (select id from public.items where code = 'caster_desk')`;

async function consentOf(groupId: string): Promise<{ status: string; count: number | null } | undefined> {
  const rows = await sql<{ status: string; count: number | null }>(
    `select status::text as status, count from public.substitution_consents where group_id = $1
       and from_item_id = (select id from public.items where code = 'desk')
       and to_item_id = (select id from public.items where code = 'caster_desk')`,
    [groupId],
  );
  return rows[0];
}

async function substituted(yearId: string, groupId: string): Promise<{ total: number; pinned: number }> {
  const [r] = await sql<{ total: number; pinned: number }>(
    `select coalesce(sum(count), 0)::int as total, count(*) filter (where pinned)::int as pinned
       from public.allocations where year_id = $1 and group_id = $2 and ${SUBS}`,
    [yearId, groupId],
  );
  return r!;
}

/** 団体の行（表の行は `団体|元|先` の id。団体名のセルで引く） */
function swapRow(page: Page, groupName: string): Locator {
  return page.locator('[data-row-id]').filter({ has: page.getByText(groupName, { exact: true }) });
}

/** シナリオの年度は最新の年度（seed の R8）より前なので、書く前に「最新でない年度（…）に記録します」を確かめる（1.3.1・T13-15） */
async function confirmNotLatest(page: Page): Promise<void> {
  const d = page.getByRole('alertdialog').filter({ hasText: '最新でない年度' });
  await expect(d).toContainText('に記録します。よろしいですか');
  await d.getByRole('button', { name: 'この年度に記録する' }).click();
  await expect(d).toBeHidden();
}

async function operate(page: Page, groupName: string, label: string): Promise<void> {
  await swapRow(page, groupName).getByTestId('swap-ops').getByRole('button', { name: label, exact: true }).click();
  await confirmNotLatest(page);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('T13 キャスター机交換：依頼済みにする・拒否 → 最小変更で置き換えが消える・了承の行に「未依頼に戻す」がない・Excel', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await page.goto('/swaps/');
    await expect(page.getByRole('heading', { level: 1, name: 'キャスター机交換' })).toBeVisible();
    await expect(swapRow(page, '模擬店10')).toBeVisible();

    // 了承の行には「未依頼に戻す」を出さない（依頼済み・拒否の行だけ）
    const rows = page.locator('[data-row-id]');
    const n = await rows.count();
    expect(n).toBeGreaterThan(5);
    let accepted = 0;
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const status = (await row.getByTestId('swap-status').textContent())?.trim();
      const back = row.getByRole('button', { name: '未依頼に戻す' });
      if (status === '了承') {
        accepted++;
        await expect(back).toHaveCount(0);
      } else if (status === '依頼済み' || status === '拒否') {
        await expect(back).toHaveCount(1);
      } else {
        await expect(back).toHaveCount(0);
      }
    }
    expect(accepted).toBeGreaterThan(0);

    // 依頼済みにする：その時点の置き換え台数が依頼した台数になる
    const g10 = s.ids.groups['模擬店10']!;
    const before10 = await substituted(s.yearId, g10);
    expect(before10.total).toBeGreaterThan(0);
    // 備考の欄は団体代表に見える「団体へのコメント」（T13-19）：表の見出しとダイアログの説明
    await expect(page.getByRole('columnheader', { name: '団体へのコメント' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '備考' })).toHaveCount(0);
    await swapRow(page, '模擬店10').getByTestId('swap-ops').getByRole('button', { name: '依頼済みにする', exact: true }).click();
    await confirmNotLatest(page);
    const opDialog = page.getByRole('alertdialog');
    await expect(opDialog.getByLabel('団体へのコメント（任意）')).toBeVisible();
    await expect(opDialog.getByTestId('swap-note-help')).toContainText('団体代表の『自団体の振り分け』に「コメント：」として表示されます');
    await expect(opDialog.getByTestId('swap-note-help')).toContainText('総務の内部のメモには使えません');
    await opDialog.getByRole('button', { name: '依頼済みにする', exact: true }).click();
    await expect(opDialog).toBeHidden();
    await expect(page.getByText(/^依頼済みにしました（模擬店10）/)).toBeVisible();
    await expect(swapRow(page, '模擬店10').getByTestId('swap-status')).toHaveText('依頼済み');
    await expect(swapRow(page, '模擬店10').getByRole('button', { name: '未依頼に戻す' })).toBeVisible();
    expect(await consentOf(g10)).toEqual({ status: 'asked', count: before10.total });

    // 拒否：置き換えの行の固定が外れ、注意の列に振り分け画面へのリンク
    const g02 = s.ids.groups['模擬店02']!;
    await sql(`update public.allocations set pinned = true where group_id = $1 and ${SUBS}`, [g02]);
    await operate(page, '模擬店02', '拒否');
    await expect(swapRow(page, '模擬店02').getByTestId('swap-status')).toHaveText('拒否');
    expect((await consentOf(g02))?.status).toBe('declined');
    expect((await substituted(s.yearId, g02)).pinned).toBe(0);
    const attention = swapRow(page, '模擬店02').getByTestId('swap-attention');
    await expect(attention).toHaveAttribute('data-attention', 'rerun');
    // PC（1280px）で、注意の文が出ていても操作の列の右端のボタンまで画面の中に収まる（団体へのコメントの列を足した後も）
    const screenBox = (await page.getByTestId('swaps-screen').boundingBox())!;
    for (const name of ['模擬店02', '模擬店09']) {
      const last = swapRow(page, name).getByTestId('swap-ops').getByRole('button').last();
      const box = (await last.boundingBox())!;
      expect(box.x + box.width, `${name} の操作の列が切れる`).toBeLessThanOrEqual(screenBox.x + screenBox.width);
    }
    await expect(swapRow(page, '模擬店02').getByRole('button', { name: '未依頼に戻す' })).toBeVisible();

    // 交換依頼一覧（Excel）
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '交換依頼一覧（Excel）' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${s.label}_キャスター机交換依頼一覧.xlsx`);

    // 振り分け画面へ → 最小変更で再実行 → その団体の置き換えが消える
    await attention.getByRole('link', { name: '振り分け画面' }).click();
    await expect(page).toHaveURL(/\/allocation\/?\?view=group&group=/);
    await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '最小変更で再実行', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
    await expect(page.getByTestId('allocate-saved')).toBeVisible({ timeout: 30_000 });
    expect((await substituted(s.yearId, g02)).total).toBe(0);

    await page.goto('/swaps/');
    await expect(swapRow(page, '模擬店02').getByTestId('swap-status')).toHaveText('拒否');
    await expect(swapRow(page, '模擬店02').getByTestId('swap-attention')).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('T13 キャスター机交換：依頼の後に増えたら注意と「依頼し直す」、団体代表が回答を変えると /swaps に出る（Q4）', async ({ page, request }) => {
  const s = await createScenario({
    dataset: 'synthetic',
    status: 'allocating',
    allocations: 'reference',
    roles: { admin: true },
    repGroup: '模擬店10',
  });
  try {
    const g10 = s.ids.groups['模擬店10']!;
    const ids = await sql<{ desk: string; caster: string }>(
      `select (select id from public.items where code = 'desk') as desk, (select id from public.items where code = 'caster_desk') as caster`,
    );
    const { desk, caster } = ids[0]!;
    const admin = await accessToken(request, 'admin');
    const asked = await rpc(request, admin, 'set_consent', { p_group_id: g10, p_from_item: desk, p_to_item: caster, p_status: 'asked' });
    expect(asked.error).toBeNull();

    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await page.goto('/swaps/');
    await expect(swapRow(page, '模擬店10').getByTestId('swap-status')).toHaveText('依頼済み');

    // 団体代表が了承し、その後で回答を変える（Q4）→ 読み直すと /swaps に出る
    const rep = await accessToken(request, 'rep');
    const a1 = await rpc(request, rep, 'set_consent', { p_group_id: g10, p_from_item: desk, p_to_item: caster, p_status: 'accepted' });
    expect(a1.error).toBeNull();
    const a2 = await rpc(request, rep, 'set_consent', {
      p_group_id: g10,
      p_from_item: desk,
      p_to_item: caster,
      p_status: 'declined',
      p_note: 'E2E：回答を変えた',
    });
    expect(a2.error).toBeNull();
    await page.getByRole('button', { name: '読み直す' }).first().click();
    await expect(swapRow(page, '模擬店10').getByTestId('swap-status')).toHaveText('拒否');
    await expect(swapRow(page, '模擬店10').getByText('E2E：回答を変えた')).toBeVisible();

    // 依頼済みに戻して、置き換えを増やす → 注意「依頼の後に増えました」、了承は押せず「依頼し直す」が出る
    const r = await rpc(request, admin, 'set_consent', { p_group_id: g10, p_from_item: desk, p_to_item: caster, p_status: 'asked' });
    expect(r.error).toBeNull();
    await sql(
      `update public.allocations set count = count + 2 where id = (
         select id from public.allocations where year_id = $1 and group_id = $2 and ${SUBS} order by id limit 1)`,
      [s.yearId, g10],
    );
    await page.getByRole('button', { name: '読み直す' }).first().click();
    const row = swapRow(page, '模擬店10');
    await expect(row.getByTestId('swap-attention')).toHaveAttribute('data-attention', 'reask');
    await expect(row.getByTestId('swap-attention')).toHaveText('依頼の後に増えました。依頼し直してください');
    await expect(row.getByRole('button', { name: '了承', exact: true })).toBeDisabled();
    await operate(page, '模擬店10', '依頼し直す');
    await expect(row.getByTestId('swap-attention')).toHaveCount(0);
    const total = (await sql<{ n: number }>(
      `select coalesce(sum(count), 0)::int as n from public.allocations where year_id = $1 and group_id = $2 and ${SUBS}`,
      [s.yearId, g10],
    ))[0]!.n;
    expect(await consentOf(g10)).toEqual({ status: 'asked', count: total });
  } finally {
    await s.cleanup();
  }
});

test('T13 キャスター机交換：確定中は読み取り、置き換えがない年度は「ありません」', async ({ page }) => {
  const confirmed = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { admin: true } });
  const empty = await createScenario({ dataset: 'small', status: 'allocating', roles: { admin: true } });
  try {
    await pinYear(page, SEED_USER_IDS.admin, confirmed.yearId);
    await page.goto('/swaps/');
    await expect(page.getByTestId('read-only-notice')).toBeVisible();
    await expect(page.locator('[data-row-id]').first()).toBeVisible();
    await expect(page.getByTestId('swap-ops').getByRole('button')).toHaveCount(0);

    await pinYear(page, SEED_USER_IDS.admin, empty.yearId);
    await page.goto('/swaps/');
    await expect(page.getByText('キャスター机への置き換えはありません')).toBeVisible();
    await expect(page.getByRole('button', { name: '交換依頼一覧（Excel）' })).toBeDisabled();
  } finally {
    await confirmed.cleanup();
    await empty.cleanup();
  }
});
