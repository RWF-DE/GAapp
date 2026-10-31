// お知らせ（T17。D-53）の E2E とスクリーンショットが使う補助：お知らせと宛先の団体を SQL で入れる、一覧とダッシュボードの欄を
// 開いて読み終わるのを待つ、1件を題名で探す。e2e/t17-notices.spec.ts と e2e/shots/T17.shots.ts。
// SQL はシナリオの年度のお知らせ（notices・notice_groups）にだけ書く（年度をまたぐ表には書かない。D-36）。書いた人（created_by）は
// 入れた値のまま残る（auth.uid() のない書き込みでは、set_actor のトリガーが入れた値を変えない。D-10）。
// 期待値の文言は画面の仕様（04「お知らせ一覧」）のとおりに書く（アプリの定数から引かない）。
import { expect, type Locator, type Page } from '@playwright/test';
import { sql, withTx } from './db';

/** お知らせの宛先（notice_audience。02 の列挙の並び） */
export type NoticeAudience = 'soumu' | 'all_groups' | 'groups';

export interface NoticeInput {
  audience: NoticeAudience;
  title: string;
  body?: string | null;
  pinned?: boolean;
  /** 書いた人の user_id（null は、アカウントが消えた・アプリの外で入れたお知らせ） */
  createdBy: string | null;
  /** 宛先の団体の id（audience が groups のときだけ） */
  groupIds?: readonly string[];
}

/**
 * お知らせを1件ずつ入れ、id を入れた順に返す（渡した配列と同じ長さの組。分割代入で受け取れる）。1件ごとに別のトランザクションなので、
 * 出した日時（created_at。DB の now()）は入れた順に新しくなる（並びはピン留め → 出した日時の新しい順なので、古いものから入れる）。
 *
 * @example
 * const [soumu, all] = await insertNotices(s.yearId, [
 *   { audience: 'soumu', title: 'E2E 総務内', createdBy: SEED_USER_IDS.staff },
 *   { audience: 'all_groups', title: 'E2E 全団体', pinned: true, createdBy: SEED_USER_IDS.head },
 * ]);
 */
export async function insertNotices<const T extends readonly NoticeInput[]>(
  yearId: string,
  notices: T,
): Promise<{ -readonly [K in keyof T]: string }> {
  const ids: string[] = [];
  for (const n of notices) {
    if (n.audience !== 'groups' && (n.groupIds?.length ?? 0) > 0) throw new Error(`宛先の団体は指定の団体あてにだけ付けられます：${n.title}`);
    const id = await withTx(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into public.notices (year_id, audience, title, body, pinned, created_by, updated_by)
         values ($1, $2::public.notice_audience, $3, $4, $5, $6, $6) returning id`,
        [yearId, n.audience, n.title, n.body ?? null, n.pinned ?? false, n.createdBy],
      );
      const nid = r.rows[0]!.id;
      for (const g of n.groupIds ?? []) {
        await c.query('insert into public.notice_groups (notice_id, year_id, group_id) values ($1, $2, $3)', [nid, yearId, g]);
      }
      return nid;
    });
    ids.push(id);
  }
  return ids as { -readonly [K in keyof T]: string };
}

/**
 * 出した日時と直した日時を、今から何分前かで決め直す（スクリーンショットで日時をばらけさせるため。shots のプロジェクトでだけ使う）。
 * 日時のトリガー（set_timestamps）は created_at・updated_at を DB の now() にするので、同じトランザクションの中でだけトリガーを止めて
 * 書き、すぐに戻す（表のロックを取るので、ほかのセッションの読み書きはその間だけ待つ。並行の E2E では使わない）。
 */
export async function backdateNotices(rows: readonly { id: string; createdMinutesAgo: number; updatedMinutesAgo?: number }[]): Promise<void> {
  await withTx(async (c) => {
    await c.query('alter table public.notices disable trigger set_timestamps');
    for (const r of rows) {
      await c.query(
        `update public.notices
            set created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $3)
          where id = $1`,
        [r.id, r.createdMinutesAgo, r.updatedMinutesAgo ?? r.createdMinutesAgo],
      );
    }
    await c.query('alter table public.notices enable trigger set_timestamps');
  });
}

/** DB のお知らせの行（題名・本文・宛先・ピン留め・書いた人・直した人。宛先の団体は id の順） */
export interface NoticeDbRow {
  id: string;
  audience: NoticeAudience;
  title: string;
  body: string | null;
  pinned: boolean;
  created_by: string | null;
  updated_by: string | null;
  group_ids: string[];
}

/** そのシナリオの年度のお知らせ（出した日時の順）。宛先の団体は id の順 */
export async function noticesOf(yearId: string): Promise<NoticeDbRow[]> {
  return sql<NoticeDbRow>(
    `select n.id, n.audience::text as audience, n.title, n.body, n.pinned, n.created_by, n.updated_by,
            coalesce(array(select ng.group_id::text from public.notice_groups ng where ng.notice_id = n.id order by ng.group_id), '{}') as group_ids
       from public.notices n where n.year_id = $1 order by n.created_at, n.id`,
    [yearId],
  );
}

/** 出した日時の表示（一覧の notice-time。Asia/Tokyo の `YYYY/MM/DD HH:mm`）を DB で作る */
export async function noticeTimeLabel(id: string, column: 'created_at' | 'updated_at' = 'created_at'): Promise<string> {
  const [r] = await sql<{ t: string }>(
    `select to_char(${column === 'created_at' ? 'created_at' : 'updated_at'} at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI') as t
       from public.notices where id = $1`,
    [id],
  );
  if (!r) throw new Error(`お知らせ ${id} がありません`);
  return r.t;
}

// ---------------------------------------------------------------- 画面

/** 一覧の1件（data-id） */
export const noticeItem = (page: Page, id: string): Locator => page.locator(`[data-testid="notice-item"][data-id="${id}"]`);

/** 一覧の1件（題名で。題名は h3） */
export const noticeItemByTitle = (page: Page, title: string): Locator =>
  page.getByTestId('notice-item').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

/** 一覧のお知らせの id（出ている順） */
export function noticeIds(page: Page): Promise<string[]> {
  return page.getByTestId('notice-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/**
 * お知らせ一覧（/notices/）を開き、読み終わるのを待つ（h1「お知らせ一覧」と、一覧か空の表示）。query は `?audience=…` など。
 * 年度は呼ぶ前に pinYear で決める。
 */
export async function openNotices(page: Page, query = ''): Promise<void> {
  await page.goto(`/notices/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'お知らせ一覧' })).toBeVisible();
  await expect(page.getByTestId('notices-list').or(page.getByTestId('notices-empty'))).toBeVisible();
}

/** ダッシュボードの欄の1件（data-id） */
export const portalNotice = (widget: Locator, id: string): Locator => widget.locator(`[data-testid="portal-notice"][data-id="${id}"]`);

/** ダッシュボードの欄のお知らせの id（出ている順） */
export function portalNoticeIds(widget: Locator): Promise<string[]> {
  return widget.getByTestId('portal-notice').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/**
 * ダッシュボード（/）を開き、欄の読み込みが終わるのを待つ（h1 は総務に「ダッシュボード」、閲覧のみ・店長・副店長に「ホーム」）。
 * 欄は年度の行がそろうと同じ描画で読み込み中（portal-loading）を出すので、締切と予定の欄が見えた後に読み込み中が消えれば終わり
 * （e2e/t16-portal.spec.ts の openPortal と同じ）。
 */
export async function openPortal(page: Page, h1: 'ダッシュボード' | 'ホーム'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
  await expect(page.getByTestId('portal-dated')).toBeVisible();
  await expect(page.getByTestId('portal-loading')).toHaveCount(0);
  await expect(page.getByTestId('rep-home-loading')).toHaveCount(0);
}
