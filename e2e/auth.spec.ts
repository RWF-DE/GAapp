import { expect, test } from '@playwright/test';
import { loginAs, navLabels } from './helpers';

// ローカルの Supabase（supabase start → supabase db reset）と、テスト用ログインを有効にしたビルドが要る（README「E2E」）。

test.describe('ロールごとの表示', () => {
  test('管理者：総務の画面がすべてメニューに出る', async ({ page }) => {
    await loginAs(page, 'admin');
    expect(await navLabels(page)).toEqual([
      'ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', 'お知らせ一覧', 'マスタ設定', '履歴',
    ]);
    await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
    await expect(page.getByTestId('home-roles')).toHaveText('管理者');
  });

  // 部門長以上（D-48・D-50。T15b）：ナビは管理者と同じ（マスタ設定の中のタブは段で分ける）
  test('総務部門長：管理者と同じ画面がメニューに出る', async ({ page }) => {
    await loginAs(page, 'head');
    expect(await navLabels(page)).toEqual([
      'ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', 'お知らせ一覧', 'マスタ設定', '履歴',
    ]);
    await expect(page.getByTestId('current-year')).toHaveText('R8・申請受付中');
    await expect(page.getByTestId('home-roles')).toHaveText('総務部門長');
  });

  // Q1（D-39。T09a）：総務部門員は振り分けをいつでも読み取り専用で開ける。お知らせ一覧（T17）は招待されている全員
  test('総務部門員：机椅子の状況・在庫・申請一覧と振り分け（閲覧）とお知らせ一覧だけ（マスタ設定・団体の画面は出ない）', async ({ page }) => {
    await loginAs(page, 'staff');
    expect(await navLabels(page)).toEqual(['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け', 'お知らせ一覧']);
    await expect(page.getByTestId('home-roles')).toHaveText('総務部門員');
  });

  test('団体代表（店長）：申請と自団体の振り分けとお知らせ一覧だけ', async ({ page }) => {
    await loginAs(page, 'rep');
    expect(await navLabels(page)).toEqual(['ホーム', '申請', '自団体の振り分け', 'お知らせ一覧']);
    await expect(page.getByTestId('home-roles')).toHaveText('テスト団体 の店長');
  });

  test('閲覧のみ：ホームとお知らせ一覧だけ', async ({ page }) => {
    await loginAs(page, 'viewer');
    expect(await navLabels(page)).toEqual(['ホーム', 'お知らせ一覧']);
    await expect(page.getByTestId('home-roles')).toHaveText('閲覧のみ');
  });

  test('未招待：「総務から招待されていません」だけが出る', async ({ page }) => {
    await loginAs(page, 'outsider');
    await expect(page.getByRole('heading', { name: '総務から招待されていません' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByTestId('current-year')).toHaveCount(0);
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page).toHaveURL(/\/login\/$/);
  });
});

test.describe('ログイン状態', () => {
  test('再読み込みしてもログインしたまま。ログアウトでログインの画面に戻る', async ({ page }) => {
    await loginAs(page, 'staff');
    await page.reload();
    expect(await navLabels(page)).toContain('在庫入力');
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page).toHaveURL(/\/login\/$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\/$/);
  });

  test('パスワードが違えばログインできない', async ({ page }) => {
    await page.goto('/login/');
    const form = page.getByTestId('test-login-form');
    await form.getByLabel('メールアドレス').fill('admin@example.test');
    await form.getByLabel('パスワード').fill('wrong-password');
    await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
    await expect(form.getByRole('alert')).toHaveText('メールアドレスかパスワードが違います。');
  });

  test('戻り先に別のサイトを指定されても、このサイトの中にとどまる', async ({ page }) => {
    await loginAs(page, 'admin', '/login/?next=//evil.example/');
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
  });

  test('ログイン後に、ログイン前に開こうとしたページへ戻る', async ({ page }) => {
    await page.goto('/?from=test');
    await expect(page).toHaveURL(/\/login\/\?next=/);
    const form = page.getByTestId('test-login-form');
    await form.getByLabel('メールアドレス').fill('admin@example.test');
    await form.getByLabel('パスワード').fill('password123');
    await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
    await expect(page).toHaveURL(/\/\?from=test$/);
  });
});

test.describe('スマホ幅', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('メニューのボタンでナビゲーションを開く', async ({ page }) => {
    await loginAs(page, 'rep');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.getByRole('button', { name: 'メニューを開く' }).click();
    expect(await navLabels(page)).toEqual(['ホーム', '申請', '自団体の振り分け', 'お知らせ一覧']);
  });
});
