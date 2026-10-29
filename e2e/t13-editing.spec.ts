import { expect, test, type Locator, type Page } from '@playwright/test';
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
  await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled({ timeout: 30_000 });
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
