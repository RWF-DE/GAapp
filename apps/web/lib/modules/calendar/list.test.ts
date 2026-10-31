// /calendar の一覧の組み立て（lib/modules/calendar/list.ts。04「締切と予定」の並び・既定は今日から・1件に出すもの・絞り込み、
// notes/T18.md「後半（画面）の約束」5。T18）
import { describe, expect, it } from 'vitest';
import type { CalendarEventRow } from '@/lib/data/calendar';
import type { DatedItem } from '../portal';
import {
  buildCalendarDays,
  calendarHref,
  dayRelative,
  entryRelative,
  entryTimeLabel,
  parseCalendarParams,
  type CalendarDay,
  type CalendarFilter,
} from './list';
import { eventDatedItem } from './portal';

// 2027-10-14 12:00（Asia/Tokyo）。今日は 10/14（木）
const NOW = Date.parse('2027-10-14T03:00:00Z');

const ev = (id: string, over: Partial<CalendarEventRow> = {}): CalendarEventRow => ({
  id,
  kind: 'event',
  audience: 'soumu',
  title: `題名${id}`,
  starts_at: '2027-10-14T04:00:00+00:00',
  ends_at: null,
  all_day: false,
  note: null,
  updated_at: '2027-10-01T00:00:00.123456+00:00',
  ...over,
});
const mod = (id: string, at: string, extra: Partial<DatedItem> = {}): DatedItem => ({ id, moduleId: 'furniture', title: id, at, kind: 'event', ...extra });

const EVENTS: CalendarEventRow[] = [
  // 開始・id の順（DB の並び）
  ev('g', { kind: 'deadline', starts_at: '2027-10-10T08:00:00+00:00', audience: 'all' }), // 10/10 17:00 の締切（過ぎた）
  ev('e', { all_day: true, starts_at: '2027-10-11T15:00:00+00:00', ends_at: '2027-10-14T15:00:00+00:00', audience: 'groups' }), // 終日 10/12〜10/15（続いている）
  ev('f', { all_day: true, starts_at: '2027-10-12T15:00:00+00:00' }), // 終日 10/13（昨日）
  ev('a', { all_day: true, starts_at: '2027-10-13T15:00:00+00:00', audience: 'all' }), // 終日 10/14
  ev('b', { starts_at: '2027-10-14T00:00:00+00:00' }), // 10/14 09:00（今日のうちに過ぎた）
  ev('c', { starts_at: '2027-10-14T04:00:00+00:00', ends_at: '2027-10-14T06:00:00+00:00', audience: 'groups' }), // 10/14 13:00〜15:00
  ev('d', { kind: 'deadline', starts_at: '2027-10-15T08:00:00+00:00' }), // 10/15 17:00 の締切
];
const MODULE_ITEMS: DatedItem[] = [
  mod('furniture:request-close', '2027-10-14T08:00:00+00:00', { kind: 'deadline', href: '/requests' }), // 10/14 17:00
  mod('furniture:day1', '2027-10-14'),
];
const ALL: CalendarFilter = { past: false, kind: null, audience: null };
const shape = (days: CalendarDay[]) => days.map((d) => [d.date, d.entries.map((e) => e.item.id)]);

describe('T18 parseCalendarParams・calendarHref（URL の絞り込み）', () => {
  const p = (q: string, soumu = true) => parseCalendarParams(new URLSearchParams(q), soumu);

  it('?past=1・?kind=・?audience=・?event= を読む（既定は今日から・すべて）', () => {
    expect(p('')).toEqual({ past: false, kind: null, audience: null, highlight: null });
    expect(p('past=1&kind=deadline&audience=groups&event=abc')).toEqual({ past: true, kind: 'deadline', audience: 'groups', highlight: 'abc' });
    expect(p('kind=event&audience=all').kind).toBe('event');
    expect(p('audience=soumu').audience).toBe('soumu');
  });

  it('知らない値は「すべて」。past は 1 だけ。?event= は前後の空白を除き、空なら null', () => {
    expect(p('past=true&kind=meeting&audience=all_groups&event=%20%20')).toEqual({ past: false, kind: null, audience: null, highlight: null });
    expect(p('event=%20e1%20').highlight).toBe('e1');
  });

  it('総務でなければ種類・対象の絞り込みを読まない（過去も表示と ?event= は読む）', () => {
    expect(p('past=1&kind=deadline&audience=groups&event=e1', false)).toEqual({ past: true, kind: null, audience: null, highlight: 'e1' });
  });

  it('calendarHref は既定の値を入れない', () => {
    expect(calendarHref(ALL)).toBe('/calendar');
    expect(calendarHref({ past: true, kind: 'deadline', audience: 'all' })).toBe('/calendar?past=1&kind=deadline&audience=all');
    expect(calendarHref({ past: false, kind: null, audience: 'groups' })).toBe('/calendar?audience=groups');
  });
});

describe('T18 buildCalendarDays（日ごとの一覧）', () => {
  it('既定は今日から：最後の日が今日より前のもの（昨日の予定・過ぎた締切）は出さず、今日のうちに過ぎたものは出す。続いている項目は今日にまとめる', () => {
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, ALL))).toEqual([
      // 日の中は日付だけのもの（開始の早い順、同じなら機能の登録の順〔机椅子 → 締切と予定〕）→ 時刻のあるもの（開始の早い順）
      ['2027-10-14', ['calendar:e', 'furniture:day1', 'calendar:a', 'calendar:b', 'calendar:c', 'furniture:request-close']],
      ['2027-10-15', ['calendar:d']],
    ]);
  });

  it('過去も表示：その年度の全部を開始の日にまとめる（日の早い順）', () => {
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { ...ALL, past: true }))).toEqual([
      ['2027-10-10', ['calendar:g']],
      ['2027-10-12', ['calendar:e']],
      ['2027-10-13', ['calendar:f']],
      ['2027-10-14', ['furniture:day1', 'calendar:a', 'calendar:b', 'calendar:c', 'furniture:request-close']],
      ['2027-10-15', ['calendar:d']],
    ]);
  });

  it('項目は表の行（event）を持ち、機能の日付は event が null。項目の DatedItem は eventDatedItem と同じ', () => {
    const [today] = buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, ALL);
    const a = today!.entries.find((x) => x.item.id === 'calendar:a')!;
    expect(a.event).toBe(EVENTS[3]);
    expect(a.item).toEqual(eventDatedItem(EVENTS[3]!));
    expect(today!.entries.find((x) => x.item.id === 'furniture:day1')!.event).toBeNull();
  });

  it('種類の絞り込みは項目と機能の日付の両方に効く', () => {
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { ...ALL, kind: 'deadline' }))).toEqual([
      ['2027-10-14', ['furniture:request-close']],
      ['2027-10-15', ['calendar:d']],
    ]);
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { past: true, kind: 'event', audience: null })).flatMap(([, ids]) => ids)).toEqual([
      'calendar:e',
      'calendar:f',
      'furniture:day1',
      'calendar:a',
      'calendar:b',
      'calendar:c',
    ]);
  });

  it('対象で絞ると項目だけ（機能の日付は対象を持たないので出さない）', () => {
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { ...ALL, audience: 'groups' }))).toEqual([['2027-10-14', ['calendar:e', 'calendar:c']]]);
    expect(shape(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { past: true, kind: 'deadline', audience: 'all' }))).toEqual([['2027-10-10', ['calendar:g']]]);
    expect(buildCalendarDays(EVENTS, MODULE_ITEMS, NOW, { ...ALL, audience: 'soumu', kind: 'deadline' }).flatMap((d) => d.entries.map((e) => e.event?.audience))).toEqual(['soumu']);
  });

  it('同じ開始の時刻は機能の登録の順、同じ機能の中は元の順（項目は開始・id の順）', () => {
    const same = [ev('x2', { starts_at: '2027-10-16T01:00:00+00:00' }), ev('x1', { starts_at: '2027-10-16T01:00:00+00:00' })];
    const days = buildCalendarDays(same, [mod('furniture:z', '2027-10-16T01:00:00+00:00'), mod('notices:y', '2027-10-16T01:00:00+00:00', { moduleId: 'notices' })], NOW, ALL);
    expect(shape(days)).toEqual([['2027-10-16', ['furniture:z', 'notices:y', 'calendar:x2', 'calendar:x1']]]);
  });

  it('読めない日時のものは出さない。元の配列は変えない。何もなければ空', () => {
    const before = EVENTS.map((e) => e.id);
    const days = buildCalendarDays([...EVENTS, ev('bad', { starts_at: 'oops' }), ev('badEnd', { ends_at: 'oops' })], [...MODULE_ITEMS, mod('furniture:bad', 'oops'), mod('furniture:noDay', '2027-02-30')], NOW, {
      ...ALL,
      past: true,
    });
    const ids = days.flatMap((d) => d.entries.map((e) => e.item.id));
    for (const id of ['calendar:bad', 'calendar:badEnd', 'furniture:bad', 'furniture:noDay']) expect(ids).not.toContain(id);
    expect(days.flatMap((d) => d.entries)).toHaveLength(EVENTS.length + MODULE_ITEMS.length);
    expect(EVENTS.map((e) => e.id)).toEqual(before);
    expect(buildCalendarDays([], [], NOW, ALL)).toEqual([]);
  });

  it('日の境目は Asia/Tokyo：10/14 23:59:59.999 までは 10/14 の項目を出し、10/15 00:00 から出さない（既定）', () => {
    const items = [ev('t', { all_day: true, starts_at: '2027-10-13T15:00:00+00:00' })];
    expect(shape(buildCalendarDays(items, [], Date.parse('2027-10-14T14:59:59.999Z'), ALL))).toEqual([['2027-10-14', ['calendar:t']]]);
    expect(buildCalendarDays(items, [], Date.parse('2027-10-14T15:00:00Z'), ALL)).toEqual([]);
  });
});

describe('T18 dayRelative・entryTimeLabel・entryRelative（日の見出しと1件の文）', () => {
  it('日の見出しの相対の言い方（その日の予定として：今日・明日・あと N 日・N 日前）', () => {
    expect(dayRelative('2027-10-14', NOW)).toBe('今日');
    expect(dayRelative('2027-10-15', NOW)).toBe('明日');
    expect(dayRelative('2027-10-17', NOW)).toBe('あと 3 日');
    expect(dayRelative('2027-10-12', NOW)).toBe('2 日前');
    expect(dayRelative('oops', NOW)).toBe('');
  });

  it('時刻の文：日付だけは「終日」（最後の日が別の日なら「終日（〜10/15（金））」）、時刻は開始と終わり（別の日なら日付と曜日も）', () => {
    const item = (row: CalendarEventRow) => eventDatedItem(row);
    expect(entryTimeLabel(item(EVENTS[3]!), '2027-10-14', NOW)).toBe('終日');
    expect(entryTimeLabel(item(EVENTS[1]!), '2027-10-12', NOW)).toBe('終日（〜10/15（金））');
    expect(entryTimeLabel(item(EVENTS[4]!), '2027-10-14', NOW)).toBe('09:00');
    expect(entryTimeLabel(item(EVENTS[5]!), '2027-10-14', NOW)).toBe('13:00〜15:00');
    expect(entryTimeLabel(item(ev('h', { starts_at: '2027-10-14T04:00:00+00:00', ends_at: '2027-10-15T03:00:00+00:00' })), '2027-10-14', NOW)).toBe(
      '13:00〜10/15（金）12:00',
    );
    // 年をまたぐ終わり（今年と違う年は年も）
    expect(entryTimeLabel(item(ev('y', { starts_at: '2027-12-31T04:00:00+00:00', ends_at: '2028-01-01T03:00:00+00:00' })), '2027-12-31', NOW)).toBe(
      '13:00〜2028/1/1（土）12:00',
    );
  });

  it('今日にまとめた続いている項目は、開始の日も入れる（ダッシュボードの欄と同じ形）', () => {
    expect(entryTimeLabel(eventDatedItem(EVENTS[1]!), '2027-10-14', NOW)).toBe('10/12（火）〜10/15（金）');
    expect(entryTimeLabel(eventDatedItem(ev('i', { starts_at: '2027-10-13T04:00:00+00:00', ends_at: '2027-10-15T03:00:00+00:00' })), '2027-10-14', NOW)).toBe(
      '10/13（水）13:00〜10/15（金）12:00',
    );
  });

  it('1件の相対の言い方は、日の見出しと違うときだけ（過ぎた締切・期限が別の日の締切など）', () => {
    expect(entryRelative(eventDatedItem(EVENTS[3]!), '2027-10-14', NOW)).toBeNull();
    expect(entryRelative(MODULE_ITEMS[0]!, '2027-10-14', NOW)).toBeNull();
    expect(entryRelative(eventDatedItem(EVENTS[1]!), '2027-10-14', NOW)).toBeNull();
    expect(entryRelative(eventDatedItem(EVENTS[2]!), '2027-10-13', NOW)).toBeNull();
    expect(entryRelative(eventDatedItem(EVENTS[0]!), '2027-10-10', NOW)).toBe('締切を過ぎました');
    // 今日の 09:00 に過ぎた締切（今日の見出しの下）
    expect(entryRelative(eventDatedItem(ev('p', { kind: 'deadline', starts_at: '2027-10-14T00:00:00+00:00' })), '2027-10-14', NOW)).toBe('締切を過ぎました');
    // 期限（終わり）が別の日の締切：今日にまとめても「あと 6 日」
    expect(
      entryRelative(eventDatedItem(ev('w', { kind: 'deadline', starts_at: '2027-10-10T00:00:00+00:00', ends_at: '2027-10-20T08:00:00+00:00' })), '2027-10-14', NOW),
    ).toBe('あと 6 日');
    // 続いている予定を過去も表示で開始の日に出すと、見出し（2 日前）と違うので「今日」
    expect(entryRelative(eventDatedItem(EVENTS[1]!), '2027-10-12', NOW)).toBe('今日');
  });
});
