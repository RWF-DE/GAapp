import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { GroupSummary, Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import {
  DATED_OVERDUE,
  EMPTY_PORTAL_SECTION,
  PORTAL_DATED_DAYS,
  PORTAL_DATED_LIMIT,
  PORTAL_NOTICE_LIMIT,
  PORTAL_WIDGETS,
  datedDue,
  datedLastDay,
  datedRelative,
  datedStartDay,
  datedTime,
  datedWhen,
  isDatedPast,
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

// ---------------------------------------------------------------- T18：締切と予定の選び方と日付の出し方

describe('T18 締切と予定の日付（datedStartDay・datedLastDay・datedDue・isDatedPast）', () => {
  // 2027-10-14 12:00（Asia/Tokyo）
  const now = Date.parse('2027-10-14T03:00:00Z');

  it('開始の日・最後の日は Asia/Tokyo の日付（日付だけはそのまま）。期限は終わりがあれば終わり', () => {
    expect(datedStartDay(dated('a', '2027-10-15T15:00:00Z'))).toBe('2027-10-16');
    expect(datedStartDay(dated('a', '2027-10-16'))).toBe('2027-10-16');
    expect(datedLastDay(dated('a', '2027-10-16', { end: '2027-10-17' }))).toBe('2027-10-17');
    expect(datedLastDay(dated('a', '2027-10-14T04:00:00Z', { end: '2027-10-14T15:00:00Z' }))).toBe('2027-10-15');
    expect(datedLastDay(dated('a', '2027-10-16'))).toBe('2027-10-16');
    expect(datedDue(dated('a', '2027-10-10T00:00:00Z', { end: '2027-10-20T08:00:00Z' }))).toBe('2027-10-20T08:00:00Z');
    expect(datedDue(dated('a', '2027-10-10T00:00:00Z'))).toBe('2027-10-10T00:00:00Z');
    expect(datedStartDay(dated('a', 'oops'))).toBe('');
  });

  it('終わったか：日付だけは最後の日が今日より前、時刻のあるものは終わり（なければ開始）が now 以前（ちょうども終わった側）', () => {
    expect(isDatedPast(dated('a', '2027-10-14'), now)).toBe(false);
    expect(isDatedPast(dated('a', '2027-10-13'), now)).toBe(true);
    expect(isDatedPast(dated('a', '2027-10-12', { end: '2027-10-14' }), now)).toBe(false);
    expect(isDatedPast(dated('a', '2027-10-14T03:00:00Z'), now)).toBe(true);
    expect(isDatedPast(dated('a', '2027-10-14T03:00:00.001Z'), now)).toBe(false);
    expect(isDatedPast(dated('a', '2027-10-14T00:00:00Z', { end: '2027-10-14T05:00:00Z' }), now)).toBe(false);
    expect(isDatedPast(dated('a', '2027-10-14T00:00:00Z', { end: '2027-10-14T01:00:00Z' }), now)).toBe(true);
    expect(isDatedPast(dated('a', 'oops'), now)).toBe(false);
  });
});

describe('T18 datedRelative・datedWhen（相対の言い方と曜日つきの日付。notes/T18.md「後半（画面）の約束」2 の表）', () => {
  // 2027-10-14 12:00（Asia/Tokyo）。今日は 10/14（木）
  const now = Date.parse('2027-10-14T03:00:00Z');
  const deadline = (at: string, extra: Partial<DatedItem> = {}) => dated('d', at, { kind: 'deadline', ...extra });
  it.each<[string, DatedItem, string, string]>([
    ['予定・日付だけ 10/14', dated('e', '2027-10-14'), '今日', '10/14（木）'],
    ['予定・日付だけ 10/15', dated('e', '2027-10-15'), '明日', '10/15（金）'],
    ['予定・日付だけ 10/16〜10/17', dated('e', '2027-10-16', { end: '2027-10-17' }), 'あと 2 日', '10/16（土）〜10/17（日）'],
    ['予定・日付だけ 10/12〜10/14', dated('e', '2027-10-12', { end: '2027-10-14' }), '今日', '10/12（火）〜10/14（木）'],
    ['予定・日付だけ 10/13', dated('e', '2027-10-13'), '1 日前', '10/13（水）'],
    ['予定・日付だけ 10/10〜10/12', dated('e', '2027-10-10', { end: '2027-10-12' }), '2 日前', '10/10（日）〜10/12（火）'],
    ['予定・時刻 10/14 09:00〜10:00（今日のうちに終わった）', dated('e', '2027-10-14T00:00:00Z', { end: '2027-10-14T01:00:00Z' }), '今日', '10/14（木）09:00〜10:00'],
    ['予定・時刻 10/14 13:00〜10/15 12:00', dated('e', '2027-10-14T04:00:00Z', { end: '2027-10-15T03:00:00Z' }), '今日', '10/14（木）13:00〜10/15（金）12:00'],
    ['締切・時刻 10/14 17:00', deadline('2027-10-14T08:00:00Z'), '今日', '10/14（木）17:00'],
    ['締切・時刻 10/14 09:00', deadline('2027-10-14T00:00:00Z'), DATED_OVERDUE, '10/14（木）09:00'],
    ['締切・日付だけ 10/14', deadline('2027-10-14'), '今日', '10/14（木）'],
    ['締切・日付だけ 10/13', deadline('2027-10-13'), DATED_OVERDUE, '10/13（水）'],
    ['締切・時刻 10/15 17:00', deadline('2027-10-15T08:00:00Z'), '明日', '10/15（金）17:00'],
    ['締切・時刻 10/10 09:00〜10/20 17:00（期限は終わり）', deadline('2027-10-10T00:00:00Z', { end: '2027-10-20T08:00:00Z' }), 'あと 6 日', '10/10（日）09:00〜10/20（水）17:00'],
    ['予定・日付だけ 2028-01-01（年が違う）', dated('e', '2028-01-01'), 'あと 79 日', '2028/1/1（土）'],
    ['予定・時刻 2028-01-05 09:00（年が違う）', dated('e', '2028-01-05T00:00:00Z'), 'あと 83 日', '2028/1/5（水）09:00'],
  ])('%s → %s・%s', (_name, item, relative, when) => {
    expect(datedRelative(item, now)).toBe(relative);
    expect(datedWhen(item, now)).toBe(when);
  });

  it('日の境目は Asia/Tokyo：10/14 23:59:59.999 は 10/14、10/15 00:00（UTC の 15:00）から 10/15', () => {
    const before = Date.parse('2027-10-14T14:59:59.999Z');
    const after = Date.parse('2027-10-14T15:00:00Z');
    expect(datedRelative(deadline('2027-10-14'), before)).toBe('今日');
    expect(datedRelative(deadline('2027-10-14'), after)).toBe(DATED_OVERDUE);
    expect(datedRelative(dated('e', '2027-10-15'), before)).toBe('明日');
    expect(datedRelative(dated('e', '2027-10-15'), after)).toBe('今日');
    expect(datedRelative(dated('e', '2027-10-14'), after)).toBe('1 日前');
  });

  it('時刻つきの締切は期限の時刻ちょうどから「締切を過ぎました」', () => {
    const due = '2027-10-14T08:00:00Z';
    expect(datedRelative(deadline(due), Date.parse(due) - 1)).toBe('今日');
    expect(datedRelative(deadline(due), Date.parse(due))).toBe(DATED_OVERDUE);
  });

  it('終わりが開始と同じ日付だけの項目・読めない日時', () => {
    expect(datedWhen(dated('e', '2027-10-16', { end: '2027-10-16' }), now)).toBe('10/16（土）');
    expect(datedRelative(dated('e', 'oops'), now)).toBe('');
    expect(datedWhen(dated('e', 'oops'), now)).toBe('');
  });

  it('端末のタイムゾーンによらない（夏時間のある地域でも同じ）', () => {
    const tz = process.env.TZ;
    try {
      for (const z of ['America/Los_Angeles', 'Europe/London', 'UTC']) {
        process.env.TZ = z;
        expect(datedRelative(dated('e', '2027-10-16', { end: '2027-10-17' }), now)).toBe('あと 2 日');
        expect(datedWhen(deadline('2027-10-10T00:00:00Z', { end: '2027-10-20T08:00:00Z' }), now)).toBe('10/10（日）09:00〜10/20（水）17:00');
      }
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe('T18 upcomingDated（これからの 30 日と過ぎた締切。04「ダッシュボード」の締切と予定）', () => {
  const now = Date.parse('2027-10-14T03:00:00Z');
  const deadline = (id: string, at: string, extra: Partial<DatedItem> = {}) => dated(id, at, { kind: 'deadline', ...extra });
  // notes/T18.md「後半（画面）の約束」2 の例
  const items = [
    deadline('A', '2027-10-10T08:00:00Z'), // 過ぎた締切
    dated('B', '2027-10-16'), // これから
    dated('C', '2027-11-20'), // 30 日の外
    deadline('D', '2027-11-13T08:00:00Z'), // これから（10/14＋30 日＝11/13 は入る）
    dated('E', '2027-10-14T00:00:00Z'), // 終わった予定
    deadline('F', '2027-09-30T08:00:00Z'), // 過ぎた締切
  ];

  it(`既定は ${PORTAL_DATED_LIMIT} 件・${PORTAL_DATED_DAYS} 日。これから（B・D）と過ぎた締切（A・F）を早い順に`, () => {
    expect(PORTAL_DATED_DAYS).toBe(30);
    expect(upcomingDated(items, now)).toEqual({ items: [items[5], items[0], items[1], items[3]], more: 0 });
  });

  it('枠が足りなければ、これからを先に選び、余りに過ぎた締切の新しいものから。選ばなかった数が more', () => {
    const r = upcomingDated(items, now, 3);
    expect(r.items.map((d) => d.id)).toEqual(['A', 'B', 'D']);
    expect(r.more).toBe(1);
    expect(upcomingDated(items, now, 2)).toEqual({ items: [items[1], items[3]], more: 2 });
    expect(upcomingDated(items, now, 0)).toEqual({ items: [], more: 4 });
  });

  it('30 日の端：今日＋30 日は入り、＋31 日は入らない（30 日の外は more にも数えない）', () => {
    const r = upcomingDated([dated('in', '2027-11-13'), dated('out', '2027-11-14'), dated('outT', '2027-11-14T00:00:00Z')], now);
    expect(r).toEqual({ items: [dated('in', '2027-11-13')], more: 0 });
    expect(upcomingDated([dated('in', '2027-11-14')], now, 8, 31).items).toHaveLength(1);
  });

  it('始まって続いているもの（2日間の終日の2日目・時刻つきの続き）は出す。期限が終わりの締切は終わりで決める', () => {
    const r = upcomingDated(
      [
        dated('ongoing', '2027-10-13', { end: '2027-10-14' }),
        dated('ongoingT', '2027-10-13T00:00:00Z', { end: '2027-10-14T05:00:00Z' }),
        deadline('window', '2027-10-01T00:00:00Z', { end: '2027-10-20T08:00:00Z' }),
        deadline('closed', '2027-10-01T00:00:00Z', { end: '2027-10-14T02:00:00Z' }),
      ],
      now,
    );
    expect(r.items.map((d) => d.id)).toEqual(['window', 'closed', 'ongoing', 'ongoingT']);
    expect(r.more).toBe(0);
  });

  it('これからが limit 件以上あれば、過ぎた締切は出さずに more に数える', () => {
    const many = Array.from({ length: 9 }, (_, k) => dated(`u${k}`, `2027-10-${String(15 + k).padStart(2, '0')}`));
    const r = upcomingDated([...many, deadline('old', '2027-10-01T00:00:00Z')], now);
    expect(r.items.map((d) => d.id)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
    expect(r.more).toBe(2);
  });

  it('同じ時刻は機能の登録の順・元の順。過ぎた締切の同じ期限も同じ並び。読めない日時（開始・終わり）は出さない。元の配列は変えない', () => {
    const list = [
      dated('n1', '2027-10-16', { moduleId: NOTICES }),
      dated('f1', '2027-10-16'),
      dated('f2', '2027-10-16'),
      dated('bad', 'oops'),
      dated('badEnd', '2027-10-16', { end: 'oops' }),
      // Date.parse は 2027-02-30 を 3/2 と読むが、暦にない日付は出さない
      deadline('noDay', '2027-02-30'),
      dated('noEndDay', '2027-10-16', { end: '2027-10-32' }),
      deadline('od-n', '2027-10-01T00:00:00Z', { moduleId: NOTICES }),
      deadline('od-f', '2027-10-01T00:00:00Z'),
    ];
    const before = list.map((d) => d.id);
    expect(upcomingDated(list, now).items.map((d) => d.id)).toEqual(['od-f', 'od-n', 'f1', 'f2', 'n1']);
    expect(upcomingDated(list, now, 4).items.map((d) => d.id)).toEqual(['od-f', 'f1', 'f2', 'n1']);
    expect(list.map((d) => d.id)).toEqual(before);
  });

  it('mergePortalSections は終わりのある項目もそのまま（同じ id は最初の1件）', () => {
    const x = dated('x', '2027-10-16', { end: '2027-10-17' });
    const merged = mergePortalSections([
      { moduleId: 'furniture', kind: 'soumu', section: { card: null, todos: [], dated: [x] } },
      { moduleId: 'furniture', kind: 'rep', section: { card: null, todos: [], dated: [{ ...x, end: '2027-10-18' }] } },
    ]);
    expect(merged[0]!.dated).toEqual([x]);
  });
});
