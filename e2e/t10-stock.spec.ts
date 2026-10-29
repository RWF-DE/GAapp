// T10 在庫入力・在庫一覧・部屋の QR の印刷（画面の設計 3.3・3.4・6 章・7.2 の T10 の行）。
// どのテストもシナリオの年度（createScenario）で閉じる。seed の R8 の年度には書かない（QR の印刷は年度によらないので R8 で開く）。
// シナリオの年度（2001 年）は seed のユーザーにとって最新の年度（R8）ではないので、保存のたびに「最新でない年度」の確かめが出る。
import { expect, test, type Page } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SMALL } from './support/datasets';
import { readGlobalRooms } from './support/global-rooms';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

interface StockRow {
  item_id: string;
  count: number;
  counted_by: string | null;
  counted_at: Date | null;
}

async function roomStocks(yearId: string, roomId: string): Promise<Map<string, StockRow>> {
  const rows = await sql<StockRow>('select item_id, count, counted_by, counted_at from public.stocks where year_id = $1 and room_id = $2', [yearId, roomId]);
  return new Map(rows.map((r) => [r.item_id, r]));
}

const input = (page: Page, item: string) => page.getByRole('textbox', { name: `${item}の数` });
const plus = (page: Page, item: string) => page.getByRole('button', { name: `${item}の数を1増やす` });

/** 最新でない年度の確かめに「この年度に保存する」で答える */
async function confirmNotLatest(page: Page): Promise<void> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('最新でない年度');
  await dialog.getByRole('button', { name: 'この年度に保存する' }).click();
}

/**
 * 画面が読み込み終わるまで待つ：机(木)の数が出て、部屋の行・前年・名前・振り分けの合計のどれも読んでいない
 * （data-fetching="false"）。この後に SQL でほかの人の保存を入れても、裏の読み込みに拾われない（保存の前の確かめで見つかる）。
 */
async function waitInput(page: Page, desk: number): Promise<void> {
  await expect(input(page, '机(木)')).toHaveValue(String(desk));
  await expect(page.getByTestId('stock-input')).toHaveAttribute('data-fetching', 'false');
}

test.describe('T10 部員', () => {
  test.use({ storageState: storageStateFor('staff') });

  test('T10 在庫入力（390px）：＋－と数字で入れて保存すると、数えた人と日時が出て counted_by・counted_at が更新される', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const before = await roomStocks(s.yearId, roomA);
      const startedAt = new Date(Date.now() - 1000);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageA);
      await waitInput(page, 10);
      // シナリオの行は postgres が入れたので数えた人がいない（読めない）
      await expect(page.getByTestId('last-counted')).toContainText('名前を表示できません');
      // 前年度（small）の数
      const deskRow = page.getByTestId('stock-item-row').filter({ hasText: '机(木)' });
      await expect(deskRow.getByTestId('stock-prev')).toHaveText('前年 10');

      await plus(page, '机(木)').click();
      await expect(input(page, '机(木)')).toHaveValue('11');
      await input(page, '椅子(木)').fill('25');
      await input(page, '椅子(木)').press('Enter');
      await expect(input(page, '椅子(木)')).toHaveValue('25');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-saved')).toContainText('保存しました');
      await expect(page.getByTestId('last-counted')).toContainText('テスト部員');
      // small の使える保管場所はほかにすべて数えてある
      await expect(page.getByTestId('stock-saved')).toContainText('まだ数えていない保管場所はありません');
      // ページが横にスクロールしない
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);

      const after = await roomStocks(s.yearId, roomA);
      // 部屋の全品目（0 を含む）を書いた。数えた人は部員、日時は保存の後（前は postgres が入れた行で数えた人なし）
      const [items] = await sql<{ n: number }>('select count(*)::int as n from public.items');
      expect(after.size).toBe(items!.n);
      expect([...before.values()].every((r) => r.counted_by === null)).toBe(true);
      for (const r of after.values()) {
        expect(r.counted_by).toBe(SEED_USER_IDS.staff);
        expect(r.counted_at!.getTime()).toBeGreaterThan(startedAt.getTime());
      }
      expect(after.get(s.ids.items.desk!)!.count).toBe(11);
      expect(after.get(s.ids.items.chair!)!.count).toBe(25);
      expect(after.get(s.ids.items.lectern!)!.count).toBe(0);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 ほかの人の保存：読み込んだ後に保存されていれば、上書きするか読み直すかを選べる', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const desk = s.ids.items.desk!;
      const chair = s.ids.items.chair!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      // シナリオの行は postgres が入れたので数えた人がいない（読めない）
      await expect(page.getByTestId('last-counted')).toContainText('名前を表示できません');

      // 管理者が別の端末で保存した（数えた人・日時も DB の値として入れる）
      await sql('update public.stocks set count = 7, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
        s.yearId,
        roomA,
        SEED_USER_IDS.admin,
        desk,
      ]);
      await plus(page, '机(木)').click();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const dialog = page.getByTestId('stock-conflict-dialog');
      await expect(dialog).toContainText('テスト管理者さんが');
      await expect(dialog.getByTestId('conflict-row').filter({ hasText: '机(木)' })).toContainText('711');
      // 開くとフォーカスはダイアログの中（やめる）。Esc で閉じると「保存」へ戻る
      await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeFocused();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      await expect(dialog).toContainText('テスト管理者さんが');
      // 読み直す：相手の数になり、保存しない
      await dialog.getByRole('button', { name: '読み直す' }).click();
      await waitInput(page, 7);
      expect((await roomStocks(s.yearId, roomA)).get(desk)!.counted_by).toBe(SEED_USER_IDS.admin);
      // 「前回の入力」も読み直した行（管理者の保存）で出す
      await expect(page.getByTestId('last-counted')).toContainText('テスト管理者');
      await expect(page.getByTestId('last-counted')).not.toContainText('名前を表示できません');

      // もう一度ほかの人が保存 → 今度は上書きする
      await plus(page, '机(木)').click();
      await sql('update public.stocks set count = 19, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
        s.yearId,
        roomA,
        SEED_USER_IDS.admin,
        chair,
      ]);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '上書きする' }).click();
      await expect(page.getByTestId('stock-saved')).toBeVisible();
      const after = await roomStocks(s.yearId, roomA);
      expect(after.get(desk)!.count).toBe(8);
      expect(after.get(chair)!.count).toBe(20);
      expect(after.get(chair)!.counted_by).toBe(SEED_USER_IDS.staff);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 前年度：在庫入力に前年の数、在庫一覧に前年との差が出る', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const desk = s.ids.items.desk!;
      const chair = s.ids.items.chair!;
      // 前年度の E2E倉庫A の机(木)を 8 にする（今年は 10 → +2）
      await sql('update public.years set status = $2 where id = $1', [s.prevYearId, 'allocating']);
      await sql('update public.stocks set count = 8 where year_id = $1 and room_id = $2 and item_id = $3', [s.prevYearId, roomA, desk]);
      await sql('update public.years set status = $2 where id = $1', [s.prevYearId, 'closed']);
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await expect(page.getByTestId('stock-item-row').filter({ hasText: '机(木)' }).getByTestId('stock-prev')).toHaveText('前年 8');
      await expect(page.getByTestId('stock-item-row').filter({ hasText: '椅子(木)' }).getByTestId('stock-prev')).toHaveText('前年 20');

      await page.setViewportSize(PC);
      await page.goto('/stocks/');
      const row = page.locator(`[data-testid="stock-matrix-row"][data-room-id="${roomA}"]`);
      await expect(row.locator(`td[data-item-id="${desk}"]`)).toHaveText('10（+2）');
      await expect(row.locator(`td[data-item-id="${chair}"]`)).toHaveText('20（±0）');
      // 合計（使用不可を除く）：机(木) は 倉庫A 10 ＋ 倉庫B 10 ＝ 20、前年は 8 ＋ 10 ＝ 18
      await expect(page.getByTestId('stock-total-usable').locator(`td[data-item-id="${desk}"]`)).toHaveText('20（+2）');
      // 部屋の名前から在庫入力へ
      await row.getByRole('link', { name: SMALL.rooms.storageA }).click();
      await expect(page).toHaveURL((u) => u.pathname === '/stock/' && u.searchParams.get('room') === roomA);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 前年の数を読めないとき：失敗を出し、読み直せる（前年がないのと見分ける）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, prevYear: { dataset: 'small' } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.route('**/rest/v1/rpc/previous_year_stocks*', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'boom', details: '', hint: '' }) }),
      );
      await page.goto(`/stock/?room=${roomA}`);
      const err = page.getByTestId('stock-prev-error');
      await expect(err).toContainText('前年の数を読み込めませんでした');
      await expect(page.getByTestId('stock-prev')).toHaveCount(0);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await err.getByRole('button', { name: '前年の数を読み直す' }).click();
      await expect(page.getByTestId('stock-item-row').filter({ hasText: '机(木)' }).getByTestId('stock-prev')).toHaveText('前年 10');
      await expect(err).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 下書き：入力の途中で別の画面へ移って戻ると、下書きから戻せる', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(PC);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      await plus(page, '机(木)').click();
      await expect(input(page, '机(木)')).toHaveValue('12');
      // 別の画面へ（未保存の入力の確かめ → 移る）
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '在庫一覧' }).click();
      const leave = page.getByRole('alertdialog');
      await expect(leave).toContainText('保存していない入力があります');
      await leave.getByRole('button', { name: '移る' }).click();
      await expect(page).toHaveURL((u) => u.pathname === '/stocks/');
      // 戻る（在庫一覧の部屋の名前から）
      await page.locator(`[data-testid="stock-matrix-row"][data-room-id="${roomA}"]`).getByRole('link', { name: SMALL.rooms.storageA }).click();
      const notice = page.getByTestId('draft-notice');
      await expect(notice).toContainText('保存していない入力があります');
      await waitInput(page, 10);
      await notice.getByRole('button', { name: '戻す' }).click();
      await waitInput(page, 12);
      // 戻しただけでは保存していない
      expect((await roomStocks(s.yearId, roomA)).get(s.ids.items.desk!)!.count).toBe(10);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 下書き：下書きを作った後にほかの人が保存していれば、戻して保存するときに上書きするか読み直すかを選べる', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const desk = s.ids.items.desk!;
      const chair = s.ids.items.chair!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(PC);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      await expect(input(page, '机(木)')).toHaveValue('11');
      // 別の画面へ離れる（下書きが残る）
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '在庫一覧' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '移る' }).click();
      await expect(page).toHaveURL((u) => u.pathname === '/stocks/');
      // 離れている間に、管理者がこの部屋の椅子(木)を保存した
      await sql('update public.stocks set count = 19, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
        s.yearId,
        roomA,
        SEED_USER_IDS.admin,
        chair,
      ]);
      await page.goto(`/stock/?room=${roomA}`);
      await expect(input(page, '椅子(木)')).toHaveValue('19');
      await page.getByTestId('draft-notice').getByRole('button', { name: '戻す' }).click();
      await waitInput(page, 11);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const dialog = page.getByTestId('stock-conflict-dialog');
      await expect(dialog).toContainText('テスト管理者さんが');
      await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused();
      // 読み直す：相手の数になり、保存しない（椅子(木)の 19 は残る）
      await dialog.getByRole('button', { name: '読み直す' }).click();
      await waitInput(page, 10);
      await expect(input(page, '椅子(木)')).toHaveValue('19');
      const after = await roomStocks(s.yearId, roomA);
      expect(after.get(desk)!.count).toBe(10);
      expect(after.get(chair)!.count).toBe(19);
      expect(after.get(chair)!.counted_by).toBe(SEED_USER_IDS.admin);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 読み直し：入力があるときに読み直した行がほかの人の保存なら、入力を残して知らせる（保存するときに選べる）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const desk = s.ids.items.desk!;
      const chair = s.ids.items.chair!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      // 保存の送信の間に管理者が椅子(木)を保存し、自分の送信は一意の違反（conflict）で返る → 画面が部屋の行を読み直す
      await page.route('**/rest/v1/stocks?*', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        await sql('update public.stocks set count = 19, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
          s.yearId,
          roomA,
          SEED_USER_IDS.admin,
          chair,
        ]);
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'duplicate key', details: '', hint: '' }) });
      });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const notice = page.getByTestId('stock-remote-change');
      await expect(notice).toContainText('テスト管理者さんが');
      await expect(input(page, '机(木)')).toHaveValue('11');
      await expect(input(page, '椅子(木)')).toHaveValue('20');
      await expect(page.getByTestId('last-counted')).toContainText('テスト管理者');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // 保存すると、読み込んだ後のほかの人の保存として選ばせる
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const dialog = page.getByTestId('stock-conflict-dialog');
      await expect(dialog).toContainText('テスト管理者さんが');
      await dialog.getByRole('button', { name: '読み直す' }).click();
      await waitInput(page, 10);
      await expect(input(page, '椅子(木)')).toHaveValue('19');
      await expect(notice).toHaveCount(0);
      const after = await roomStocks(s.yearId, roomA);
      expect(after.get(desk)!.count).toBe(10);
      expect(after.get(chair)!.count).toBe(19);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 応答が届かなかった保存：知らせを出し、もう一度「保存」で読み直して、自分の保存が入っていれば「保存されていました」', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      // upsert は DB に届くが、応答はブラウザに届かない
      let upserts = 0;
      await page.route('**/rest/v1/stocks?*', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        upserts += 1;
        const res = await route.fetch();
        expect(res.ok()).toBe(true);
        await route.abort('failed');
      });
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const notice = page.getByTestId('stock-unknown-outcome');
      await expect(notice).toContainText('保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります');
      // 押せないボタン・「確かめる」は出さない。入力は残り、保存は押せる
      await expect(notice.getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
      await expect(input(page, '机(木)')).toHaveValue('11');
      expect((await roomStocks(s.yearId, roomA)).get(s.ids.items.desk!)!.count).toBe(11);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-saved')).toContainText('保存されていました');
      await expect(page.getByTestId('stock-conflict-dialog')).toHaveCount(0);
      await expect(notice).toHaveCount(0);
      expect(upserts).toBe(1);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 応答が届かなかった保存：もう一度「保存」の読み直しも通信できなければ送らずに知らせ、通信が戻って押すと「保存されていました」', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      // upsert は DB に届くが、応答はブラウザに届かない。その後は部屋の行の読み込みも通信できない（offline で切る）
      let upserts = 0;
      let offline = false;
      await page.route('**/rest/v1/stocks?*', async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          upserts += 1;
          const res = await route.fetch();
          expect(res.ok()).toBe(true);
          offline = true;
          return route.abort('failed');
        }
        if (offline && req.url().includes('room_id=')) return route.abort('failed');
        return route.fallback();
      });
      const save = page.getByRole('button', { name: '保存', exact: true });
      await save.click();
      await confirmNotLatest(page);
      const notice = page.getByTestId('stock-unknown-outcome');
      await expect(notice).toBeVisible();
      await save.click();
      await confirmNotLatest(page);
      // postgrest-js は通信の失敗した GET を 1・2・4 秒あけて3回送り直すので、読み直しが諦めるまで約7秒かかる
      await expect(save).toBeEnabled({ timeout: 20_000 });
      await expect(notice).toContainText('保存できたか分かりません');
      await expect(input(page, '机(木)')).toHaveValue('11');
      expect(upserts).toBe(1);
      // 通信が戻った → もう一度「保存」で読み直し、自分の保存が入っているので送らない
      offline = false;
      await save.click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-saved')).toContainText('保存されていました');
      await expect(notice).toHaveCount(0);
      expect(upserts).toBe(1);
      expect((await roomStocks(s.yearId, roomA)).get(s.ids.items.desk!)!.count).toBe(11);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 応答が届かなかった保存：その後にほかの人が保存していれば、もう一度「保存」で上書きするか読み直すかを選べる', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true, admin: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      const desk = s.ids.items.desk!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await plus(page, '机(木)').click();
      // 1回目の upsert は DB に届かずに切れる
      let upserts = 0;
      await page.route('**/rest/v1/stocks?*', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        upserts += 1;
        if (upserts === 1) return route.abort('failed');
        return route.fallback();
      });
      const save = page.getByRole('button', { name: '保存', exact: true });
      await save.click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-unknown-outcome')).toBeVisible();
      // その間に、管理者が別の端末で保存した
      await sql('update public.stocks set count = 7, counted_by = $3, counted_at = now() where year_id = $1 and room_id = $2 and item_id = $4', [
        s.yearId,
        roomA,
        SEED_USER_IDS.admin,
        desk,
      ]);
      await save.click();
      await confirmNotLatest(page);
      // 黙って上書きせず、ほかの人の保存のダイアログで選ばせる
      const dialog = page.getByTestId('stock-conflict-dialog');
      await expect(dialog).toContainText('テスト管理者さんが');
      await expect(dialog.getByTestId('conflict-row').filter({ hasText: '机(木)' })).toContainText('711');
      expect(upserts).toBe(1);
      // やめても入力はほかの人の数に置き換わらない
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toBeHidden();
      await expect(input(page, '机(木)')).toHaveValue('11');
      // 「保存」でもう一度選ばせる → 上書きする
      await save.click();
      await confirmNotLatest(page);
      await dialog.getByRole('button', { name: '上書きする' }).click();
      await expect(page.getByTestId('stock-saved')).toContainText('保存しました');
      expect(upserts).toBe(2);
      const after = await roomStocks(s.yearId, roomA);
      expect(after.get(desk)!.count).toBe(11);
      expect(after.get(desk)!.counted_by).toBe(SEED_USER_IDS.staff);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 最新でない年度：最新の年度に切り替えるボタンを出し、保存の前に確かめる（やめれば保存しない）', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await expect(page.getByTestId('latest-year-switch')).toContainText('最新の年度（R8）に切り替える');
      await plus(page, '机(木)').click();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`最新でない年度（${s.label}・申請受付中）に保存します。よろしいですか`);
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toHaveCount(0);
      expect((await roomStocks(s.yearId, roomA)).get(s.ids.items.desk!)!.count).toBe(10);
      await expect(input(page, '机(木)')).toHaveValue('11');
    } finally {
      await s.cleanup();
    }
  });

  test('T10 振り分け中：部員には読み取り専用（入力できず保存のボタンがない）', async ({ page }) => {
    const s = await createScenario({ status: 'allocating', roles: { staff: true } });
    try {
      const roomA = s.ids.rooms[SMALL.rooms.storageA]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomA}`);
      await waitInput(page, 10);
      await expect(page.getByTestId('read-only-notice')).toHaveText('振り分けが始まったので、在庫は総務管理者だけが直せます');
      await expect(input(page, '机(木)')).toBeDisabled();
      await expect(plus(page, '机(木)')).toBeDisabled();
      await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 使用不可の部屋：在庫入力に「今年は使用不可」、場所の一覧と在庫一覧に印', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true }, usable: { [SMALL.rooms.storageB]: false } });
    try {
      const roomB = s.ids.rooms[SMALL.rooms.storageB]!;
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${roomB}`);
      await waitInput(page, 10);
      await expect(page.getByTestId('unusable-notice')).toContainText('今年は使用不可');
      await expect(page.getByTestId('unusable-notice')).toContainText('E2E：データセットで使用不可');
      // 数えることはできる
      await expect(input(page, '机(木)')).toBeEnabled();

      await page.goto('/stock/');
      await page.getByPlaceholder('場所の名前で絞る').fill('E2E倉庫');
      const rows = page.getByTestId('stock-room-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: SMALL.rooms.storageB }).getByTestId('unusable-badge')).toBeVisible();
      await expect(rows.filter({ hasText: SMALL.rooms.storageA }).getByTestId('unusable-badge')).toHaveCount(0);
      await expect(rows.filter({ hasText: SMALL.rooms.storageA }).getByTestId('counted-label')).toContainText('数えた');

      await page.setViewportSize(PC);
      await page.goto('/stocks/');
      const row = page.locator(`[data-testid="stock-matrix-row"][data-room-id="${roomB}"]`);
      await expect(row).toHaveAttribute('data-usable', 'false');
      await expect(row.getByTestId('unusable-badge')).toBeVisible();
      // 合計（使用不可を除く）は 倉庫A だけ、全部は 倉庫A＋倉庫B（机(木) 10＋10）
      const desk = s.ids.items.desk!;
      await expect(page.getByTestId('stock-total-usable').locator(`td[data-item-id="${desk}"]`)).toHaveText('10');
      await expect(page.getByTestId('stock-total-all').locator(`td[data-item-id="${desk}"]`)).toHaveText('20');
    } finally {
      await s.cleanup();
    }
  });

  test('T10 場所の一覧と、見つからない場所', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', roles: { staff: true } });
    try {
      await pinYear(page, SEED_USER_IDS.staff, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto('/stock/');
      await page.getByPlaceholder('場所の名前で絞る').fill('E2E');
      await expect(page.getByTestId('stock-room-row')).toHaveCount(3);
      await page.getByTestId('stock-room-row').filter({ hasText: SMALL.rooms.storageA }).getByRole('link').click();
      await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageA);

      for (const room of ['00000000-0000-4000-8000-00000000dead', 'not-a-uuid', s.ids.rooms[SMALL.rooms.class1]!]) {
        await page.goto(`/stock/?room=${room}`);
        await expect(page.getByText('この場所は見つかりません')).toBeVisible();
        await expect(page.getByRole('link', { name: '保管場所の一覧へ' })).toBeVisible();
      }
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T10 管理者', () => {
  test.use({ storageState: storageStateFor('admin') });

  /** 振り分けの行が最も多い運び元と品目（合成データの reference） */
  async function busiest(yearId: string) {
    const [r] = await sql<{ room_id: string; room: string; item: string; allocated: number; stock: number }>(
      `select a.source_room_id as room_id, r.name as room, i.name as item, sum(a.count)::int as allocated, s.count as stock
       from public.allocations a join public.rooms r on r.id = a.source_room_id join public.items i on i.id = a.item_id
       join public.stocks s on s.year_id = a.year_id and s.room_id = a.source_room_id and s.item_id = a.item_id
       where a.year_id = $1 and r.is_storage group by 1, 2, 3, s.count order by 4 desc, 2, 3 limit 1`,
      [yearId],
    );
    if (!r) throw new Error('振り分けの行がありません');
    return r;
  }

  test('T10 確定中：管理者が振り分けの合計より少なくしようとすると、保存の前に止まる', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'confirmed', allocations: 'reference', roles: { admin: true } });
    try {
      const b = await busiest(s.yearId);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${b.room_id}`);
      await expect(input(page, b.item)).toHaveValue(String(b.stock));
      const row = page.getByTestId('stock-item-row').filter({ has: page.getByText(b.item, { exact: true }) });
      await expect(row.getByTestId('stock-allocated')).toHaveText(`振り分け ${b.allocated}台`);
      await input(page, b.item).fill(String(b.allocated - 1));
      await input(page, b.item).press('Enter');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      await expect(page.getByTestId('stock-shortfall-blocked')).toContainText('確定中は振り分けの合計より少なくできません');
      await expect(page.getByTestId('stock-shortfall-blocked')).toContainText(`${b.item}：入力 ${b.allocated - 1}、振り分けの合計 ${b.allocated}台`);
      const [after] = await sql<{ count: number }>(
        'select s.count from public.stocks s join public.items i on i.id = s.item_id where s.year_id = $1 and s.room_id = $2 and i.name = $3',
        [s.yearId, b.room_id, b.item],
      );
      expect(after!.count).toBe(b.stock);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 振り分け中：管理者は書けるが、振り分けの合計より少なくなるときは保存の前に確かめる', async ({ page }) => {
    const s = await createScenario({ dataset: 'synthetic', status: 'allocating', allocations: 'reference', roles: { admin: true } });
    try {
      const b = await busiest(s.yearId);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.setViewportSize(MOBILE);
      await page.goto(`/stock/?room=${b.room_id}`);
      await expect(input(page, b.item)).toHaveValue(String(b.stock));
      await input(page, b.item).fill(String(b.allocated - 1));
      await input(page, b.item).press('Enter');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await confirmNotLatest(page);
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('保存すると振り分けに在庫超過（E001）が出ます。振り分け画面で直してください');
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await expect(dialog).toHaveCount(0);
      const [after] = await sql<{ count: number }>(
        'select s.count from public.stocks s join public.items i on i.id = s.item_id where s.year_id = $1 and s.room_id = $2 and i.name = $3',
        [s.yearId, b.room_id, b.item],
      );
      expect(after!.count).toBe(b.stock);
    } finally {
      await s.cleanup();
    }
  });

  test('T10 QR のページ：保管場所ごとにカードがあり、URL は /stock/?room=<id>（年度を入れない）', async ({ page }) => {
    const storage = readGlobalRooms().filter((r) => r.isStorage);
    await page.setViewportSize(PC);
    await page.goto('/stocks/qr/');
    const cards = page.getByTestId('qr-card');
    await expect(cards).toHaveCount(storage.length);
    const origin = new URL(page.url()).origin;
    const urls = await page.getByTestId('qr-url').allTextContents();
    expect(new Set(urls)).toEqual(new Set(storage.map((r) => `${origin}/stock/?room=${r.id}`)));
    await expect(cards.first().locator('svg')).toBeVisible();

    // ?rooms= で絞る（形の違うものは無視）
    const a = storage.find((r) => r.name === SMALL.rooms.storageA)!;
    const b = storage.find((r) => r.name === SMALL.rooms.storageB)!;
    await page.goto(`/stocks/qr/?rooms=${b.id},x,${a.id}`);
    await expect(cards).toHaveCount(2);
    expect(await page.getByTestId('qr-url').allTextContents()).toEqual(
      [a, b].sort((x, y) => x.sortOrder - y.sortOrder).map((r) => `${origin}/stock/?room=${r.id}`),
    );
    // カードの URL を開くと、その部屋の在庫入力（ログイン済みなら最新の年度で開く）
    await page.goto(`/stock/?room=${a.id}`);
    await expect(page.getByTestId('stock-room-name')).toHaveText(SMALL.rooms.storageA);
  });
});

test.describe('T10 権限', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T10 団体代表は在庫入力・在庫一覧・QR を開けない', async ({ page }) => {
    for (const path of ['/stock/', '/stocks/', '/stocks/qr/']) {
      await page.goto(path);
      await expect(page.getByRole('alert').filter({ hasText: '権限がありません' })).toBeVisible();
    }
  });
});
