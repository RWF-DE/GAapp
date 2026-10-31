// 締切と予定（/calendar）の読み取りと書き込み（04「締切と予定」、notes/T18.md「後半（画面）の約束」4。T18・D-54）。
// - 読む：開いている年度の項目（events。year_id で絞り、開始・id の順に全部。書いた人・直した人は読まない）。RLS が返したものを
//   そのまま使う（画面では対象で絞らない〔総務の絞り込みを除く〕。件数の上限なし）。
// - 書く：画面から直接（RLS。RPC はない。書けるのはその年度の部門長以上で、年度が終了でないとき）。登録は画面が作った id で insert
//   （主キーが一意のキー。送り直しは 23505 で止まる）、保存・削除は読んだときの updated_at の文字列のまま条件に入れる
//   （updateWithLock・deleteChecked。DB はマイクロ秒まで完全一致で比べるので Date に通さない）。0 行は読み直して not_found・conflict・
//   forbidden に分ける（explainZeroRows）。
// - 応答が届かなかったとき・止められたときの読み直し（2.6 の (B1)）：readEvent（id で1行）と、入力と同じかの比べ方 sameEventWrite。
// 版（allocation_version）は使わない（予定と締切は振り分けの入力でない。D-54）。
import { compareStrings, Constants, type Database, type Tables } from '@gaapp/shared';
import { queryOptions, useQuery, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { deleteChecked } from '@/lib/db/delete-checked';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

/** 種類（event_kind） */
export type EventKind = Database['public']['Enums']['event_kind'];
/** 対象（event_audience） */
export type EventAudience = Database['public']['Enums']['event_audience'];
/** 種類の一覧（02 の列挙の並び：締切・予定） */
export const EVENT_KINDS: readonly EventKind[] = Constants.public.Enums.event_kind;
/** 対象の一覧（02 の列挙の並び：総務・団体・全員） */
export const EVENT_AUDIENCES: readonly EventAudience[] = Constants.public.Enums.event_audience;

/** 一覧の select（04 の「読むもの」。書いた人・直した人は読まない） */
export const CALENDAR_EVENTS_SELECT = 'id, kind, audience, title, starts_at, ends_at, all_day, note, updated_at';

/** 一覧の1行 */
export type CalendarEventRow = Pick<
  Tables<'events'>,
  'id' | 'kind' | 'audience' | 'title' | 'starts_at' | 'ends_at' | 'all_day' | 'note' | 'updated_at'
>;

export interface CalendarEventsData {
  /** 開始の早い順・id の順 */
  events: CalendarEventRow[];
  /** 読み込んだ時刻（ISO） */
  loadedAt: string;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** 一覧の並び（開始の早い順、同じなら id の順。DB の order と同じ）。元の配列は変えない */
export function sortEvents<T extends Pick<CalendarEventRow, 'id' | 'starts_at'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => timeOf(a.starts_at) - timeOf(b.starts_at) || compareStrings(a.id, b.id));
}

/** 行の列を一覧の形にそろえる（updateWithLock・deleteChecked は全部の列を返すので、一覧のキャッシュに余分な列を入れない） */
export function toCalendarEventRow(row: CalendarEventRow): CalendarEventRow {
  return {
    id: row.id,
    kind: row.kind,
    audience: row.audience,
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    note: row.note,
    updated_at: row.updated_at,
  };
}

/** 一覧を読む（fetchAll。year_id で絞り、starts_at・id の順に全部） */
export async function fetchCalendarEvents(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<CalendarEventsData> {
  const events = await fetchAll<CalendarEventRow>(
    (from, to) =>
      client
        .from('events')
        .select(CALENDAR_EVENTS_SELECT)
        .eq('year_id', yearId)
        .order('starts_at')
        .order('id')
        .range(from, to) as unknown as PromiseLike<PageResult<CalendarEventRow>>,
  );
  return { events, loadedAt: new Date().toISOString() };
}

/** 一覧のクエリ（キーは `['year', yearId, 'calendar', 'events']`） */
export function calendarEventsOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'calendar', 'events'),
    queryFn: () => fetchCalendarEvents(yearId!),
    enabled: !!yearId,
  });
}

export function useCalendarEvents(yearId: string | null | undefined) {
  return useQuery(calendarEventsOptions(yearId));
}

/** その項目を1行読む（(B1) の読み直し）。なければ（消えた・読めない）null。読めなければ AppError を投げる */
export async function readEvent(id: string, client: AppSupabaseClient = getSupabase()): Promise<CalendarEventRow | null> {
  const res = await client.from('events').select(CALENDAR_EVENTS_SELECT).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as CalendarEventRow | null) ?? null;
}

/**
 * 登録の id（uuid v4）。ダイアログを開いたときに作り、閉じるまで（もう一度の送信と下書きを含めて）同じ id を使う（(B1)：送り直しは
 * 主キーの重複〔23505〕で止まる）。crypto.randomUUID のないとき（安全でない接続）は getRandomValues で作る。
 */
export function newEventId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 送る値（lib/schemas/calendar.ts の checkEventForm が作る）。書いた人・直した人・日時・id・year_id は入れない（DB が入れる・変えない）。
 * 保存（update）はこの全部の欄を置き換える。
 */
export interface EventWrite {
  kind: EventKind;
  audience: EventAudience;
  /** 前後の空白を除いた 1〜100 字 */
  title: string;
  /** 終日なら開始の日の Asia/Tokyo の 00:00（`YYYY-MM-DDT00:00:00+09:00`）、でなければ開始の日時（`+09:00`） */
  starts_at: string;
  /** 終日なら最後の日の Asia/Tokyo の 00:00（1日だけなら null）、でなければ終わりの日時（なければ null） */
  ends_at: string | null;
  all_day: boolean;
  /** 前後の空白を除いたメモ（空なら null） */
  note: string | null;
}

/**
 * 登録：画面が作った id（ダイアログを開いたときの uuid）で insert し、行を返させる（`insert({ id, year_id, ...w }).select().single()`）。
 * 送り直しは主キーの重複（23505。conflict）で止まる。書けなければ 42501（forbidden）。失敗したら AppError を投げる。
 */
export async function insertEvent(yearId: string, id: string, w: EventWrite, client: AppSupabaseClient = getSupabase()): Promise<CalendarEventRow> {
  const res = await client
    .from('events')
    .insert({ id, year_id: yearId, ...w })
    .select(CALENDAR_EVENTS_SELECT)
    .single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as CalendarEventRow;
}

/**
 * 保存：読んだときの updated_at（受け取った文字列のまま）を条件に入れて、全部の欄を置き換える（updateWithLock）。
 * 0 行なら explainZeroRows の AppError（not_found＝lock_missing・conflict＝lock_conflict・forbidden＝lock_unchanged）を投げる。
 */
export async function updateEvent(
  row: Pick<CalendarEventRow, 'id' | 'updated_at'>,
  w: EventWrite,
  client: AppSupabaseClient = getSupabase(),
): Promise<CalendarEventRow> {
  const saved = await updateWithLock(client, 'events', { id: row.id }, row.updated_at, { ...w });
  return toCalendarEventRow(saved);
}

/**
 * 削除：読んだときの updated_at を条件に入れて delete し、消えた行を受け取る（deleteChecked）。0 行なら explainZeroRows の AppError
 * （not_found・conflict・forbidden）を投げる。
 */
export async function deleteEvent(row: Pick<CalendarEventRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<CalendarEventRow> {
  const deleted = await deleteChecked(client, 'events', { id: row.id }, row.updated_at);
  return toCalendarEventRow(deleted);
}

/** 同じ時刻か（DB は UTC で返すので、文字列でなく Date.parse で比べる。どちらも null なら同じ） */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && ta === tb;
}

/**
 * 読み直した行が送った値と同じか（種類・対象・題名・終日・メモ〔null と空をそろえる〕は同じ値、開始・終わりは同じ時刻）。
 * (B1) の「保存されていました」「登録されていました」と、編集で何も変えていないかの判定に使う。
 */
export function sameEventWrite(row: Pick<CalendarEventRow, keyof EventWrite>, w: EventWrite): boolean {
  return (
    row.kind === w.kind &&
    row.audience === w.audience &&
    row.title === w.title &&
    row.all_day === w.all_day &&
    (row.note || null) === (w.note || null) &&
    sameInstant(row.starts_at, w.starts_at) &&
    sameInstant(row.ends_at, w.ends_at)
  );
}

/** 書いた後に読み直すキー：一覧（`['year', y, 'calendar']`）とダッシュボードの締切と予定（`['year', y, 'portal', 'calendar']`） */
export function calendarInvalidateKeys(yearId: string): QueryKey[] {
  return [queryKeys.yearPart(yearId, 'calendar'), queryKeys.yearPart(yearId, 'portal', 'calendar')];
}

/** 書いた後に、一覧とダッシュボードの締切と予定を読み直す（待たない。画面は先にキャッシュを直している） */
export function invalidateCalendar(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of calendarInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}

/** 登録・保存した行を一覧のキャッシュに入れる（読み直しの前に一覧に出す）。キャッシュがなければ何もしない */
export function putEventInCache(queryClient: QueryClient, yearId: string, row: CalendarEventRow): void {
  queryClient.setQueryData(calendarEventsOptions(yearId).queryKey, (old) => {
    if (!old) return old;
    const next = toCalendarEventRow(row);
    return { ...old, events: sortEvents([...old.events.filter((e) => e.id !== next.id), next]) };
  });
}

/** 消えた項目を一覧のキャッシュから外す */
export function dropEventFromCache(queryClient: QueryClient, yearId: string, id: string): void {
  queryClient.setQueryData(calendarEventsOptions(yearId).queryKey, (old) => (old ? { ...old, events: old.events.filter((e) => e.id !== id) } : old));
}
