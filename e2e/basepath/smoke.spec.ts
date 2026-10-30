// basePath（/GAapp）で書き出したもののスモーク（画面の設計 7.2「basePath のスモーク」。T14）。
// E2E の本体は basePath なしで流れるので、本番の basePath で壊れやすいもの（Worker のチャンクと locateFile の wasm の URL、
// QR の絶対 URL、マニフェスト・アイコン、末尾のスラッシュ）をここで一度通す。
// 流し方：pnpm build:e2e -- --base-path /GAapp → pnpm e2e:basepath（E2E_BASEPATH=1。ポートは E2E_BASEPATH_PORT、既定 3101）。
// ログインは basePath の下のテスト用ログイン（storageState は E2E_PORT の origin のものなので使えない）。シナリオの年度で閉じる。
import { expect, test, type Page, type Response } from '@playwright/test';
import { loginAs } from '../helpers';
import { createScenario } from '../support/db';
import { readGlobalRooms } from '../support/global-rooms';
import { PC } from '../support/shots';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

const BP = '/GAapp';

/** アプリの origin（静的サーバー）へのリクエストで 400 以上・失敗になったもの（Supabase の API は数えない） */
function watchFailures(page: Page, origin: string): string[] {
  const failures: string[] = [];
  page.on('response', (r: Response) => {
    const u = new URL(r.url());
    if (u.origin === origin && r.status() >= 400) failures.push(`${r.status()} ${u.pathname}${u.search}`);
  });
  // 移動で打ち切られた先読み（Next のリンクの prefetch。net::ERR_ABORTED）は数えない
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    const why = r.failure()?.errorText ?? '';
    if (u.origin === origin && !why.includes('ERR_ABORTED')) failures.push(`${why} ${u.pathname}${u.search}`);
  });
  return failures;
}

test.describe('T14 basePath（/GAapp）のスモーク', () => {
  test('T14 basePath：ログイン → 振り分けで計算エンジンの読み込み（/GAapp/highs.wasm が 200）→ QR の URL → マニフェストとアイコン', async ({ page, request }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!;
    const s = await createScenario({ dataset: 'small', status: 'allocating', roles: { admin: true } });
    try {
      await page.setViewportSize(PC);
      const failures = watchFailures(page, new URL(baseURL).origin);

      // ログイン（/GAapp/login/ のテスト用ログイン → /GAapp/ に戻る）
      await loginAs(page, 'admin', `${BP}/login/`);
      await expect(page).toHaveURL(new RegExp(`^${baseURL}${BP}/`));
      await expect(page.getByTestId('current-year')).toBeVisible();

      // 振り分け：Worker のチャンクと wasm が basePath の下から読まれ、計算エンジンの読み込みが終わる
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      const wasm = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/highs.wasm'), { timeout: 60_000 });
      await page.goto(`${BP}/allocation/`);
      await expect(page.getByRole('heading', { level: 1, name: '振り分け' })).toBeVisible();
      await expect(page.getByTestId('engine-state')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
      const res = await wasm;
      const wasmUrl = new URL(res.url());
      expect(wasmUrl.pathname).toBe(`${BP}/highs.wasm`);
      expect(wasmUrl.search).toMatch(/^\?v=/);
      expect(res.status()).toBe(200);
      testInfo.annotations.push({ type: 'highs.wasm', description: `${wasmUrl.pathname}${wasmUrl.search} → ${res.status()}` });
      await expect(page.getByRole('button', { name: '自動振り分け', exact: true })).toBeEnabled();

      // QR：カードの URL は http://localhost:<port>/GAapp/stock/?room=<id>。開くとその部屋の在庫入力（末尾のスラッシュつき）
      const storage = readGlobalRooms().filter((r) => r.isStorage);
      await page.goto(`${BP}/stocks/qr/`);
      await expect(page.getByTestId('qr-card')).toHaveCount(storage.length);
      const urls = await page.getByTestId('qr-url').allTextContents();
      for (const u of urls) expect(u.startsWith(`${baseURL}${BP}/stock/?room=`)).toBe(true);
      expect(new Set(urls)).toEqual(new Set(storage.map((r) => `${baseURL}${BP}/stock/?room=${r.id}`)));
      await page.goto(urls[0]!);
      await expect(page.getByTestId('stock-room-name')).toHaveText(storage.find((r) => urls[0]!.endsWith(r.id))!.name);

      // マニフェストとアイコン：<link> の href に basePath が付き、どれも 200。マニフェストの中の URL にも basePath
      await page.goto(`${BP}/`);
      const href = async (sel: string) => (await page.locator(sel).first().getAttribute('href'))!;
      const manifestHref = await href('link[rel="manifest"]');
      const iconHref = await href('link[rel="icon"][type="image/png"]');
      const appleHref = await href('link[rel="apple-touch-icon"]');
      for (const h of [manifestHref, iconHref, appleHref]) expect(h.startsWith(`${BP}/`)).toBe(true);

      const manifestRes = await request.get(`${baseURL}${manifestHref}`);
      expect(manifestRes.status()).toBe(200);
      const manifest = (await manifestRes.json()) as { display: string; start_url: string; scope: string; icons: { src: string; type: string }[] };
      expect(manifest.display).toBe('browser');
      expect(manifest.start_url).toBe(`${BP}/`);
      expect(manifest.scope).toBe(`${BP}/`);
      expect(manifest.icons.length).toBeGreaterThan(0);
      for (const src of [iconHref, appleHref, ...manifest.icons.map((i) => i.src)]) {
        expect(src.startsWith(`${BP}/`)).toBe(true);
        const r = await request.get(`${baseURL}${src}`);
        expect(r.status(), src).toBe(200);
        expect(r.headers()['content-type']).toContain('image/png');
      }
      // start_url を開くとアプリが出る（ログイン済み）
      await page.goto(manifest.start_url);
      await expect(page.getByTestId('current-year')).toBeVisible();

      expect(failures, 'アプリの静的ファイルで 400 以上・失敗したリクエスト').toEqual([]);
    } finally {
      await s.cleanup();
    }
  });
});
