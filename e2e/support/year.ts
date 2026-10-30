// 開く年度を決める（画面の設計 1.3.1・7.2。T09a）。
// 選んだ年度はタブごとの sessionStorage の `gaapp:year:<user_id>`（apps/web/lib/auth/selected-year.ts）にある。
// pinYear はそのページ（タブ）の読み込みのたびに値を入れるので、同じページの再読み込みでもその年度で開く。
// 新しいページ（タブ）には入らない（新しいタブは最新の年度で開く）。
import type { Page } from '@playwright/test';

/** apps/web/lib/auth/selected-year.ts の SELECTED_YEAR_PREFIX と同じ */
export const SELECTED_YEAR_PREFIX = 'gaapp:year:';

/**
 * このページで、その利用者が開く年度を固定する（goto の前に呼ぶ）。
 *
 * @example
 * const s = await createScenario({ roles: { staff: true } });
 * await pinYear(page, SEED_USER_IDS.staff, s.yearId);
 * await page.goto('/stocks/');
 */
export async function pinYear(page: Page, userId: string, yearId: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        globalThis.sessionStorage.setItem(key, value);
      } catch {
        // sessionStorage が使えなければ何もしない（既定の年度で開く）
      }
    },
    [`${SELECTED_YEAR_PREFIX}${userId}`, yearId] as const,
  );
}
