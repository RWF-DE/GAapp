// T11 Googleフォームの回答の取り込み（申請一覧から。画面の設計 5.2）の E2E。シナリオの年度（small＋模擬店甲・乙・丙）で閉じる。
// 合成データ r8like の年度では取り込まない（需要が変わってほかのテストの前提を崩すため）。
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { storageStateFor } from './support/auth';
import { createScenario, sql } from './support/db';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

const STALL_CSV = fileURLToPath(new URL('../fixtures/importer-samples/stall.csv', import.meta.url));
/** 画面に出てはいけない、メールアドレスの形の文字列 */
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

async function countsOf(groupId: string): Promise<Record<string, number>> {
  const rows = await sql<{ code: string; count: number }>(
    'select i.code, r.count from public.requests r join public.items i on i.id = r.item_id where r.group_id = $1 and r.count > 0',
    [groupId],
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.count]));
}

async function submittedAtOf(groupId: string): Promise<string | null> {
  const rows = await sql<{ at: string | null }>(
    "select to_char(submitted_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') as at from public.request_submissions where group_id = $1",
    [groupId],
  );
  return rows[0]?.at ?? null;
}

test.describe('T11 取り込み（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T11 取り込み：stall.csv の対応しない行を手で選んで取り込むと、requests と提出日時（フォームのタイムスタンプ）が入る', async ({ page }) => {
    const s = await createScenario({
      roles: { admin: true },
      extraGroups: [
        { name: '模擬店甲', category: 'stall' },
        { name: '模擬店乙', category: 'stall' },
        { name: '模擬店丙', category: 'stall' },
      ],
    });
    try {
      const kou = s.ids.groups['模擬店甲']!;
      const otsu = s.ids.groups['模擬店乙']!;
      const hei = s.ids.groups['模擬店丙']!;
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await page.getByRole('button', { name: 'Googleフォームの回答を取り込む' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('CSV ファイル').setInputFiles(STALL_CSV);

      await expect(dialog.getByTestId('import-counts')).toContainText('回答 5・対応した 3・対応しない 2・取り込まない 4');
      await expect(dialog.getByTestId('unmatched-row-8')).toContainText('存在しない団体');
      await expect(dialog.getByTestId('unmatched-row-9')).toContainText('（なし）');
      await expect(dialog.getByTestId('import-superseded')).toContainText('模擬店甲：行4（2026/10/06 09:00）を使い、行2（2026/10/05 18:01）は使いません');
      for (const t of ['行5：列のずれ', '行6：数が読めない', '行7：列のずれ', '行10：空の行']) {
        await expect(dialog.getByTestId('import-rejected')).toContainText(t);
      }
      expect(await page.content()).not.toMatch(EMAIL);

      // 対応しない行（存在しない団体）を手で模擬店丙に対応させる
      await dialog.getByRole('combobox', { name: '行8の団体' }).click();
      await page.getByRole('option', { name: '模擬店丙', exact: true }).click();
      await expect(dialog.getByTestId('import-counts')).toContainText('対応した 4・対応しない 1');
      await expect(dialog.getByTestId('plan-模擬店丙')).toBeVisible();
      expect(await page.content()).not.toMatch(EMAIL);

      await dialog.getByRole('button', { name: '取り込む（3 団体）' }).click();
      await expect(dialog.getByTestId('import-results')).toContainText('模擬店丙：取り込みました');
      await expect(dialog.getByTestId('import-results')).not.toContainText('取り込めません');

      expect(await countsOf(kou)).toEqual({ desk: 6, chair: 10, blue_chair: 2, long_desk_2: 1 });
      expect(await countsOf(otsu)).toEqual({ desk: 2, chair: 4, caster_desk: 1 });
      expect(await countsOf(hei)).toEqual({ desk: 1, chair: 1 });
      expect(await submittedAtOf(kou)).toBe('2026-10-06 09:00:00');
      expect(await submittedAtOf(otsu)).toBe('2026-10-05 19:30:00');
      expect(await submittedAtOf(hei)).toBe('2026-10-06 11:00:00');
      const notes = await sql<{ note: string | null }>('select note from public.request_submissions where group_id = $1', [kou]);
      expect(notes[0]!.note).toContain('人数が増えました');
      expect(notes[0]!.note).not.toMatch(EMAIL);
      const logs = await sql<{ reason: string | null }>(
        "select distinct reason from public.audit_logs where table_name = 'requests' and group_id = $1 and year_id = $2",
        [hei, s.yearId],
      );
      expect(logs.map((l) => l.reason)).toEqual(['Googleフォームの回答の取り込み（模擬店）']);

      // 閉じると申請一覧が読み直されている
      await dialog.getByRole('button', { name: '閉じる' }).first().click();
      await expect(page.getByRole('textbox', { name: '模擬店丙の机(木)', exact: true })).toHaveValue('1');
    } finally {
      await s.cleanup();
    }
  });

  test('T11 取り込み：アプリの提出の方が新しい団体は既定で上書きしない', async ({ page }) => {
    const s = await createScenario({
      roles: { admin: true },
      extraGroups: [
        { name: '模擬店甲', category: 'stall' },
        { name: '模擬店乙', category: 'stall' },
      ],
    });
    try {
      const kou = s.ids.groups['模擬店甲']!;
      // 模擬店甲はフォームの回答（10/06 09:00）より後にアプリで提出した
      await sql(
        "insert into public.requests (group_id, item_id, count) select $1, id, 9 from public.items where code = 'desk'",
        [kou],
      );
      await sql("insert into public.request_submissions (group_id, submitted_at) values ($1, now())", [kou]);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/requests/');
      await page.getByRole('button', { name: 'Googleフォームの回答を取り込む' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('CSV ファイル').setInputFiles(STALL_CSV);
      await expect(dialog.getByTestId('plan-模擬店甲')).toContainText('アプリの提出の方が新しい');
      await expect(dialog.getByRole('checkbox', { name: '模擬店甲を上書きする' })).not.toBeChecked();
      await dialog.getByRole('button', { name: '取り込む（1 団体）' }).click();
      await expect(dialog.getByTestId('import-results')).toContainText('模擬店乙：取り込みました');
      expect(await countsOf(kou)).toEqual({ desk: 9 });
    } finally {
      await s.cleanup();
    }
  });
});
