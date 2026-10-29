// T11 申請 /request（団体代表。スマホ）の E2E（画面の設計 3.5・7.2）。シナリオの年度で閉じる。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SMALL } from './support/datasets';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

test.use({ storageState: storageStateFor('rep') });

async function countOf(groupId: string, code: string): Promise<number | null> {
  const rows = await sql<{ count: number }>(
    'select r.count from public.requests r join public.items i on i.id = r.item_id where r.group_id = $1 and i.code = $2',
    [groupId, code],
  );
  return rows[0]?.count ?? null;
}

async function submittedAt(groupId: string): Promise<Date | null> {
  const rows = await sql<{ submitted_at: Date | null }>('select submitted_at from public.request_submissions where group_id = $1', [groupId]);
  return rows[0]?.submitted_at ?? null;
}

/** 提出する。シナリオの年度は最新の年度（seed の R8）ではないので、先に「最新でない年度に保存します」を確かめる（1.3.1） */
async function submit(page: Page, buttonName: RegExp | string) {
  await page.getByRole('button', { name: buttonName }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'この年度に保存する' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: '提出する' }).click();
  await expect(dialog).toHaveCount(0);
}

test('T11 申請：提出・修正して再提出ができ、締切後は読み取り専用になる（390px）', async ({ page }) => {
  const s = await createScenario({ repGroup: SMALL.groups.stall });
  try {
    const gid = s.ids.groups[SMALL.groups.stall]!;
    // 未提出から始める（small の提出の記録を消す）
    await sql('delete from public.request_submissions where group_id = $1', [gid]);
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.setViewportSize(MOBILE);
    await page.goto('/request/');
    await expect(page.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
    await expect(page.getByTestId('request-submitted')).toHaveText('未提出');
    await expect(page.getByRole('textbox', { name: '机(木)の数', exact: true })).toHaveValue('3');

    // 提出（机(木) 3 → 4）
    await page.getByRole('button', { name: '机(木)の数を1増やす' }).click();
    await submit(page, '提出');
    await expect(page.getByText(/^提出しました（/)).toBeVisible();
    await expect(page.getByTestId('request-submitted')).toHaveText(/^提出済み（/);
    expect(await countOf(gid, 'desk')).toBe(4);
    const first = await submittedAt(gid);
    expect(first).not.toBeNull();

    // 修正して再提出（椅子(木) 6 → 9）
    const chair = page.getByRole('textbox', { name: '椅子(木)の数', exact: true });
    await chair.fill('9');
    await chair.press('Enter');
    await submit(page, '修正して再提出');
    await expect.poll(() => countOf(gid, 'chair')).toBe(9);
    expect((await submittedAt(gid))!.getTime()).toBeGreaterThanOrEqual(first!.getTime());

    // 締切を過ぎる（SQL で受付期間を過去にする）→ 読み取り専用
    await sql("update public.years set request_close_at = now() - interval '1 minute' where id = $1", [s.yearId]);
    await page.reload();
    await expect(page.getByTestId('read-only-notice')).toHaveText('締切を過ぎました。変更は総務へ');
    await expect(page.getByRole('button', { name: /提出/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '机(木)の数を1増やす' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '机(木)の数', exact: true })).toHaveValue('4');
  } finally {
    await s.cleanup();
  }
});

test('T11 申請：企業以外には長机(3人掛)の欄がなく、DB に残る長机(3人掛)は読み取り専用の行で出る', async ({ page }) => {
  const s = await createScenario({ repGroup: SMALL.groups.stall });
  try {
    const gid = s.ids.groups[SMALL.groups.stall]!;
    await sql(
      "insert into public.requests (group_id, item_id, count) select $1, id, 2 from public.items where code = 'long_desk_3'",
      [gid],
    );
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.setViewportSize(MOBILE);
    await page.goto('/request/');
    await expect(page.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
    await expect(page.getByTestId('request-field').filter({ hasText: '長机(2人掛)' })).toHaveCount(1);
    await expect(page.locator('[data-testid="request-field"][data-item-code="long_desk_3"]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '長机(3人掛)の数' })).toHaveCount(0);
    await expect(page.getByTestId('request-extra')).toHaveText('長机(3人掛) 2台（長机(2人掛)として扱います。変えるときは総務へ）');

    // 提出しても長机(3人掛)の行は送らない（残る）
    await submit(page, /提出/);
    await expect(page.getByText(/^提出しました（/)).toBeVisible();
    expect(await countOf(gid, 'long_desk_3')).toBe(2);
  } finally {
    await s.cleanup();
  }
});

test('T11 申請：ほかの団体の id をクエリに入れても自団体を開く', async ({ page }) => {
  const s = await createScenario({ repGroup: SMALL.groups.stall });
  try {
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.goto(`/request/?group=${s.ids.groups[SMALL.groups.department]}`);
    await expect(page.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
  } finally {
    await s.cleanup();
  }
});

test('T11 申請：端末の時計が遅れていて DB が締切後と判断したら、読み取り専用にして同じ提出を繰り返さない', async ({ page }) => {
  const s = await createScenario({ repGroup: SMALL.groups.stall, requestWindow: 'closed' });
  try {
    // DB の締切は1日前。端末の時計を3日前にすると、画面は受付期間内と判断する
    await page.clock.setFixedTime(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    let submits = 0;
    page.on('request', (r) => {
      if (r.url().includes('/rest/v1/rpc/submit_requests')) submits++;
    });
    await pinYear(page, SEED_USER_IDS.rep, s.yearId);
    await page.setViewportSize(MOBILE);
    await page.goto('/request/');
    await expect(page.getByTestId('request-group-name')).toHaveText(SMALL.groups.stall);
    await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
    await submit(page, /提出/);
    await expect(page.getByTestId('submit-error')).toHaveText('締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります');
    await expect(page.getByTestId('read-only-notice')).toContainText('端末の時計がずれている可能性があります。変更は総務へ');
    await expect(page.getByRole('button', { name: /提出/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '机(木)の数を1増やす' })).toBeDisabled();
    expect(submits).toBe(1);
  } finally {
    await s.cleanup();
  }
});
