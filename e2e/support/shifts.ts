// シフト・作業（T20。D-56）の E2E とスクリーンショットが使う補助：持ち場・時間枠・ます・割り当て・作業を SQL で入れる・DB の行を読む、
// Asia/Tokyo の時刻の計算と期待値の文（時間枠の時刻「09:00〜10:00」）、今の時刻のまわりの時間枠の決め方、/shifts・/shift・/tasks を
// 開いて読み終わるのを待つ・1件を探す。e2e/t20-*.spec.ts と e2e/shots/T20.shots.ts。
// SQL はシナリオの年度の5表（shift_duties・shift_slots・shift_needs・shift_assignments・tasks）にだけ書く（年度をまたぐ表には書かない。
// D-36）。SQL Editor と同じ postgres で書くので、時間枠の重なり（no_overlap）と「総務だけ」（member_check）のトリガーは確かめる（入れる
// 時間枠を重ねない・割り当てる人と担当者はその年度の総務にする）。書いた人（created_by・updated_by）は入れた値のまま残る（auth.uid() の
// ない書き込みでは、set_actor のトリガーが入れた値を変えない。D-10）。
// 時刻はテストの時計の Asia/Tokyo で決め、期待値も同じ時計から作る（Asia/Tokyo は夏時間がないので、日付の差は暦の差）。期待値の文言は
// 画面の仕様（04「シフト表」「自分のシフト」「作業一覧」「ダッシュボードに出すもの（シフト・作業）」）のとおりに書く（アプリの関数・定数から
// 引かない）。名前は「部門員A」などにし、個人名を使わない。
import { expect, type Locator, type Page } from '@playwright/test';
import { addDays, tokyoToday } from './calendar';
import { createUser, sql, type TestUser } from './db';

// ---------------------------------------------------------------- Asia/Tokyo の時刻

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** テストの時計の Asia/Tokyo の、今日の 0 時からの分（0〜1439） */
export function tokyoMinutesNow(now: number = Date.now()): number {
  const d = new Date(now + TOKYO_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 分（0 時から。1440 以上は次の日に送る）の `HH:mm` */
export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Asia/Tokyo の日付と 0 時からの分（1440 以上は次の日）を、timestamptz の文字列（`YYYY-MM-DDTHH:mm:00+09:00`）にする */
export function tokyoIso(date: string, minutes: number): string {
  const days = Math.floor(minutes / 1440);
  return `${addDays(date, days)}T${hhmm(minutes - days * 1440)}:00+09:00`;
}

/** timestamptz の文字列の Asia/Tokyo の日付（`YYYY-MM-DD`）と 0 時からの分 */
export function tokyoPartsOf(iso: string): { date: string; minutes: number } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`日時として読めません：${iso}`);
  const d = new Date(t + TOKYO_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 時間枠の開始と終わり（timestamptz の文字列。`+09:00`） */
export interface SlotTimes {
  startsAt: string;
  endsAt: string;
}

/** 時間枠の日（開始の Asia/Tokyo の日付。0 時をまたぐ枠は開始の日） */
export const slotDay = (s: SlotTimes): string => tokyoPartsOf(s.startsAt).date;

/** 開始の `HH:mm`（ダッシュボードの「今 09:00〜 受付」の 09:00） */
export const slotStart = (s: SlotTimes): string => hhmm(tokyoPartsOf(s.startsAt).minutes);

/**
 * 時間枠の時刻の文（04「シフト表」の行の見出し）：「09:00〜10:00」。終わりが次の日なら「23:00〜翌 01:00」（ちょうど次の日の 0 時なら
 * 「23:00〜24:00」）。
 */
export function slotLabel(s: SlotTimes): string {
  const a = tokyoPartsOf(s.startsAt);
  const b = tokyoPartsOf(s.endsAt);
  const start = hhmm(a.minutes);
  const end = hhmm(b.minutes);
  if (a.date === b.date) return `${start}〜${end}`;
  if (b.date === addDays(a.date, 1)) return end === '00:00' ? `${start}〜24:00` : `${start}〜翌 ${end}`;
  return `${start}〜${Number(b.date.slice(5, 7))}/${Number(b.date.slice(8, 10))} ${end}`;
}

/** Asia/Tokyo の日付の `HH:mm` から `HH:mm` までの時間枠（終わりが始まり以前なら次の日の時刻） */
export function slotAt(date: string, start: string, end: string): SlotTimes {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(start);
  let e = toMin(end);
  if (e <= s) e += 1440;
  return { startsAt: tokyoIso(date, s), endsAt: tokyoIso(date, e) };
}

/**
 * 今の時刻のまわりの時間枠（自分のシフトの「今」「次」と、ダッシュボードの今日のシフトを確かめる。notes/T20.md の E2E）：
 * - now：今を 15 分に切り下げた時刻から 60 分（始まり ≤ 今 < 終わり。テストの間に終わらない）。日は今日（開始の日）。
 * - next：now の終わりから 60 分（隣り合う。重ならない）。23 時より後に流すと、次の日の枠になる（nextIsToday が偽）。
 * 期待値は同じ時計から作る（今日の枠の数・「今日あと N 枠」は nextIsToday で決める）。
 */
export function slotsAroundNow(now: number = Date.now()): { today: string; now: SlotTimes; next: SlotTimes; nextIsToday: boolean } {
  const today = tokyoToday(now);
  const s = Math.floor(tokyoMinutesNow(now) / 15) * 15;
  const cur = { startsAt: tokyoIso(today, s), endsAt: tokyoIso(today, s + 60) };
  const next = { startsAt: tokyoIso(today, s + 60), endsAt: tokyoIso(today, s + 120) };
  return { today, now: cur, next, nextIsToday: slotDay(next) === today };
}

// ---------------------------------------------------------------- SQL で入れる・読む

export interface DutyInput {
  name: string;
  place?: string | null;
  note?: string | null;
  sortOrder?: number;
}

/** 持ち場を入れ、id を入れた順に返す */
export async function insertDuties(yearId: string, duties: readonly DutyInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [k, d] of duties.entries()) {
    const [r] = await sql<{ id: string }>(
      `insert into public.shift_duties (year_id, name, place, note, sort_order) values ($1, $2, $3, $4, $5) returning id`,
      [yearId, d.name, d.place ?? null, d.note ?? null, d.sortOrder ?? k + 1],
    );
    ids.push(r!.id);
  }
  return ids;
}

/** 時間枠を入れ、id を入れた順に返す（同じ年度の時間枠と重ねない。重なれば no_overlap のトリガーが止める） */
export async function insertSlots(yearId: string, slots: readonly SlotTimes[]): Promise<string[]> {
  const ids: string[] = [];
  for (const s of slots) {
    const [r] = await sql<{ id: string }>(
      `insert into public.shift_slots (year_id, starts_at, ends_at) values ($1, $2::timestamptz, $3::timestamptz) returning id`,
      [yearId, s.startsAt, s.endsAt],
    );
    ids.push(r!.id);
  }
  return ids;
}

export interface NeedInput {
  slotId: string;
  dutyId: string;
  required: number;
  /** このますに割り当てる人（その年度の総務） */
  users?: readonly string[];
}

/** ます（必要人数）と、そのますの割り当てを入れる */
export async function insertNeeds(yearId: string, needs: readonly NeedInput[]): Promise<void> {
  for (const n of needs) {
    await sql(`insert into public.shift_needs (year_id, slot_id, duty_id, required_count) values ($1, $2, $3, $4)`, [
      yearId,
      n.slotId,
      n.dutyId,
      n.required,
    ]);
    for (const u of n.users ?? []) {
      await sql(`insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values ($1, $2, $3, $4)`, [yearId, n.slotId, n.dutyId, u]);
    }
  }
}

/** 作業の状態（task_status。02 の列挙の並び） */
export type TaskStatus = 'todo' | 'doing' | 'done';

export interface TaskInput {
  title: string;
  note?: string | null;
  assigneeId?: string | null;
  /** 締切（timestamptz の文字列。`+09:00`） */
  dueAt?: string | null;
  status?: TaskStatus;
  /** 書いた人（直した人も同じにする） */
  createdBy: string | null;
}

/** 作業を1件ずつ入れ、id を入れた順に返す（渡した配列と同じ長さの組。分割代入で受け取れる） */
export async function insertTasks<const T extends readonly TaskInput[]>(yearId: string, tasks: T): Promise<{ -readonly [K in keyof T]: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const [r] = await sql<{ id: string }>(
      `insert into public.tasks (year_id, title, note, assignee_id, due_at, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5::timestamptz, $6::public.task_status, $7, $7) returning id`,
      [yearId, t.title, t.note ?? null, t.assigneeId ?? null, t.dueAt ?? null, t.status ?? 'todo', t.createdBy],
    );
    ids.push(r!.id);
  }
  return ids as { -readonly [K in keyof T]: string };
}

/** DB の持ち場（並び順・名前の順） */
export async function dutiesOf(yearId: string): Promise<{ id: string; name: string; place: string | null; note: string | null; sort_order: number }[]> {
  return sql(`select id, name, place, note, sort_order from public.shift_duties where year_id = $1 order by sort_order, name, id`, [yearId]);
}

/** DB の時間枠（開始の順。開始・終わりは Asia/Tokyo の `YYYY-MM-DDTHH:mm`） */
export async function slotsOf(yearId: string): Promise<{ id: string; starts: string; ends: string }[]> {
  return sql(
    `select id, to_char(starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as starts,
            to_char(ends_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as ends
       from public.shift_slots where year_id = $1 order by starts_at, id`,
    [yearId],
  );
}

/** DB のます（時間枠の開始の順、持ち場の並び順） */
export async function needsOf(yearId: string): Promise<{ slot_id: string; duty_id: string; required_count: number }[]> {
  return sql(
    `select n.slot_id, n.duty_id, n.required_count from public.shift_needs n
       join public.shift_slots s on s.id = n.slot_id join public.shift_duties d on d.id = n.duty_id
      where n.year_id = $1 order by s.starts_at, d.sort_order, d.name`,
    [yearId],
  );
}

/** DB の割り当て（時間枠の開始の順、持ち場の並び順、人の id の順） */
export async function assignmentsOf(yearId: string): Promise<{ slot_id: string; duty_id: string; user_id: string }[]> {
  return sql(
    `select a.slot_id, a.duty_id, a.user_id from public.shift_assignments a
       join public.shift_slots s on s.id = a.slot_id join public.shift_duties d on d.id = a.duty_id
      where a.year_id = $1 order by s.starts_at, d.sort_order, d.name, a.user_id`,
    [yearId],
  );
}

/** DB の作業の行（締切は Asia/Tokyo の `YYYY-MM-DDTHH:mm`。作った日時の順） */
export interface TaskDbRow {
  id: string;
  title: string;
  note: string | null;
  assignee_id: string | null;
  due: string | null;
  status: TaskStatus;
  created_by: string | null;
  updated_by: string | null;
}

export async function tasksOf(yearId: string): Promise<TaskDbRow[]> {
  return sql<TaskDbRow>(
    `select id, title, note, assignee_id, to_char(due_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as due,
            status::text as status, created_by, updated_by
       from public.tasks where year_id = $1 order by created_at, id`,
    [yearId],
  );
}

/**
 * 4G の計測（e2e/perf.spec.ts）の年度に、1年の量の見込み（notes/T20.md の付録の計画「7. 速さ」：時間枠 50・必要人数 250・割り当て 800・
 * 作業 200）のシフト・作業を入れる。部門員 100 人（createUser。表示名「部門員001」…）をその年度の総務部門員にし、昨日から 5 日の
 * 09:00〜19:00 の 1 時間の時間枠（50）に持ち場 5 つのます（250。必要人数 4・4・3・3・2）を置き、時間枠ごとに 16 人を順に割り当てる（800。
 * staffId の人も入る）。作業は 200（担当は順に。staffId の人に 8。締切は今の前後にばらし、状態も混ぜる）。返り値の cleanup で部門員を消す
 * （年度の行は年度の削除で消える）。
 */
export async function insertShiftVolume(yearId: string, staffId: string, now: number = Date.now()): Promise<{ cleanup(): Promise<void> }> {
  const users: TestUser[] = [];
  try {
    for (let k = 1; k <= 100; k++) users.push(await createUser({ purpose: 'perfshift', name: `部門員${String(k).padStart(3, '0')}` }));
    await sql(`insert into public.year_roles (year_id, user_id, role) select $1, u, 'staff' from unnest($2::uuid[]) as u`, [yearId, users.map((u) => u.id)]);
    const members = [staffId, ...users.map((u) => u.id)];
    await sql(`insert into public.shift_duties (year_id, name, sort_order) select $1, n, k::int from unnest($2::text[]) with ordinality as t(n, k)`, [
      yearId,
      ['受付', '運搬', '見回り', '本部', '駐輪場'],
    ]);
    await sql(
      `insert into public.shift_slots (year_id, starts_at, ends_at)
       select $1, (($2::date + d) + make_time(9 + h, 0, 0)) at time zone 'Asia/Tokyo', (($2::date + d) + make_time(10 + h, 0, 0)) at time zone 'Asia/Tokyo'
         from generate_series(0, 4) d, generate_series(0, 9) h`,
      [yearId, addDays(tokyoToday(now), -1)],
    );
    await sql(
      `insert into public.shift_needs (year_id, slot_id, duty_id, required_count)
       select $1, s.id, d.id, (array[4, 4, 3, 3, 2])[d.sort_order] from public.shift_slots s cross join public.shift_duties d
        where s.year_id = $1 and d.year_id = $1`,
      [yearId],
    );
    const slots = await sql<{ id: string }>(`select id from public.shift_slots where year_id = $1 order by starts_at`, [yearId]);
    const duties = await sql<{ id: string; required: number }>(
      `select d.id, (array[4, 4, 3, 3, 2])[d.sort_order] as required from public.shift_duties d where d.year_id = $1 order by d.sort_order`,
      [yearId],
    );
    const rows: { year_id: string; slot_id: string; duty_id: string; user_id: string }[] = [];
    for (const [i, slot] of slots.entries()) {
      let j = 0;
      for (const d of duties) for (let r = 0; r < d.required; r++) rows.push({ year_id: yearId, slot_id: slot.id, duty_id: d.id, user_id: members[(i * 16 + j++) % members.length]! });
    }
    await sql(
      `insert into public.shift_assignments (year_id, slot_id, duty_id, user_id)
       select year_id, slot_id, duty_id, user_id from jsonb_to_recordset($1::jsonb) as x(year_id uuid, slot_id uuid, duty_id uuid, user_id uuid)`,
      [JSON.stringify(rows)],
    );
    await sql(
      `insert into public.tasks (year_id, title, note, assignee_id, due_at, status)
       select $1, '作業 ' || lpad(k::text, 3, '0'), case when k % 4 = 0 then '説明 ' || k end,
              case when k % 25 = 0 then $2::uuid when k % 10 = 0 then null else ($3::uuid[])[1 + k % 100] end,
              case when k % 7 = 0 then null else now() + make_interval(hours => k - 60) end,
              (array['todo', 'doing', 'done'])[1 + k % 3]::public.task_status
         from generate_series(1, 200) k`,
      [yearId, staffId, users.map((u) => u.id)],
    );
  } catch (e) {
    for (const u of users) await u.cleanup().catch(() => undefined);
    throw e;
  }
  return {
    cleanup: async () => {
      for (const u of users) await u.cleanup();
    },
  };
}

/** 作業の更新の日時の短い表示（一覧の「{表示名}が 11/1 14:50 に更新」の 11/1 14:50。Asia/Tokyo）を DB で作る */
export async function taskUpdatedShort(id: string): Promise<string> {
  const [r] = await sql<{ t: string }>(`select to_char(updated_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.tasks where id = $1`, [id]);
  if (!r) throw new Error(`作業 ${id} がありません`);
  return r.t;
}

/** 作業の更新の日時（ダイアログの「更新：」。Asia/Tokyo の `YYYY/MM/DD HH:mm`）を DB で作る */
export async function taskUpdatedLabel(id: string): Promise<string> {
  const [r] = await sql<{ t: string }>(`select to_char(updated_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI') as t from public.tasks where id = $1`, [id]);
  if (!r) throw new Error(`作業 ${id} がありません`);
  return r.t;
}

// ---------------------------------------------------------------- 画面

/**
 * シフト表（/shifts/）を開き、読み終わるのを待つ（h1「シフト表」と、表か空の表示）。query は `?day=…` など。年度は呼ぶ前に pinYear で
 * 決める。
 */
export async function openShifts(page: Page, query = ''): Promise<void> {
  await page.goto(`/shifts/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'シフト表', exact: true })).toBeVisible();
  await expect(page.getByTestId('shifts-board').or(page.getByTestId('shifts-empty'))).toBeVisible();
}

/** 自分のシフト（/shift/）を開き、読み終わるのを待つ（h1「自分のシフト」と、一覧か空の表示） */
export async function openMyShift(page: Page, query = ''): Promise<void> {
  await page.goto(`/shift/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '自分のシフト', exact: true })).toBeVisible();
  await expect(page.getByTestId('my-shift-list').or(page.getByTestId('my-shift-empty')).first()).toBeVisible();
}

/** 作業一覧（/tasks/）を開き、読み終わるのを待つ（h1「作業一覧」と、一覧か空の表示） */
export async function openTasks(page: Page, query = ''): Promise<void> {
  await page.goto(`/tasks/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '作業一覧', exact: true })).toBeVisible();
  await expect(page.getByTestId('tasks-list').or(page.getByTestId('tasks-empty'))).toBeVisible();
}

/** シフト表のます（時間枠 × 持ち場） */
export const shiftCell = (page: Page, slotId: string, dutyId: string): Locator =>
  page.locator(`[data-testid="shift-cell"][data-slot-id="${slotId}"][data-duty-id="${dutyId}"]`);

/** シフト表の行（時間枠） */
export const shiftRow = (page: Page, slotId: string): Locator => page.locator(`[data-testid="shift-row"][data-slot-id="${slotId}"]`);

/** ますの人の表示名（出ている順） */
export async function cellMembers(cell: Locator): Promise<string[]> {
  return (await cell.getByTestId('shift-cell-member').allInnerTexts()).map((t) => t.replace('（あなた）', '').trim());
}

/** シフト表の行の data-slot-id（出ている順） */
export function shiftRowIds(page: Page): Promise<string[]> {
  return page.getByTestId('shift-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-slot-id') ?? ''));
}

/** ますのダイアログの人の1行（data-user-id） */
export const memberOption = (scope: Page | Locator, userId: string): Locator =>
  scope.locator(`[data-testid="shift-member-option"][data-user-id="${userId}"]`);

/** 自分のシフトの1件（data-slot-id） */
export const myShiftItem = (page: Page, slotId: string): Locator => page.locator(`[data-testid="my-shift-item"][data-slot-id="${slotId}"]`);

/** 自分のシフトの日の data-day（出ている順） */
export function myShiftDays(page: Page): Promise<string[]> {
  return page.getByTestId('my-shift-day').evaluateAll((els) => els.map((e) => e.getAttribute('data-day') ?? ''));
}

/** 作業一覧の1件（data-id） */
export const taskItem = (page: Page, id: string): Locator => page.locator(`[data-testid="tasks-item"][data-id="${id}"]`);

/** 作業一覧の作業の id（出ている順） */
export function taskIds(page: Page): Promise<string[]> {
  return page.getByTestId('tasks-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/** ダッシュボードの要対応の id（出ている順） */
export function portalTodoIds(page: Page): Promise<string[]> {
  return page
    .getByTestId('portal-todos')
    .getByTestId('portal-todo')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/** ダッシュボードの要対応の1件（data-id） */
export const portalTodo = (page: Page, id: string): Locator => page.locator(`[data-testid="portal-todo"][data-id="${id}"]`);

/** ダッシュボードのシフト・作業のカード */
export const shiftsCard = (page: Page): Locator => page.locator('[data-testid="module-card"][data-module="shifts"]');

/** ページが横にはみ出していない（スマホの幅 390px） */
export async function expectNoOverflow(page: Page, width = 390): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);
}

/** 今日（Asia/Tokyo）から n 日後の日付 */
export const dayFromToday = (n: number, now: number = Date.now()): string => addDays(tokyoToday(now), n);
