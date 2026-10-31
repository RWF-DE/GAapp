// /calendar（締切と予定）の一覧の組み立て（04「締切と予定」の並び・既定は今日から・1件に出すもの・絞り込み、notes/T18.md「後半（画面）の
// 約束」5。T18・D-54）。純粋な関数（時計は now だけ）。項目（表 events の行）と、ほかの機能が締切と予定に出す日付（機能の日付。
// ダッシュボードと同じプロバイダの流れで集めたもの）を、Asia/Tokyo の日ごとにまとめる。
// ダッシュボード（/）はこのファイルを読まない（一覧の画面の部品なので、/ の JS に入れない）。
import { Constants } from '@gaapp/shared';
import type { CalendarEventRow, EventAudience, EventKind } from '@/lib/data/calendar';
import { formatTime, tokyoDate, tokyoToday } from '@/lib/datetime';
import { formatShortDateTimeWeekday, formatShortDateWeekday } from '@/lib/datetime-weekday';
import {
  datedLastDay,
  datedRelative,
  datedStartDay,
  datedTime,
  datedWhen,
  isDatedReadable,
  isDateOnly,
  moduleIndex,
  tokyoYearOf,
  type DatedItem,
} from '../portal';
import { eventDatedItem } from './portal';

/** 一覧の絞り込み（`?past=1`・`?kind=`・`?audience=`。種類・対象は総務だけ） */
export interface CalendarFilter {
  /** 過去も出すか（既定は今日から） */
  past: boolean;
  /** 種類（null はすべて。項目と機能の日付の両方に効く） */
  kind: EventKind | null;
  /** 対象（null はすべて。項目だけに効き、選ぶと機能の日付〔対象を持たない〕を出さない） */
  audience: EventAudience | null;
}

/** 1件：項目は event が表の行、機能の日付は event が null */
export interface CalendarEntry {
  item: DatedItem;
  event: CalendarEventRow | null;
}

/** 1日（Asia/Tokyo の `YYYY-MM-DD`）と、その日の項目（日の中の並び） */
export interface CalendarDay {
  date: string;
  entries: CalendarEntry[];
}

const KINDS: readonly string[] = Constants.public.Enums.event_kind;
const AUDIENCES: readonly string[] = Constants.public.Enums.event_audience;

/**
 * URL のクエリを読む：`?past=1`（過去も表示）、`?kind=deadline|event`・`?audience=soumu|groups|all`（総務だけ。知らない値と、総務でない
 * 人は null＝すべて）、`?event=<id>`（ダッシュボードの欄から来た項目。空なら null）。
 */
export function parseCalendarParams(params: Pick<URLSearchParams, 'get'>, soumu: boolean): CalendarFilter & { highlight: string | null } {
  const kind = params.get('kind');
  const audience = params.get('audience');
  const highlight = params.get('event')?.trim() ?? '';
  return {
    past: params.get('past') === '1',
    kind: soumu && kind !== null && KINDS.includes(kind) ? (kind as EventKind) : null,
    audience: soumu && audience !== null && AUDIENCES.includes(audience) ? (audience as EventAudience) : null,
    highlight: highlight === '' ? null : highlight,
  };
}

/** 絞り込みを URL にする（`/calendar?past=1&kind=…&audience=…`。既定の値は入れない） */
export function calendarHref(filter: CalendarFilter): string {
  const q = new URLSearchParams();
  if (filter.past) q.set('past', '1');
  if (filter.kind) q.set('kind', filter.kind);
  if (filter.audience) q.set('audience', filter.audience);
  const s = q.toString();
  return s ? `/calendar?${s}` : '/calendar';
}

/**
 * 一覧（日ごと）。events は表の行（eventDatedItem と同じ形の DatedItem にする）、moduleItems は calendar 以外のプロバイダの締切と予定
 * （ダッシュボードと同じプロバイダの流れの dated。兼ねた人の重なりは mergePortalSections が消したもの）。
 * - 絞り込み：kind は両方に、audience は項目だけに効く（audience があれば機能の日付を出さない）。past が偽なら最後の日（datedLastDay）が
 *   今日（Asia/Tokyo）より前のものを出さない（今日のうちに時刻を過ぎたものは出す）。読めない日時のものは出さない。
 * - まとめる日：past が偽なら max(開始の日, 今日)（今日より前に始まって続いているものは今日に）、真なら開始の日。日の早い順。
 * - 日の中：日付だけのもの → 時刻のあるもの。それぞれ開始の早い順、同じなら機能の登録の順、元の順（機能の日付が先に並び、項目は
 *   starts_at・id の順）。
 */
export function buildCalendarDays(
  events: readonly CalendarEventRow[],
  moduleItems: readonly DatedItem[],
  now: number,
  filter: CalendarFilter,
): CalendarDay[] {
  const today = tokyoToday(new Date(now));
  const all: CalendarEntry[] = [
    ...(filter.audience ? [] : moduleItems.map((item) => ({ item, event: null }))),
    ...events.filter((e) => !filter.audience || e.audience === filter.audience).map((e) => ({ item: eventDatedItem(e), event: e })),
  ];
  type Placed = { entry: CalendarEntry; day: string; t: number; dateOnly: boolean; k: number };
  const placed: Placed[] = [];
  all.forEach((entry, k) => {
    const { item } = entry;
    if (filter.kind && item.kind !== filter.kind) return;
    if (!isDatedReadable(item)) return;
    const t = datedTime(item.at)!;
    const start = datedStartDay(item);
    const last = datedLastDay(item);
    if (!filter.past && last < today) return;
    const day = !filter.past && start < today ? today : start;
    placed.push({ entry, day, t, dateOnly: isDateOnly(item.at), k });
  });
  placed.sort(
    (a, b) =>
      (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
      Number(b.dateOnly) - Number(a.dateOnly) ||
      a.t - b.t ||
      moduleIndex(a.entry.item.moduleId) - moduleIndex(b.entry.item.moduleId) ||
      a.k - b.k,
  );
  const days: CalendarDay[] = [];
  for (const p of placed) {
    const last = days.at(-1);
    if (last && last.date === p.day) last.entries.push(p.entry);
    else days.push({ date: p.day, entries: [p.entry] });
  }
  return days;
}

/** 日の見出しの相対の言い方（その日の予定として datedRelative と同じ決め方：今日・明日・あと N 日・N 日前）。読めない日は空文字 */
export function dayRelative(day: string, now: number): string {
  return datedRelative({ at: day, kind: 'event' }, now);
}

/**
 * 1件の時刻の文：日付だけは「終日」（最後の日が別の日なら「終日（〜10/17（日））」）、時刻のあるものは「13:00」「13:00〜15:00」
 * 「13:00〜10/15（金）12:00」。開始の日が day と違う（今日にまとめた続いている項目）ときは datedWhen（開始の日も入れる）。
 */
export function entryTimeLabel(item: DatedItem, day: string, now: number): string {
  if (datedStartDay(item) !== day) return datedWhen(item, now);
  const year = tokyoYearOf(now);
  if (isDateOnly(item.at)) {
    const last = datedLastDay(item);
    return last !== day ? `終日（〜${formatShortDateWeekday(last, year)}）` : '終日';
  }
  const start = formatTime(item.at);
  if (!item.end) return start;
  return `${start}〜${tokyoDate(item.end) === day ? formatTime(item.end) : formatShortDateTimeWeekday(item.end, year)}`;
}

/** 1件の相対の言い方。日の見出し（dayRelative）と同じなら null（出さない。期限を過ぎた締切・期限が別の日の締切などだけ出る） */
export function entryRelative(item: DatedItem, day: string, now: number): string | null {
  const r = datedRelative(item, now);
  return r === '' || r === dayRelative(day, now) ? null : r;
}
