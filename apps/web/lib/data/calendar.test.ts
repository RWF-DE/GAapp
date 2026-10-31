// 締切と予定（/calendar）の読み取りと書き込み（lib/data/calendar.ts。04「締切と予定」、notes/T18.md「後半（画面）の約束」4。T18）。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）。直接の insert・update・delete の形（送る値・条件・返す列）と、
// 0 行の分け方（explainZeroRows）を確かめる。
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, classifyError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import {
  CALENDAR_EVENTS_SELECT,
  calendarEventsOptions,
  calendarInvalidateKeys,
  deleteEvent,
  dropEventFromCache,
  EVENT_AUDIENCES,
  EVENT_KINDS,
  fetchCalendarEvents,
  insertEvent,
  newEventId,
  putEventInCache,
  readEvent,
  sameEventWrite,
  sortEvents,
  updateEvent,
  type CalendarEventRow,
  type EventWrite,
} from './calendar';

const Y = '11111111-1111-4111-8111-111111111111';
const E1 = '00000000-0000-4000-8000-000000000101';
/** DB の updated_at（マイクロ秒つき。受け取った文字列のまま条件に入れる） */
const V1 = '2027-10-01T00:00:00.123456+00:00';

const row = (over: Partial<CalendarEventRow> = {}): CalendarEventRow => ({
  id: E1,
  kind: 'event',
  audience: 'soumu',
  title: '説明会',
  starts_at: '2027-10-14T04:00:00+00:00',
  ends_at: null,
  all_day: false,
  note: null,
  updated_at: V1,
  ...over,
});
const write: EventWrite = {
  kind: 'deadline',
  audience: 'all',
  title: '書類の提出',
  starts_at: '2027-10-16T00:00:00+09:00',
  ends_at: null,
  all_day: true,
  note: 'メモ',
};
/** DB が返す行（全部の列。書いた人なども含む） */
const dbRow = (over: Partial<CalendarEventRow> = {}) => ({ ...row(over), year_id: Y, created_by: 'u1', updated_by: 'u1', created_at: V1 });
const NO_ROWS = { data: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T18 列挙と読む列', () => {
  it('種類・対象は 02 の列挙の並び。一覧は id・種類・対象・題名・開始・終わり・終日・メモ・updated_at（書いた人は読まない）', () => {
    expect(EVENT_KINDS).toEqual(['deadline', 'event']);
    expect(EVENT_AUDIENCES).toEqual(['soumu', 'groups', 'all']);
    expect(CALENDAR_EVENTS_SELECT).toBe('id, kind, audience, title, starts_at, ends_at, all_day, note, updated_at');
    for (const col of ['created_by', 'updated_by', 'year_id', 'profiles']) expect(CALENDAR_EVENTS_SELECT).not.toContain(col);
  });
});

describe('T18 fetchCalendarEvents・readEvent（読み取り）', () => {
  it('一覧：year_id で絞り、開始・id の順に全部（range）。読み込んだ時刻つき', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [row()] }));
    const d = await fetchCalendarEvents(Y, client);
    expect(d.events).toEqual([row()]);
    expect(Number.isNaN(Date.parse(d.loadedAt))).toBe(false);
    const c = issued[0]!;
    expect(c.table).toBe('events');
    expect(opArgs(c, 'select')).toEqual([[CALENDAR_EVENTS_SELECT]]);
    expect(opArgs(c, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(c, 'order')).toEqual([['starts_at'], ['id']]);
    expect(opArgs(c, 'range')).toEqual([[0, 999]]);
  });

  it('一覧のキーは ["year", 年度, "calendar", "events"]（書いた後の読み直しのキーの下）', () => {
    expect(calendarEventsOptions(Y).queryKey).toEqual(['year', Y, 'calendar', 'events']);
    expect(calendarEventsOptions(null).enabled).toBe(false);
    expect(calendarInvalidateKeys(Y)).toEqual([
      ['year', Y, 'calendar'],
      ['year', Y, 'portal', 'calendar'],
    ]);
  });

  it('1行：id で maybeSingle。なければ null、読めなければ AppError', async () => {
    const found = createFakeSupabase(() => ({ data: row() }));
    expect(await readEvent(E1, found.client)).toEqual(row());
    expect(opArgs(found.issued[0]!, 'eq')).toEqual([['id', E1]]);
    expect(found.issued[0]!.ops.some((o) => o.op === 'maybeSingle')).toBe(true);
    expect(await readEvent(E1, createFakeSupabase(() => NO_ROWS).client)).toBeNull();
    await expect(readEvent(E1, createFakeSupabase(() => ({ error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 })).client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T18 insertEvent（登録：画面が作った id で insert）', () => {
  it('id・year_id と送る値だけを入れ（書いた人・日時は送らない）、行を返させる', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: row({ ...write, id: E1 }) }));
    expect(await insertEvent(Y, E1, write, client)).toEqual(row({ ...write, id: E1 }));
    const c = issued[0]!;
    expect(c.table).toBe('events');
    expect(opArgs(c, 'insert')).toEqual([[{ id: E1, year_id: Y, ...write }]]);
    for (const col of ['created_by', 'updated_by', 'created_at', 'updated_at']) expect(opArgs(c, 'insert')[0]![0]).not.toHaveProperty(col);
    expect(opArgs(c, 'select')).toEqual([[CALENDAR_EVENTS_SELECT]]);
    expect(c.ops.some((o) => o.op === 'single')).toBe(true);
  });

  it('送り直しの 23505 は conflict、書けなければ（42501）forbidden、CHECK（23514）は input の AppError', async () => {
    const fail = async (code: string) => {
      try {
        await insertEvent(Y, E1, write, createFakeSupabase(() => ({ error: { code, message: 'x' }, status: 409 })).client);
      } catch (e) {
        return classifyError(e).kind;
      }
      return 'ok';
    };
    expect(await fail('23505')).toBe('conflict');
    expect(await fail('42501')).toBe('forbidden');
    expect(await fail('23514')).toBe('input');
  });
});

describe('T18 updateEvent・deleteEvent（楽観ロック。updated_at の文字列のまま）', () => {
  it('保存：全部の欄を送り、id と受け取った updated_at の文字列（マイクロ秒つき）を条件に入れる。返った行は一覧の列だけにする', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: dbRow({ ...write, updated_at: '2027-10-02T00:00:00.654321+00:00' }) }));
    const saved = await updateEvent(row(), write, client);
    expect(saved).toEqual(row({ ...write, updated_at: '2027-10-02T00:00:00.654321+00:00' }));
    expect(saved).not.toHaveProperty('created_by');
    const c = issued[0]!;
    expect(opArgs(c, 'update')).toEqual([[write]]);
    expect(opArgs(c, 'match')).toEqual([[{ id: E1 }]]);
    expect(opArgs(c, 'eq')).toEqual([['updated_at', V1]]);
    expect(c.ops.some((o) => o.op === 'maybeSingle')).toBe(true);
  });

  /** 0 行の後の読み直し（explainZeroRows）の応答を決める偽の DB */
  const zeroRows = (current: { updated_at: string } | null) =>
    createFakeSupabase((call: FakeCall) => (call.ops.some((o) => o.op === 'update' || o.op === 'delete') ? { data: call.ops.some((o) => o.op === 'delete') ? [] : null } : { data: current }));

  it.each([
    ['ない → not_found（lock_missing）', null, 'not_found', 'lock_missing'],
    ['版が違う → conflict（lock_conflict）', { updated_at: '2027-10-02T00:00:00+00:00' }, 'conflict', 'lock_conflict'],
    ['版が同じ → forbidden（lock_unchanged。権限か年度の状態が変わった）', { updated_at: V1 }, 'forbidden', 'lock_unchanged'],
  ] as const)('保存・削除が 0 行：%s', async (_name, current, kind, reason) => {
    for (const run of [(c: ReturnType<typeof zeroRows>['client']) => updateEvent(row(), write, c), (c: ReturnType<typeof zeroRows>['client']) => deleteEvent(row(), c)]) {
      const { client } = zeroRows(current);
      const e = await run(client).then(
        () => null,
        (x: unknown) => x,
      );
      expect(classifyError(e)).toMatchObject({ kind, reason });
    }
  });

  it('削除：id と updated_at を条件に入れて消えた行を受け取る', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [dbRow()] }));
    expect(await deleteEvent(row(), client)).toEqual(row());
    const c = issued[0]!;
    expect(c.ops.some((o) => o.op === 'delete')).toBe(true);
    expect(opArgs(c, 'match')).toEqual([[{ id: E1 }]]);
    expect(opArgs(c, 'eq')).toEqual([['updated_at', V1]]);
    expect(c.ops.some((o) => o.op === 'select')).toBe(true);
  });
});

describe('T18 sameEventWrite（読み直した行が送った値と同じか）', () => {
  const saved = row({ ...write, starts_at: '2027-10-15T15:00:00+00:00' });

  it('開始・終わりは同じ時刻なら表し方が違っても同じ（DB は UTC で返す）', () => {
    expect(sameEventWrite(saved, write)).toBe(true);
    expect(sameEventWrite({ ...saved, starts_at: '2027-10-15T15:00:00.000Z' }, write)).toBe(true);
    expect(sameEventWrite({ ...saved, starts_at: '2027-10-15T15:00:01+00:00' }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, ends_at: '2027-10-16T15:00:00+00:00' }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, ends_at: '2027-10-16T15:00:00+00:00' }, { ...write, ends_at: '2027-10-17T00:00:00+09:00' })).toBe(true);
  });

  it('種類・対象・題名・終日・メモのどれかが違えば違う。メモの null と空は同じ', () => {
    expect(sameEventWrite({ ...saved, kind: 'event' }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, audience: 'groups' }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, title: '書類の提出 ' }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, all_day: false }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, note: null }, write)).toBe(false);
    expect(sameEventWrite({ ...saved, note: '' }, { ...write, note: null })).toBe(true);
    expect(sameEventWrite({ ...saved, starts_at: 'oops' }, { ...write, starts_at: 'oops' })).toBe(false);
  });
});

describe('T18 一覧のキャッシュ（putEventInCache・dropEventFromCache・sortEvents）', () => {
  it('登録・保存した行を開始・id の順に入れ（同じ id は置き換え、余分な列は入れない）、消えた行を外す。キャッシュがなければ何もしない', () => {
    const qc = new QueryClient();
    const key = calendarEventsOptions(Y).queryKey;
    putEventInCache(qc, Y, row());
    expect(qc.getQueryData(key)).toBeUndefined();
    const early = row({ id: 'a', starts_at: '2027-10-01T00:00:00+00:00' });
    qc.setQueryData(key, { events: [early, row()], loadedAt: 't' });
    putEventInCache(qc, Y, { ...dbRow({ id: 'b', starts_at: '2027-10-05T00:00:00+00:00' }) });
    putEventInCache(qc, Y, row({ title: '直した' }));
    const data = qc.getQueryData(key)!;
    expect(data.events.map((e) => [e.id, e.title])).toEqual([
      ['a', early.title],
      ['b', '説明会'],
      [E1, '直した'],
    ]);
    expect(data.events[1]).not.toHaveProperty('created_by');
    dropEventFromCache(qc, Y, 'b');
    expect(qc.getQueryData(key)!.events.map((e) => e.id)).toEqual(['a', E1]);
  });

  it('sortEvents：開始の早い順、同じなら id の順（読めない日時は後ろ）。元の配列は変えない', () => {
    const list = [row({ id: 'b' }), row({ id: 'a' }), row({ id: 'x', starts_at: 'oops' }), row({ id: 'c', starts_at: '2027-10-01T00:00:00+00:00' })];
    expect(sortEvents(list).map((e) => e.id)).toEqual(['c', 'a', 'b', 'x']);
    expect(list.map((e) => e.id)).toEqual(['b', 'a', 'x', 'c']);
  });
});

describe('T18 newEventId（登録の id）', () => {
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('uuid v4 を作る（呼ぶたびに違う）', () => {
    const a = newEventId();
    expect(a).toMatch(UUID4);
    expect(newEventId()).not.toBe(a);
  });

  it('crypto.randomUUID のない環境（安全でない接続）では getRandomValues で作る', () => {
    const getRandomValues = <T extends ArrayBufferView>(b: T) => {
      new Uint8Array(b.buffer).fill(0xff);
      return b;
    };
    vi.stubGlobal('crypto', { getRandomValues });
    expect(newEventId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
