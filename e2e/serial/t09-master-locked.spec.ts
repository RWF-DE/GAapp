import { expect, test } from '@playwright/test';
import { storageStateFor } from '../support/auth';
import { createScenario, SERIAL_NAMES, sql } from '../support/db';
import { SEED_USER_IDS } from '../support/users';
import { pinYear } from '../support/year';

// T09 年度をまたぐ表（場所）の更新で、応答だけが届かなかったとき（画面の設計 2.6 の (B1)・7.2）。
// rooms は全年度で共有なので、並行の chromium では書かない（serial）。場所の名前は SERIAL_NAMES.roomPrefix で始め、
// 終わったら消す（残っても db-setup の cleanupLeftovers が消す）。

test.use({ storageState: storageStateFor('admin') });

test('T09 場所の更新：応答だけが届かなくても、id で読み直して「保存されていました」で閉じ、行は1つで値は入力のとおり', async ({ page }) => {
  const name = `${SERIAL_NAMES.roomPrefix}応答なし`;
  const s = await createScenario({ dataset: 'empty', roles: { admin: true } });
  const [created] = await sql<{ id: string }>(
    `insert into public.rooms (name, kind, building, floor, is_storage, extra_cost, sort_order)
     values ($1, 'room', null, null, false, 0, 99999) returning id`,
    [name],
  );
  try {
    await pinYear(page, SEED_USER_IDS.admin, s.yearId);
    await page.goto('/settings/?tab=rooms');
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    await row.getByRole('button', { name: '編集' }).click();
    const form = page.getByTestId('room-form');

    // 場所の更新（PATCH）をサーバーには届け、応答だけを落とす（1回だけ）
    let dropped = 0;
    await page.route('**/rest/v1/rooms*', async (route) => {
      if (route.request().method() === 'PATCH' && dropped === 0) {
        dropped += 1;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await form.getByLabel('建物（任意）').fill(`  ${SERIAL_NAMES.buildingPrefix}応答なし  `);
    await form.getByLabel('追加コスト（0〜20）').fill('3');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(`「${name}」は保存されていました`)).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(dropped).toBe(1);
    await expect(row).toContainText(`${SERIAL_NAMES.buildingPrefix}応答なし`);
    expect(await sql('select name, building, extra_cost from public.rooms where name like $1', [`${name}%`])).toEqual([
      { name, building: `${SERIAL_NAMES.buildingPrefix}応答なし`, extra_cost: 3 },
    ]);
  } finally {
    await sql('delete from public.rooms where id = $1', [created!.id]);
    await s.cleanup();
  }
});
