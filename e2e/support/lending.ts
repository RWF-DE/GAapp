// テント等の貸し出し（T21。D-57）の E2E・スクリーンショット・4G の計測が使う補助：備品・申請・割り当て・記録・確定の印を SQL で入れる、
// DB の行を読む、3つの画面（/lending・/lending/records・/request のテント等のタブ）とダッシュボードの欄を開いて読み終わるのを待つ、
// 1件を探す。e2e/t21-lending.spec.ts・e2e/shots/T21.shots.ts・e2e/perf.spec.ts。
// SQL はシナリオの年度のテント等の5表（と、撮影・2日目の確かめで1日目）にだけ書く（年度をまたぐ表には書かない。D-36）。
// 書いた人（updated_by・confirmed_by）は入れた値のまま残る（auth.uid() のない書き込みでは、set_actor のトリガーが入れた値を変えない。
// D-10）。テント等の表は年度ごとなので、年度を消すと連鎖で消える（後片付けは createScenario の cleanup のまま）。
// 期待値の文言は画面の仕様（04「テント等の貸し出し」）のとおりに書く（アプリの定数から引かない）。
import { expect, type Locator, type Page } from '@playwright/test';
import { sql, withTx } from './db';

/** 団体の区分（group_category。02 の列挙の並び） */
export type LendingCategory = 'stall' | 'department' | 'company' | 'rest_area';

export interface LendingItemInput {
  name: string;
  /** 既定「個」（DB の既定と同じ） */
  unit?: string;
  stock: number;
  /** 申請できる区分（既定は模擬店・部門。DB の既定と同じ） */
  categories?: readonly LendingCategory[];
  /** 既定は入れた順（1 から） */
  sortOrder?: number;
}

/**
 * 貸し出す備品を入れ、id を入れた順に返す（渡した配列と同じ長さの組。分割代入で受け取れる）。
 *
 * @example
 * const [tent, weight] = await insertLendingItems(s.yearId, [
 *   { name: 'テント', unit: '張', stock: 3 },
 *   { name: '重し', stock: 20 },
 * ]);
 */
export async function insertLendingItems<const T extends readonly LendingItemInput[]>(
  yearId: string,
  items: T,
): Promise<{ -readonly [K in keyof T]: string }> {
  const ids = await withTx(async (c) => {
    const out: string[] = [];
    for (const [k, it] of items.entries()) {
      const r = await c.query<{ id: string }>(
        `insert into public.lending_items (year_id, name, unit, stock, requestable_categories, sort_order)
         values ($1, $2, $3, $4, $5::public.group_category[], $6) returning id`,
        [yearId, it.name, it.unit ?? '個', it.stock, it.categories ?? ['stall', 'department'], it.sortOrder ?? k + 1],
      );
      out.push(r.rows[0]!.id);
    }
    return out;
  });
  return ids as { -readonly [K in keyof T]: string };
}

/** 団体×備品の数（申請・割り当て）。書いた人は入れた値のまま（null は、アプリの外で入れた行） */
export interface LendingCountInput {
  groupId: string;
  itemId: string;
  count: number;
  updatedBy?: string | null;
}

async function insertCounts(table: 'lending_requests' | 'lending_assignments', yearId: string, rows: readonly LendingCountInput[]): Promise<void> {
  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `insert into public.${table} (group_id, lending_item_id, year_id, count, updated_by) values ($1, $2, $3, $4, $5)
         on conflict (group_id, lending_item_id) do update set count = excluded.count, updated_by = excluded.updated_by`,
        [r.groupId, r.itemId, yearId, r.count, r.updatedBy ?? null],
      );
    }
  });
}

/** 申請を入れる（同じ組があれば数を置き換える） */
export function insertLendingRequests(yearId: string, rows: readonly LendingCountInput[]): Promise<void> {
  return insertCounts('lending_requests', yearId, rows);
}

/** 割り当てを入れる（同じ組があれば数を置き換える。RPC を通さないので、監査の理由は入らない） */
export function insertLendingAssignments(yearId: string, rows: readonly LendingCountInput[]): Promise<void> {
  return insertCounts('lending_assignments', yearId, rows);
}

/** 受け渡し・返却の記録（返った・破損は既定 0、メモは既定なし） */
export interface LendingRecordInput {
  groupId: string;
  itemId: string;
  lent: number;
  returned?: number;
  damaged?: number;
  note?: string | null;
  updatedBy?: string | null;
}

/** 記録を入れる（同じ組があれば置き換える） */
export async function insertLendingRecords(yearId: string, rows: readonly LendingRecordInput[]): Promise<void> {
  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `insert into public.lending_records (group_id, lending_item_id, year_id, lent_count, returned_count, damaged_count, note, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (group_id, lending_item_id) do update
           set lent_count = excluded.lent_count, returned_count = excluded.returned_count, damaged_count = excluded.damaged_count,
               note = excluded.note, updated_by = excluded.updated_by`,
        [r.groupId, r.itemId, yearId, r.lent, r.returned ?? 0, r.damaged ?? 0, r.note ?? null, r.updatedBy ?? null],
      );
    }
  });
}

/** 割り当てを確定した印を入れる（確定した人は入れた値のまま。解除の後なら確定し直す） */
export async function confirmLending(yearId: string, by: string | null): Promise<void> {
  await sql(
    `insert into public.lending_years (year_id, confirmed_at, confirmed_by) values ($1, now(), $2)
     on conflict (year_id) do update set confirmed_at = now(), confirmed_by = excluded.confirmed_by`,
    [yearId, by],
  );
}

/** 1日目（Asia/Tokyo の `YYYY-MM-DD`）を変える（2日目・祭の後の確かめ。seed の利用者がロールを持つ年度では、並行の E2E で使わない） */
export async function setFestivalStart(yearId: string, date: string): Promise<void> {
  await sql('update public.years set festival_start = $2::date where id = $1', [yearId, date]);
}

// ---------------------------------------------------------------- DB の行

export interface LendingItemDbRow {
  id: string;
  name: string;
  unit: string;
  stock: number;
  requestable_categories: string[];
  sort_order: number;
}

/** その年度の備品（並び → 名前 → id） */
export function lendingItemsOf(yearId: string): Promise<LendingItemDbRow[]> {
  return sql<LendingItemDbRow>(
    `select id, name, unit, stock, requestable_categories::text[] as requestable_categories, sort_order
       from public.lending_items where year_id = $1 order by sort_order, name collate "C", id`,
    [yearId],
  );
}

export interface LendingCountDbRow {
  group_id: string;
  lending_item_id: string;
  count: number;
  updated_by: string | null;
}

/** その年度の申請（団体 → 備品の id の順） */
export function lendingRequestsOf(yearId: string): Promise<LendingCountDbRow[]> {
  return sql<LendingCountDbRow>(
    'select group_id, lending_item_id, count, updated_by from public.lending_requests where year_id = $1 order by group_id, lending_item_id',
    [yearId],
  );
}

/** その年度の割り当て（団体 → 備品の id の順） */
export function lendingAssignmentsOf(yearId: string): Promise<LendingCountDbRow[]> {
  return sql<LendingCountDbRow>(
    'select group_id, lending_item_id, count, updated_by from public.lending_assignments where year_id = $1 order by group_id, lending_item_id',
    [yearId],
  );
}

export interface LendingRecordDbRow {
  group_id: string;
  lending_item_id: string;
  lent_count: number;
  returned_count: number;
  damaged_count: number;
  note: string | null;
  updated_by: string | null;
}

/** その年度の記録（団体 → 備品の id の順） */
export function lendingRecordsOf(yearId: string): Promise<LendingRecordDbRow[]> {
  return sql<LendingRecordDbRow>(
    `select group_id, lending_item_id, lent_count, returned_count, damaged_count, note, updated_by
       from public.lending_records where year_id = $1 order by group_id, lending_item_id`,
    [yearId],
  );
}

/** 確定の印（行がなければ null） */
export async function lendingConfirmationOf(yearId: string): Promise<{ confirmed: boolean; confirmed_by: string | null } | null> {
  const [r] = await sql<{ confirmed: boolean; confirmed_by: string | null }>(
    'select confirmed_at is not null as confirmed, confirmed_by from public.lending_years where year_id = $1',
    [yearId],
  );
  return r ?? null;
}

/** 日時の短い表示（「11/1 9:05」の形。画面の formatShortDateTime と同じ。Asia/Tokyo）を DB で作る */
async function shortLabel(query: string, id: string): Promise<string> {
  const [r] = await sql<{ t: string | null }>(query, [id]);
  if (!r?.t) throw new Error(`日時がありません：${id}`);
  return r.t;
}

/** 確定した日時の表示（「割り当て：確定（11/1 09:05）」の中身） */
export function confirmedLabel(yearId: string): Promise<string> {
  return shortLabel(`select to_char(confirmed_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.lending_years where year_id = $1`, yearId);
}

/** 受付の締切の表示（「受付の締切 11/30 17:05」の中身） */
export function closeLabel(yearId: string): Promise<string> {
  return shortLabel(`select to_char(request_close_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.years where id = $1`, yearId);
}

/** テント等の5表の監査（その年度。古い順）。理由は RPC が置いたもの（直接の書き込みは null） */
export function lendingAuditOf(yearId: string, table: string): Promise<{ action: string; reason: string | null; user_id: string | null }[]> {
  return sql<{ action: string; reason: string | null; user_id: string | null }>(
    'select action, reason, user_id from public.audit_logs where year_id = $1 and table_name = $2 order by id',
    [yearId, table],
  );
}

// ---------------------------------------------------------------- 画面（/lending）

/** 備品と割り当て（/lending/）を開き、読み終わるのを待つ（h1 と上の欄）。年度は呼ぶ前に pinYear で決める */
export async function openLending(page: Page, query = ''): Promise<void> {
  await page.goto(`/lending/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '備品と割り当て' })).toBeVisible();
  await expect(page.getByTestId('lending-status')).toBeVisible();
}

/** 備品の表の1行（data-id） */
export const itemRow = (page: Page, id: string): Locator => page.locator(`[data-testid="lending-item-row"][data-id="${id}"]`);

/** 割り当ての表の1行（団体） */
export const assignmentRow = (page: Page, groupId: string): Locator =>
  page.locator(`[data-testid="lending-assignment-row"][data-group-id="${groupId}"]`);

/** 割り当ての表のセル（団体×備品） */
export const lendingCell = (page: Page, groupId: string, itemId: string): Locator =>
  page.locator(`[data-testid="lending-cell"][data-group-id="${groupId}"][data-item-id="${itemId}"]`);

/** 割り当ての表の行の団体の id（出ている順） */
export function assignmentGroupIds(page: Page): Promise<string[]> {
  return page.getByTestId('lending-assignment-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id') ?? ''));
}

/** 確定の押せない理由の種類（出ている順） */
export function blockerKinds(page: Page): Promise<string[]> {
  return page
    .getByTestId('lending-confirm-blockers')
    .locator('li')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-kind') ?? ''));
}

/** 割り当てのセルに数を入れて確定する（Enter。空にすると未入力に戻す） */
export async function fillCell(page: Page, groupId: string, itemId: string, value: string): Promise<void> {
  const input = lendingCell(page, groupId, itemId).getByTestId('lending-cell-input');
  await input.fill(value);
  await input.press('Enter');
}

// ---------------------------------------------------------------- 画面（/lending/records）

/** 受け渡し・返却（/lending/records/）を開き、読み終わるのを待つ（一覧か団体の欄） */
export async function openRecords(page: Page, query = ''): Promise<void> {
  await page.goto(`/lending/records/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '受け渡し・返却' })).toBeVisible();
  await expect(page.getByTestId('records-filter').or(page.getByTestId('records-panel'))).toBeVisible();
}

/** 一覧の1団体 */
export const recordsGroup = (page: Page, groupId: string): Locator => page.locator(`[data-testid="records-group"][data-group-id="${groupId}"]`);

/** 一覧の団体と状態（出ている順。`{団体の id}:{状態}`） */
export function recordsGroupStates(page: Page): Promise<string[]> {
  return page
    .getByTestId('records-group')
    .evaluateAll((els) => els.map((e) => `${e.getAttribute('data-group-id') ?? ''}:${e.getAttribute('data-state') ?? ''}`));
}

/** 団体の欄の1備品 */
export const recordsItem = (page: Page, itemId: string): Locator => page.locator(`[data-testid="records-item"][data-item-id="${itemId}"]`);

/** 団体の欄の数の欄（渡した・返った・うち破損） */
export function recordsCount(page: Page, itemId: string, kind: 'lent' | 'returned' | 'damaged'): Locator {
  return recordsItem(page, itemId).getByTestId(`records-${kind}`).getByRole('textbox');
}

/** 団体の欄の数を入れる（Enter で確定） */
export async function fillRecord(page: Page, itemId: string, kind: 'lent' | 'returned' | 'damaged', value: number): Promise<void> {
  const input = recordsCount(page, itemId, kind);
  await input.fill(String(value));
  await input.press('Enter');
}

// ---------------------------------------------------------------- 画面（/request のテント等のタブ）

/** 申請（/request/）をテント等のタブで開き、テント等のパネルを読み終わるのを待つ。query は `?tab=lending` を含める */
export async function openRequestLending(page: Page, query = '?tab=lending'): Promise<void> {
  await page.goto(`/request/${query}`);
  await expect(page.getByTestId('lending-request')).toBeVisible();
  await expect(page.getByTestId('request-tab-lending')).toHaveAttribute('aria-selected', 'true');
}

/** テント等のパネルの1備品 */
export const requestItem = (page: Page, itemId: string): Locator =>
  page.locator(`[data-testid="lending-request-item"][data-item-id="${itemId}"]`);

/** テント等のパネルの数の欄 */
export const requestCount = (page: Page, itemId: string): Locator => requestItem(page, itemId).getByRole('textbox');

// ---------------------------------------------------------------- ダッシュボード

/** テント等の要対応（出ている順の id） */
export function lendingTodoIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="portal-todo"][data-module="lending"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/** 要対応の1件（data-id） */
export const portalTodo = (page: Page, id: string): Locator => page.locator(`[data-testid="portal-todo"][data-id="${id}"]`);

/** テント等のカード */
export const lendingCard = (page: Page): Locator => page.locator('[data-testid="module-card"][data-module="lending"]');
