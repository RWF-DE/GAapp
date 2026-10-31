// @vitest-environment jsdom
// ダッシュボード（/）の欄（04「ダッシュボード」、notes/T16.md「固めた約束」2・5。T16）：立場ごとの欄と h1、欄ごとの読み込み中・
// 失敗ともう一度・エラーの境界（1つの機能・1つの欄の失敗でほかを止めない）、読むもの（版・振り分けの行・ルールを読まない）、
// / の部品がスナップショット・検証・机椅子の状況の部品を import しないこと。T17：お知らせの欄（総務内のお知らせ・お知らせ）の
// 立場ごとの出し分け・並び・読むもの・失敗の切り分けと、/ がお知らせ一覧の画面とダイアログを import しないこと。T18：締切と予定の
// 欄の選び方（これからの 30 日と過ぎた締切）・曜日と相対の言い方・リンク、予定と締切の読み取り（1人1回）と失敗の切り分け、
// / が締切と予定の一覧の画面とダイアログを import しないこと。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）、立場は useAuth の差し替え、年度の行は立場と一緒に読んだキャッシュ
// （QueryClient に入れておく）。時計は Date だけを止める（ダッシュボードを開いた時刻）。
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { portalQueryKey, portalQueryOptions, type PortalProvider } from '@/lib/modules/portal';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createQueryClient, queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { PortalScreen } from './portal-screen';

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  client: null as unknown,
  /** PORTAL_PROVIDERS の差し替え（机椅子・お知らせ・締切と予定の本物のプロバイダの後ろに、テストのプロバイダを足せる） */
  providers: [] as PortalProvider[],
  /** 真なら要対応の並べ替え（sortTodos）で例外を投げる（欄の描画の例外） */
  throwInTodos: false,
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({ membership: h.membership, reloadMembership: () => {}, isRefreshing: false }),
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
vi.mock('@/lib/modules/portal', async (orig) => {
  const actual = await orig<typeof import('@/lib/modules/portal')>();
  return {
    ...actual,
    sortTodos: (todos: Parameters<typeof actual.sortTodos>[0]) => {
      if (h.throwInTodos) throw new Error('描画の例外（テスト）');
      return actual.sortTodos(todos);
    },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown> & { href: string; children: React.ReactNode }) => {
    const { href, children, onNavigate, prefetch, ...rest } = props;
    void onNavigate;
    void prefetch;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// ---------------------------------------------------------------- データ

const Y = '11111111-1111-4111-8111-111111111111';
const OPEN = '2026-09-20T00:00:00+00:00';
/** 10/5 17:00（Asia/Tokyo） */
const CLOSE = '2026-10-05T08:00:00+00:00';
/** 締切を過ぎた後（10/6 9:00 Asia/Tokyo）。1日目は 10/17 なので、前々日〜2日目の4つはこれから */
const AFTER_CLOSE = '2026-10-06T00:00:00Z';
/** 受付期間の中（10/1 9:00 Asia/Tokyo） */
const IN_WINDOW = '2026-10-01T00:00:00Z';

const yearRow = (status: YearStatus, over: Partial<YearRow> = {}): YearRow => ({
  id: Y,
  label: 'R8',
  status,
  allocation_version: 3,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: OPEN,
  request_close_at: CLOSE,
  prev_year_id: null,
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };

function member(role: AppRole | null, groups: GroupSummary[], status: YearStatus): Membership {
  const year = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role, groups, years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

/** 総務の読み取りの行：未提出 1 団体（模擬店02）・数えていない保管場所 1 か所（1-2）・了承の依頼中 1 団体（模擬店01） */
const SOUMU_ROWS: Record<string, unknown[]> = {
  groups: [
    { id: 'g1', name: '模擬店01', category: 'stall', sort_order: 1 },
    { id: 'g2', name: '模擬店02', category: 'stall', sort_order: 2 },
  ],
  request_submissions: [{ group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z', groups: { year_id: Y } }],
  rooms: [
    { id: 'r1', name: '1-1', is_storage: true, sort_order: 1 },
    { id: 'r2', name: '1-2', is_storage: true, sort_order: 2 },
  ],
  room_years: [],
  stocks: [{ room_id: 'r1' }],
  substitution_consents: [{ group_id: 'g1', status: 'asked', groups: { year_id: Y } }],
};

/** 団体代表（模擬店01）の読み取りの行：未提出・交換の依頼あり */
const REP_ROWS: Record<string, unknown[]> = {
  request_submissions: [],
  substitution_consents: [
    { group_id: 'g1', from_item_id: 'desk', to_item_id: 'caster', status: 'asked', count: 2, note: null, updated_at: 't' },
  ],
};

/** お知らせの新着の応答（T17。既定は 0 件。テストが入れる） */
let noticeRows: Record<string, unknown>[] = [];
/** 予定と締切の応答（T18。RLS が返した行の代わり。既定は 0 件。テストが入れる） */
let eventRows: Record<string, unknown>[] = [];

/** 偽の Supabase の応答。override が FakeResult か Promise を返せばそれを使う */
let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
  // お知らせの新着（T17）：宛先の絞り込み（eq の audience = soumu か、in の all_groups・groups）を当てて返す
  if (call.table === 'notices') {
    const soumu = opArgs(call, 'eq').some(([col, v]) => col === 'audience' && v === 'soumu');
    return { data: noticeRows.filter((r) => (soumu ? r.audience === 'soumu' : r.audience !== 'soumu')) };
  }
  // 予定と締切（T18）：読める範囲は RLS が決めるので、テストが入れた行をそのまま返す
  if (call.table === 'events') return { data: eventRows };
  const byRep = opArgs(call, 'in').length > 0;
  const rows = (byRep ? REP_ROWS : SOUMU_ROWS)[call.table];
  if (!rows) return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  return { data: rows };
}

const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

function renderPortal(m: Membership, opts: { year?: YearRow | null } = {}) {
  h.membership = { status: 'ready', membership: m };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  // 立場と一緒に読んだ年度の行（D-45）。null なら入れない（年度の行を読む）
  if (opts.year !== null) qc.setQueryData(queryKeys.yearRow(Y), opts.year ?? yearRow(m.year!.status));
  render(
    <QueryClientProvider client={qc}>
      <PortalScreen />
    </QueryClientProvider>,
  );
  return qc;
}

const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const todoIds = () => screen.queryAllByTestId('portal-todo').map((x) => x.getAttribute('data-id'));
const datedIds = () => screen.queryAllByTestId('portal-dated-item').map((x) => x.getAttribute('data-id'));
const tablesRead = () => issued.map((c) => c.table).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AFTER_CLOSE));
  override = null;
  noticeRows = [];
  eventRows = [];
  const fake = createFakeSupabase(handler);
  h.client = fake.client;
  issued = fake.issued;
  h.throwInTodos = false;
  h.providers.splice(3);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 立場ごとの欄

describe('T16 ダッシュボード：立場ごとの欄と h1', () => {
  it('総務（管理者）：h1「ダッシュボード」、立場の一覧 → 要対応・締切と予定 → 総務内のお知らせ（T17）→ 機能ごとの状況。代表する団体はない', async () => {
    renderPortal(member('admin', [], 'requesting'));
    expect(h1()).toBe('ダッシュボード');
    expect(screen.getByTestId('home-year').textContent).toBe('R8（申請受付中）');
    expect(screen.getByTestId('home-roles').textContent).toBe('管理者');
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    // T18：これからの4つ（前々日〜2日目）と、過ぎた締切（申請の締切 10/5 17:00）。早い順
    expect(datedIds()).toEqual(['furniture:request-close', 'furniture:day-minus2', 'furniture:day-minus1', 'furniture:day1', 'furniture:day2']);
    const card = screen.getByTestId('module-card');
    expect(card.getAttribute('data-module')).toBe('furniture');
    // 開いた時刻（10/6）は締切（10/5 17:00）の後なので、締切を過ぎたことも出す（レビューの T16-UX-04）
    expect([...card.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '申請受付中（締切を過ぎました）',
      '申請 1／2 団体が提出',
      '在庫 1／2 か所を数えた',
    ]);
    expect(within(card).getByRole('link', { name: '机椅子の状況へ' }).getAttribute('href')).toBe('/furniture');
    expect(screen.queryByTestId('rep-home')).toBeNull();
    // 要対応の期日（締切を過ぎた・未提出）も「を過ぎました」
    expect(screen.getAllByTestId('portal-todo-due').map((x) => x.textContent)).toEqual(['締切 10/5 17:00 を過ぎました', '締切 10/5 17:00 を過ぎました']);
    // 今の年度と状態は立場の一覧にあるので、見出し（h1）の横には出さない（レビューの T16-UX-11）
    expect(screen.getByRole('heading', { level: 1 }).parentElement?.textContent).toBe('ダッシュボード');
    // 見出し（h2）と DOM の並び。お知らせはカードを作らない（機能ごとの状況は机椅子だけ）
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual([
      'あなたの立場',
      '要対応',
      '締切と予定',
      '総務内のお知らせ',
      '機能ごとの状況',
    ]);
    expect(screen.getAllByTestId('module-card').map((c) => c.getAttribute('data-module'))).toEqual(['furniture']);
  });

  it('総務部門員も h1「ダッシュボード」。部門長以上の要対応（締切を押す）は出ず、総務の分だけ', async () => {
    renderPortal(member('staff', [], 'requesting'));
    expect(h1()).toBe('ダッシュボード');
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
  });

  it('閲覧のみ：h1「ホーム」、要対応の欄がない。机椅子のカード（確定前はリンクなし）と締切と予定。読むのはお知らせの新着（T17）と締切と予定（T18）だけ', async () => {
    renderPortal(member('viewer', [], 'allocating'));
    expect(h1()).toBe('ホーム');
    expect(screen.queryByTestId('portal-todos')).toBeNull();
    const card = within(screen.getByTestId('portal-cards')).getByTestId('module-card');
    expect(card.textContent).toBe('机椅子振り分けが確定すると、ここから見られます');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(datedIds()).toHaveLength(5);
    // 机椅子の締切と予定は閲覧のみにはリンクにしない（申請一覧・申請を開けない）。欄の下の「締切と予定の一覧へ」だけ
    expect(within(screen.getByTestId('portal-dated')).queryAllByRole('link').map((a) => a.getAttribute('data-testid'))).toEqual(['portal-dated-link']);
    await screen.findByTestId('portal-notices-empty');
    await waitFor(() => expect(screen.queryByTestId('portal-loading')).toBeNull());
    expect(tablesRead()).toEqual(['events', 'notices']);
  });

  it('閲覧のみ（確定）：カードに「振り分けが決まりました」と「振り分け表を見る」（/allocation）', () => {
    renderPortal(member('viewer', [], 'confirmed'));
    const card = screen.getByTestId('module-card');
    expect(card.textContent).toContain('振り分けが決まりました');
    expect(within(card).getByRole('link', { name: '振り分け表を見る' }).getAttribute('href')).toBe('/allocation');
  });

  it('店長：h1「ホーム」、要対応・締切と予定・お知らせ（T17）・代表する団体。機能ごとのカードはない。自団体の提出と了承とお知らせの新着だけを読む（1回ずつ）', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    renderPortal(member(null, [G1], 'requesting'));
    expect(h1()).toBe('ホーム');
    expect(screen.queryByTestId('portal-cards')).toBeNull();
    const card = await screen.findByTestId('rep-card');
    expect(card.getAttribute('data-group')).toBe('模擬店01');
    await waitFor(() => expect(todoIds()).toEqual(['furniture:rep:g1:unsubmitted', 'furniture:rep:g1:consent']));
    const unsubmitted = screen.getAllByTestId('portal-todo')[0]!;
    expect(unsubmitted.textContent).toContain('模擬店01：申請が未提出です');
    expect(within(unsubmitted).getByTestId('portal-todo-due').textContent).toBe('締切 10/5 17:00');
    expect(within(unsubmitted).getByRole('link').getAttribute('href')).toBe('/request?group=g1');
    // 締切と予定は申請（/request）へのリンク
    const close = screen.getAllByTestId('portal-dated-item').find((x) => x.getAttribute('data-id') === 'furniture:request-close')!;
    expect(close.getAttribute('data-kind')).toBe('deadline');
    expect(within(close).getByRole('link').getAttribute('href')).toBe('/request');
    // T18：曜日つきの日付と相対の言い方（10/1 から 10/5 は「あと 4 日」）
    expect(within(close).getByTestId('portal-dated-when').textContent).toBe('10/5（月）17:00');
    expect(within(close).getByTestId('portal-dated-relative').textContent).toBe('あと 4 日');
    expect(close.textContent).toContain('締切');
    // 代表する団体の欄と要対応は同じキャッシュ（リクエストは1回ずつ）。版・在庫・振り分けの行・ルールは読まない
    await screen.findByTestId('portal-notices-empty');
    await waitFor(() => expect(tablesRead()).toEqual(['events', 'notices', 'request_submissions', 'substitution_consents']));
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual([
      'あなたの立場',
      '要対応',
      '締切と予定',
      'お知らせ',
      '代表する団体',
    ]);
  });

  it('管理者で店長も務める人：ダッシュボードに代表する団体のカードと自団体の要対応。並びは要対応・締切と予定 → 総務内のお知らせ・お知らせ → 代表する団体 → 機能ごとの状況', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    renderPortal(member('admin', [G1], 'requesting'));
    expect(h1()).toBe('ダッシュボード');
    await screen.findByTestId('rep-card');
    await screen.findByTestId('module-card');
    await waitFor(() => expect(todoIds()).toContain('furniture:rep:g1:unsubmitted'));
    // 1つの欄にまとめ、sortTodos の順（どれもふつう → 期日〔締切〕のあるものが先 → 作った順〔総務 → 団体代表〕）
    expect(todoIds()).toEqual(['furniture:soumu:unsubmitted', 'furniture:rep:g1:unsubmitted', 'furniture:soumu:uncounted', 'furniture:rep:g1:consent']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual([
      'あなたの立場',
      '要対応',
      '締切と予定',
      '総務内のお知らせ',
      'お知らせ',
      '代表する団体',
      '機能ごとの状況',
    ]);
    const before = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByTestId('portal-dated'), screen.getByTestId('rep-card'))).toBe(true);
    expect(before(screen.getByTestId('rep-card'), screen.getByTestId('portal-cards'))).toBe(true);
    // 締切と予定は兼ねた人でも1回ずつ（申請一覧へのリンク。立場全体で決める）
    expect(datedIds().filter((id) => id === 'furniture:request-close')).toHaveLength(1);
    // T18：予定と締切は総務として1回だけ読む（店長・副店長の分は読まない。RLS は人ごとに同じ行を返す）
    await waitFor(() => expect(issued.filter((c) => c.table === 'events')).toHaveLength(1));
  });

  it('閲覧のみで店長も務める人：h1「ホーム」、要対応（自団体の分）・締切と予定・代表する団体・機能ごとの状況', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    renderPortal(member('viewer', [G1], 'requesting'));
    expect(h1()).toBe('ホーム');
    await screen.findByTestId('rep-card');
    await waitFor(() => expect(todoIds()).toEqual(['furniture:rep:g1:unsubmitted', 'furniture:rep:g1:consent']));
    expect(within(screen.getByTestId('portal-cards')).getByTestId('module-card').textContent).toContain('振り分けが確定すると');
  });
});

// ---------------------------------------------------------------- 読むもの

describe('T16 ダッシュボード：読むもの（版・振り分けの行・ルールを読まない。D-51）', () => {
  it('総務：机椅子の軽い読み取りの6つの表と、T17 総務内のお知らせの新着と、T18 予定と締切を1回ずつ（欄が3つでも同じキーは1回）。years・allocations・rules・requests は読まない', async () => {
    renderPortal(member('admin', [], 'requesting'));
    await screen.findByTestId('module-card');
    await screen.findByTestId('portal-notices-empty');
    await waitFor(() =>
      expect(tablesRead()).toEqual(['events', 'groups', 'notices', 'request_submissions', 'room_years', 'rooms', 'stocks', 'substitution_consents']),
    );
    const stocks = issued.find((c) => c.table === 'stocks')!;
    expect(opArgs(stocks, 'select')).toEqual([['room_id']]);
  });
});

// ---------------------------------------------------------------- 最後に読み込んだ日時と読み直し（レビューの T16-R2）

describe('T16 ダッシュボード：最後に読み込んだ日時と「読み直す」は出さず、戻ったときに 30 秒より前に読んだものを読み直す（04「ダッシュボード」の読むもの）', () => {
  it.each([
    { who: '総務（管理者）', m: () => member('admin', [], 'requesting'), ready: 'module-card' },
    { who: '閲覧のみ', m: () => member('viewer', [], 'requesting'), ready: 'module-card' },
    { who: '店長', m: () => member(null, [G1], 'requesting'), ready: 'rep-card' },
  ])('$who：最終読み込みの日時と「読み直す」のボタンがない', async ({ m, ready }) => {
    renderPortal(m());
    await screen.findByTestId(ready);
    expect(screen.queryByText(/最終読み込み/)).toBeNull();
    expect(screen.queryByRole('button', { name: /読み直/ })).toBeNull();
  });

  it.each([
    {
      who: '総務（管理者）',
      m: () => member('admin', [], 'requesting'),
      ready: 'module-card',
      tables: ['events', 'groups', 'notices', 'request_submissions', 'room_years', 'rooms', 'stocks', 'substitution_consents'],
    },
    {
      who: '店長',
      m: () => member(null, [G1], 'requesting'),
      ready: 'rep-card',
      tables: ['events', 'notices', 'request_submissions', 'substitution_consents'],
    },
  ])('$who：アプリの QueryClient の既定のまま、30 秒以内に戻れば読み直さず、30 秒を過ぎて戻れば読み直す', async ({ m, ready, tables }) => {
    const t0 = Date.parse(IN_WINDOW);
    vi.setSystemTime(new Date(t0));
    // 30 秒を過ぎると年度の行（立場の読み込みが入れたもの）も読み直すので、years にも答える
    override = (call) => (call.table === 'years' ? { data: yearRow('requesting') } : undefined);
    h.membership = { status: 'ready', membership: m() };
    // app/layout.tsx と同じ QueryClient（staleTime などの既定値）。テストの QueryClient の既定値で隠さない
    const qc = createQueryClient();
    qc.setQueryData(queryKeys.yearRow(Y), yearRow('requesting'));
    const open = () =>
      render(
        <QueryClientProvider client={qc}>
          <PortalScreen />
        </QueryClientProvider>,
      );
    const first = open();
    await screen.findByTestId(ready);
    await waitFor(() => expect(tablesRead()).toEqual(tables));
    first.unmount();

    // ほかの画面から 29 秒後に戻る：読んだものはまだ新しいので読み直さない
    vi.setSystemTime(new Date(t0 + 29_000));
    const second = open();
    await screen.findByTestId(ready);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(tablesRead()).toEqual(tables);
    second.unmount();

    // 31 秒後に戻る：机椅子の読み取り（と年度の行）を読み直す
    vi.setSystemTime(new Date(t0 + 31_000));
    open();
    await waitFor(() => expect(tablesRead()).toEqual([...tables, ...tables, 'years'].sort()));
    await screen.findByTestId(ready);
  });
});

// ---------------------------------------------------------------- 読み込み中・失敗・エラーの境界

describe('T16 ダッシュボード：欄ごとの読み込み中と失敗（04「ダッシュボード」の読み込みと失敗）', () => {
  it('読み込み中：年度の行だけで決まる項目（締切を過ぎた・締切と予定）は先に出し、机椅子の分は要対応とカードの欄に Skeleton（portal-loading）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    override = (call) => (call.table === 'request_submissions' ? gate.then(() => ({ data: SOUMU_ROWS.request_submissions })) : undefined);
    renderPortal(member('admin', [], 'requesting'));
    const todos = screen.getByTestId('portal-todos');
    expect(todoIds()).toEqual(['furniture:lead:close-requests']);
    expect(within(todos).getByTestId('portal-loading').getAttribute('data-module')).toBe('furniture');
    expect(within(screen.getByTestId('portal-cards')).getByTestId('portal-loading')).toBeTruthy();
    expect(within(screen.getByTestId('portal-cards')).queryByTestId('module-card')).toBeNull();
    expect(datedIds()).toHaveLength(5);
    expect(screen.queryByTestId('portal-todos-empty')).toBeNull();
    // 締切と予定は（机椅子の分は）年度の行だけで決まるので、机椅子の読み込み中を出さない（決定 7。締切と予定の機能の読み込み中だけ）
    const datedLoading = () => within(screen.getByTestId('portal-dated')).queryAllByTestId('portal-loading').map((x) => x.getAttribute('data-module'));
    expect(datedLoading()).not.toContain('furniture');

    release();
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    await waitFor(() => expect(screen.queryByTestId('portal-loading')).toBeNull());
  });

  it('机椅子の読み込みの失敗：要対応とカードの欄に失敗と「もう一度」。年度だけの要対応・締切と予定・立場の一覧は出る。もう一度で直る', async () => {
    let fail = true;
    override = (call) => (call.table === 'request_submissions' && fail ? NETWORK : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('admin', [], 'requesting'));
    const todos = screen.getByTestId('portal-todos');
    const err = await within(todos).findByTestId('portal-module-error');
    expect(err.getAttribute('data-module')).toBe('furniture');
    expect(err.textContent).toContain('机椅子：通信できませんでした。電波の良い所でもう一度');
    expect(todoIds()).toEqual(['furniture:lead:close-requests']);
    expect(within(todos).queryByTestId('portal-todos-empty')).toBeNull();
    // カードの欄：機能の名前・失敗・もう一度と、開ける入口（机椅子の状況）へのリンク
    const cards = screen.getByTestId('portal-cards');
    const cardErr = within(cards).getByTestId('portal-module-error');
    expect(within(cardErr).getByRole('link', { name: '机椅子の状況へ' }).getAttribute('href')).toBe('/furniture');
    // カードの欄は、すぐ上の見出し（机椅子）と重ねないよう「机椅子：」を sr-only に（読み上げでは読む）。要対応の欄では見せる（レビューの T16-UX-08）
    expect(within(cards).getByRole('heading', { level: 3 }).textContent).toBe('机椅子');
    expect(cardErr.textContent).toContain('机椅子：通信できませんでした');
    expect(within(cardErr).getByTestId('portal-module-error-label').className).toContain('sr-only');
    expect(within(err).getByTestId('portal-module-error-label').className).not.toContain('sr-only');
    expect(within(cards).queryByTestId('module-card')).toBeNull();
    // ほかの欄は出したまま。締切と予定は年度の行だけで決まるので、机椅子の失敗を出さない（決定 7。失敗は要対応とカードの2か所）
    expect(datedIds()).toHaveLength(5);
    expect(within(screen.getByTestId('portal-dated')).queryByTestId('portal-module-error')).toBeNull();
    expect(screen.getAllByTestId('portal-module-error')).toHaveLength(2);
    expect(screen.getByTestId('home-roles').textContent).toBe('管理者');
    expect(screen.queryByTestId('portal-widget-error')).toBeNull();

    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });

  it('読み直しだけの失敗（data がある）は、前の data を出し続ける（失敗を出さない）', async () => {
    const qc = renderPortal(member('admin', [], 'requesting'));
    await screen.findByTestId('module-card');
    override = (call) => (call.table === 'request_submissions' ? NETWORK : undefined);
    await qc.refetchQueries({ queryKey: ['year', Y, 'portal'] });
    // 読み直しは失敗している（キャッシュは error で data を持つ）。描画に知らせが届くまで待つ
    expect(qc.getQueryState(['year', Y, 'portal', 'furniture', 'soumu'])?.status).toBe('error');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByTestId('module-card')).toBeTruthy();
    expect(todoIds()).toContain('furniture:soumu:unsubmitted');
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });

  it('エラーの境界：要対応の欄の描画で例外が起きると、その欄だけ「この欄を表示できませんでした。」ともう一度。ほかの欄は出る。もう一度で戻る', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.throwInTodos = true;
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('admin', [], 'requesting'));
    const todos = screen.getByTestId('portal-todos');
    const err = within(todos).getByTestId('portal-widget-error');
    expect(err.textContent).toContain('この欄を表示できませんでした。');
    expect(within(todos).getByRole('heading', { level: 2 }).textContent).toBe('要対応');
    await screen.findByTestId('module-card');
    expect(datedIds()).toHaveLength(5);
    expect(within(screen.getByTestId('portal-dated')).queryByTestId('portal-widget-error')).toBeNull();

    h.throwInTodos = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    expect(within(todos).queryByTestId('portal-widget-error')).toBeNull();
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
  });

  it('年度の行がまだないときは、どの欄も読み込み中。読めたら中身を出す（年度の行は1回だけ読む）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    override = (call) => (call.table === 'years' ? gate.then(() => ({ data: yearRow('requesting') })) : undefined);
    renderPortal(member('viewer', [], 'requesting'), { year: null });
    expect(within(screen.getByTestId('portal-dated')).getByTestId('portal-loading')).toBeTruthy();
    expect(within(screen.getByTestId('portal-cards')).getByTestId('portal-loading')).toBeTruthy();
    expect(within(screen.getByTestId('portal-notices')).getByTestId('portal-loading')).toBeTruthy();
    release();
    await screen.findByTestId('module-card');
    expect(datedIds()).toHaveLength(5);
    // 年度の行は1回だけ。お知らせの新着（T17）と予定と締切（T18）は年度の行が届いてから読む
    await screen.findByTestId('portal-notices-empty');
    await waitFor(() => expect(issued.map((c) => c.table).sort()).toEqual(['events', 'notices', 'years']));
    expect(issued[0]!.table).toBe('years');
  });

  it('年度の行の読み込みの失敗：欄ごとに失敗ともう一度（年度の行を読み直す）', async () => {
    let fail = true;
    override = (call) => (call.table === 'years' ? (fail ? NETWORK : { data: yearRow('requesting') }) : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('viewer', [], 'requesting'), { year: null });
    const errs = await screen.findAllByTestId('portal-year-error');
    // 締切と予定・お知らせ（T17）・機能ごとの状況
    expect(errs).toHaveLength(3);
    expect(errs[0]!.textContent).toContain('通信できませんでした');
    fail = false;
    await user.click(within(errs[0]!).getByRole('button', { name: 'もう一度' }));
    await screen.findByTestId('module-card');
    expect(screen.queryByTestId('portal-year-error')).toBeNull();
  });
});

// ---------------------------------------------------------------- 読み取りを使う欄（query.widgets。決定 7）

describe('T16 ダッシュボード：機能の読み取りは、その結果を使う欄（query.widgets）にだけ並べる', () => {
  /** 締切と予定だけに使う読み取りを持つテストのプロバイダ（T18 の予定と締切のような機能）。読むのは test_events の表 */
  function datedOnlyProvider(): PortalProvider {
    return {
      moduleId: 'furniture',
      kinds: ['soumu'],
      query: {
        widgets: ['dated'],
        options: (ctx) =>
          portalQueryOptions(
            queryOptions({
              queryKey: portalQueryKey(ctx.year.id, 'furniture', 'soumu', 'test-events'),
              queryFn: async () => {
                const res = await (h.client as AppSupabaseClient).from('test_events' as never).select('*');
                if (res.error) throw new Error('読めませんでした');
                return res.data as unknown[];
              },
            }),
            () => ({ card: null, todos: [], dated: [{ id: 'test:event', moduleId: 'furniture', title: 'テストの予定', at: '2026-10-10', kind: 'event' }] }),
          ),
      },
    };
  }

  it('締切と予定だけに使う読み取りは、締切と予定の欄にだけ読み込み中・失敗を出し、要対応とカードには出さない', async () => {
    let fail = true;
    h.providers.push(datedOnlyProvider());
    override = (call) => (call.table === 'test_events' ? (fail ? NETWORK : { data: [{ id: 'e1' }] }) : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('admin', [], 'requesting'));
    const dated = screen.getByTestId('portal-dated');
    const err = await within(dated).findByTestId('portal-module-error');
    expect(err.textContent).toContain('机椅子：');
    // 要対応とカードは机椅子の読み取りだけ（テストの読み取りの失敗を出さない）
    await screen.findByTestId('module-card');
    expect(within(screen.getByTestId('portal-todos')).queryByTestId('portal-module-error')).toBeNull();
    expect(within(screen.getByTestId('portal-cards')).queryByTestId('portal-module-error')).toBeNull();
    expect(issued.filter((c) => c.table === 'test_events')).toHaveLength(1);

    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(datedIds()).toContain('test:event'));
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });
});

// ---------------------------------------------------------------- 急ぎの度合いの印

describe('T16 ダッシュボード：急ぎの度合いの印（急ぎ・参考）', () => {
  it('確定中の団体代表の「振り分けが決まりました」は「参考」の印（機能の「お知らせ」と取り違えないよう「お知らせ」と書かない）', async () => {
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    renderPortal(member(null, [G1], 'confirmed'));
    await waitFor(() => expect(todoIds()).toEqual(['furniture:rep:g1:final']));
    const final = screen.getByTestId('portal-todo');
    expect(final.getAttribute('data-severity')).toBe('info');
    expect(final.textContent).toContain('参考');
    expect(final.textContent).not.toContain('お知らせ');
    expect(final.textContent).toContain('模擬店01：振り分けが決まりました');
  });

  it('締切を過ぎた（急ぎ）の要対応は「急ぎ」の印', async () => {
    renderPortal(member('head', [], 'requesting'));
    await screen.findByTestId('module-card');
    const urgent = screen.getAllByTestId('portal-todo').find((x) => x.getAttribute('data-id') === 'furniture:lead:close-requests')!;
    expect(urgent.getAttribute('data-severity')).toBe('urgent');
    expect(urgent.textContent).toContain('急ぎ');
  });
});

// ---------------------------------------------------------------- 0 件と続き

describe('T16 ダッシュボード：0 件の文言と「ほか N 件」', () => {
  it('要対応が 0 件なら「今やることはありません」、締切と予定が 0 件なら「これからの締切と予定はありません」', async () => {
    // 祭の後（2日目の翌日より後）の振り分け中：総務部門員の要対応はなく、日付もすべて過去。受付期間のない年度（過ぎた締切もない。T18）
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    renderPortal(member('staff', [], 'allocating'), { year: yearRow('allocating', { request_open_at: null, request_close_at: null }) });
    await screen.findByTestId('module-card');
    expect(screen.getByTestId('portal-todos-empty').textContent).toBe('今やることはありません');
    expect((await screen.findByTestId('portal-dated-empty')).textContent).toBe('これからの締切と予定はありません');
    expect(screen.queryByTestId('portal-dated-more')).toBeNull();
    // 空のときも一覧へのリンクを出す
    expect(screen.getByTestId('portal-dated-link').getAttribute('href')).toBe('/calendar');
  });

  it('締切と予定は 8 件まで。続きは「ほか N 件」（早い順）', async () => {
    // テストのプロバイダ：これからの予定を 5 件足す（机椅子の4件と合わせて 9 件）
    h.providers.push({
      moduleId: 'furniture',
      kinds: ['viewer'],
      fromYear: () => ({
        card: null,
        todos: [],
        dated: [1, 2, 3, 4, 5].map((d) => ({ id: `test:${d}`, moduleId: 'furniture' as const, title: `予定 ${d}`, at: `2026-10-0${d + 6}`, kind: 'event' as const })),
      }),
    });
    renderPortal(member('viewer', [], 'requesting'));
    expect(datedIds()).toEqual(['test:1', 'test:2', 'test:3', 'test:4', 'test:5', 'furniture:day-minus2', 'furniture:day-minus1', 'furniture:day1']);
    // 残りは、これからの 2日目と、枠に入らなかった過ぎた締切（申請の締切。T18）
    expect(screen.getByTestId('portal-dated-more').textContent).toBe('ほか 2 件');
    // 日付だけの項目は「10/7（水）」の形（T18 で曜日を付けた）
    expect(screen.getAllByTestId('portal-dated-item')[0]!.querySelector('time')?.textContent).toBe('10/7（水）');
  });
});

// ---------------------------------------------------------------- お知らせの欄（T17）

/** お知らせの新着の行（RLS の結果の代わり。題名で並びを見分ける） */
const notice = (id: string, audience: 'soumu' | 'all_groups' | 'groups', created_at: string, pinned = false) => ({
  id,
  audience,
  title: `題名${id}`,
  pinned,
  created_at,
});
const noticeIds = (root: HTMLElement) => within(root).queryAllByTestId('portal-notice').map((x) => x.getAttribute('data-id'));

describe('T17 ダッシュボード：お知らせの欄（04「ダッシュボード」・「お知らせ一覧」の「ダッシュボードに出すもの」）', () => {
  it('総務：「総務内のお知らせ」に総務内の新着（ピン留めが先、出した日時の新しい順）。1件は一覧のそのお知らせへのリンク・ピン留めの印・日時。宛先の印は出さない', async () => {
    noticeRows = [
      notice('n1', 'soumu', '2026-10-01T00:00:00Z'),
      notice('n2', 'soumu', '2026-10-03T00:00:00Z'),
      notice('n3', 'soumu', '2026-09-20T00:00:00Z', true),
      notice('g1', 'all_groups', '2026-10-04T00:00:00Z', true),
    ];
    renderPortal(member('staff', [], 'requesting'));
    const w = screen.getByTestId('portal-soumu-notices');
    expect(within(w).getByRole('heading', { level: 2 }).textContent).toBe('総務内のお知らせ');
    await waitFor(() => expect(noticeIds(w)).toEqual(['n3', 'n2', 'n1']));
    expect(screen.queryByTestId('portal-notices')).toBeNull();
    const [first] = within(w).getAllByTestId('portal-notice');
    expect(first!.getAttribute('data-pinned')).toBe('true');
    expect(first!.getAttribute('data-audience')).toBe('soumu');
    expect(within(first!).getByRole('link').getAttribute('href')).toBe('/notices?notice=n3');
    expect(first!.textContent).toContain('ピン留め');
    expect(first!.textContent).toContain('題名n3');
    // 9/20 9:00（Asia/Tokyo。formatShortDateTime の形）
    expect(first!.querySelector('time')?.textContent).toBe('9/20 09:00');
    expect(first!.textContent).not.toContain('総務内');
    expect(within(w).getAllByTestId('portal-notice')[1]!.textContent).not.toContain('ピン留め');
    // 欄の下のリンクは総務内で絞った一覧
    expect(within(w).getByTestId('portal-notices-link').getAttribute('href')).toBe('/notices?audience=soumu');
    expect(within(w).getByTestId('portal-notices-link').textContent).toBe('お知らせ一覧へ');
  });

  it('総務：読むのは notices の id・宛先・題名・ピン留め・出した日時だけ（総務内で、年度で絞り、ピン留め → 新しい順 → id に 5 件）', async () => {
    renderPortal(member('admin', [], 'requesting'));
    await screen.findByTestId('portal-notices-empty');
    const calls = issued.filter((c) => c.table === 'notices');
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(opArgs(c, 'select')).toEqual([['id, audience, title, pinned, created_at']]);
    expect(opArgs(c, 'eq')).toEqual([
      ['year_id', Y],
      ['audience', 'soumu'],
    ]);
    expect(opArgs(c, 'in')).toEqual([]);
    expect(opArgs(c, 'order')).toEqual([['pinned', { ascending: false }], ['created_at', { ascending: false }], ['id']]);
    expect(opArgs(c, 'limit')).toEqual([[5]]);
    expect(screen.getByTestId('portal-notices-empty').textContent).toBe('総務内のお知らせはありません');
  });

  it('新着は 5 件まで（ピン留めのものを先に）。6 件以上あっても 5 件', async () => {
    noticeRows = [1, 2, 3, 4, 5, 6].map((d) => notice(`s${d}`, 'soumu', `2026-10-0${d}T00:00:00Z`, d === 1));
    renderPortal(member('head', [], 'requesting'));
    const w = screen.getByTestId('portal-soumu-notices');
    await waitFor(() => expect(noticeIds(w)).toEqual(['s1', 's6', 's5', 's4', 's3']));
  });

  it('閲覧のみ：「お知らせ」に団体あての新着（宛先の印つき）。総務内のお知らせの欄はない。読むのは団体あて（in の全団体・指定の団体）を1回', async () => {
    noticeRows = [notice('a1', 'all_groups', '2026-10-02T00:00:00Z'), notice('a2', 'groups', '2026-10-03T00:00:00Z'), notice('x', 'soumu', '2026-10-04T00:00:00Z')];
    renderPortal(member('viewer', [], 'requesting'));
    expect(screen.queryByTestId('portal-soumu-notices')).toBeNull();
    const w = screen.getByTestId('portal-notices');
    expect(within(w).getByRole('heading', { level: 2 }).textContent).toBe('お知らせ');
    await waitFor(() => expect(noticeIds(w)).toEqual(['a2', 'a1']));
    const items = within(w).getAllByTestId('portal-notice');
    expect(items.map((x) => x.getAttribute('data-audience'))).toEqual(['groups', 'all_groups']);
    expect(items[0]!.textContent).toContain('指定の団体');
    expect(items[1]!.textContent).toContain('全団体');
    expect(within(w).getByTestId('portal-notices-link').getAttribute('href')).toBe('/notices');
    const calls = issued.filter((c) => c.table === 'notices');
    expect(calls).toHaveLength(1);
    expect(opArgs(calls[0]!, 'in')).toEqual([['audience', ['all_groups', 'groups']]]);
    expect(opArgs(calls[0]!, 'eq')).toEqual([['year_id', Y]]);
  });

  it('店長：「お知らせ」に団体あての新着。0 件なら「お知らせはありません」', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    renderPortal(member(null, [G1], 'requesting'));
    const w = screen.getByTestId('portal-notices');
    expect((await within(w).findByTestId('portal-notices-empty')).textContent).toBe('お知らせはありません');
    expect(screen.queryByTestId('portal-soumu-notices')).toBeNull();
  });

  it('管理者で店長も務める人：総務内のお知らせ（総務として）とお知らせ（団体あて）の両方。広い PC で横に並べ、総務内が先。読み取りは2回', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    noticeRows = [notice('s1', 'soumu', '2026-10-02T00:00:00Z'), notice('a1', 'all_groups', '2026-10-03T00:00:00Z')];
    renderPortal(member('admin', [G1], 'requesting'));
    const soumu = screen.getByTestId('portal-soumu-notices');
    const groups = screen.getByTestId('portal-notices');
    await waitFor(() => expect(noticeIds(soumu)).toEqual(['s1']));
    await waitFor(() => expect(noticeIds(groups)).toEqual(['a1']));
    expect(soumu.parentElement).toBe(groups.parentElement);
    expect(soumu.parentElement?.className).toContain('lg:grid-cols-2');
    expect(!!(soumu.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(issued.filter((c) => c.table === 'notices')).toHaveLength(2);
  });

  it('閲覧のみで店長も務める人：お知らせの欄は1つ、読み取りは閲覧のみとしての1回（同じお知らせを重ねない）', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    noticeRows = [notice('a1', 'all_groups', '2026-10-03T00:00:00Z')];
    renderPortal(member('viewer', [G1], 'requesting'));
    await screen.findByTestId('rep-card');
    const w = screen.getByTestId('portal-notices');
    await waitFor(() => expect(noticeIds(w)).toEqual(['a1']));
    expect(screen.getAllByTestId('portal-notices')).toHaveLength(1);
    expect(screen.queryByTestId('portal-soumu-notices')).toBeNull();
    expect(issued.filter((c) => c.table === 'notices')).toHaveLength(1);
  });

  it('お知らせの読み込み中は、お知らせの欄にだけ Skeleton（data-module=notices）。ほかの欄は出す', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    override = (call) => (call.table === 'notices' ? gate.then(() => ({ data: [notice('s1', 'soumu', '2026-10-02T00:00:00Z')] })) : undefined);
    renderPortal(member('admin', [], 'requesting'));
    await screen.findByTestId('module-card');
    // 締切と予定の機能（T18）の読み取りが届くのを待つ（その読み込み中は締切と予定の欄にだけ出る）
    await waitFor(() => expect(within(screen.getByTestId('portal-dated')).queryByTestId('portal-loading')).toBeNull());
    const w = screen.getByTestId('portal-soumu-notices');
    expect(within(w).getByTestId('portal-loading').getAttribute('data-module')).toBe('notices');
    expect(within(w).queryByTestId('portal-notices-empty')).toBeNull();
    for (const id of ['portal-todos', 'portal-dated', 'portal-cards']) {
      expect(within(screen.getByTestId(id)).queryByTestId('portal-loading'), id).toBeNull();
    }
    release();
    await waitFor(() => expect(noticeIds(w)).toEqual(['s1']));
    expect(screen.queryByTestId('portal-loading')).toBeNull();
  });

  it('お知らせの読み込みの失敗：お知らせの欄にだけ「お知らせ：…」ともう一度（と、お知らせ一覧へ）。要対応・締切と予定・カードは出る。もう一度で直る', async () => {
    let fail = true;
    override = (call) => (call.table === 'notices' && fail ? NETWORK : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('admin', [], 'requesting'));
    const w = screen.getByTestId('portal-soumu-notices');
    const err = await within(w).findByTestId('portal-module-error');
    expect(err.getAttribute('data-module')).toBe('notices');
    expect(err.textContent).toContain('お知らせ：通信できませんでした。電波の良い所でもう一度');
    expect(within(w).getByTestId('portal-notices-link').getAttribute('href')).toBe('/notices?audience=soumu');
    expect(within(w).queryByTestId('portal-notices-empty')).toBeNull();
    // ほかの欄は机椅子の分を出し、お知らせの失敗を出さない
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    for (const id of ['portal-todos', 'portal-dated', 'portal-cards']) {
      expect(within(screen.getByTestId(id)).queryByTestId('portal-module-error'), id).toBeNull();
    }
    noticeRows = [notice('s1', 'soumu', '2026-10-02T00:00:00Z')];
    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(noticeIds(w)).toEqual(['s1']));
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });

  it('机椅子の読み込みの失敗は、お知らせの欄に出ない（お知らせは出る）', async () => {
    override = (call) => (call.table === 'request_submissions' ? NETWORK : undefined);
    noticeRows = [notice('s1', 'soumu', '2026-10-02T00:00:00Z')];
    renderPortal(member('admin', [], 'requesting'));
    await within(screen.getByTestId('portal-todos')).findByTestId('portal-module-error');
    const w = screen.getByTestId('portal-soumu-notices');
    await waitFor(() => expect(noticeIds(w)).toEqual(['s1']));
    expect(within(w).queryByTestId('portal-module-error')).toBeNull();
  });

  it('エラーの境界：お知らせの欄の描画で例外が起きると、その欄だけ「この欄を表示できませんでした。」。ほかの欄は出る', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 題名に描けない値（object。React の子にできない）を入れて、欄の描画を例外にする
    noticeRows = [{ id: 'bad', audience: 'soumu', title: { broken: true }, pinned: false, created_at: '2026-10-02T00:00:00Z' }];
    renderPortal(member('admin', [], 'requesting'));
    const w = screen.getByTestId('portal-soumu-notices');
    expect((await within(w).findByTestId('portal-widget-error')).textContent).toContain('この欄を表示できませんでした。');
    await screen.findByTestId('module-card');
    expect(within(screen.getByTestId('portal-todos')).queryByTestId('portal-widget-error')).toBeNull();
  });
});

// ---------------------------------------------------------------- 締切と予定の欄（T18）

/** 予定と締切の欄の1行（RLS の結果の代わり。読む列は id・種類・題名・開始・終わり・終日だけ） */
const eventRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'event',
  title: `予定${id}`,
  starts_at: '2026-10-08T04:00:00Z',
  ends_at: null,
  all_day: false,
  ...over,
});
const datedItem = (id: string) => screen.getAllByTestId('portal-dated-item').find((x) => x.getAttribute('data-id') === id)!;

describe('T18 ダッシュボード：締切と予定の欄（04「ダッシュボード」・「締切と予定」の「ダッシュボードに出すもの」）', () => {
  // 開いた時刻は AFTER_CLOSE（10/6〔火〕09:00 Asia/Tokyo）
  const ROWS = [
    eventRow('e1', { kind: 'deadline', title: '書類の提出', starts_at: '2026-10-07T08:00:00Z' }), // 10/7（水）17:00 → 明日
    eventRow('e2', { title: '搬入の説明会', starts_at: '2026-10-09T04:00:00Z', ends_at: '2026-10-09T06:00:00Z' }), // 10/9（金）13:00〜15:00
    eventRow('e3', { kind: 'deadline', title: '古い締切', starts_at: '2026-09-30T08:00:00Z' }), // 過ぎた締切（申請の締切より古い）
    eventRow('e4', { title: '片付け', all_day: true, starts_at: '2026-10-18T15:00:00Z', ends_at: '2026-10-19T15:00:00Z' }), // 終日 10/19〜10/20
    eventRow('e5', { title: '遠い予定', all_day: true, starts_at: '2026-11-30T15:00:00Z' }), // 12/1：今日＋30 日（11/5）より後なので出さない
  ];

  it('項目と机椅子の日付を選んで早い順に（これからの 30 日を先に 8 件の枠へ、余りに過ぎた締切の新しいもの）。続きは「ほか N 件」', async () => {
    eventRows = ROWS;
    renderPortal(member('head', [], 'requesting'));
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    // これから 7 件（e1・e2・祭の4日・e4）と、過ぎた締切 2 件（申請の締切 10/5・e3 9/30）のうち新しい申請の締切
    expect(datedIds()).toEqual([
      'furniture:request-close',
      'calendar:e1',
      'calendar:e2',
      'furniture:day-minus2',
      'furniture:day-minus1',
      'furniture:day1',
      'furniture:day2',
      'calendar:e4',
    ]);
    expect(screen.getByTestId('portal-dated-more').textContent).toBe('ほか 1 件');
  });

  it('1件は曜日つきの日付・相対の言い方・種類・題名。項目は /calendar?event=<id> へのリンク。過ぎた締切は「締切を過ぎました」を注意の色で。欄の下に「締切と予定の一覧へ」', async () => {
    eventRows = ROWS;
    renderPortal(member('staff', [], 'requesting'));
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    const when = (id: string) => within(datedItem(id)).getByTestId('portal-dated-when').textContent;
    const rel = (id: string) => within(datedItem(id)).getByTestId('portal-dated-relative').textContent;
    expect([when('calendar:e1'), rel('calendar:e1')]).toEqual(['10/7（水）17:00', '明日']);
    expect([when('calendar:e2'), rel('calendar:e2')]).toEqual(['10/9（金）13:00〜15:00', 'あと 3 日']);
    expect([when('calendar:e4'), rel('calendar:e4')]).toEqual(['10/19（月）〜10/20（火）', 'あと 13 日']);
    expect([when('furniture:day1'), rel('furniture:day1')]).toEqual(['10/17（土）', 'あと 11 日']);
    expect([when('furniture:request-close'), rel('furniture:request-close')]).toEqual(['10/5（月）17:00', '締切を過ぎました']);
    expect(within(datedItem('furniture:request-close')).getByTestId('portal-dated-relative').className).toContain('text-amber-700');
    expect(within(datedItem('calendar:e1')).getByTestId('portal-dated-relative').className).not.toContain('text-amber-700');
    const e1 = datedItem('calendar:e1');
    expect(e1.getAttribute('data-kind')).toBe('deadline');
    expect(e1.getAttribute('data-module')).toBe('calendar');
    expect(e1.textContent).toContain('締切');
    expect(e1.textContent).toContain('書類の提出');
    expect(within(e1).getByRole('link').getAttribute('href')).toBe('/calendar?event=e1');
    expect(within(e1).getByTestId('portal-dated-when').getAttribute('dateTime')).toBe('2026-10-07T08:00:00Z');
    // 終日の項目は日付だけ（dateTime は開始の日）
    expect(within(datedItem('calendar:e4')).getByTestId('portal-dated-when').getAttribute('dateTime')).toBe('2026-10-19');
    const link = screen.getByTestId('portal-dated-link');
    expect([link.textContent, link.getAttribute('href')]).toEqual(['締切と予定の一覧へ', '/calendar']);
  });

  it('読むのは events の id・種類・題名・開始・終わり・終日だけ（対象・メモ・書いた人は読まない）。年度で絞り、開始・id の順に全部。どの立場も1人1回', async () => {
    const cases = [member('staff', [], 'requesting'), member('viewer', [], 'requesting'), member(null, [G1], 'requesting'), member('admin', [G1], 'requesting'), member('viewer', [G1], 'requesting')];
    for (const m of cases) {
      cleanup();
      issued.splice(0);
      renderPortal(m);
      await waitFor(() => expect(issued.filter((c) => c.table === 'events'), `${m.role}・${m.groups.length}`).toHaveLength(1));
      await act(() => new Promise((r) => setTimeout(r, 20)));
      const calls = issued.filter((c) => c.table === 'events');
      expect(calls, `${m.role}・${m.groups.length}`).toHaveLength(1);
      const c = calls[0]!;
      expect(opArgs(c, 'select')).toEqual([['id, kind, title, starts_at, ends_at, all_day']]);
      expect(opArgs(c, 'eq')).toEqual([['year_id', Y]]);
      expect(opArgs(c, 'order')).toEqual([['starts_at'], ['id']]);
      expect(opArgs(c, 'range')).toEqual([[0, 999]]);
      expect(opArgs(c, 'in')).toEqual([]);
      expect(opArgs(c, 'neq')).toEqual([]);
    }
  });

  it('予定と締切の読み込み中は、締切と予定の欄にだけ Skeleton（data-module=calendar）。机椅子の日付は先に出し、ほかの欄に出さない', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    override = (call) => (call.table === 'events' ? gate.then(() => ({ data: [eventRow('e1', { kind: 'deadline', starts_at: '2026-10-07T08:00:00Z' })] })) : undefined);
    renderPortal(member('viewer', [], 'requesting'));
    const dated = screen.getByTestId('portal-dated');
    expect(within(dated).getByTestId('portal-loading').getAttribute('data-module')).toBe('calendar');
    expect(datedIds()).toHaveLength(5);
    expect(within(dated).queryByTestId('portal-dated-empty')).toBeNull();
    expect(within(dated).getByTestId('portal-dated-link')).toBeTruthy();
    await screen.findByTestId('portal-notices-empty');
    for (const id of ['portal-notices', 'portal-cards']) {
      expect(within(screen.getByTestId(id)).queryAllByTestId('portal-loading').map((x) => x.getAttribute('data-module')), id).not.toContain('calendar');
    }
    release();
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    expect(within(dated).queryByTestId('portal-loading')).toBeNull();
  });

  it('予定と締切の読み込みの失敗：締切と予定の欄にだけ「締切と予定：…」ともう一度。机椅子の日付と一覧へのリンクは出たまま、要対応・お知らせ・カードの欄は失敗を出さない。もう一度で直る', async () => {
    let fail = true;
    eventRows = [eventRow('e1', { kind: 'deadline', title: '書類の提出', starts_at: '2026-10-07T08:00:00Z' })];
    override = (call) => (call.table === 'events' && fail ? NETWORK : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('admin', [], 'requesting'));
    const dated = screen.getByTestId('portal-dated');
    const err = await within(dated).findByTestId('portal-module-error');
    expect(err.getAttribute('data-module')).toBe('calendar');
    expect(err.textContent).toContain('締切と予定：通信できませんでした。電波の良い所でもう一度');
    expect(datedIds()).toEqual(['furniture:request-close', 'furniture:day-minus2', 'furniture:day-minus1', 'furniture:day1', 'furniture:day2']);
    expect(within(dated).getByTestId('portal-dated-link').getAttribute('href')).toBe('/calendar');
    expect(within(dated).queryByTestId('portal-dated-empty')).toBeNull();
    await screen.findByTestId('module-card');
    await screen.findByTestId('portal-notices-empty');
    for (const id of ['portal-todos', 'portal-soumu-notices', 'portal-cards']) {
      expect(within(screen.getByTestId(id)).queryByTestId('portal-module-error'), id).toBeNull();
    }
    expect(screen.getAllByTestId('portal-module-error')).toHaveLength(1);
    expect(screen.queryByTestId('portal-widget-error')).toBeNull();

    fail = false;
    await user.click(within(err).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    expect(screen.queryByTestId('portal-module-error')).toBeNull();
  });

  it('机椅子の読み込みの失敗は、締切と予定の欄に出ない（項目は出る）', async () => {
    eventRows = [eventRow('e1', { starts_at: '2026-10-08T04:00:00Z' })];
    override = (call) => (call.table === 'request_submissions' ? NETWORK : undefined);
    renderPortal(member('admin', [], 'requesting'));
    await within(screen.getByTestId('portal-todos')).findByTestId('portal-module-error');
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    expect(within(screen.getByTestId('portal-dated')).queryByTestId('portal-module-error')).toBeNull();
  });

  it('日の境目は Asia/Tokyo：10/7 0:00（Asia/Tokyo）の直前は 10/7 の締切が「明日」、ちょうどから「今日」', async () => {
    eventRows = [eventRow('e1', { kind: 'deadline', title: '日付だけの締切', all_day: true, starts_at: '2026-10-06T15:00:00Z' })];
    vi.setSystemTime(new Date('2026-10-06T14:59:59.999Z'));
    renderPortal(member('staff', [], 'requesting'));
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    expect(within(datedItem('calendar:e1')).getByTestId('portal-dated-relative').textContent).toBe('明日');
    expect(within(datedItem('calendar:e1')).getByTestId('portal-dated-when').textContent).toBe('10/7（水）');
    cleanup();
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    renderPortal(member('staff', [], 'requesting'));
    await waitFor(() => expect(datedIds()).toContain('calendar:e1'));
    expect(within(datedItem('calendar:e1')).getByTestId('portal-dated-relative').textContent).toBe('今日');
  });
});

// ---------------------------------------------------------------- / の JS

describe('T16 / の部品の import（スナップショット・検証・机椅子の状況の部品を / の JS に入れない。D-51）', () => {
  const HEAVY_FILES = [
    'components/dashboard/dashboard.tsx',
    'components/dashboard/furniture-screen.tsx',
    'components/common/year-status-actions.tsx',
    'lib/data/dashboard.ts',
    'lib/data/snapshot.ts',
    'lib/data/validation.ts',
    'lib/data/version-watch.ts',
    'lib/data/export.ts',
    'lib/data/swaps.ts',
  ];
  const HEAVY_PACKAGES = /^(@gaapp\/(allocator|exporter|importer)|highs)(\/|$)/;

  it('app/(app)/page.tsx（ダッシュボード）からたどれるファイルに、机椅子の状況・スナップショット・検証がない', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    expect(g.files.filter((f) => HEAVY_FILES.includes(f))).toEqual([]);
    expect(g.packages.filter((p) => HEAVY_PACKAGES.test(p))).toEqual([]);
    // ダッシュボードの部品と、代表する団体の欄は入る
    for (const f of ['components/portal/portal-screen.tsx', 'components/dashboard/rep-home.tsx', 'lib/modules/providers.ts']) expect(g.files).toContain(f);
  });

  it('T17 / はお知らせの欄の部品と新着の読み取りだけを読み、お知らせ一覧の画面・ダイアログ・一覧の読み取り・入力の zod を読まない', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    for (const f of ['components/portal/notice-digests.tsx', 'lib/modules/notices/portal.ts', 'lib/modules/notices/latest.ts']) expect(g.files).toContain(f);
    expect(g.files.filter((f) => f.startsWith('components/notices/'))).toEqual([]);
    expect(g.files).not.toContain('lib/data/notices.ts');
    expect(g.files).not.toContain('lib/schemas/notices.ts');
    expect(g.files).not.toContain('lib/modules/notices/permissions.ts');
  });

  it('T18 / は締切と予定の欄の部品と読み取り（calendar/portal.ts・dated.ts・labels.ts）だけを読み、締切と予定の一覧の画面・ダイアログ・一覧の読み書き・入力の zod・一覧の組み立てを読まない', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    for (const f of ['components/portal/dated-list.tsx', 'lib/modules/calendar/portal.ts', 'lib/modules/calendar/dated.ts', 'lib/modules/calendar/labels.ts']) {
      expect(g.files).toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('components/calendar/'))).toEqual([]);
    for (const f of ['lib/data/calendar.ts', 'lib/schemas/calendar.ts', 'lib/modules/calendar/list.ts', 'lib/modules/calendar/permissions.ts']) {
      expect(g.files).not.toContain(f);
    }
  });

  it('T18 /calendar（締切と予定）はスナップショット・検証・机椅子の状況・お知らせ一覧の画面を読まない', () => {
    const g = staticImportGraph('app/(app)/calendar/page.tsx');
    expect(g.files).toContain('components/calendar/calendar-screen.tsx');
    expect(g.files.filter((f) => HEAVY_FILES.includes(f))).toEqual([]);
    expect(g.files.filter((f) => f.startsWith('components/notices/'))).toEqual([]);
    expect(g.packages.filter((p) => HEAVY_PACKAGES.test(p))).toEqual([]);
  });

  it('T17 /notices（お知らせ一覧）はスナップショット・検証・机椅子の状況を読まない', () => {
    const g = staticImportGraph('app/(app)/notices/page.tsx');
    expect(g.files).toContain('components/notices/notices-screen.tsx');
    expect(g.files.filter((f) => HEAVY_FILES.includes(f))).toEqual([]);
    expect(g.packages.filter((p) => HEAVY_PACKAGES.test(p))).toEqual([]);
  });

  it('app/(app)/furniture/page.tsx（机椅子の状況）は Dashboard を読む（比べるための確かめ）', () => {
    const g = staticImportGraph('app/(app)/furniture/page.tsx');
    expect(g.files).toContain('components/dashboard/dashboard.tsx');
    expect(g.files).toContain('lib/data/validation.ts');
  });
});
