// T10 のスクリーンショット（画面の設計 7.4）。`pnpm e2e:shots --grep T10` で notes/T10/ に撮る（CI では流さない）。
// 在庫入力（スマホと PC）・場所の一覧・保存の後・主なダイアログ（最新でない年度・ほかの人の保存・振り分けの合計）・
// 読み取り専用・使用不可・下書き・見つからない場所・在庫一覧・QR の印刷と、読み込み中・空・権限なし。
// 読み込み中は page.route で応答を止めてから撮る。
import { expect, test, type Page, type Route } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, sql } from '../support/db';
import { SMALL } from '../support/datasets';
import { MOBILE, PC, shoot } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const input = (page: Page, item: string) => page.getByRole('textbox', { name: `${item}の数` });
const plus = (page: Page, item: string) => page.getByRole('button', { name: `${item}の数を1増やす` });
const save = (page: Page) => page.getByRole('button', { name: '保存', exact: true });

async function confirmNotLatest(page: Page): Promise<void> {
  await page.getByRole('alertdialog').getByRole('button', { name: 'この年度に保存する' }).click();
}

/** 応答を止める（release で流す） */
async function hold(page: Page, pattern: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route(pattern, async (route: Route) => {
    await held;
    await route.continue();
  });
  return release;
}

test.describe('T10 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T10 在庫入力（スマホ・PC）・場所の一覧・保存の後・最新でない年度の確かめ', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      // 倉庫B をまだ数えていないことにする（場所の一覧の「まだ」と「次の部屋へ」）
      await sql('delete from public.stocks where year_id = $1 and room_id = $2', [s.yearId, roomB]);
      await sql(
        'update public.stocks set count = count - 2 where year_id = $1 and room_id = $2 and item_id = $3',
        [s.prevYearId, roomA, s.ids.items.desk],
      );
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);

      await page.goto('/stock/');
      await page.getByPlaceholder('場所の名前で絞る').fill('E2E');
      await expect(page.getByTestId('stock-room-row')).toHaveCount(3);
      await shoot(page, 'T10', 'stock-list-mobile', { fullPage: true });

      await page.goto(`/stock/?room=${roomA}`);
      await expect(input(page, '机(木)')).toHaveValue('10');
      await expect(page.getByTestId('stock-prev').first()).toHaveText('前年 8');
      await shoot(page, 'T10', 'stock-input-mobile');
      await shoot(page, 'T10', 'stock-input-mobile-full', { fullPage: true });

      await plus(page, '机(木)').click();
      await save(page).click();
      await expect(page.getByRole('alertdialog')).toContainText('最新でない年度');
      await shoot(page, 'T10', 'stock-not-latest-dialog-mobile');
      await confirmNotLatest(page);
      await expect(page.getByRole('link', { name: /次の部屋へ/ })).toBeVisible();
      await page.getByTestId('stock-saved').scrollIntoViewIfNeeded();
      await shoot(page, 'T10', 'stock-saved-mobile');

      await page.setViewportSize(PC);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('last-counted')).toContainText('テスト部員');
      await shoot(page, 'T10', 'stock-input-pc');
    } finally {
      await s.cleanup();
    }
  });

  test('T10 ほかの人の保存のダイアログ・下書き・見つからない場所', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(input(page, '机(木)')).toHaveValue('10');
      await sql('update public.stocks set count = 7, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
        s.yearId,
        roomA,
        SEED_USER_IDS.admin,
        s.ids.items.desk,
      ]);
      await plus(page, '机(木)').click();
      await save(page).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-conflict-dialog')).toContainText('テスト管理者さんが');
      await shoot(page, 'T10', 'stock-conflict-dialog-mobile');
      await page.getByTestId('stock-conflict-dialog').getByRole('button', { name: 'やめる' }).click();

      // 下書き：入力したまま画面が外れた（書き切った）後に開き直す
      await plus(page, '椅子(木)').click();
      await page.goto('/stock/?room=00000000-0000-4000-8000-00000000dead');
      await expect(page.getByText('この場所は見つかりません')).toBeVisible();
      await shoot(page, 'T10', 'stock-not-found-mobile');
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('draft-notice')).toBeVisible();
      await shoot(page, 'T10', 'stock-draft-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T10 ほかの人が保存したことの知らせ・前年の数の失敗・確かめられません・保存されていました', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      const fetched = page.getByTestId('stock-input');

      // 前年の数を読めない
      await page.route('**/rest/v1/rpc/previous_year_stocks*', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom', details: '', hint: '' }) }),
      );
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('stock-prev-error')).toBeVisible();
      await expect(fetched).toHaveAttribute('data-fetching', 'false');
      await shoot(page, 'T10', 'stock-prev-error-mobile');
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      // 入力の途中で読み直した行が、ほかの人の保存だった（送信が conflict で返り、画面が読み直す）
      await page.goto(`/stock/?room=${roomA}`);
      await expect(input(page, '机(木)')).toHaveValue('10');
      await expect(fetched).toHaveAttribute('data-fetching', 'false');
      await plus(page, '机(木)').click();
      await page.route('**/rest/v1/stocks?*', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        await sql('update public.stocks set count = 19, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
          s.yearId,
          roomA,
          SEED_USER_IDS.admin,
          s.ids.items.chair,
        ]);
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'duplicate key', details: '', hint: '' }) });
      });
      await save(page).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-remote-change')).toContainText('テスト管理者さんが');
      await expect(fetched).toHaveAttribute('data-fetching', 'false');
      await shoot(page, 'T10', 'stock-remote-change-mobile');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.getByTestId('stock-remote-change').getByRole('button', { name: 'ほかの人の数を読み直す' }).click();
      await expect(input(page, '椅子(木)')).toHaveValue('19');

      // 送った upsert は DB に入ったが応答が届かなかった（「保存できたか分かりません…」）
      // → もう一度「保存」で読み直し、自分の保存が入っているので送らずに「保存されていました」
      await plus(page, '机(木)').click();
      await page.route('**/rest/v1/stocks?*', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        await route.fetch();
        await route.abort('failed');
      });
      await save(page).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-unknown-outcome')).toBeVisible();
      await expect(save(page)).toBeEnabled();
      await shoot(page, 'T10', 'stock-unknown-outcome-mobile');
      await save(page).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-saved')).toContainText('保存されていました');
      await page.getByTestId('stock-saved').scrollIntoViewIfNeeded();
      await shoot(page, 'T10', 'stock-recovered-mobile');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    } finally {
      await s.cleanup();
    }
  });

  test('T10 読み取り専用（部員・振り分け中）と使用不可の部屋', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', roles: { staff: true }, usable: { [SMALL.rooms.storageB]: false } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${s.ids.rooms[SMALL.rooms.storageA]}`);
      await expect(page.getByTestId('read-only-notice')).toBeVisible();
      await expect(input(page, '机(木)')).toHaveValue('10');
      await shoot(page, 'T10', 'stock-readonly-mobile');
      await page.goto(`/stock/?room=${s.ids.rooms[SMALL.rooms.storageB]}`);
      await expect(page.getByTestId('unusable-notice')).toBeVisible();
      await expect(input(page, '机(木)')).toHaveValue('10');
      await shoot(page, 'T10', 'stock-unusable-mobile');
    } finally {
      await s.cleanup();
    }
  });

  test('T10 読み込み中（在庫入力・在庫一覧）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      let release = await hold(page, '**/rest/v1/stocks*');
      await page.goto(`/stock/?room=${s.ids.rooms[SMALL.rooms.storageA]}`);
      // 立場・年度・場所は読めて、在庫の行だけを待っているところ（見出しと場所名が出ている）
      await expect(page.getByTestId('stock-room-name')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' })).toBeVisible();
      await shoot(page, 'T10', 'stock-loading-mobile');
      release();
      await expect(input(page, '机(木)')).toHaveValue('10');
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      await page.setViewportSize(PC);
      release = await hold(page, '**/rest/v1/stocks*');
      await page.goto('/stocks/');
      await expect(page.getByRole('heading', { level: 1, name: '在庫一覧' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: '読み込み中…' })).toBeVisible();
      await shoot(page, 'T10', 'stocks-loading-pc');
      release();
      await expect(page.getByTestId('stock-matrix')).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });

  test('T10 在庫一覧（前年との差・使用不可・まだ数えていない場所）と、在庫が1件もない年度', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' }, usable: { [SMALL.rooms.storageB]: false } });
    const empty = await createScenario({ status: 'preparing', dataset: 'empty', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await sql('delete from public.stocks where year_id = $1 and room_id = $2', [s.yearId, s.ids.rooms[SMALL.rooms.outdoor]]);
      await sql('update public.stocks set count = count + 2 where year_id = $1 and room_id = $2 and item_id = $3', [s.yearId, roomA, s.ids.items.desk]);
      await sql('update public.stocks set count = count - 1 where year_id = $1 and room_id = $2 and item_id = $3', [s.yearId, roomA, s.ids.items.chair]);
      await page.setViewportSize(PC);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.goto('/stocks/');
      await expect(page.getByTestId('stock-matrix')).toBeVisible();
      // 表の中で small の場所が見えるところまで送る（ほかのデータセットの場所は使用不可で上に並ぶ）
      await page.locator(`[data-testid="stock-matrix-row"][data-room-id="${roomA}"]`).scrollIntoViewIfNeeded();
      await shoot(page, 'T10', 'stocks-pc');
    } finally {
      await s.cleanup();
    }
    try {
      const p2 = await page.context().newPage();
      await p2.setViewportSize(PC);
      await pinYear(p2, SEED_USER_IDS.staff, empty.yearId);
      await p2.goto('/stocks/');
      await expect(p2.getByTestId('stock-matrix')).toBeVisible();
      await expect(p2.getByTestId('uncounted-rooms')).toBeVisible();
      await shoot(p2, 'T10', 'stocks-empty-pc');
      await p2.close();
    } finally {
      await empty.cleanup();
    }
  });
});

test.describe('T10 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  async function busiest(yearId: string) {
    const [r] = await sql<{ room_id: string; item: string; allocated: number }>(
      `select a.source_room_id as room_id, i.name as item, sum(a.count)::int as allocated
       from public.allocations a join public.items i on i.id = a.item_id join public.rooms r on r.id = a.source_room_id
       where a.year_id = $1 and r.is_storage group by 1, 2 order by 3 desc, 2 limit 1`,
      [yearId],
    );
    return r!;
  }

  test('T10 振り分けの合計より少なくするとき（振り分け中の確かめ・確定中の止め）', async ({ page }) => {
    for (const status of ['allocating', 'confirmed'] as const) {
      const s = await createScenario({ dataset: 'synthetic', status, allocations: 'reference', roles: { admin: true } });
      try {
        const b = await busiest(s.yearId);
        await pinYear(page, SEED_USER_IDS.admin, s.yearId);
        await page.setViewportSize(MOBILE);
        await page.goto(`/stock/?room=${b.room_id}`);
        await expect(page.getByTestId('stock-allocated').first()).toBeVisible();
        await input(page, b.item).fill(String(b.allocated - 1));
        await input(page, b.item).press('Enter');
        await save(page).click();
        await confirmNotLatest(page);
        if (status === 'allocating') {
          await expect(page.getByRole('alertdialog')).toContainText('在庫超過（E001）');
          await shoot(page, 'T10', 'stock-shortfall-dialog-mobile');
          await page.getByRole('alertdialog').getByRole('button', { name: 'やめる' }).click();
        } else {
          await expect(page.getByTestId('stock-shortfall-blocked')).toBeVisible();
          await page.getByTestId('stock-shortfall-blocked').scrollIntoViewIfNeeded();
          await shoot(page, 'T10', 'stock-blocked-mobile');
        }
      } finally {
        await s.cleanup();
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('T10 部屋の QR の印刷（画面と印刷の見た目）', async ({ page }) => {
    const ids = await sql<{ id: string }>(
      `select id from public.rooms where is_storage and (name like 'E2E%' or name like 'テスト用%') order by sort_order, name, id`,
    );
    await page.setViewportSize(PC);
    await page.goto(`/stocks/qr/?rooms=${ids.map((r) => r.id).join(',')}`);
    await expect(page.getByTestId('qr-card')).toHaveCount(ids.length);
    await shoot(page, 'T10', 'stocks-qr-pc', { fullPage: true });
    await page.emulateMedia({ media: 'print' });
    await shoot(page, 'T10', 'stocks-qr-print', { fullPage: true });
  });
});

test.describe('T10 権限なし', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T10 団体代表が在庫入力・在庫一覧を開いたとき', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/stock/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T10', 'stock-forbidden-mobile');
    await page.setViewportSize(PC);
    await page.goto('/stocks/');
    await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    await shoot(page, 'T10', 'stocks-forbidden-pc');
  });
});
