import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { GroupSummary, Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import {
  EMPTY_PORTAL_SECTION,
  PORTAL_DATED_LIMIT,
  PORTAL_NOTICE_LIMIT,
  PORTAL_WIDGETS,
  datedTime,
  latestNotices,
  mergePortalSections,
  moduleLabel,
  portalContextsOf,
  portalKindsOf,
  portalQueryKey,
  portalSectionOf,
  sortTodos,
  upcomingDated,
  type DatedItem,
  type ModuleCardModel,
  type NoticeDigest,
  type PortalContext,
  type PortalSection,
  type TodoItem,
} from './portal';
import type { ModuleId } from './registry';

// 機能の登録の順を確かめるため、2つ目の機能（T17 のお知らせを仮に置く）を足した登録にする
vi.mock('./registry', () => ({
  MODULES: [
    { id: 'furniture', label: '机椅子', homeHref: '/furniture' },
    { id: 'notices', label: 'お知らせ', homeHref: '/notices' },
  ],
}));
const NOTICES = 'notices' as string as ModuleId;

const Y = '11111111-1111-4111-8111-111111111111';
const year: YearRow = {
  id: Y,
  label: 'R8',
  status: 'requesting',
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: null,
  request_close_at: '2026-10-05T08:00:00+00:00',
  prev_year_id: null,
  updated_at: 't',
};
const group = (k: number): GroupSummary => ({ id: `g${k}`, name: `模擬店0${k}`, year_id: Y, role: 'manager' });
const todo = (id: string, severity: TodoItem['severity'], extra: Partial<TodoItem> = {}): TodoItem => ({
  id,
  moduleId: 'furniture',
  title: id,
  severity,
  href: '/',
  ...extra,
});
const dated = (id: string, at: string, extra: Partial<DatedItem> = {}): DatedItem => ({ id, moduleId: 'furniture', title: id, at, kind: 'event', ...extra });
const card = (moduleId: ModuleId, title: string): ModuleCardModel => ({ moduleId, title, lines: [title], href: null, linkLabel: '開く' });

describe('T16 portalKindsOf（立場の種類）', () => {
  const m = (role: AppRole | null, groups = 0) => ({ role, groups: Array.from({ length: groups }, (_, k) => group(k + 1)) });
  it.each([
    ['admin', 0, ['soumu']],
    ['head', 0, ['soumu']],
    ['deputy_head', 0, ['soumu']],
    ['staff', 0, ['soumu']],
    ['viewer', 0, ['viewer']],
    [null, 1, ['rep']],
    ['admin', 1, ['soumu', 'rep']],
    ['viewer', 2, ['viewer', 'rep']],
    [null, 0, []],
  ] as const)('%s・団体 %i → %j', (role, groups, kinds) => {
    expect(portalKindsOf(m(role, groups))).toEqual(kinds);
  });
});

describe('T16 portalContextsOf', () => {
  it('種類ごとに、立場全体（audiences）と年度の行・開いた時刻を持つ', () => {
    const g = group(1);
    const m: Membership = {
      displayName: null,
      year: { id: Y, label: 'R8', status: 'requesting', festival_start: '2026-10-17' },
      role: 'admin',
      groups: [g],
      years: [],
      latestYear: null,
      adminOfOpenYear: true,
    };
    const ctxs = portalContextsOf(m, year, 123);
    expect(ctxs).toEqual([
      { kind: 'soumu', year, role: 'admin', groups: [g], audiences: ['admin', 'rep'], now: 123 },
      { kind: 'rep', year, role: 'admin', groups: [g], audiences: ['admin', 'rep'], now: 123 },
    ]);
    expect(portalContextsOf({ ...m, role: null, groups: [] }, year, 1)).toEqual([]);
  });
});

describe('T16 portalQueryKey', () => {
  it("['year', yearId, 'portal', moduleId, kind, ...extra]（queryKeys.yearPart と同じ形）", () => {
    expect(portalQueryKey(Y, 'furniture', 'soumu')).toEqual(['year', Y, 'portal', 'furniture', 'soumu']);
    expect(portalQueryKey(Y, 'furniture', 'rep', 'g1', 'g2')).toEqual(queryKeys.yearPart(Y, 'portal', 'furniture', 'rep', 'g1', 'g2'));
  });

  it('年度の下にあるので、年度の invalidate（状態の遷移の後）で一緒に読み直しになる', async () => {
    const qc = new QueryClient();
    const key = portalQueryKey(Y, 'furniture', 'soumu');
    const other = portalQueryKey('22222222-2222-4222-8222-222222222222', 'furniture', 'soumu');
    qc.setQueryData(key, 1);
    qc.setQueryData(other, 1);
    await qc.invalidateQueries({ queryKey: queryKeys.year(Y) });
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe('T16 portalSectionOf', () => {
  const ctx: PortalContext = { kind: 'soumu', year, role: 'admin', groups: [], audiences: ['admin'], now: 0 };
  const fromYear: PortalSection = { card: null, todos: [todo('y', 'normal')], dated: [] };
  const read: PortalSection = { card: card('furniture', '机椅子'), todos: [todo('y', 'normal'), todo('r', 'normal')], dated: [] };

  it('query の data があればそれ（fromYear と足し合わせない）、なければ fromYear、どちらもなければ空', () => {
    expect(portalSectionOf({ fromYear: () => fromYear }, ctx, read)).toBe(read);
    expect(portalSectionOf({ fromYear: () => fromYear }, ctx, undefined)).toBe(fromYear);
    expect(portalSectionOf({}, ctx)).toEqual({ card: null, todos: [], dated: [] });
    expect(portalSectionOf({}, ctx)).toBe(EMPTY_PORTAL_SECTION);
  });
});

describe('T16 moduleLabel', () => {
  it('登録の名前', () => {
    expect(moduleLabel('furniture')).toBe('机椅子');
    expect(moduleLabel(NOTICES)).toBe('お知らせ');
  });
});

describe('T16 sortTodos（要対応の並び）', () => {
  it('急ぎ → ふつう → 参考（info）、同じなら期日の早い順（期日のないものは後）、機能の登録の順、元の順', () => {
    const input = [
      todo('info', 'info', { due: '2026-10-01T00:00:00Z' }),
      todo('n-furniture-1', 'normal'),
      todo('u-late', 'urgent', { due: '2026-10-05T08:00:00Z' }),
      todo('u-nodue', 'urgent'),
      todo('u-early', 'urgent', { due: '2026-10-04T08:00:00Z' }),
      todo('n-notices', 'normal', { moduleId: NOTICES }),
      todo('n-furniture-2', 'normal'),
      todo('n-notices-due', 'normal', { moduleId: NOTICES, due: '2026-10-09T00:00:00Z' }),
    ];
    const before = input.map((t) => t.id);
    expect(sortTodos(input).map((t) => t.id)).toEqual([
      'u-early',
      'u-late',
      'u-nodue',
      'n-notices-due',
      'n-furniture-1',
      'n-furniture-2',
      'n-notices',
      'info',
    ]);
    expect(input.map((t) => t.id)).toEqual(before); // 元の配列は変えない
  });

  it('読めない期日は期日なしとして扱う。空なら空', () => {
    expect(sortTodos([todo('bad', 'normal', { due: 'oops' }), todo('ok', 'normal', { due: '2026-10-01T00:00:00Z' })]).map((t) => t.id)).toEqual([
      'ok',
      'bad',
    ]);
    expect(sortTodos([])).toEqual([]);
  });
});

describe('T16 upcomingDated（これからの締切と予定）', () => {
  // Asia/Tokyo の 2026-10-16 23:59:59.999（UTC では 14:59:59.999）
  const now = Date.parse('2026-10-16T14:59:59.999Z');
  const items = [
    dated('time-now', '2026-10-16T14:59:59.999Z'), // ちょうど今は出さない（今より後だけ）
    dated('time-next', '2026-10-16T15:00:00Z'), // Asia/Tokyo の 10/17 00:00
    dated('notice-day', '2026-10-17', { moduleId: NOTICES }),
    dated('today', '2026-10-16'), // 今日（Asia/Tokyo）は出す
    dated('yesterday', '2026-10-15'),
    dated('day1', '2026-10-17'), // time-next と同じ時刻（Asia/Tokyo の 0 時）
    dated('broken', 'oops'),
    dated('deadline', '2026-10-20T08:00:00+00:00', { kind: 'deadline' }),
  ];

  it('時刻のあるものは今より後、日付だけは今日（Asia/Tokyo）以降。早い順、同じ時刻は機能の登録の順・元の順', () => {
    const r = upcomingDated(items, now);
    expect(r.items.map((d) => d.id)).toEqual(['today', 'time-next', 'day1', 'notice-day', 'deadline']);
    expect(r.more).toBe(0);
  });

  it('日付の境目：UTC の 15:00 で Asia/Tokyo の次の日になる', () => {
    const r = upcomingDated(items, Date.parse('2026-10-16T15:00:00Z'));
    expect(r.items.map((d) => d.id)).toEqual(['day1', 'notice-day', 'deadline']);
  });

  it(`既定で ${PORTAL_DATED_LIMIT} 件まで、残りは more。limit を渡せる`, () => {
    const many = Array.from({ length: 10 }, (_, k) => dated(`d${k}`, `2026-11-${String(k + 1).padStart(2, '0')}`));
    const r = upcomingDated(many, now);
    expect(r.items.map((d) => d.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    expect(r.more).toBe(2);
    expect(upcomingDated(many, now, 3)).toMatchObject({ more: 7 });
    expect(upcomingDated(many, now, 20)).toMatchObject({ more: 0 });
    expect(upcomingDated([], now)).toEqual({ items: [], more: 0 });
  });

  it('datedTime：日付だけは Asia/Tokyo の 0 時、読めなければ null', () => {
    expect(datedTime('2026-10-17')).toBe(Date.parse('2026-10-16T15:00:00Z'));
    expect(datedTime('2026-10-05T08:00:00+00:00')).toBe(Date.parse('2026-10-05T08:00:00Z'));
    expect(datedTime('oops')).toBeNull();
    expect(datedTime('2026-13-45')).toBeNull();
  });
});

describe('T16 mergePortalSections（兼ねた人の欄を機能ごとにまとめる）', () => {
  it('要対応と締切と予定は種類の順（総務 → 閲覧のみ → 団体代表）で同じ id を1回だけ、カードは種類の順で最初の null でないもの', () => {
    const x = dated('x', '2026-10-17');
    const merged = mergePortalSections([
      { moduleId: 'furniture', kind: 'rep', section: { card: null, todos: [todo('rep-1', 'normal')], dated: [x, dated('y', '2026-10-18')] } },
      { moduleId: NOTICES, kind: 'soumu', section: { card: card(NOTICES, 'お知らせ'), todos: [], dated: [] } },
      { moduleId: 'furniture', kind: 'soumu', section: { card: null, todos: [todo('soumu-1', 'urgent')], dated: [x] } },
      { moduleId: 'furniture', kind: 'viewer', section: { card: card('furniture', '閲覧'), todos: [], dated: [x] } },
    ]);
    expect(merged).toEqual([
      {
        moduleId: 'furniture',
        card: card('furniture', '閲覧'),
        todos: [todo('soumu-1', 'urgent'), todo('rep-1', 'normal')],
        dated: [x, dated('y', '2026-10-18')],
      },
      { moduleId: NOTICES, card: card(NOTICES, 'お知らせ'), todos: [], dated: [] },
    ]);
  });

  it('総務のカードがあれば閲覧のみのカードより先。機能がなければ空', () => {
    const merged = mergePortalSections([
      { moduleId: 'furniture', kind: 'viewer', section: { card: card('furniture', '閲覧'), todos: [], dated: [] } },
      { moduleId: 'furniture', kind: 'soumu', section: { card: card('furniture', '総務'), todos: [], dated: [] } },
    ]);
    expect(merged.map((m) => m.card?.title)).toEqual(['総務']);
    expect(mergePortalSections([])).toEqual([]);
  });
});

describe('T17 お知らせの欄（PORTAL_WIDGETS・latestNotices・mergePortalSections の notices。D-52 の T17 の直し）', () => {
  const digest = (id: string, at: string, pinned = false): NoticeDigest => ({
    id,
    moduleId: NOTICES,
    title: id,
    at,
    pinned,
    audience: 'soumu',
    href: `/notices?notice=${id}`,
  });

  it('欄の並びは 要対応 → 締切と予定 → 総務内のお知らせ → お知らせ → 機能ごとのカード（04「ダッシュボード」）', () => {
    expect(PORTAL_WIDGETS).toEqual(['todos', 'dated', 'soumuNotices', 'notices', 'cards']);
  });

  it('latestNotices：ピン留めのものを先に、その中と残りは出した日時の新しい順、同じなら id の順に 5 件。元の配列は変えない', () => {
    const items = [
      digest('a', '2026-10-01T00:00:00Z'),
      digest('b', '2026-10-03T00:00:00Z'),
      digest('p-old', '2026-09-01T00:00:00Z', true),
      digest('p-new', '2026-09-02T00:00:00Z', true),
      digest('c2', '2026-10-02T00:00:00Z'),
      digest('c1', '2026-10-02T00:00:00Z'),
      digest('z', '2026-08-01T00:00:00Z'),
    ];
    const before = items.map((x) => x.id);
    expect(PORTAL_NOTICE_LIMIT).toBe(5);
    expect(latestNotices(items).map((x) => x.id)).toEqual(['p-new', 'p-old', 'b', 'c1', 'c2']);
    expect(items.map((x) => x.id)).toEqual(before);
    expect(latestNotices(items, 2).map((x) => x.id)).toEqual(['p-new', 'p-old']);
    expect(latestNotices(items, 0)).toEqual([]);
    expect(latestNotices([])).toEqual([]);
  });

  it('latestNotices：読めない日時は同じ並びの中で後ろ', () => {
    expect(latestNotices([digest('bad', 'nope'), digest('ok', '2026-10-01T00:00:00Z')]).map((x) => x.id)).toEqual(['ok', 'bad']);
  });

  it('mergePortalSections：お知らせは種類の順（総務 → 閲覧のみ → 団体代表）につなぎ、同じ id は最初の1件。どの部分も持たなければ付けない', () => {
    const s1 = digest('s1', '2026-10-01T00:00:00Z');
    const g1 = { ...digest('g1', '2026-10-02T00:00:00Z'), audience: 'all_groups' as const };
    const g1Again = { ...g1, title: '重なり' };
    const merged = mergePortalSections([
      { moduleId: NOTICES, kind: 'rep', section: { card: null, todos: [], dated: [], notices: [g1Again] } },
      { moduleId: 'furniture', kind: 'soumu', section: { card: null, todos: [], dated: [] } },
      { moduleId: NOTICES, kind: 'soumu', section: { card: null, todos: [], dated: [], notices: [s1, g1] } },
    ]);
    expect(merged).toEqual([
      { moduleId: 'furniture', card: null, todos: [], dated: [] },
      { moduleId: NOTICES, card: null, todos: [], dated: [], notices: [s1, g1] },
    ]);
    expect('notices' in merged[0]!).toBe(false);
    // 空の配列は「持つ」（欄は空の文を出す）
    expect(mergePortalSections([{ moduleId: NOTICES, kind: 'viewer', section: { card: null, todos: [], dated: [], notices: [] } }])).toEqual([
      { moduleId: NOTICES, card: null, todos: [], dated: [], notices: [] },
    ]);
  });
});
