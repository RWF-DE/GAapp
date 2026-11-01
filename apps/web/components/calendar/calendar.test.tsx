// @vitest-environment jsdom
// 締切と予定（/calendar）の画面とダイアログ（04「締切と予定」、notes/T18.md「後半（画面）の約束」4〜7。T18）：
// 立場ごとの一覧（対象の印・絞り込み・登録・編集・削除）、日ごとの並びと日の見出し・相対の言い方、機能の日付（机椅子の印とリンク）、
// メモの改行、過去も表示・`?kind=`・`?audience=`・`?event=`、空の3つの文、終了した年度の帯、機能の日付の読み取りの失敗。
// ダイアログの既定・終日の切り替え・欄の誤り・送る値（登録は作った id、保存は全部の欄と updated_at）・変更なし・捨てて閉じる・下書き
// （編集の下書きは下書きの updated_at で送る）・アプリの中の移動と年度の切り替えの前の確かめ。
// 読み直し（(B1)：23505・conflict・消えていた・応答なし・読み直せなかった後の「読み直す」・forbidden・CHECK）と削除、画面の「読み直す」。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）で、events の直接の insert・update・delete は DB の動き（RLS の段・
// 楽観ロック・主キーの重複）を小さくまねる。立場は useAuth の差し替え。時計は Date だけを止める（画面を開いた時刻）。
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '@/components/common/app-link';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import { CALENDAR_EVENTS_SELECT, type CalendarEventRow } from '@/lib/data/calendar';
import type { YearRow } from '@/lib/db/types';
import { draftKey, saveDraft } from '@/lib/drafts';
import { unknownOutcomeMessage } from '@/lib/errors';
import { portalQueryKey, portalQueryOptions, type PortalProvider } from '@/lib/modules/portal';
import { queryKeys } from '@/lib/query';
import { EVENT_FORM_MESSAGES } from '@/lib/schemas/calendar';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { LEAVE_MESSAGES } from '@/lib/unsaved-changes';
import { ALREADY_DELETED_MESSAGE, CLOSED_CALENDAR, CalendarScreen, DELETE_CHANGED_MESSAGE, EMPTY_TEXTS } from './calendar-screen';
import {
  AUDIENCE_HELP,
  CANNOT_SAVE_TEXT,
  CONFLICT_NOTICE,
  EVENT_MISSING_MESSAGE,
  REREAD_AGAIN_FAILED_MESSAGE,
  REREAD_FAILED_NOTICE,
} from './event-form-dialog';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  /** 偽の DB が段を決めるロールと年度の状態 */
  role: 'head' as AppRole | null,
  status: 'requesting' as YearStatus,
  userId: 'u-head',
  client: null as unknown,
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  reloadMembership: vi.fn(),
  setYear: vi.fn(),
  /** PORTAL_PROVIDERS の差し替え（本物のプロバイダの後ろに、テストのプロバイダを足せる） */
  providers: [] as PortalProvider[],
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: h.reloadMembership,
    setYear: h.setYear,
    reauthenticate: async () => false,
    isRefreshing: false,
  }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));
vi.mock('@/lib/modules/providers', async () => {
  const { furniturePortalProvider } = await import('@/lib/modules/furniture/portal');
  const { noticesPortalProvider } = await import('@/lib/modules/notices/portal');
  const { calendarPortalProvider } = await import('@/lib/modules/calendar/portal');
  h.providers.push(furniturePortalProvider, noticesPortalProvider, calendarPortalProvider);
  return { PORTAL_PROVIDERS: h.providers };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, refresh: vi.fn() }),
  usePathname: () => '/calendar',
  useSearchParams: () => h.params,
}));
vi.mock('next/link', () => ({
  // Next の Link と同じく、移る前に onNavigate を呼び、preventDefault されたら移らない（AppLink の未保存の入力の確かめ）。移るときは h.push
  default: (props: Record<string, unknown> & { href: string; children: React.ReactNode }) => {
    const { href, children, onNavigate, prefetch, ...rest } = props;
    void prefetch;
    const onClick = (e: React.MouseEvent) => {
      e.preventDefault();
      let prevented = false;
      (onNavigate as ((ev: { preventDefault: () => void }) => void) | undefined)?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) h.push(href);
    };
    return (
      <a href={href} {...rest} onClick={onClick}>
        {children}
      </a>
    );
  },
}));

// jsdom にないもの（Radix の Dialog・Checkbox・RadioGroup が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

// ---------------------------------------------------------------- データ

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const G1: GroupSummary = { id: uuid(11), name: '模擬店01', year_id: Y, role: 'manager' };
/** 画面を開いた時刻：2027-10-14（木）12:00（Asia/Tokyo） */
const NOW = '2027-10-14T03:00:00Z';
const V0 = '2027-10-01T00:00:00.123456+00:00';

const E_SOUMU = uuid(101);
const E_GROUPS = uuid(102);
const E_ALL = uuid(103);
const E_PAST = uuid(104);

interface DbEvent extends CalendarEventRow {
  year_id: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
}

const dbEvent = (id: string, over: Partial<DbEvent>): DbEvent => ({
  id,
  year_id: Y,
  kind: 'event',
  audience: 'soumu',
  title: `題名${id.slice(-3)}`,
  starts_at: '2027-10-14T04:00:00+00:00',
  ends_at: null,
  all_day: false,
  note: null,
  created_by: 'u-head',
  updated_by: 'u-head',
  created_at: V0,
  updated_at: V0,
  ...over,
});

function seedRows(): DbEvent[] {
  return [
    dbEvent(E_PAST, { kind: 'deadline', audience: 'all', title: '古い締切', starts_at: '2027-10-10T08:00:00+00:00' }),
    dbEvent(E_SOUMU, {
      title: '総務の打ち合わせ',
      starts_at: '2027-10-14T04:00:00+00:00',
      ends_at: '2027-10-14T06:00:00+00:00',
      note: '会議室A\n  資料を持参',
    }),
    dbEvent(E_GROUPS, { kind: 'deadline', audience: 'groups', title: '書類の提出', starts_at: '2027-10-18T08:00:00+00:00' }),
    dbEvent(E_ALL, { audience: 'all', title: '片付け', all_day: true, starts_at: '2027-10-23T15:00:00+00:00', ends_at: '2027-10-24T15:00:00+00:00' }),
  ];
}

/** 年度の行：受付開始 10/1 09:00、申請の締切 10/15 17:00、1日目 10/23（前々日 10/21〜2日目 10/24） */
const yearRow = (status: YearStatus, over: Partial<YearRow> = {}): YearRow => ({
  id: Y,
  label: 'R9',
  status,
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2027-10-23',
  request_open_at: '2027-10-01T00:00:00Z',
  request_close_at: '2027-10-15T08:00:00Z',
  prev_year_id: null,
  updated_at: 't',
  ...over,
});

function member(role: AppRole | null, groups: GroupSummary[], status: YearStatus): Membership {
  const year = { id: Y, label: 'R9', status, festival_start: '2027-10-23' };
  return { displayName: 'テスト', year, role, groups, years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

// ---------------------------------------------------------------- 偽の DB（events の RLS と直接の書き込み）

let rows: DbEvent[] = [];
let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];
let clock = 0;

const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
const pgError = (code: string, status: number): FakeResult => ({ error: { code, message: `pg ${code}`, details: null, hint: null }, status });
const nextAt = () => `2027-10-02T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
const LEAD = ['admin', 'head', 'deputy_head'];
const SOUMU = [...LEAD, 'staff'];
const canLead = () => LEAD.includes(h.role ?? '') && h.status !== 'closed';
const visible = (r: DbEvent) => SOUMU.includes(h.role ?? '') || r.audience !== 'soumu';
const has = (call: FakeCall, op: string) => call.ops.some((o) => o.op === op);
const eqOf = (call: FakeCall) => Object.fromEntries(opArgs(call, 'eq').map(([k, v]) => [k as string, v]));
const matchId = (call: FakeCall) => (opArgs(call, 'match')[0]?.[0] as { id?: string } | undefined)?.id ?? (eqOf(call).id as string | undefined);
/** 一覧の列だけ（CALENDAR_EVENTS_SELECT） */
const pick = (r: DbEvent): CalendarEventRow => ({
  id: r.id,
  kind: r.kind,
  audience: r.audience,
  title: r.title,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  all_day: r.all_day,
  note: r.note,
  updated_at: r.updated_at,
});

/** insert（RLS の with check：部門長以上で終了でない。主キーの重複は 23505） */
function dbInsert(call: FakeCall): FakeResult {
  const v = opArgs(call, 'insert')[0]![0] as Partial<DbEvent>;
  if (!canLead()) return pgError('42501', 403);
  if (rows.some((r) => r.id === v.id)) return pgError('23505', 409);
  const at = nextAt();
  const r = { ...dbEvent(v.id!, {}), ...v, created_by: h.userId, updated_by: h.userId, created_at: at, updated_at: at } as DbEvent;
  rows.push(r);
  return { data: pick(r) };
}

/** update（楽観ロック。書けない人・版が違う・ないは 0 行） */
function dbUpdate(call: FakeCall): FakeResult {
  const patch = opArgs(call, 'update')[0]![0] as Partial<DbEvent>;
  const k = rows.findIndex((r) => r.id === matchId(call));
  if (k < 0 || !canLead() || !visible(rows[k]!) || rows[k]!.updated_at !== eqOf(call).updated_at) return { data: null };
  rows[k] = { ...rows[k]!, ...patch, updated_by: h.userId, updated_at: nextAt() };
  return { data: rows[k] };
}

function dbDelete(call: FakeCall): FakeResult {
  const k = rows.findIndex((r) => r.id === matchId(call));
  if (k < 0 || !canLead() || !visible(rows[k]!) || rows[k]!.updated_at !== eqOf(call).updated_at) return { data: [] };
  const [gone] = rows.splice(k, 1);
  return { data: [gone] };
}

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
  if (call.table === 'years') return { data: yearRow(h.status) };
  if (call.table !== 'events') return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  if (has(call, 'insert')) return dbInsert(call);
  if (has(call, 'update')) return dbUpdate(call);
  if (has(call, 'delete')) return dbDelete(call);
  if (has(call, 'maybeSingle')) {
    const r = rows.find((x) => x.id === matchId(call) && visible(x));
    return { data: r ? pick(r) : null };
  }
  const list = rows
    .filter((r) => r.year_id === eqOf(call).year_id && visible(r))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || (a.id < b.id ? -1 : 1))
    .map(pick);
  return { data: list };
}

/** 切り替え先の年度（年度の切り替えの確かめのテスト） */
const Y_PREV = uuid(2);

/**
 * ダイアログの外の、アプリの中の移動（ナビと同じ AppLink）と年度の切り替え（年度の選択と同じ useGuardedSetYear）。
 * AppShell の代わりに、同じ部品と関数で未保存の入力の確かめを通す
 */
function OutsideProbe() {
  const setYear = useGuardedSetYear();
  return (
    <div>
      <AppLink href="/notices" data-testid="probe-nav">
        お知らせ一覧
      </AppLink>
      <button type="button" data-testid="probe-year" onClick={() => void setYear(Y_PREV)}>
        年度を切り替える
      </button>
    </div>
  );
}

function renderScreen(
  role: AppRole | null,
  opts: { groups?: GroupSummary[]; status?: YearStatus; userId?: string; search?: string; year?: Partial<YearRow>; guard?: boolean } = {},
) {
  const status = opts.status ?? 'requesting';
  h.role = role;
  h.status = status;
  h.userId = opts.userId ?? `u-${role ?? 'rep'}`;
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, opts.groups ?? [], status) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status, opts.year));
  render(
    <QueryClientProvider client={qc}>
      {opts.guard ? (
        // アプリと同じく、未保存の入力の守り（app/layout.tsx の Providers）の中に画面とナビ・年度の選択を置く
        <UnsavedChangesProvider>
          <OutsideProbe />
          <CalendarScreen />
        </UnsavedChangesProvider>
      ) : (
        <CalendarScreen />
      )}
    </QueryClientProvider>,
  );
  return qc;
}

const items = () => screen.queryAllByTestId('calendar-item');
const itemIds = () => items().map((x) => x.getAttribute('data-id'));
const itemOf = (id: string) => items().find((x) => x.getAttribute('data-id') === id)!;
const days = () => screen.queryAllByTestId('calendar-day');
const dayOf = (date: string) => days().find((d) => d.getAttribute('data-date') === date)!;
const calls = (op: 'insert' | 'update' | 'delete') => issued.filter((c) => c.table === 'events' && has(c, op));
const valuesOf = (call: FakeCall, op: 'insert' | 'update') => opArgs(call, op)[0]![0] as Record<string, unknown>;
const form = () => screen.getByTestId('event-form');
const loaded = () => waitFor(() => expect(items().length).toBeGreaterThan(0));
const setUser = () => userEvent.setup({ advanceTimers: () => {} });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  rows = seedRows();
  override = null;
  clock = 0;
  const fake = createFakeSupabase(handler);
  h.client = fake.client;
  issued = fake.issued;
  h.push.mockClear();
  h.replace.mockClear();
  h.reloadMembership.mockClear();
  h.setYear.mockClear();
  h.providers.splice(3);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const c = (id: string) => `calendar:${id}`;
/** 総務部門長の既定（今日から）の並び */
const HEAD_ORDER = [
  c(E_SOUMU),
  'furniture:request-close',
  c(E_GROUPS),
  'furniture:day-minus2',
  'furniture:day-minus1',
  'furniture:day1',
  'furniture:day2',
  c(E_ALL),
];

// ---------------------------------------------------------------- 一覧

describe('T18 締切と予定：総務部門長', () => {
  it('h1「締切と予定の一覧」・最終読み込みと「読み直す」・「締切・予定を登録」。今日からの日ごとの一覧（日の見出しと曜日・相対の言い方）', async () => {
    renderScreen('head');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('締切と予定の一覧');
    await loaded();
    expect(screen.getByText(/最終読み込み/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy();
    expect(screen.getByTestId('calendar-add').textContent).toBe('締切・予定を登録');
    expect(itemIds()).toEqual(HEAD_ORDER);
    expect(days().map((d) => d.getAttribute('data-date'))).toEqual([
      '2027-10-14',
      '2027-10-15',
      '2027-10-18',
      '2027-10-21',
      '2027-10-22',
      '2027-10-23',
      '2027-10-24',
    ]);
    const heading = (date: string) => [
      within(dayOf(date)).getByTestId('calendar-day-heading').textContent,
      within(dayOf(date)).getByTestId('calendar-day-relative').textContent,
    ];
    expect(heading('2027-10-14')).toEqual(['10月14日（木）', '今日']);
    expect(heading('2027-10-15')).toEqual(['10月15日（金）', '明日']);
    expect(heading('2027-10-18')).toEqual(['10月18日（月）', 'あと 4 日']);
    expect(heading('2027-10-24')).toEqual(['10月24日（日）', 'あと 10 日']);
    // 昨日より前の項目（過ぎた締切・受付開始）は出さない
    expect(itemIds()).not.toContain(c(E_PAST));
    expect(itemIds()).not.toContain('furniture:request-open');
  });

  it('1件：時刻・種類の印・対象の印・題名・メモ（改行を残す）・編集と削除。相対の言い方は日の見出しと同じなら出さない', async () => {
    renderScreen('head');
    await loaded();
    const s = itemOf(c(E_SOUMU));
    expect(s.getAttribute('data-kind')).toBe('event');
    expect(s.getAttribute('data-audience')).toBe('soumu');
    expect(s.getAttribute('data-module')).toBe('calendar');
    expect(within(s).getByTestId('calendar-item-time').textContent).toBe('13:00〜15:00');
    expect(within(s).getByTestId('calendar-item-kind').textContent).toBe('予定');
    expect(within(s).getByTestId('calendar-item-audience').textContent).toBe('総務');
    expect(within(s).getByTestId('calendar-item-title').textContent).toBe('総務の打ち合わせ');
    expect(within(s).queryByRole('link')).toBeNull();
    const note = within(s).getByTestId('calendar-item-note');
    expect(note.textContent).toBe('会議室A\n  資料を持参');
    expect(note.className).toContain('whitespace-pre-wrap');
    expect(within(s).queryByTestId('calendar-item-relative')).toBeNull();
    expect(within(s).getByRole('button', { name: '「総務の打ち合わせ」を編集' })).toBeTruthy();
    expect(within(s).getByRole('button', { name: '「総務の打ち合わせ」を削除' })).toBeTruthy();
    const g = itemOf(c(E_GROUPS));
    expect([within(g).getByTestId('calendar-item-kind').textContent, within(g).getByTestId('calendar-item-audience').textContent]).toEqual(['締切', '団体']);
    expect(within(g).getByTestId('calendar-item-time').textContent).toBe('17:00');
    const all = itemOf(c(E_ALL));
    expect(within(all).getByTestId('calendar-item-time').textContent).toBe('終日（〜10/25（月））');
    expect(within(all).getByTestId('calendar-item-audience').textContent).toBe('全員');
    expect(within(all).queryByTestId('calendar-item-note')).toBeNull();
  });

  it('機能の日付：机椅子の印、題名は機能の行き先（申請の締切は申請一覧、祭の日は机椅子の状況）へのリンク。編集・削除・対象の印はない', async () => {
    renderScreen('head');
    await loaded();
    const close = itemOf('furniture:request-close');
    expect(close.getAttribute('data-module')).toBe('furniture');
    expect(close.getAttribute('data-audience')).toBeNull();
    expect(within(close).getByTestId('calendar-item-module').textContent).toBe('机椅子');
    expect(within(close).getByTestId('calendar-item-kind').textContent).toBe('締切');
    expect(within(close).getByRole('link', { name: '机椅子の申請の締切' }).getAttribute('href')).toBe('/requests');
    expect(within(close).queryByTestId('calendar-item-audience')).toBeNull();
    expect(within(close).queryByRole('button')).toBeNull();
    const day1 = itemOf('furniture:day1');
    expect(within(day1).getByTestId('calendar-item-time').textContent).toBe('終日');
    expect(within(day1).getByRole('link', { name: '電波祭 1日目' }).getAttribute('href')).toBe('/furniture');
  });

  it('絞り込み（種類・対象）と「過去も表示」。押すと URL に入れる', async () => {
    const user = setUser();
    renderScreen('head');
    await loaded();
    const kind = screen.getByTestId('calendar-kind-filter');
    expect(within(kind).getAllByRole('radio').map((x) => x.textContent)).toEqual(['すべて', '締切', '予定']);
    const audience = screen.getByTestId('calendar-audience-filter');
    expect(within(audience).getAllByRole('radio').map((x) => x.textContent)).toEqual(['すべて', '総務', '団体', '全員']);
    // 見える見出し「種類」「対象」を前に置き、読み上げの名前にもする（「すべて」が2つ並んでも、どちらの絞り込みか分かる。レビューの T18-3）
    expect(screen.getByTestId('calendar-kind-filter-label').textContent).toBe('種類');
    expect(screen.getByTestId('calendar-audience-filter-label').textContent).toBe('対象');
    expect(screen.getByRole('radiogroup', { name: '種類' })).toBe(kind);
    expect(screen.getByRole('radiogroup', { name: '対象' })).toBe(audience);
    await user.click(within(kind).getByRole('radio', { name: '締切' }));
    expect(h.replace).toHaveBeenLastCalledWith('/calendar?kind=deadline');
    await user.click(within(audience).getByRole('radio', { name: '団体' }));
    expect(h.replace).toHaveBeenLastCalledWith('/calendar?audience=groups');
    await user.click(screen.getByRole('checkbox', { name: '過去も表示' }));
    expect(h.replace).toHaveBeenLastCalledWith('/calendar?past=1');
  });

  it('対象の「全員」（all）で絞れる。「すべて」と取り違えず、開いたときは「すべて」だけが押されている（撮影で見つけた。パート B）', async () => {
    const user = setUser();
    renderScreen('head');
    await loaded();
    const checked = (testId: string) =>
      within(screen.getByTestId(testId))
        .getAllByRole('radio')
        .filter((x) => x.getAttribute('aria-checked') === 'true')
        .map((x) => x.textContent);
    expect(checked('calendar-kind-filter')).toEqual(['すべて']);
    expect(checked('calendar-audience-filter')).toEqual(['すべて']);
    await user.click(within(screen.getByTestId('calendar-audience-filter')).getByRole('radio', { name: '全員' }));
    expect(h.replace).toHaveBeenLastCalledWith('/calendar?audience=all');
    cleanup();
    renderScreen('head', { search: 'audience=all' });
    await loaded();
    expect(checked('calendar-audience-filter')).toEqual(['全員']);
    expect(itemIds()).toEqual([c(E_ALL)]);
    // 「すべて」に戻す
    await user.click(within(screen.getByTestId('calendar-audience-filter')).getByRole('radio', { name: 'すべて' }));
    expect(h.replace).toHaveBeenLastCalledWith('/calendar');
  });

  it('?kind=deadline は締切だけ（機能の日付にも効く）、?audience=groups は団体の項目だけ（機能の日付は出さない）', async () => {
    renderScreen('head', { search: 'kind=deadline' });
    await loaded();
    expect(itemIds()).toEqual(['furniture:request-close', c(E_GROUPS)]);
    cleanup();
    renderScreen('head', { search: 'audience=groups' });
    await loaded();
    expect(itemIds()).toEqual([c(E_GROUPS)]);
    cleanup();
    renderScreen('head', { search: 'kind=nope&audience=teachers' });
    await loaded();
    expect(itemIds()).toEqual(HEAD_ORDER);
  });

  it('過去も表示（?past=1）：その年度の全部。過ぎた日の見出しは「N 日前」、過ぎた締切は「締切を過ぎました」', async () => {
    renderScreen('head', { search: 'past=1' });
    await loaded();
    expect(screen.getByRole('checkbox', { name: '過去も表示' }).getAttribute('aria-checked')).toBe('true');
    expect(itemIds().slice(0, 3)).toEqual(['furniture:request-open', c(E_PAST), c(E_SOUMU)]);
    expect(within(dayOf('2027-10-10')).getByTestId('calendar-day-relative').textContent).toBe('4 日前');
    expect(within(dayOf('2027-10-01')).getByTestId('calendar-day-relative').textContent).toBe('13 日前');
    const past = itemOf(c(E_PAST));
    expect(within(past).getByTestId('calendar-item-relative').textContent).toBe('締切を過ぎました');
    expect(within(past).getByTestId('calendar-item-relative').className).toContain('text-amber-700');
  });

  it('?event=<id>（ダッシュボードの欄から）：その項目を目立たせ、絞り込みは「すべて」、今日より前に終わった項目なら過去も出す。ない id なら何もしない', async () => {
    renderScreen('head', { search: `event=${E_PAST}&kind=event` });
    await loaded();
    expect(itemOf(c(E_PAST)).getAttribute('data-highlighted')).toBe('true');
    expect(items().filter((x) => x.getAttribute('data-highlighted'))).toHaveLength(1);
    expect(within(screen.getByTestId('calendar-kind-filter')).getByRole('radio', { name: 'すべて' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: '過去も表示' }).getAttribute('aria-checked')).toBe('true');
    cleanup();
    renderScreen('head', { search: `event=${E_GROUPS}` });
    await loaded();
    expect(itemOf(c(E_GROUPS)).getAttribute('data-highlighted')).toBe('true');
    expect(itemIds()).not.toContain(c(E_PAST));
    cleanup();
    renderScreen('head', { search: `event=${uuid(999)}&kind=deadline` });
    await loaded();
    expect(items().filter((x) => x.getAttribute('data-highlighted'))).toEqual([]);
    expect(itemIds()).toEqual(['furniture:request-close', c(E_GROUPS)]);
  });

  it('空の3つの文：既定（登録できる人には足し方も）・絞り込み・過去も表示', async () => {
    rows = [];
    // 祭も受付期間も過ぎた（機能の日付も今日より前）
    renderScreen('head', { year: { festival_start: '2027-10-01', request_open_at: null, request_close_at: null } });
    const empty = await screen.findByTestId('calendar-empty');
    expect(empty.textContent).toContain(EMPTY_TEXTS.upcoming);
    expect(empty.textContent).toContain(EMPTY_TEXTS.addHint);
    cleanup();
    rows = [];
    renderScreen('staff', { year: { festival_start: '2027-10-01', request_open_at: null, request_close_at: null } });
    expect((await screen.findByTestId('calendar-empty')).textContent).not.toContain(EMPTY_TEXTS.addHint);
    cleanup();
    renderScreen('head', { search: 'audience=soumu&kind=deadline' });
    expect((await screen.findByTestId('calendar-empty')).textContent).toContain(EMPTY_TEXTS.filtered);
    cleanup();
    rows = [];
    // 1日目の読めない年度の行（機能の日付が1つもない）で、過去も表示
    renderScreen('head', { search: 'past=1', year: { festival_start: '', request_open_at: null, request_close_at: null } });
    const all = await screen.findByTestId('calendar-empty');
    expect(all.textContent).toContain(EMPTY_TEXTS.all);
    expect(all.textContent).not.toContain(EMPTY_TEXTS.addHint);
  });

  it('終了した年度：一覧は読めるが、登録・編集・削除がなく、部門長以上に読むだけの帯', async () => {
    renderScreen('head', { status: 'closed' });
    await loaded();
    expect(screen.getByTestId('calendar-closed').textContent).toBe(CLOSED_CALENDAR);
    expect(screen.queryByTestId('calendar-add')).toBeNull();
    expect(screen.queryByTestId('calendar-item-edit')).toBeNull();
    expect(screen.queryByTestId('calendar-item-delete')).toBeNull();
    expect(screen.getByTestId('calendar-kind-filter')).toBeTruthy();
  });

  it('機能の日付の読み取りが失敗したら、その機能の分だけ失敗と「もう一度」を一覧の上に出す（項目とほかの日付は出したまま）', async () => {
    let fail = true;
    h.providers.push({
      moduleId: 'notices',
      kinds: ['soumu'],
      query: {
        widgets: ['dated'],
        options: (ctx) =>
          portalQueryOptions(
            queryOptions({
              queryKey: portalQueryKey(ctx.year.id, 'notices', 'soumu', 'test-dates'),
              queryFn: async () => {
                const res = await (h.client as AppSupabaseClient).from('test_dates' as never).select('*');
                if (res.error) throw res.error;
                return res.data as unknown[];
              },
            }),
            () => ({ card: null, todos: [], dated: [{ id: 'notices:test', moduleId: 'notices', title: 'テストの日付', at: '2027-10-16', kind: 'event' }] }),
          ),
      },
    });
    override = (call) => (call.table === 'test_dates' ? (fail ? NETWORK : { data: [] }) : undefined);
    const user = setUser();
    renderScreen('head');
    const err = await screen.findByTestId('portal-module-error');
    expect(err.getAttribute('data-module')).toBe('notices');
    expect(err.textContent).toContain('お知らせ：通信できませんでした');
    await loaded();
    expect(itemIds()).toEqual(HEAD_ORDER);
    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(itemIds()).toContain('notices:test'));
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });

  it('読むのは events の一覧の列だけ（year_id で絞り、開始・id の順に全部）。机椅子の日付は年度の行から作るので読み取りは増えない', async () => {
    renderScreen('head');
    await loaded();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(issued.map((x) => x.table)).toEqual(['events']);
    const list = issued[0]!;
    expect(opArgs(list, 'select')).toEqual([[CALENDAR_EVENTS_SELECT]]);
    expect(opArgs(list, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(list, 'order')).toEqual([['starts_at'], ['id']]);
  });

  it('「読み直す」は項目と年度の行（机椅子の日付）を読み直し、今日と相対の言い方を押した時刻で決め直す（レビューの T18-4）', async () => {
    const user = setUser();
    renderScreen('head');
    await loaded();
    expect(days()[0]!.getAttribute('data-date')).toBe('2027-10-14');
    // 開いたまま2日たち（10/16 12:00）、その間に申請の締切が 10/20 17:00 に延びた
    vi.setSystemTime(new Date('2027-10-16T03:00:00Z'));
    override = (call) => (call.table === 'years' ? { data: yearRow(h.status, { request_close_at: '2027-10-20T08:00:00Z' }) } : undefined);
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(days()[0]!.getAttribute('data-date')).toBe('2027-10-18'));
    expect(within(dayOf('2027-10-18')).getByTestId('calendar-day-relative').textContent).toBe('あと 2 日');
    expect(
      within(dayOf('2027-10-20'))
        .getAllByTestId('calendar-item')
        .map((x) => x.getAttribute('data-id')),
    ).toEqual(['furniture:request-close']);
    expect(itemIds()).not.toContain(c(E_SOUMU));
    expect(issued.filter((x) => x.table === 'years')).toHaveLength(1);
    expect(issued.filter((x) => x.table === 'events')).toHaveLength(2);
  });
});

describe('T18 締切と予定：総務部門員・閲覧のみ・店長', () => {
  it('総務部門員：全部の項目と対象の印・絞り込みは出るが、登録・編集・削除と帯はない', async () => {
    renderScreen('staff');
    await loaded();
    expect(itemIds()).toEqual(HEAD_ORDER);
    expect(within(itemOf(c(E_SOUMU))).getByTestId('calendar-item-audience').textContent).toBe('総務');
    expect(screen.getByTestId('calendar-kind-filter')).toBeTruthy();
    expect(screen.queryByTestId('calendar-add')).toBeNull();
    expect(screen.queryByRole('button', { name: /を編集$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /を削除$/ })).toBeNull();
    expect(screen.queryByTestId('calendar-closed')).toBeNull();
  });

  it('閲覧のみ：RLS が返す団体・全員の項目だけ（総務の項目は DOM にもない）。対象の印・絞り込み・操作はない。机椅子の日付は開けないのでリンクにしない', async () => {
    renderScreen('viewer', { search: 'kind=deadline&audience=soumu' });
    await loaded();
    // 総務でない人は ?kind=・?audience= を読まない
    expect(itemIds()).toEqual(HEAD_ORDER.filter((id) => id !== c(E_SOUMU)));
    expect(document.body.textContent).not.toContain('総務の打ち合わせ');
    expect(screen.queryByTestId('calendar-item-audience')).toBeNull();
    expect(screen.queryByTestId('calendar-kind-filter')).toBeNull();
    expect(screen.queryByTestId('calendar-audience-filter')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '過去も表示' })).toBeTruthy();
    expect(screen.queryByTestId('calendar-add')).toBeNull();
    expect(within(itemOf('furniture:request-close')).queryByRole('link')).toBeNull();
    expect(within(itemOf('furniture:day1')).queryByRole('link')).toBeNull();
    expect(within(itemOf('furniture:day1')).getByTestId('calendar-item-module').textContent).toBe('机椅子');
    // リンクにしない題名は、リンクに見える下線も付けない（撮影で見つけた。パート B）
    for (const id of ['furniture:request-close', 'furniture:day1']) {
      const title = within(itemOf(id)).getByTestId('calendar-item-title');
      expect(title.textContent).not.toBe('');
      expect(title.querySelector('.underline')).toBeNull();
    }
  });

  it('店長：団体・全員の項目だけ。申請の締切は申請（/request）へのリンク。終了した年度でも帯を出さない', async () => {
    renderScreen(null, { groups: [G1] });
    await loaded();
    expect(itemIds()).toEqual(HEAD_ORDER.filter((id) => id !== c(E_SOUMU)));
    expect(within(itemOf('furniture:request-close')).getByRole('link').getAttribute('href')).toBe('/request');
    expect(screen.queryByRole('button', { name: /を編集$/ })).toBeNull();
    cleanup();
    renderScreen(null, { groups: [G1], status: 'closed' });
    await loaded();
    expect(screen.queryByTestId('calendar-closed')).toBeNull();
  });
});

// ---------------------------------------------------------------- ダイアログ

async function openNew(user: ReturnType<typeof setUser>) {
  await loaded();
  await user.click(screen.getByTestId('calendar-add'));
  return screen.findByTestId('event-form');
}
async function openEdit(user: ReturnType<typeof setUser>, title: string) {
  await loaded();
  await user.click(screen.getByRole('button', { name: `「${title}」を編集` }));
  return screen.findByTestId('event-form');
}
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const submit = () => screen.getByTestId('event-submit');
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('T18 ダイアログ：登録', () => {
  it('既定は種類「予定」・対象「総務」（読む人の説明つき）・終日を外す。終日の締切を登録すると、作った id と Asia/Tokyo の 00:00 で insert して閉じ、一覧に出す', async () => {
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    expect(screen.getByRole('heading', { name: '締切・予定を登録' })).toBeTruthy();
    const kind = screen.getByTestId('event-kind');
    expect(within(kind).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    const audience = screen.getByTestId('event-audience');
    expect(within(audience).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    for (const text of Object.values(AUDIENCE_HELP)) expect(within(audience).getByText(text)).toBeTruthy();
    expect(screen.getByTestId('event-all-day').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('event-title-count').textContent).toBe('0/100');

    await user.click(within(kind).getByLabelText('締切'));
    await user.click(within(audience).getByLabelText('全員'));
    await user.type(screen.getByLabelText('題名'), '　書類の提出 ');
    expect(screen.getByTestId('event-title-count').textContent).toBe('5/100');
    await user.click(screen.getByTestId('event-all-day'));
    setValue('event-start-date', '2027-10-15');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(calls('insert')).toHaveLength(1);
    const sent = valuesOf(calls('insert')[0]!, 'insert');
    expect(sent.id).toMatch(UUID4);
    expect(sent).toEqual({
      id: sent.id,
      year_id: Y,
      kind: 'deadline',
      audience: 'all',
      title: '書類の提出',
      starts_at: '2027-10-15T00:00:00+09:00',
      ends_at: null,
      all_day: true,
      note: null,
    });
    expect(toast.success).toHaveBeenCalledWith('「書類の提出」を登録しました');
    await waitFor(() => expect(itemIds()).toContain(c(sent.id as string)));
    expect(within(itemOf(c(sent.id as string))).getByTestId('calendar-item-time').textContent).toBe('終日');
  });

  it('時刻つきの予定：開始・終わりは Asia/Tokyo の日時（+09:00）、メモは前後の空白を除く', async () => {
    const user = setUser();
    renderScreen('admin');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '搬入の説明会');
    setValue('event-start', '2027-10-17T13:00');
    setValue('event-end', '2027-10-17T15:00');
    await user.type(screen.getByLabelText('メモ（任意）'), '  体育館{enter}  上履き  ');
    // 字数は前後の空白を除いた形（送る値と同じ）で数える
    expect(screen.getByTestId('event-note-count').textContent).toBe('9/1000');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(valuesOf(calls('insert')[0]!, 'insert')).toMatchObject({
      kind: 'event',
      audience: 'soumu',
      starts_at: '2027-10-17T13:00:00+09:00',
      ends_at: '2027-10-17T15:00:00+09:00',
      all_day: false,
      note: '体育館\n  上履き',
    });
  });

  it('欄の誤りは欄の下に出して送らない（題名・開始の日時・終わりが前）', async () => {
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.click(submit());
    expect(within(form()).getByText(EVENT_FORM_MESSAGES.titleRequired)).toBeTruthy();
    expect(within(form()).getByText(EVENT_FORM_MESSAGES.startRequired)).toBeTruthy();
    setValue('event-start', '2027-10-17T13:00');
    setValue('event-end', '2027-10-17T12:00');
    await user.type(screen.getByLabelText('題名'), 'a');
    await user.click(submit());
    expect(within(form()).getByText(EVENT_FORM_MESSAGES.endBefore)).toBeTruthy();
    expect(within(form()).queryByText(EVENT_FORM_MESSAGES.titleRequired)).toBeNull();
    expect(calls('insert')).toEqual([]);
  });

  it('終日の切り替え：入れると開始・終わりの日付を日付・最後の日に、外すと日付の 09:00 を開始に（終わりは空）', async () => {
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    setValue('event-start', '2027-10-14T13:00');
    setValue('event-end', '2027-10-16T10:00');
    await user.click(screen.getByTestId('event-all-day'));
    expect((screen.getByTestId('event-start-date') as HTMLInputElement).value).toBe('2027-10-14');
    expect((screen.getByTestId('event-end-date') as HTMLInputElement).value).toBe('2027-10-16');
    expect(screen.queryByTestId('event-start')).toBeNull();
    await user.click(screen.getByTestId('event-all-day'));
    expect((screen.getByTestId('event-start') as HTMLInputElement).value).toBe('2027-10-14T09:00');
    expect((screen.getByTestId('event-end') as HTMLInputElement).value).toBe('');
  });

  it('入力があれば、やめる前に「保存していない入力を捨てますか」。捨てて閉じると下書きも消える', async () => {
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '途中');
    await user.click(within(screen.getByTestId('event-dialog')).getByRole('button', { name: 'やめる' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('保存していない入力を捨てますか')).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(window.localStorage.getItem(draftKey({ userId: 'u-head', yearId: Y, screen: 'calendar', target: 'new' }))).toBeNull();
  });

  it('下書き：開いたときに下書きがあれば「保存していない入力があります」。戻すと入力と登録の id が戻る', async () => {
    const id = uuid(555);
    saveDraft(
      { userId: 'u-head', yearId: Y, screen: 'calendar', target: 'new' },
      {
        values: { kind: 'deadline', audience: 'groups', title: '下書きの締切', allDay: false, startDate: '', endDate: '', start: '2027-10-20T17:00', end: '', note: '' },
        id,
        baseUpdatedAt: null,
      },
    );
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.click(within(screen.getByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('下書きの締切');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(valuesOf(calls('insert')[0]!, 'insert')).toMatchObject({ id, kind: 'deadline', audience: 'groups', starts_at: '2027-10-20T17:00:00+09:00' });
  });
});

describe('T18 ダイアログ：編集', () => {
  it('今の値で開き、全部の欄を読んだときの updated_at の文字列のまま条件に入れて update する', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    expect(screen.getByRole('heading', { name: '締切・予定を編集' })).toBeTruthy();
    expect((screen.getByTestId('event-start') as HTMLInputElement).value).toBe('2027-10-14T13:00');
    expect((screen.getByTestId('event-end') as HTMLInputElement).value).toBe('2027-10-14T15:00');
    expect((screen.getByLabelText('メモ（任意）') as HTMLTextAreaElement).value).toBe('会議室A\n  資料を持参');
    const title = screen.getByLabelText('題名');
    await user.clear(title);
    await user.type(title, '総務の打ち合わせ（変更）');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    const u = calls('update')[0]!;
    expect(valuesOf(u, 'update')).toEqual({
      kind: 'event',
      audience: 'soumu',
      title: '総務の打ち合わせ（変更）',
      starts_at: '2027-10-14T13:00:00+09:00',
      ends_at: '2027-10-14T15:00:00+09:00',
      all_day: false,
      note: '会議室A\n  資料を持参',
    });
    expect(opArgs(u, 'match')).toEqual([[{ id: E_SOUMU }]]);
    expect(opArgs(u, 'eq')).toEqual([['updated_at', V0]]);
    expect(toast.success).toHaveBeenCalledWith('「総務の打ち合わせ（変更）」を保存しました');
    await waitFor(() => expect(within(itemOf(c(E_SOUMU))).getByTestId('calendar-item-title').textContent).toBe('総務の打ち合わせ（変更）'));
  });

  it('何も変えていなければ送らずに「変更はありません」で閉じる', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '片付け');
    expect((screen.getByTestId('event-start-date') as HTMLInputElement).value).toBe('2027-10-24');
    expect((screen.getByTestId('event-end-date') as HTMLInputElement).value).toBe('2027-10-25');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(calls('update')).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith('変更はありません');
  });

  it('戻した編集の下書きは下書きの updated_at で送る：間にほかの人が変えていれば衝突の知らせ（今の題名）で入力を残し、次の保存は読み直した版で上書きする（04 の保存していない入力。レビューの T18-1）', async () => {
    const V1 = '2027-10-05T01:00:00.000001+00:00';
    // 下書き（読んだときの版 V0）を書いた後に、ほかの人が題名を直した（一覧とダイアログは新しい版 V1 で開く）
    rows = rows.map((r) => (r.id === E_SOUMU ? { ...r, title: 'ほかの人の題名', updated_at: V1 } : r));
    saveDraft(
      { userId: 'u-head', yearId: Y, screen: 'calendar', target: E_SOUMU },
      {
        values: {
          kind: 'event',
          audience: 'soumu',
          title: '下書きの題名',
          allDay: false,
          startDate: '',
          endDate: '',
          start: '2027-10-14T13:00',
          end: '2027-10-14T15:00',
          note: '下書きのメモ',
        },
        id: E_SOUMU,
        baseUpdatedAt: V0,
      },
    );
    const user = setUser();
    renderScreen('head');
    await openEdit(user, 'ほかの人の題名');
    const title = screen.getByLabelText('題名') as HTMLInputElement;
    // 開いたときは今の行の値。「戻す」で下書きの値
    expect(title.value).toBe('ほかの人の題名');
    await user.click(within(screen.getByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    expect(title.value).toBe('下書きの題名');
    await user.click(submit());
    const box = await screen.findByTestId('event-conflict');
    // 開いたときの版（V1）でなく、下書きの版（V0）を条件に入れて送った（黙ってほかの人の変更を上書きしない）
    expect(opArgs(calls('update')[0]!, 'eq')).toEqual([['updated_at', V0]]);
    expect(rows.find((r) => r.id === E_SOUMU)!.title).toBe('ほかの人の題名');
    expect(box.textContent).toContain(CONFLICT_NOTICE);
    expect(box.textContent).toContain('今の題名：ほかの人の題名');
    expect(title.value).toBe('下書きの題名');
    // 確かめた後の保存は、読み直した版で送って上書きする
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(opArgs(calls('update')[1]!, 'eq')).toEqual([['updated_at', V1]]);
    expect(rows.find((r) => r.id === E_SOUMU)).toMatchObject({ title: '下書きの題名', note: '下書きのメモ' });
    expect(toast.success).toHaveBeenCalledWith('「下書きの題名」を保存しました');
  });
});

describe('T18 ダイアログ：アプリの中の移動・年度の切り替えの前の確かめ（04 の保存していない入力。レビューの T18-1）', () => {
  // モーダルのダイアログの外（ナビ・年度の選択）はポインタで押せないので、要素に直接 click を送り、ダイアログの入力が
  // アプリ全体の守り（UnsavedChangesProvider）に入って、AppLink・useGuardedSetYear が確かめることを見る
  it('入力がなければ確かめずに移る。入力があれば、移る前に確かめ、やめれば移らず入力が残り、「移る」で移る', async () => {
    const user = setUser();
    renderScreen('head', { guard: true });
    await openNew(user);
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(h.push).toHaveBeenLastCalledWith('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    h.push.mockClear();

    await user.type(screen.getByLabelText('題名'), '途中の題名');
    fireEvent.click(screen.getByTestId('probe-nav'));
    const leave = await screen.findByRole('alertdialog');
    expect(leave.textContent).toContain(LEAVE_MESSAGES.navigate.title);
    expect(leave.textContent).toContain(LEAVE_MESSAGES.navigate.description);
    await user.click(within(leave).getByRole('button', { name: 'やめる（入力を続ける）' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(h.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('event-form')).toBeTruthy();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('途中の題名');

    fireEvent.click(screen.getByTestId('probe-nav'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/notices'));
  });

  it('入力があれば、年度を切り替える前に確かめる。やめれば切り替えず入力が残り、「切り替える」で切り替える', async () => {
    const user = setUser();
    renderScreen('head', { guard: true });
    await openEdit(user, '総務の打ち合わせ');
    await user.type(screen.getByLabelText('題名'), '！');
    fireEvent.click(screen.getByTestId('probe-year'));
    const leave = await screen.findByRole('alertdialog');
    expect(leave.textContent).toContain(LEAVE_MESSAGES.year.description);
    await user.click(within(leave).getByRole('button', { name: 'やめる（入力を続ける）' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(h.setYear).not.toHaveBeenCalled();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('総務の打ち合わせ！');

    fireEvent.click(screen.getByTestId('probe-year'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.year.confirm }));
    await waitFor(() => expect(h.setYear).toHaveBeenCalledWith(Y_PREV));
  });

  it('捨てて閉じた後は確かめずに移る（守りはダイアログの入力の間だけ）', async () => {
    const user = setUser();
    renderScreen('head', { guard: true });
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '途中');
    await user.click(within(screen.getByTestId('event-dialog')).getByRole('button', { name: 'やめる' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(h.push).toHaveBeenLastCalledWith('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('T18 読み直し（(B1)）', () => {
  it('編集の conflict：今の行を読み直し、入力を残して知らせる（今の題名と更新の日時）。次の保存は読み直した版で送り、上書きできる', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    // 開いた後に、ほかの人が直した
    rows = rows.map((r) => (r.id === E_SOUMU ? { ...r, title: 'ほかの人の題名', updated_at: '2027-10-05T01:00:00.000001+00:00' } : r));
    const title = screen.getByLabelText('題名');
    await user.clear(title);
    await user.type(title, '私の題名');
    await user.click(submit());
    const box = await screen.findByTestId('event-conflict');
    expect(box.textContent).toContain(CONFLICT_NOTICE);
    expect(box.textContent).toContain('今の題名：ほかの人の題名');
    expect(box.textContent).toContain('更新：2027/10/05 10:00');
    expect((title as HTMLInputElement).value).toBe('私の題名');
    expect(submit().hasAttribute('disabled')).toBe(false);
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(opArgs(calls('update')[1]!, 'eq')).toEqual([['updated_at', '2027-10-05T01:00:00.000001+00:00']]);
    expect(rows.find((r) => r.id === E_SOUMU)!.title).toBe('私の題名');
  });

  it('編集の間に消えていた：「この項目は見つかりません」と出し、「保存」を押せなくする（入力は残す）', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    rows = rows.filter((r) => r.id !== E_SOUMU);
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(submit());
    expect((await screen.findByTestId('event-missing')).textContent).toContain(EVENT_MISSING_MESSAGE);
    expect(submit().hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('総務の打ち合わせ！');
  });

  it('保存の応答が届かず、読み直すと入力どおり：「保存されていました」で閉じる', async () => {
    override = (call) => {
      if (call.table !== 'events' || !has(call, 'update')) return undefined;
      dbUpdate(call);
      return NETWORK;
    };
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    await user.type(screen.getByLabelText('題名'), '（変更）');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('保存されていました');
  });

  it('保存の応答が届かず、版が読んだときのまま：「保存できたか分かりません」。もう一度の保存は（入力を戻しても）送る', async () => {
    override = (call) => (call.table === 'events' && has(call, 'update') ? NETWORK : undefined);
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    const title = screen.getByLabelText('題名');
    await user.type(title, '！');
    await user.click(submit());
    const box = await screen.findByTestId('event-error');
    expect(box.textContent).toBe(unknownOutcomeMessage('保存'));
    await user.clear(title);
    await user.type(title, '総務の打ち合わせ');
    override = null;
    await user.click(submit());
    await waitFor(() => expect(calls('update')).toHaveLength(2));
    expect(toast.info).not.toHaveBeenCalledWith('変更はありません');
  });

  it('保存の応答が届かず、読み直せない：「保存できたか分かりません」（「読み直しました」と言わない）', async () => {
    override = (call) => (call.table === 'events' && (has(call, 'update') || has(call, 'maybeSingle')) ? NETWORK : undefined);
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(submit());
    const box = await screen.findByTestId('event-error');
    expect(box.textContent).toBe(unknownOutcomeMessage('保存'));
    expect(box.textContent).not.toContain('読み直しました');
  });

  /** 止められた保存（版が V1 に進んでいる）の後の (B1) の読み直し（readEvent）だけを落とす。0 行の理由の読み直し（explainZeroRows）は通す */
  function failRereads(): { fail: boolean } {
    const state = { fail: true };
    override = (call) =>
      state.fail && call.table === 'events' && has(call, 'maybeSingle') && opArgs(call, 'select')[0]?.[0] === CALENDAR_EVENTS_SELECT ? NETWORK : undefined;
    return state;
  }
  const unreadBox = async () => {
    const box = await screen.findByTestId('event-error');
    expect(box.getAttribute('data-kind')).toBe('unread');
    expect(box.textContent).toContain(REREAD_FAILED_NOTICE);
    return box;
  };

  it('止められた（conflict）後に読み直せない：読み直せなかったと出す。「読み直す」はその項目を読み直し、まだ読めなければ知らせて版を進めず、読めれば衝突の知らせにして、次の1回の保存で上書きできる（レビューの T18-2）', async () => {
    const V1 = '2027-10-05T01:00:00.000001+00:00';
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    rows = rows.map((r) => (r.id === E_SOUMU ? { ...r, title: 'ほかの人の題名', updated_at: V1 } : r));
    const reads = failRereads();
    const title = screen.getByLabelText('題名') as HTMLInputElement;
    await user.type(title, '！');
    await user.click(submit());
    await unreadBox();
    // まだ読めない：知らせて、知らせと「読み直す」を残す。版は進めない（次の保存も読んだときの版 V0 で送り、また止められる）
    await user.click(within(screen.getByTestId('event-error')).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REREAD_AGAIN_FAILED_MESSAGE));
    await unreadBox();
    await user.click(submit());
    await waitFor(() => expect(calls('update')).toHaveLength(2));
    expect(opArgs(calls('update')[1]!, 'eq')).toEqual([['updated_at', V0]]);
    await unreadBox();
    // 読めた：今の行で衝突の知らせにし（入力は残す）、一覧も読み直す
    reads.fail = false;
    const lists = () => issued.filter((x) => x.table === 'events' && !has(x, 'maybeSingle') && !has(x, 'update')).length;
    const before = lists();
    await user.click(within(screen.getByTestId('event-error')).getByRole('button', { name: '読み直す' }));
    const conflict = await screen.findByTestId('event-conflict');
    expect(conflict.textContent).toContain('今の題名：ほかの人の題名');
    expect(screen.queryByTestId('event-error')).toBeNull();
    expect(title.value).toBe('総務の打ち合わせ！');
    await waitFor(() => expect(lists()).toBe(before + 1));
    expect(calls('update')).toHaveLength(2);
    // 次の1回の保存は、読み直した版で送って上書きする
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(opArgs(calls('update')[2]!, 'eq')).toEqual([['updated_at', V1]]);
    expect(rows.find((r) => r.id === E_SOUMU)!.title).toBe('総務の打ち合わせ！');
    expect(toast.success).toHaveBeenCalledWith('「総務の打ち合わせ！」を保存しました');
  });

  it('読み直せなかった後の「読み直す」：項目が消えていたら「この項目は見つかりません」で「保存」を押せなくし、今の行が入力と同じなら「保存されていました」で閉じる', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    rows = rows.map((r) => (r.id === E_SOUMU ? { ...r, updated_at: '2027-10-05T01:00:00.000001+00:00' } : r));
    const reads = failRereads();
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(submit());
    await unreadBox();
    rows = rows.filter((r) => r.id !== E_SOUMU);
    reads.fail = false;
    await user.click(within(screen.getByTestId('event-error')).getByRole('button', { name: '読み直す' }));
    expect((await screen.findByTestId('event-missing')).textContent).toContain(EVENT_MISSING_MESSAGE);
    expect(submit().hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('総務の打ち合わせ！');
    cleanup();

    // ほかの人が（または前の送信が）同じ中身にしていた
    rows = seedRows();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    rows = rows.map((r) => (r.id === E_SOUMU ? { ...r, title: '総務の打ち合わせ！', updated_at: '2027-10-05T01:00:00.000001+00:00' } : r));
    const again = failRereads();
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(submit());
    await unreadBox();
    const sent = calls('update').length;
    again.fail = false;
    await user.click(within(screen.getByTestId('event-error')).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('保存されていました');
    // 「読み直す」は読むだけ（送り直さない）
    expect(calls('update')).toHaveLength(sent);
  });

  it('登録の応答が届かず、読み直すと登録されていた：「「…」は登録されていました」で閉じる', async () => {
    override = (call) => {
      if (call.table !== 'events' || !has(call, 'insert')) return undefined;
      dbInsert(call);
      return NETWORK;
    };
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '説明会');
    setValue('event-start', '2027-10-17T13:00');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('「説明会」は登録されていました');
  });

  it('登録の応答が届かず、登録されていなかった：「登録できたか分かりません」。もう一度押すと同じ id で送る', async () => {
    override = (call) => (call.table === 'events' && has(call, 'insert') ? NETWORK : undefined);
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '説明会');
    setValue('event-start', '2027-10-17T13:00');
    await user.click(submit());
    expect((await screen.findByTestId('event-error')).textContent).toBe(unknownOutcomeMessage('登録'));
    override = null;
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    const [first, second] = calls('insert');
    expect(valuesOf(second!, 'insert').id).toBe(valuesOf(first!, 'insert').id);
    expect(toast.success).toHaveBeenCalledWith('「説明会」を登録しました');
  });

  it('登録の送り直しが 23505 で、読み直すと入力と違う（間にほかの人が直した）：その項目の編集に切り替えて入力を残し、衝突の知らせ', async () => {
    let first = true;
    override = (call) => {
      if (call.table !== 'events' || !has(call, 'insert') || !first) return undefined;
      first = false;
      // 前の送信が通っていて、その後ほかの人が題名を直した
      dbInsert(call);
      const id = valuesOf(call, 'insert').id;
      rows = rows.map((r) => (r.id === id ? { ...r, title: 'ほかの人が直した', updated_at: '2027-10-06T00:00:00.000009+00:00' } : r));
      return NETWORK;
    };
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '説明会');
    setValue('event-start', '2027-10-17T13:00');
    await user.click(submit());
    const box = await screen.findByTestId('event-conflict');
    expect(box.textContent).toContain('今の題名：ほかの人が直した');
    expect(screen.getByRole('heading', { name: '締切・予定を編集' })).toBeTruthy();
    expect(submit().textContent).toBe('保存');
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('説明会');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(opArgs(calls('update')[0]!, 'eq')).toEqual([['updated_at', '2027-10-06T00:00:00.000009+00:00']]);
    expect(toast.success).toHaveBeenCalledWith('「説明会」を保存しました');
  });

  it('登録が 23505 で、読み直すと入力どおり（前の送信が通っていた）：「「…」は登録されていました」', async () => {
    override = (call) => {
      if (call.table !== 'events' || !has(call, 'insert')) return undefined;
      dbInsert(call);
      return pgError('23505', 409);
    };
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '説明会');
    setValue('event-start', '2027-10-17T13:00');
    await user.click(submit());
    await waitFor(() => expect(screen.queryByTestId('event-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('「説明会」は登録されていました');
  });

  it('forbidden（権限か年度の状態が変わった。0 行で版が同じ）：失敗の帯、立場と年度の行の読み直し、「保存」を押せなくする（入力は残す）', async () => {
    const user = setUser();
    renderScreen('head');
    await openEdit(user, '総務の打ち合わせ');
    // 開いた後に、総務部門員に変わった（DB は 0 行を返す）
    h.role = 'staff';
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(submit());
    const box = await screen.findByTestId('event-error');
    expect(box.textContent).toContain('権限がありません。立場が変わった可能性があります');
    expect(h.reloadMembership).toHaveBeenCalled();
    expect(submit().hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByTestId('event-dialog')).getByText(CANNOT_SAVE_TEXT)).toBeTruthy();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('総務の打ち合わせ！');
  });

  it('登録が 42501（書けない）・23514（CHECK）：失敗の帯（CHECK は「入力が範囲を超えています」）', async () => {
    override = (call) => (call.table === 'events' && has(call, 'insert') ? pgError('23514', 400) : undefined);
    const user = setUser();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '説明会');
    setValue('event-start', '2027-10-17T13:00');
    await user.click(submit());
    expect((await screen.findByTestId('event-error')).textContent).toContain('入力が範囲を超えています');
    expect(submit().hasAttribute('disabled')).toBe(false);
  });
});

// ---------------------------------------------------------------- 削除

async function openDelete(user: ReturnType<typeof setUser>, title: string) {
  await loaded();
  await user.click(screen.getByRole('button', { name: `「${title}」を削除` }));
  return screen.findByRole('alertdialog');
}

describe('T18 削除', () => {
  it('確かめてから、読んだときの updated_at を条件に入れて delete。消えたら一覧から外して「「…」を削除しました」', async () => {
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    expect(within(dialog).getByText('「書類の提出」を削除しますか')).toBeTruthy();
    expect(within(dialog).getByText('この項目は、一覧とダッシュボードの締切と予定から消えます。元に戻せません。')).toBeTruthy();
    expect(within(dialog).getByTestId('event-delete-confirm')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(itemIds()).not.toContain(c(E_GROUPS)));
    const d = calls('delete')[0]!;
    expect(opArgs(d, 'match')).toEqual([[{ id: E_GROUPS }]]);
    expect(opArgs(d, 'eq')).toEqual([['updated_at', V0]]);
    expect(toast.success).toHaveBeenCalledWith('「書類の提出」を削除しました');
  });

  it('すでに消えていた（0 行で読み直すとない）：「すでに削除されていました」', async () => {
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    rows = rows.filter((r) => r.id !== E_GROUPS);
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(ALREADY_DELETED_MESSAGE));
  });

  it('版が違う（ほかの人が先に変えた）：内容を確かめてからもう一度削除してもらう（一覧を読み直す）', async () => {
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    rows = rows.map((r) => (r.id === E_GROUPS ? { ...r, title: '書類の提出（延長）', updated_at: '2027-10-05T00:00:00.000001+00:00' } : r));
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(DELETE_CHANGED_MESSAGE));
    await waitFor(() => expect(within(itemOf(c(E_GROUPS))).getByTestId('calendar-item-title').textContent).toBe('書類の提出（延長）'));
    expect(rows.some((r) => r.id === E_GROUPS)).toBe(true);
  });

  it('応答が届かず、版が同じ：確かめのダイアログに「削除できたか分かりません…」と出して開いたまま。もう一度押して消えていれば「「…」は削除されていました」', async () => {
    override = (call) => (call.table === 'events' && has(call, 'delete') ? NETWORK : undefined);
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    expect((await within(dialog).findByTestId('event-delete-error')).textContent).toBe(unknownOutcomeMessage('削除'));
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    // 前の削除が後から通っていた
    rows = rows.filter((r) => r.id !== E_GROUPS);
    override = null;
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「書類の提出」は削除されていました'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('応答が届かず、読み直すともうない：消せたとして「「…」を削除しました」', async () => {
    override = (call) => {
      if (call.table !== 'events' || !has(call, 'delete')) return undefined;
      dbDelete(call);
      return NETWORK;
    };
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「書類の提出」を削除しました'));
    await waitFor(() => expect(itemIds()).not.toContain(c(E_GROUPS)));
  });

  it('forbidden（0 行で版が同じ。権限か年度の状態が変わった）：失敗の知らせと立場の読み直し', async () => {
    const user = setUser();
    renderScreen('head');
    const dialog = await openDelete(user, '書類の提出');
    h.status = 'closed';
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('権限がありません。立場が変わった可能性があります'));
    expect(h.reloadMembership).toHaveBeenCalled();
    expect(rows.some((r) => r.id === E_GROUPS)).toBe(true);
  });
});
