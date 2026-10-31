// 締切と予定（T18。D-54）の E2E とスクリーンショットが使う補助：項目（表 events の行）を SQL で入れる・DB の行を読む、Asia/Tokyo の
// 日付の計算と期待値の文（曜日つきの日付・日の見出し）、/calendar とダッシュボードの欄を開いて読み終わるのを待つ・1件を探す。
// e2e/t18-calendar.spec.ts と e2e/shots/T18.shots.ts。
// SQL はシナリオの年度の項目（events）にだけ書く（年度をまたぐ表には書かない。D-36）。書いた人（created_by）は入れた値のまま残る
// （auth.uid() のない書き込みでは、set_actor のトリガーが入れた値を変えない。D-10）。終日の項目は Asia/Tokyo の 00:00 で入れる
// （DB の CHECK events_all_day_check と同じ形。notes/T18.md の「終日の項目の保存のしかた」）。
// 日付はテストの時計の Asia/Tokyo の今日からの日数で決め、期待値の曜日と相対の言い方も同じ今日から作る（Asia/Tokyo は夏時間が
// ないので、日付の差は暦の差）。期待値の文言は画面の仕様（04「締切と予定」）のとおりに書く（アプリの関数・定数から引かない）。
import { expect, type Locator, type Page } from '@playwright/test';
import { sql } from './db';

/** 種類（event_kind。02 の列挙の並び） */
export type EventKind = 'deadline' | 'event';
/** 対象（event_audience。02 の列挙の並び） */
export type EventAudience = 'soumu' | 'groups' | 'all';

interface EventBase {
  kind: EventKind;
  audience: EventAudience;
  title: string;
  note?: string | null;
  /** 書いた人の user_id（null は、アカウントが消えた・アプリの外で入れた項目） */
  createdBy: string | null;
}

/** 終日の項目：開始の日（と最後の日。Asia/Tokyo の YYYY-MM-DD） */
export interface AllDayEventInput extends EventBase {
  allDay: true;
  date: string;
  endDate?: string;
}

/** 時刻つきの項目：開始（と終わり）。Asia/Tokyo の `YYYY-MM-DDTHH:mm` */
export interface TimedEventInput extends EventBase {
  allDay?: false;
  start: string;
  end?: string;
}

export type EventInput = AllDayEventInput | TimedEventInput;

/** Asia/Tokyo の日付・日時（`YYYY-MM-DD`・`YYYY-MM-DDTHH:mm`）を timestamptz の文字列にする */
const tokyoTs = (local: string) => (local.length === 10 ? `${local}T00:00:00+09:00` : `${local}:00+09:00`);

/**
 * 項目を入れ、id を入れた順に返す（渡した配列と同じ長さの組。分割代入で受け取れる）。
 *
 * @example
 * const [deadline, meeting] = await insertEvents(s.yearId, [
 *   { kind: 'deadline', audience: 'all', title: 'E2E 締切', allDay: true, date: addDays(today, 1), createdBy: SEED_USER_IDS.head },
 *   { kind: 'event', audience: 'soumu', title: 'E2E 会議', start: `${addDays(today, 3)}T13:00`, end: `${addDays(today, 3)}T15:00`, createdBy: SEED_USER_IDS.head },
 * ]);
 */
export async function insertEvents<const T extends readonly EventInput[]>(yearId: string, events: T): Promise<{ -readonly [K in keyof T]: string }> {
  const ids: string[] = [];
  for (const e of events) {
    const startsAt = e.allDay ? tokyoTs(e.date) : tokyoTs(e.start);
    const endsAt = e.allDay ? (e.endDate ? tokyoTs(e.endDate) : null) : e.end ? tokyoTs(e.end) : null;
    const [r] = await sql<{ id: string }>(
      `insert into public.events (year_id, kind, audience, title, starts_at, ends_at, all_day, note, created_by, updated_by)
       values ($1, $2::public.event_kind, $3::public.event_audience, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $9) returning id`,
      [yearId, e.kind, e.audience, e.title, startsAt, endsAt, !!e.allDay, e.note ?? null, e.createdBy],
    );
    ids.push(r!.id);
  }
  return ids as { -readonly [K in keyof T]: string };
}

/** DB の項目の行（開始・終わりは Asia/Tokyo の `YYYY-MM-DDTHH:mm`。updated_at は PostgREST と同じ文字列ではなく text） */
export interface EventDbRow {
  id: string;
  kind: EventKind;
  audience: EventAudience;
  title: string;
  starts: string;
  ends: string | null;
  all_day: boolean;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
}

/** そのシナリオの年度の項目（開始・id の順） */
export async function eventsOf(yearId: string): Promise<EventDbRow[]> {
  return sql<EventDbRow>(
    `select id, kind::text as kind, audience::text as audience, title,
            to_char(starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as starts,
            to_char(ends_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as ends,
            all_day, note, created_by, updated_by, updated_at::text as updated_at
       from public.events where year_id = $1 order by starts_at, id`,
    [yearId],
  );
}

/** 更新の日時の表示（ダイアログの「更新：」。Asia/Tokyo の `YYYY/MM/DD HH:mm`）を DB で作る */
export async function eventUpdatedLabel(id: string): Promise<string> {
  const [r] = await sql<{ t: string }>(`select to_char(updated_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI') as t from public.events where id = $1`, [id]);
  if (!r) throw new Error(`項目 ${id} がありません`);
  return r.t;
}

/** 年度の申請の締切（Asia/Tokyo の日付と時刻。机椅子の日付「机椅子の申請の締切」の期待値を作る） */
export async function requestCloseOf(yearId: string): Promise<{ date: string; time: string }> {
  const [r] = await sql<{ date: string; time: string }>(
    `select to_char(request_close_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as date,
            to_char(request_close_at at time zone 'Asia/Tokyo', 'HH24:MI') as time
       from public.years where id = $1`,
    [yearId],
  );
  if (!r) throw new Error(`年度 ${yearId} がありません`);
  return r;
}

// ---------------------------------------------------------------- Asia/Tokyo の日付と期待値の文

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** テストの時計の Asia/Tokyo の今日（`YYYY-MM-DD`。UTC に 9 時間を足して読む） */
export function tokyoToday(now: number = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const utcOf = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

/** 暦の日付に days 日を足す（`YYYY-MM-DD`） */
export function addDays(date: string, days: number): string {
  return new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 曜日（'日'〜'土'） */
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(utcOf(date)).getUTCDay()]!;
}

const yearOf = (date: string) => Number(date.slice(0, 4));

/** 短い日付と曜日（「11/2（月）」。年が thisYear と違えば「2027/1/5（火）」。04「締切と予定」の日付の出し方） */
export function shortDate(date: string, thisYear: number): string {
  const md = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${weekdayOf(date)}）`;
  return yearOf(date) === thisYear ? md : `${yearOf(date)}/${md}`;
}

/** /calendar の日の見出し（「11月2日（月）」。年が thisYear と違えば「2001年10月11日（木）」） */
export function dayHeading(date: string, thisYear: number): string {
  const md = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${weekdayOf(date)}）`;
  return yearOf(date) === thisYear ? md : `${yearOf(date)}年${md}`;
}

/** 今日からの日数の言い方（0：今日、1：明日、2 以上：あと N 日、負：N 日前） */
export function relativeDays(n: number): string {
  if (n === 0) return '今日';
  if (n === 1) return '明日';
  return n > 1 ? `あと ${n} 日` : `${-n} 日前`;
}

/** 暦の日付の差（to − from の日数） */
export function daysFrom(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

// ---------------------------------------------------------------- /calendar

/** 一覧の1件の data-id：項目は `calendar:<uuid>`、機能の日付は機能が決めた id（`furniture:request-close` など） */
export const eventDataId = (id: string) => `calendar:${id}`;

/** 一覧の1件（data-id。項目は eventDataId で） */
export const calendarItem = (page: Page, dataId: string): Locator => page.locator(`[data-testid="calendar-item"][data-id="${dataId}"]`);

/** 一覧の1日（data-date） */
export const calendarDay = (page: Page, date: string): Locator => page.locator(`[data-testid="calendar-day"][data-date="${date}"]`);

/** 一覧の1件の data-id（出ている順） */
export function calendarItemIds(page: Page): Promise<string[]> {
  return page.getByTestId('calendar-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/** 一覧の日の data-date（出ている順） */
export function calendarDates(page: Page): Promise<string[]> {
  return page.getByTestId('calendar-day').evaluateAll((els) => els.map((e) => e.getAttribute('data-date') ?? ''));
}

/**
 * 締切と予定（/calendar/）を開き、読み終わるのを待つ（h1「締切と予定」と、一覧か空の表示）。query は `?past=1` など。
 * 年度は呼ぶ前に pinYear で決める。機能の日付は年度の行がそろうと足されるので、並びは expect.poll で確かめる。
 */
export async function openCalendar(page: Page, query = ''): Promise<void> {
  await page.goto(`/calendar/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '締切と予定' })).toBeVisible();
  await expect(page.getByTestId('calendar-days').or(page.getByTestId('calendar-empty'))).toBeVisible();
}

/** メモの表示（改行を残す。white-space: pre-wrap の innerText） */
export const noteText = (item: Locator) => item.getByTestId('calendar-item-note').innerText();

// ---------------------------------------------------------------- ダッシュボードの欄

/** ダッシュボードの締切と予定の欄 */
export const datedWidget = (page: Page): Locator => page.getByTestId('portal-dated');

/** 欄の1件（data-id） */
export const portalDatedItem = (page: Page, dataId: string): Locator => page.locator(`[data-testid="portal-dated-item"][data-id="${dataId}"]`);

/** 欄の1件の data-id（出ている順） */
export function portalDatedIds(page: Page): Promise<string[]> {
  return datedWidget(page)
    .getByTestId('portal-dated-item')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}
