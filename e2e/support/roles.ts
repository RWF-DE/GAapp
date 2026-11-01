// ロールの段の画面（T15b。D-50）の E2E とスクリーンショットが使う補助。e2e/t15b-roles.spec.ts と e2e/shots/T15b.shots.ts。
// 期待値の文言は画面の仕様（04「共通レイアウト」「マスタ設定」のユーザー）のとおりに書く（アプリの定数から引かない。表示名を
// うっかり変えたら落ちるように）。
import { expect, type Page } from '@playwright/test';
import type { TestUser } from './db';

/**
 * 部門長以上（管理者・総務部門長・総務副部門長）のナビ（lib/navigation.ts の ROUTES のうち LEAD と SOUMU の画面と、招待されている
 * 全員のお知らせ一覧〔T17〕と締切と予定〔T18〕と、総務のシフト・作業〔T20〕）。見出し（ホーム／机椅子／お知らせ／締切と予定／シフト・作業／共通。
 * T16・T17・T18・T20）の順で、平らに並べたもの
 */
export const LEAD_NAV = [
  'ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', 'お知らせ一覧', '締切と予定の一覧', '自分のシフト', 'シフト表', '作業一覧', 'マスタ設定', '履歴',
];

/** 総務部門長・総務副部門長のマスタ設定のタブ（年度・場所・ユーザーだけ） */
export const LEAD_SETTINGS_TABS = ['年度', '場所', 'ユーザー'];

/** 招待の立場：管理者は7つ、総務部門長・総務副部門長は3つ（04「マスタ設定」のユーザー） */
export const ADMIN_INVITE_KINDS = ['管理者', '総務部門長', '総務副部門長', '総務部門員', '閲覧のみ', '店長', '副店長'];
export const LEAD_INVITE_KINDS = ['総務部門員', '店長', '副店長'];

/** 兼任の禁止（role_overlap。D-49）の文言（04 のエラーの一覧） */
export const ROLE_OVERLAP_MESSAGE =
  '総務の部門員・部門長・副部門長は、同じ年度の団体の店長・副店長を兼ねられません（管理者と閲覧のみは兼ねられます）';

/** 使い捨てのユーザーで画面からログインする（storageState を使わない。立場を読み終えるまで待つ） */
export async function loginWith(page: Page, u: Pick<TestUser, 'email' | 'password'>): Promise<void> {
  await page.goto('/login/');
  const form = page.getByTestId('test-login-form');
  await form.getByLabel('メールアドレス').fill(u.email);
  await form.getByLabel('パスワード').fill(u.password);
  await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
  await expect(page.getByTestId('current-year')).toBeVisible();
}

/** マスタ設定のタブの名前（出ている順） */
export async function settingsTabLabels(page: Page): Promise<string[]> {
  const list = page.getByRole('tablist', { name: 'マスタ設定の項目' });
  await expect(list).toBeVisible();
  return (await list.getByRole('tab').allInnerTexts()).map((t) => t.trim());
}

/** 招待のフォームの「立場」の選択肢（表示名。出ている順） */
export async function inviteKindLabels(page: Page): Promise<string[]> {
  const select = page.getByTestId('invite-form').getByLabel('立場');
  await expect(select).toBeVisible();
  return (await select.locator('option').allTextContents()).map((t) => t.trim());
}

/** 招待のフォームの「団体」（EntitySelect。店長・副店長を選んだときだけ出る）で団体を選び、ポップオーバーが閉じきるまで待つ */
export async function pickInviteGroup(page: Page, name: string): Promise<void> {
  const box = page.getByTestId('invite-form').getByRole('combobox', { name: '団体', exact: true });
  await box.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(box).toHaveText(name);
  await expect(page.locator('[cmdk-root]')).toHaveCount(0);
}

/** 表示名のセルでメンバーの表の行を探す（招待の表の行と取り違えない） */
export function memberRow(page: Page, displayName: string) {
  return page
    .getByRole('table', { name: 'メンバー' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: displayName, exact: true }) });
}

/** メールで招待の表の行を探す */
export function invitationRow(page: Page, email: string) {
  return page
    .getByRole('table', { name: '招待' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: email, exact: true }) });
}

/**
 * 招待のフォームを送り、invite の応答（PostgREST の本文）を返す。同じ文言の誤りが続くとき（兼任の禁止を2回）に、
 * 前の誤りの表示を見ていないことを応答で確かめるため。
 */
export async function submitInvite(page: Page): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/rest/v1/rpc/invite') && r.request().method() === 'POST');
  await page.getByTestId('invite-form').getByRole('button', { name: '招待する' }).click();
  const r = await res;
  const text = await r.text();
  return { status: r.status(), body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}
