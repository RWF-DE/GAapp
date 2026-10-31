// 締切と予定のプロバイダと欄の読み取り（04「締切と予定」の「ダッシュボードに出すもの」、notes/T18.md「後半（画面）の約束」3。T18）
import { describe, expect, it } from 'vitest';
import type { GroupSummary, Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { PORTAL_WIDGETS, portalContextsOf, portalWidgetQuery, type PortalContext, type PortalSection } from '@/lib/modules/portal';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import { CALENDAR_DATED_SELECT, calendarDatedOptions, loadCalendarDated, type CalendarDatedRow } from './dated';
import { EVENT_AUDIENCE_LABELS, EVENT_KIND_LABELS } from './labels';
import { calendarPortalProvider, eventDatedItem } from './portal';

const Y = '11111111-1111-4111-8111-111111111111';
const year = { id: Y, label: 'R8', status: 'requesting', festival_start: '2026-10-17' } as unknown as YearRow;
const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };

function member(role: AppRole | null, groups: GroupSummary[] = []): Membership {
  const y = { id: Y, label: 'R8', status: 'requesting' as const, festival_start: '2026-10-17' };
  return { displayName: null, year: y, role, groups, years: [y], latestYear: y, adminOfOpenYear: false };
}
const ctxOf = (m: Membership, kind: PortalContext['kind']) => portalContextsOf(m, year, 0).find((c) => c.kind === kind)!;

const row = (over: Partial<CalendarDatedRow>): CalendarDatedRow => ({
  id: 'e1',
  kind: 'event',
  title: '説明会',
  starts_at: '2027-10-14T04:00:00+00:00',
  ends_at: null,
  all_day: false,
  ...over,
});

describe('T18 eventDatedItem（予定と締切の行 → 締切と予定の1件）', () => {
  it('id は calendar:<id>、行き先は /calendar?event=<id>、種類と題名はそのまま', () => {
    expect(eventDatedItem(row({ id: 'abc', kind: 'deadline', title: '書類の提出' }))).toEqual({
      id: 'calendar:abc',
      moduleId: 'calendar',
      title: '書類の提出',
      kind: 'deadline',
      href: '/calendar?event=abc',
      at: '2027-10-14T04:00:00+00:00',
    });
  });

  it('終日の1日：開始は Asia/Tokyo の日付（UTC の 15:00 は次の日）、終わりは付けない', () => {
    const d = eventDatedItem(row({ all_day: true, starts_at: '2027-10-15T15:00:00+00:00' }));
    expect(d.at).toBe('2027-10-16');
    expect(d).not.toHaveProperty('end');
    // 終わりが同じ日（DB は許す）も付けない
    expect(eventDatedItem(row({ all_day: true, starts_at: '2027-10-15T15:00:00+00:00', ends_at: '2027-10-15T15:00:00+00:00' }))).not.toHaveProperty('end');
  });

  it('終日の2日間：終わりは最後の日（Asia/Tokyo の日付。翌日の 0 時ではない）', () => {
    const d = eventDatedItem(row({ all_day: true, starts_at: '2027-10-15T15:00:00+00:00', ends_at: '2027-10-16T15:00:00+00:00' }));
    expect([d.at, d.end]).toEqual(['2027-10-16', '2027-10-17']);
  });

  it('時刻つき：開始・終わりは timestamptz のまま。終わりが開始と同じ時刻（表し方が違っても）なら付けない', () => {
    const d = eventDatedItem(row({ starts_at: '2027-10-14T04:00:00+00:00', ends_at: '2027-10-14T06:00:00+00:00' }));
    expect([d.at, d.end]).toEqual(['2027-10-14T04:00:00+00:00', '2027-10-14T06:00:00+00:00']);
    expect(eventDatedItem(row({ starts_at: '2027-10-14T04:00:00+00:00', ends_at: '2027-10-14T13:00:00+09:00' }))).not.toHaveProperty('end');
  });

  it('締切の終わり（期限）も付ける', () => {
    const d = eventDatedItem(row({ kind: 'deadline', starts_at: '2027-10-10T00:00:00+00:00', ends_at: '2027-10-20T08:00:00+00:00' }));
    expect([d.kind, d.end]).toEqual(['deadline', '2027-10-20T08:00:00+00:00']);
  });
});

describe('T18 calendarPortalProvider（締切と予定のプロバイダ）', () => {
  it('機能は calendar、種類は総務・閲覧のみ・団体代表。読み取りの結果を使う欄は締切と予定だけ。年度の行だけで決まる項目はない', () => {
    expect(calendarPortalProvider.moduleId).toBe('calendar');
    expect(calendarPortalProvider.kinds).toEqual(['soumu', 'viewer', 'rep']);
    expect(calendarPortalProvider.query?.widgets).toEqual(['dated']);
    expect(calendarPortalProvider.fromYear).toBeUndefined();
  });

  it('種類ごとのキー：総務は soumu、閲覧のみは viewer、ロールのない店長・副店長は rep（団体の id を入れない）', () => {
    const q = calendarPortalProvider.query!;
    expect(q.options(ctxOf(member('staff'), 'soumu'))?.queryKey).toEqual(['year', Y, 'portal', 'calendar', 'soumu']);
    expect(q.options(ctxOf(member('viewer'), 'viewer'))?.queryKey).toEqual(['year', Y, 'portal', 'calendar', 'viewer']);
    expect(q.options(ctxOf(member(null, [G1]), 'rep'))?.queryKey).toEqual(['year', Y, 'portal', 'calendar', 'rep']);
    expect(q.options(ctxOf(member('head'), 'soumu'))?.queryKey).toEqual(calendarDatedOptions(Y, 'soumu').queryKey);
  });

  it('店長・副店長も務める管理者・閲覧のみの団体代表の分は読まない（総務・閲覧のみとして読む分と同じ結果）', () => {
    for (const role of ['admin', 'viewer'] as const) {
      const m = member(role, [G1]);
      expect(calendarPortalProvider.query!.options(ctxOf(m, 'rep')), role).toBeNull();
      expect(calendarPortalProvider.query!.options(ctxOf(m, role === 'admin' ? 'soumu' : 'viewer')), role).not.toBeNull();
    }
  });

  it('select の結果は締切と予定の欄の分だけ（カード・要対応・お知らせはない）', () => {
    const opts = calendarPortalProvider.query!.options(ctxOf(member('staff'), 'soumu'))!;
    const section = (opts.select as (raw: unknown) => PortalSection)([row({ id: 'e1' }), row({ id: 'e2', kind: 'deadline', all_day: true, starts_at: '2027-10-15T15:00:00+00:00' })]);
    expect(section.card).toBeNull();
    expect(section.todos).toEqual([]);
    expect(section).not.toHaveProperty('notices');
    expect(section.dated.map((d) => [d.id, d.at, d.kind])).toEqual([
      ['calendar:e1', '2027-10-14T04:00:00+00:00', 'event'],
      ['calendar:e2', '2027-10-16', 'deadline'],
    ]);
  });

  it('要対応・総務内のお知らせ・お知らせ・カードの欄には並べない（読み込み中・失敗をその欄に出さない）', () => {
    for (const m of [member('admin', [G1]), member('viewer', [G1]), member('staff'), member(null, [G1])]) {
      for (const ctx of portalContextsOf(m, year, 0)) {
        for (const w of PORTAL_WIDGETS) {
          const q = portalWidgetQuery(calendarPortalProvider, ctx, w);
          if (w !== 'dated') expect(q, `${ctx.kind}・${w}`).toBeNull();
        }
      }
    }
  });
});

describe('T18 loadCalendarDated（欄の読み取り）', () => {
  it('year_id で絞り、開始・id の順に全部（range で 1000 件ずつ）。読むのは id・種類・題名・開始・終わり・終日だけ', async () => {
    const rows = [row({ id: 'e1' })];
    const { client, issued } = createFakeSupabase(() => ({ data: rows }));
    expect(await loadCalendarDated(Y, client)).toEqual(rows);
    expect(issued).toHaveLength(1);
    const c = issued[0]!;
    expect(c.table).toBe('events');
    expect(opArgs(c, 'select')).toEqual([[CALENDAR_DATED_SELECT]]);
    expect(CALENDAR_DATED_SELECT).toBe('id, kind, title, starts_at, ends_at, all_day');
    for (const col of ['audience', 'note', 'created_by', 'updated_by', 'profiles']) expect(CALENDAR_DATED_SELECT).not.toContain(col);
    expect(opArgs(c, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(c, 'order')).toEqual([['starts_at'], ['id']]);
    expect(opArgs(c, 'range')).toEqual([[0, 999]]);
    expect(opArgs(c, 'in')).toEqual([]);
    expect(opArgs(c, 'gte')).toEqual([]);
  });

  it('1000 件を超えれば続きを読む', async () => {
    const page = Array.from({ length: 1000 }, (_, k) => row({ id: `e${k}` }));
    const { client, issued } = createFakeSupabase((call) => ({ data: opArgs(call, 'range')[0]![0] === 0 ? page : [row({ id: 'last' })] }));
    expect(await loadCalendarDated(Y, client)).toHaveLength(1001);
    expect(issued.map((c) => opArgs(c, 'range')[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('読めなければ AppError を投げる（欄が失敗ともう一度を出す）', async () => {
    const { client } = createFakeSupabase(() => ({ error: { code: '42501', message: 'denied' }, status: 403 }));
    await expect(loadCalendarDated(Y, client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T18 表示名（lib/modules/calendar/labels.ts）', () => {
  it('種類：締切・予定、対象：総務・団体・全員（02 の列挙の表示名）', () => {
    expect(EVENT_KIND_LABELS).toEqual({ deadline: '締切', event: '予定' });
    expect(EVENT_AUDIENCE_LABELS).toEqual({ soumu: '総務', groups: '団体', all: '全員' });
  });
});
