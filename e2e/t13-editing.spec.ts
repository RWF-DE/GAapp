import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { accessToken, rpc, storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T13 振り分け（段 2：手での編集と使用不可の部屋。画面の設計 3.9・7.2 の T13 の行）。
// 2つの画面の conflict、保存の応答だけを落としたとき、使用不可の部屋の固定の行（画面・API・検証の一覧の E002）、
// 部屋の見出しからの使用不可と最小変更、拒否 → 最小変更で置き換えが消える。シナリオの年度で閉じる。

test.use({ storageState: storageStateFor('admin') });

interface DbAlloc {
  id: string;
  count: number;
  pinned: boolean;
  origin: string;
  source_room_id: string;
  updated_at: string;
}

const ROW_COLS = 'a.id, a.count, a.pinned, a.origin, a.source_room_id, a.updated_at::text as updated_at';

async function rowsOf(yearId: string, where = 'true', params: unknown[] = []): Promise<DbAlloc[]> {
  return sql<DbAlloc>(
    `select ${ROW_COLS} from public.allocations a join public.items i on i.id = a.item_id
     join public.rooms r on r.id = a.source_room_id where a.year_id = $1 and ${where} order by a.id`,
    [yearId, ...params],
  );
}

async function waitEngineReady(page: Page): Promise<void> {
  // 中止の後（engine が idle）もボタンは押せるので、読み込みが済んだことは engine-state で見る
  await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();
}

/** 行を開く（その行のタブ） */
async function openRow(page: Page, rowId: string): Promise<Locator> {
  await page.goto(`/allocation/?row=${rowId}`);
  const row = page.locator(`[data-row-id="${rowId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

async function saveWithReason(page: Page, reason = 'E2E：運び元の調整'): Promise<void> {
  await page.getByTestId('pending-bar').getByRole('button', { name: '保存…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('理由（必須）').fill(reason);
  await dialog.getByRole('button', { name: '保存する' }).click();
}

async function runAuto(page: Page, mode: '自動振り分け' | '最小変更で再実行'): Promise<void> {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '実行する' }).click();
}

test('T13 行の編集：2つの画面で同じ行を変えると、後の保存で「他の人が変更しました」と出て読み直し、ぶつからない変更は当て直される', async ({ page, context }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const [x, z] = await rowsOf(s.yearId, "i.code = 'chair' and not a.is_keep");
    if (!x || !z) throw new Error('椅子(木)の行が2つ要ります');
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    const page2 = await context.newPage();
    await pinYear(page2, SEED_USER_IDS.admin, s.yearId);

    // 2つの画面で同じスナップショットを開く
    const rowX1 = await openRow(page, x.id);
    const rowX2 = await openRow(page2, x.id);

    // 画面1：行 X の数を +1 して保存
    await rowX1.getByRole('button', { name: /を1増やす$/ }).click();
    await expect(page.getByTestId('pending-bar')).toHaveAttribute('data-count', '1');
    await saveWithReason(page);
    await expect(page.getByText(/^保存しました（追加 0・変更 1・削除 0）/)).toBeVisible();
    await expect(page.getByTestId('pending-bar')).toHaveCount(0);

    // 画面2（古いスナップショット）：同じ行 X を +2、ぶつからない行 Z を +1 して保存
    await rowX2.getByRole('button', { name: /を1増やす$/ }).click();
    await rowX2.getByRole('button', { name: /を1増やす$/ }).click();
    const rowZ2 = page2.locator(`[data-row-id="${z.id}"]`);
    await rowZ2.getByRole('button', { name: /を1増やす$/ }).click();
    await expect(page2.getByTestId('pending-bar')).toHaveAttribute('data-count', '2');
    await saveWithReason(page2);
    await expect(page2.getByText('他の人が変更しました。読み直して、ぶつからない変更を当て直しました')).toBeVisible();
    const dropped = page2.getByTestId('rows-dropped');
    await expect(dropped).toBeVisible();
    await expect(dropped).toContainText('ほかの人の変更とぶつかったので外しました');
    // ぶつからない変更（Z）は当て直されて残る。X は画面1の値に読み直された
    await expect(page2.getByTestId('pending-bar')).toHaveAttribute('data-count', '1');
    await expect(rowX2.getByRole('group').getByRole('textbox')).toHaveValue(String(x.count + 1));
    await saveWithReason(page2);
    await expect(page2.getByText(/^保存しました（追加 0・変更 1・削除 0）/)).toBeVisible();

    const [x2] = await rowsOf(s.yearId, 'a.id = $2', [x.id]);
    const [z2] = await rowsOf(s.yearId, 'a.id = $2', [z.id]);
    expect(x2!.count).toBe(x.count + 1);
    expect(z2!.count).toBe(z.count + 1);
    expect(z2!.origin).toBe('manual');
    await page2.close();
  } finally {
    await s.cleanup();
  }
});

test('T13 行の編集：保存の応答だけを落とすと、送り直しの前に保存されていたことが分かり、行が二重にならない', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const [x] = await rowsOf(s.yearId, "i.code = 'desk' and not a.is_keep");
    if (!x) throw new Error('机(木)の行が要ります');
    const before = (await rowsOf(s.yearId)).length;
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    const row = await openRow(page, x.id);

    // 行の追加（insert）と数の変更（update）
    await page.getByRole('button', { name: '行を追加' }).click();
    const add = page.getByRole('dialog');
    await expect(add.getByRole('heading', { name: '行を追加' })).toBeVisible();
    await add.getByRole('button', { name: '追加する', exact: true }).click();
    await row.getByRole('button', { name: /を1増やす$/ }).click();
    await expect(page.getByTestId('pending-bar')).toHaveAttribute('data-count', '2');

    // 応答だけを落とす：サーバーには届けてから、ブラウザには通信の失敗を返す
    let calls = 0;
    await page.route('**/rest/v1/rpc/save_allocation_rows', async (route) => {
      calls += 1;
      await route.fetch();
      await route.abort();
    });
    await saveWithReason(page);
    await expect(page.getByText('保存されていました（応答が届かなかったので、読み直して確かめました）')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pending-bar')).toHaveCount(0);
    await page.unroute('**/rest/v1/rpc/save_allocation_rows');
    expect(calls).toBe(1);

    const after = await rowsOf(s.yearId);
    expect(after.length).toBe(before + 1); // insert は1行だけ（送り直していない）
    const [x2] = await rowsOf(s.yearId, 'a.id = $2', [x.id]);
    expect(x2!.count).toBe(x.count + 1);
    // 画面も DB と同じ行数
    await expect(page.getByTestId('rows-not-saved')).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('T13 使用不可の部屋の固定の行：画面に「固定を外す」が出ず、API で固定を外すと E002 で全体が拒否され、運び元の変更と削除は通る', async ({ page, request }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const roomId = s.ids.rooms['MER']!;
    const inRoom = await rowsOf(s.yearId, "r.name = 'MER' and i.code = 'desk' and not a.is_keep");
    if (inRoom.length < 2) throw new Error('MER の机(木)の行が2つ要ります');
    const [p1, p2] = inRoom;
    // ほかの人（マスタ設定など）が先に使用不可にした形：固定の行と手動の行を作ってから、部屋を使用不可にする
    await sql(`update public.allocations set pinned = true where id = $1`, [p1!.id]);
    await sql(`update public.allocations set origin = 'manual', pinned = true where id = $1`, [p2!.id]);
    await sql(`insert into public.room_years (year_id, room_id, usable, note) values ($1, $2, false, 'E2E') on conflict (year_id, room_id) do update set usable = false`, [
      s.yearId,
      roomId,
    ]);

    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    const row = await openRow(page, p1!.id);
    await waitEngineReady(page);
    // 画面：数・備考・固定のボタンはなく、運び元の変更と削除だけ
    await expect(row.getByRole('button', { name: '固定を外す' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /を1増やす$/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: '備考' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /運び元を変える$/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /を削除$/ })).toBeVisible();
    await expect(page.getByTestId('unusable-row-note').first()).toBeVisible();

    // 最小変更で再実行：allocate の precheck は固定・手動の行の E002 では止めない（03。残すのルールの部屋だけ）ので保存され、
    // 検証の一覧に E002 が残る。その項目には運び元の変更と削除だけ（「固定を外す」は出さない）
    await runAuto(page, '最小変更で再実行');
    await expect(page.getByTestId('allocate-saved')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('allocate-errors-after')).toBeVisible();
    const e002 = page.getByTestId('issues-panel').locator('[data-issue-code="E002"]');
    await expect(e002).toHaveCount(1);
    const actions = e002.getByTestId('e002-actions');
    await expect(actions.getByRole('button', { name: '運び元を変える' })).toHaveCount(2);
    await expect(actions.getByRole('button', { name: '行を削除' })).toHaveCount(2);
    await expect(e002.getByRole('button', { name: '固定を外す' })).toHaveCount(0);
    // 「部屋の見出しのメニューへ」：MER の行も在庫もないタブ（教卓）・団体別から押しても、固定の行の品目のタブ（机(木)）を開き、
    // MER の見出しのメニュー（使用可に戻す）が出る
    const merMenu = page.locator(`[data-room-block="${roomId}"]`).getByRole('button', { name: 'MERのメニュー' });
    for (const from of ['tab', 'group'] as const) {
      if (from === 'tab') await page.getByRole('tab', { name: '教卓' }).click();
      else await page.getByRole('button', { name: '団体別' }).click();
      await expect(merMenu).toHaveCount(0);
      await actions.getByRole('button', { name: '部屋の見出しのメニューへ' }).click();
      await expect(page.getByRole('tab', { name: '机(木)' })).toHaveAttribute('aria-selected', 'true');
      await expect(merMenu).toBeVisible();
      await merMenu.click();
      await expect(page.getByRole('menuitem', { name: '使用可に戻す' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    // 再実行で自動の行は MER から動き、固定・手動の2行だけが残る
    expect((await rowsOf(s.yearId, "r.name = 'MER'")).map((r) => r.id).sort()).toEqual([p1!.id, p2!.id].sort());
    const [p1now] = await rowsOf(s.yearId, 'a.id = $2', [p1!.id]);
    const [p2now] = await rowsOf(s.yearId, 'a.id = $2', [p2!.id]);

    // API：固定を外す update は E002 で全体が拒否される（同時に送った削除も入らない）
    const token = await accessToken(request, 'admin');
    const usable = (await sql<{ id: string }>(`select id from public.rooms where name = '1-2'`))[0]!.id;
    const bad = await rpc(request, token, 'save_allocation_rows', {
      p_year_id: s.yearId,
      p_changes: [
        { op: 'delete', id: p2!.id, updatedAt: p2now!.updated_at },
        { op: 'update', id: p1!.id, updatedAt: p1now!.updated_at, pinned: false },
      ],
      p_reason: 'E2E：固定を外す',
    });
    expect(bad.error?.message).toBe('E002');
    expect((await rowsOf(s.yearId, 'a.id = any($2::uuid[])', [[p1!.id, p2!.id]])).map((r) => r.pinned)).toEqual([true, true]);
    // 運び元を使用可の部屋に変える update と delete は通る
    const [cur1] = await rowsOf(s.yearId, 'a.id = $2', [p1!.id]);
    const [cur2] = await rowsOf(s.yearId, 'a.id = $2', [p2!.id]);
    const ok = await rpc(request, token, 'save_allocation_rows', {
      p_year_id: s.yearId,
      p_changes: [
        { op: 'update', id: p1!.id, updatedAt: cur1!.updated_at, sourceRoomId: usable },
        { op: 'delete', id: p2!.id, updatedAt: cur2!.updated_at },
      ],
      p_reason: 'E2E：運び元の調整',
    });
    expect(ok.error).toBeNull();
    expect((await rowsOf(s.yearId, 'a.id = $2', [p1!.id]))[0]!.source_room_id).toBe(usable);
    expect(await rowsOf(s.yearId, 'a.id = $2', [p2!.id])).toEqual([]);
  } finally {
    await s.cleanup();
  }
});

test('T13 部屋の見出しの「使用不可にする」：固定・手動の行を先に直して保存するまで押せず、その順で使用不可にして最小変更で再実行すると precheck にも検証にも E002 が出ない', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const inRoom = await rowsOf(s.yearId, "r.name = 'MER' and i.code = 'desk' and not a.is_keep");
    if (inRoom.length < 2) throw new Error('MER の机(木)の行が2つ要ります');
    const [p1, p2] = inRoom;
    await sql(`update public.allocations set pinned = true where id = $1`, [p1!.id]); // 固定の自動の行
    await sql(`update public.allocations set origin = 'manual' where id = $1`, [p2!.id]); // 手動の行

    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await openRow(page, p1!.id);
    await waitEngineReady(page);
    const block = page.locator(`[data-room-block="${s.ids.rooms['MER']}"]`);
    await block.getByRole('button', { name: 'MERのメニュー' }).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const dialog = page.getByRole('dialog');
    const list = dialog.getByTestId('unusable-checklist');
    await expect(list.locator('[data-row-id]')).toHaveCount(2);
    // 固定の自動の行は「固定を外す」も、手動の行は運び元の変更と削除だけ
    await expect(list.locator(`[data-row-id="${p1!.id}"]`).getByRole('button', { name: '固定を外す' })).toBeVisible();
    await expect(list.locator(`[data-row-id="${p2!.id}"]`).getByRole('button', { name: '固定を外す' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '使用不可にする' })).toBeDisabled();
    await expect(dialog.getByTestId('unusable-blocker')).toHaveText('先に一覧の行を直して保存してください');

    await list.locator(`[data-row-id="${p1!.id}"]`).getByRole('button', { name: '固定を外す' }).click();
    await list.locator(`[data-row-id="${p2!.id}"]`).getByRole('button', { name: '削除' }).click();
    await expect(dialog.getByTestId('unusable-checklist-empty')).toBeVisible();
    // 未保存の変更が残っている間は押せない
    await expect(dialog.getByRole('button', { name: '使用不可にする' })).toBeDisabled();
    await dialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
    await saveWithReason(page, 'E2E：使用不可にする前に直す');
    await expect(page.getByText(/^保存しました（追加 0・変更 1・削除 1）/)).toBeVisible();

    await block.getByRole('button', { name: 'MERのメニュー' }).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    await expect(dialog.getByTestId('unusable-checklist-empty')).toBeVisible();
    await dialog.getByLabel('理由のメモ（任意）').fill('E2E：工事');
    await dialog.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByTestId('suggest-minimal')).toBeVisible();
    await expect(page.getByRole('button', { name: '最小変更で再実行', exact: true })).toHaveAttribute('data-emphasized', 'true');

    await runAuto(page, '最小変更で再実行');
    await expect(page.getByTestId('allocate-saved')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('allocate-failure')).toHaveCount(0);
    await expect(page.getByTestId('issues-panel').locator('[data-issue-code="E002"]')).toHaveCount(0);
    expect(await rowsOf(s.yearId, "r.name = 'MER'")).toEqual([]);
    const usable = await sql<{ usable: boolean }>(`select usable from public.room_years where year_id = $1 and room_id = $2`, [s.yearId, s.ids.rooms['MER']]);
    expect(usable[0]!.usable).toBe(false);
  } finally {
    await s.cleanup();
  }
});

test('T13 部屋の見出しの「使用不可にする」：2つの画面で部屋の使用を変えると、古い画面は黙って上書きせず「ほかの人がこの部屋の使用を変えました」と出して読み直す', async ({ page, context }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const roomId = s.ids.rooms['MER']!;
    const [x] = await rowsOf(s.yearId, "r.name = 'MER' and i.code = 'desk' and not a.is_keep");
    if (!x) throw new Error('MER の机(木)の行が要ります');
    const roomYear = async () =>
      (await sql<{ usable: boolean; note: string | null }>(`select usable, note from public.room_years where year_id = $1 and room_id = $2`, [s.yearId, roomId]))[0];
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    const page2 = await context.newPage();
    await pinYear(page2, SEED_USER_IDS.admin, s.yearId);
    await openRow(page, x.id);
    await openRow(page2, x.id); // 画面2 は MER が使用可のスナップショットのまま
    const menu = (p: Page) => p.locator(`[data-room-block="${roomId}"]`).getByRole('button', { name: 'MERのメニュー' });

    // 画面1：使用不可にしてから、使用可に戻す（room_years の行ができて updated_at が進む）
    await menu(page).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const d1 = page.getByRole('dialog');
    await expect(d1.getByTestId('unusable-checklist-empty')).toBeVisible();
    await d1.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByTestId('suggest-minimal')).toBeVisible();
    await menu(page).click();
    await page.getByRole('menuitem', { name: '使用可に戻す' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '使用可に戻す' }).click();
    await expect(page.getByText('MERを使用可に戻しました')).toBeVisible();
    expect((await roomYear())!.usable).toBe(true);

    // 画面2（古いスナップショット）：使用不可にしようとすると conflict。読み直してもまだ使用可なので、ダイアログとメモは残る
    await menu(page2).click();
    await page2.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const d2 = page2.getByRole('dialog');
    await d2.getByLabel('理由のメモ（任意）').fill('E2E：2つ目の画面');
    await d2.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page2.getByText('ほかの人がこの部屋の使用を変えました。読み直しました')).toBeVisible();
    await expect(d2).toBeVisible();
    await expect(d2.getByLabel('理由のメモ（任意）')).toHaveValue('E2E：2つ目の画面');
    expect((await roomYear())!.usable).toBe(true);
    // 読み直した updated_at で押し直すと通る
    await d2.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page2.getByTestId('suggest-minimal')).toBeVisible();
    await expect(d2).toHaveCount(0);
    expect(await roomYear()).toEqual({ usable: false, note: 'E2E：2つ目の画面' });

    // 画面1（今は古い）：使用不可にしようとすると conflict。読み直すとすでに使用不可（メモだけ違う）なのでダイアログを閉じ、
    // 画面2のメモは上書きしない。最小変更で再実行を目立たせる
    await menu(page).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    await d1.getByLabel('理由のメモ（任意）').fill('E2E：1つ目の画面');
    await d1.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByText('ほかの人がすでにMERを使用不可にしていました（入れたメモは保存していません）')).toBeVisible();
    await expect(d1).toHaveCount(0);
    await expect(page.getByTestId('suggest-minimal')).toBeVisible();
    expect(await roomYear()).toEqual({ usable: false, note: 'E2E：2つ目の画面' });
    // 読み直したので、見出しのメニューは「使用可に戻す」になっている
    await menu(page).click();
    await expect(page.getByRole('menuitem', { name: '使用可に戻す' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page2.close();
  } finally {
    await s.cleanup();
  }
});

test('T13 部屋の見出しの「使用不可にする」：応答だけを落とすと、送り直す前に読み直して「保存されていました」と出し、最小変更で再実行を目立たせる', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const roomId = s.ids.rooms['MER']!;
    const [x] = await rowsOf(s.yearId, "r.name = 'MER' and i.code = 'desk' and not a.is_keep");
    if (!x) throw new Error('MER の机(木)の行が要ります');
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await openRow(page, x.id);
    const menu = page.locator(`[data-room-block="${roomId}"]`).getByRole('button', { name: 'MERのメニュー' });

    // room_years の書き込み（行のない部屋なので insert）を DB には届けてから、ブラウザには通信の失敗を返す
    let writes = 0;
    await page.route('**/rest/v1/room_years*', async (route) => {
      if (route.request().method() === 'GET') return route.continue();
      writes += 1;
      await route.fetch();
      await route.abort();
    });
    await menu.click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('unusable-checklist-empty')).toBeVisible();
    await dialog.getByLabel('理由のメモ（任意）').fill('E2E：応答を落とす');
    await dialog.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByText(/^保存されていました（MERを今年は使用不可にしました/)).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('ほかの人がこの部屋の使用を変えました', { exact: false })).toHaveCount(0);
    await expect(page.getByTestId('suggest-minimal')).toBeVisible();
    await expect(page.getByRole('button', { name: '最小変更で再実行', exact: true })).toHaveAttribute('data-emphasized', 'true');
    await page.unroute('**/rest/v1/room_years*');
    expect(writes).toBe(1);
    const ry = await sql<{ usable: boolean; note: string | null }>(`select usable, note from public.room_years where year_id = $1 and room_id = $2`, [s.yearId, roomId]);
    expect(ry).toEqual([{ usable: false, note: 'E2E：応答を落とす' }]);
  } finally {
    await s.cleanup();
  }
});

test('T13 部屋の見出しの「使用不可にする」：conflict の後の読み直しが失敗しても、画面・ダイアログ・メモは残り、「読み直しました」と言わず、押せるまま。「読み直す」は同じ判定を通す', async ({ page }) => {
  // 読み直しの GET は、supabase-js（postgrest-js）が通信の失敗を間をあけて数回送り直し、react-query も1回送り直すので、失敗が分かるまで十数秒かかる
  test.setTimeout(120_000);
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const roomId = s.ids.rooms['MER']!;
    const [x] = await rowsOf(s.yearId, "r.name = 'MER' and i.code = 'desk' and not a.is_keep");
    if (!x) throw new Error('MER の机(木)の行が要ります');
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await openRow(page, x.id);
    const block = page.locator(`[data-room-block="${roomId}"]`);
    await block.getByRole('button', { name: 'MERのメニュー' }).click();
    await page.getByRole('menuitem', { name: '今年は使用不可にする' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('unusable-checklist-empty')).toBeVisible();
    await dialog.getByLabel('理由のメモ（任意）').fill('E2E：読み直せない');

    // ほかの人（マスタ設定）が、画面の知らない間に行を足した（使用可のまま、メモだけ）
    await sql(`insert into public.room_years (year_id, room_id, usable, note) values ($1, $2, true, 'E2E：ほかの人')`, [s.yearId, roomId]);
    // 書き込みは通し、読み直し（GET）はすべて落とす
    const failReads = async (route: Route) => (route.request().method() === 'GET' ? route.abort() : route.continue());
    await page.route('**/rest/v1/**', failReads);
    await dialog.getByRole('button', { name: '使用不可にする' }).click();
    const unread = dialog.getByTestId('room-usable-unread');
    await expect(unread).toContainText('読み直せませんでした', { timeout: 60_000 });
    await expect(page.getByText('ほかの人がこの部屋の使用を変えました。読み直しました')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('理由のメモ（任意）')).toHaveValue('E2E：読み直せない');
    // 確かめる状態は持たない：「確かめる」は出ず、押せるまま
    await expect(dialog.getByRole('button', { name: '確かめる' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '使用不可にする' })).toBeEnabled();
    // 画面は ErrorState に替わらず、上の帯で知らせる（編集中の表は残る）
    await expect(page.getByTestId('error-banner')).toBeVisible();
    await expect(block).toBeVisible();

    // 通信が戻って「読み直す」：止められた後と同じ判定（settleRoomUsable）を通す。ほかの人の変更なので、いつもの conflict（読み直しました）。
    // 知らせは消え、読み直した行が入力の元になる。まだ使用可なので、メモを残したまま押し直せる
    await page.unroute('**/rest/v1/**', failReads);
    await unread.getByRole('button', { name: '読み直す' }).click();
    await expect(page.getByText('ほかの人がこの部屋の使用を変えました。読み直しました')).toBeVisible();
    await expect(unread).toHaveCount(0);
    await expect(dialog.getByLabel('理由のメモ（任意）')).toHaveValue('E2E：読み直せない');
    // 入力の元が読み直した行になっているので、押すとそのまま通る（DB に止められない）
    await dialog.getByRole('button', { name: '使用不可にする' }).click();
    await expect(page.getByTestId('suggest-minimal')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const ry = await sql<{ usable: boolean; note: string | null }>(`select usable, note from public.room_years where year_id = $1 and room_id = $2`, [s.yearId, roomId]);
    expect(ry).toEqual([{ usable: false, note: 'E2E：読み直せない' }]);
  } finally {
    await s.cleanup();
  }
});

test('T13 了承を「拒否」にして最小変更で再実行すると、その団体の置き換えが消える', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    const g = s.ids.groups['模擬店02']!;
    const subs = `a.group_id = $2 and i.code = 'caster_desk' and a.requested_item_id = (select id from public.items where code = 'desk')`;
    expect((await rowsOf(s.yearId, subs, [g])).length).toBeGreaterThan(0);
    // 拒否（set_consent の declined と同じ：了承の行を declined にして、置き換えの行の固定を外す）
    await sql(
      `update public.substitution_consents set status = 'declined' where group_id = $1
         and from_item_id = (select id from public.items where code = 'desk') and to_item_id = (select id from public.items where code = 'caster_desk')`,
      [g],
    );
    await sql(`update public.allocations set pinned = false where group_id = $1`, [g]);

    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await page.goto('/allocation/');
    await waitEngineReady(page);
    await runAuto(page, '最小変更で再実行');
    await expect(page.getByTestId('allocate-saved')).toBeVisible({ timeout: 30_000 });
    expect(await rowsOf(s.yearId, subs, [g])).toEqual([]);
  } finally {
    await s.cleanup();
  }
});

test.describe('T13 PC の 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('T13 1280px：2品目のタブでも「固定・操作」の列（運び元・削除）が部屋のまとまりに収まり、表が横にはみ出さない', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      for (const tab of ['机(木)', '椅子(木)', 'キャスター机']) {
        await page.goto('/allocation/');
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const block = page.locator('[data-room-block]').filter({ has: page.locator('[data-row-id]') }).first();
        const row = block.locator('[data-row-id]').first();
        await expect(row).toBeVisible();
        const source = row.getByRole('button', { name: /の運び元を変える$/ });
        const del = row.getByRole('button', { name: /を削除$/ });
        await expect(source).toBeVisible();
        await expect(del).toBeVisible();
        const b = (await block.boundingBox())!;
        for (const btn of [source, del]) {
          const x = (await btn.boundingBox())!;
          expect(x.x + x.width, `${tab}：操作のボタンが部屋のまとまりの右端を越える`).toBeLessThanOrEqual(b.x + b.width);
        }
        // どの部屋のまとまりの表も横にスクロールしない
        const overflow = await page
          .locator('[data-room-block] [data-slot="table-container"], [data-room-block] .overflow-x-auto')
          .evaluateAll((els) => Math.max(0, ...els.map((el) => el.scrollWidth - el.clientWidth)));
        expect(overflow, `${tab}：表が横にはみ出す`).toBeLessThanOrEqual(0);
        // 検証の一覧は右に並ぶ（xl から）
        const table = (await page.locator('[data-room-block]').first().boundingBox())!;
        const issues = (await page.getByTestId('issues-panel').boundingBox())!;
        expect(issues.x).toBeGreaterThanOrEqual(table.x + table.width);
      }
    } finally {
      await s.cleanup();
    }
  });

  test('T13 1280px：先頭の行を変えると、スクロールしなくても画面の下に「未保存の変更」のバーが見える', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/allocation/');
      await page.getByRole('tab', { name: '机(木)', exact: true }).click();
      const row = page.locator('[data-room-block] [data-row-id]').first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: /を1増やす$/ }).click();
      const bar = page.getByTestId('pending-bar');
      await expect(bar).toHaveAttribute('data-count', '1');
      // 先頭の行の近くにいる（ページの終わりまでスクロールしていない）
      const scroll = await page.locator('html').evaluate((el) => ({ y: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
      expect(scroll.max, 'ページが画面より長い（バーが固定されていることを確かめられる）').toBeGreaterThan(scroll.y + 800);
      await expect(bar).toBeInViewport();
      await expect(bar.getByRole('button', { name: '保存…' })).toBeInViewport();
      const box = (await bar.boundingBox())!;
      expect(box.y + box.height, 'バーが画面の下端に付いている').toBeGreaterThan(800 - 8);
    } finally {
      await s.cleanup();
    }
  });
});

test('T13 検証の一覧：同じ項目をもう一度押してもその行へ移る。未保存の追加の行（仮の id）へも移る', async ({ page }) => {
  const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
  try {
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/allocation/');
    await expect(page.getByTestId('issues-panel')).toBeVisible();

    // 同じ項目（了承待ちの W102。行へ移る）を2回押す（B8）
    const item = page.locator('[data-issue-code="W102"]').first();
    await expect(item).toBeVisible();
    const go = item.locator('button').first();
    await go.click();
    await expect(page).toHaveURL(/[?&]row=[0-9a-f-]{36}/);
    const rowId = new URL(page.url()).searchParams.get('row')!;
    const row = page.locator(`[data-row-id="${rowId}"]`);
    await expect(row).toHaveAttribute('data-highlighted', 'true');
    await expect(row).toBeInViewport();
    // 行を画面の外へ（上か下へ）スクロールしてから、同じ項目をもう一度押す
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, -100_000);
    const inView = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < (el.ownerDocument.defaultView?.innerHeight ?? 0);
    });
    if (inView) {
      await page.mouse.wheel(0, 100_000);
    }
    await expect(row).not.toBeInViewport();
    const urlBefore = page.url();
    await go.click();
    expect(page.url()).toBe(urlBefore);
    await expect(row).toBeInViewport();

    // 未保存の追加の行（ルール外の品目 → E004。rowIds は new-<uuid>）へ移る（B9）
    await page.getByRole('button', { name: '行を追加' }).click();
    const add = page.getByRole('dialog');
    await expect(add.getByRole('heading', { name: '行を追加' })).toBeVisible();
    const groupName = ((await add.getByLabel('団体').locator('option:checked').textContent()) ?? '').trim();
    const itemSelect = add.getByLabel('品目', { exact: true });
    const options = await itemSelect.locator('option').allTextContents();
    let itemName: string | null = null;
    for (const [k, text] of options.entries()) {
      if (!text.includes('ルール外')) continue;
      await itemSelect.selectOption({ index: k });
      if ((await add.getByLabel('運び元').count()) > 0 && (await add.getByRole('button', { name: '追加する', exact: true }).isEnabled())) {
        itemName = text.slice(0, text.indexOf('（'));
        break;
      }
    }
    expect(itemName, 'ルール外で在庫のある品目が要る').not.toBeNull();
    await add.getByRole('button', { name: '追加する', exact: true }).click();
    await expect(page.getByTestId('pending-bar')).toHaveAttribute('data-count', '1');
    const e004 = page.locator('[data-issue-code="E004"]').filter({ hasText: `${groupName}の` }).filter({ hasText: `を${itemName}で置き換えられません` });
    await expect(e004).toHaveCount(1);
    await e004.locator('button').first().click();
    await expect(page).toHaveURL(/[?&]row=new-[0-9a-f-]+/);
    const tempId = new URL(page.url()).searchParams.get('row')!;
    const added = page.locator(`[data-row-id="${tempId}"]`);
    await expect(added).toHaveAttribute('data-highlighted', 'true');
    await expect(added).toHaveAttribute('data-pending', 'true');
    await expect(added).toBeInViewport();
  } finally {
    await s.cleanup();
  }
});
