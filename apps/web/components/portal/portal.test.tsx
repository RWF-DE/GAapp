// @vitest-environment jsdom
// ダッシュボード（/）の欄（04「ダッシュボード」、notes/T16.md「固めた約束」2・5。T16）：立場ごとの欄と h1、欄ごとの読み込み中・
// 失敗ともう一度・エラーの境界（1つの機能・1つの欄の失敗でほかを止めない）、読むもの（版・振り分けの行・ルールを読まない）、
// / の部品がスナップショット・検証・机椅子の状況の部品を import しないこと。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）、立場は useAuth の差し替え、年度の行は立場と一緒に読んだキャッシュ
// （QueryClient に入れておく）。時計は Date だけを止める（ダッシュボードを開いた時刻）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import type { PortalProvider } from '@/lib/modules/portal';
import { queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { PortalScreen } from './portal-screen';

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  client: null as unknown,
  /** PORTAL_PROVIDERS の差し替え（机椅子の本物のプロバイダの後ろに、テストのプロバイダを足せる） */
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
  h.providers.push(furniturePortalProvider);
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

/** 偽の Supabase の応答。override が FakeResult か Promise を返せばそれを使う */
let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
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
  const fake = createFakeSupabase(handler);
  h.client = fake.client;
  issued = fake.issued;
  h.throwInTodos = false;
  h.providers.splice(1);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 立場ごとの欄

describe('T16 ダッシュボード：立場ごとの欄と h1', () => {
  it('総務（管理者）：h1「ダッシュボード」、立場の一覧 → 要対応・締切と予定 → 機能ごとの状況。代表する団体はない', async () => {
    renderPortal(member('admin', [], 'requesting'));
    expect(h1()).toBe('ダッシュボード');
    expect(screen.getByTestId('home-year').textContent).toBe('R8（申請受付中）');
    expect(screen.getByTestId('home-roles').textContent).toBe('管理者');
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    expect(datedIds()).toEqual(['furniture:day-minus2', 'furniture:day-minus1', 'furniture:day1', 'furniture:day2']);
    const card = screen.getByTestId('module-card');
    expect(card.getAttribute('data-module')).toBe('furniture');
    expect([...card.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '申請受付中（締切 10/5 17:00）',
      '申請 1／2 団体が提出',
      '在庫 1／2 か所を数えた',
    ]);
    expect(within(card).getByRole('link', { name: '机椅子の状況へ' }).getAttribute('href')).toBe('/furniture');
    expect(screen.queryByTestId('rep-home')).toBeNull();
    // 見出し（h2）と DOM の並び
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual(['あなたの立場', '要対応', '締切と予定', '機能ごとの状況']);
  });

  it('総務部門員も h1「ダッシュボード」。部門長以上の要対応（締切を押す）は出ず、総務の分だけ', async () => {
    renderPortal(member('staff', [], 'requesting'));
    expect(h1()).toBe('ダッシュボード');
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
  });

  it('閲覧のみ：h1「ホーム」、要対応の欄がない。机椅子のカード（確定前はリンクなし）と締切と予定。何も読まない', async () => {
    renderPortal(member('viewer', [], 'allocating'));
    expect(h1()).toBe('ホーム');
    expect(screen.queryByTestId('portal-todos')).toBeNull();
    const card = within(screen.getByTestId('portal-cards')).getByTestId('module-card');
    expect(card.textContent).toContain('振り分けが確定すると、ここから見られます。');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(datedIds()).toHaveLength(4);
    // 締切と予定は閲覧のみにはリンクにしない（申請一覧・申請を開けない）
    expect(within(screen.getByTestId('portal-dated')).queryAllByRole('link')).toEqual([]);
    expect(screen.queryByTestId('portal-loading')).toBeNull();
    expect(issued).toEqual([]);
  });

  it('閲覧のみ（確定）：カードに「振り分けが決まりました」と「振り分け表を見る」（/allocation）', () => {
    renderPortal(member('viewer', [], 'confirmed'));
    const card = screen.getByTestId('module-card');
    expect(card.textContent).toContain('振り分けが決まりました');
    expect(within(card).getByRole('link', { name: '振り分け表を見る' }).getAttribute('href')).toBe('/allocation');
  });

  it('店長：h1「ホーム」、要対応・締切と予定・代表する団体。機能ごとのカードはない。自団体の提出と了承だけを読む（1回ずつ）', async () => {
    vi.setSystemTime(new Date(IN_WINDOW));
    renderPortal(member(null, [G1], 'requesting'));
    expect(h1()).toBe('ホーム');
    expect(screen.queryByTestId('portal-cards')).toBeNull();
    const card = await screen.findByTestId('rep-card');
    expect(card.getAttribute('data-group')).toBe('模擬店01');
    await waitFor(() => expect(todoIds()).toEqual(['furniture:rep:g1:unsubmitted', 'furniture:rep:g1:consent']));
    const unsubmitted = screen.getAllByTestId('portal-todo')[0]!;
    expect(unsubmitted.textContent).toContain('模擬店01：申請が未提出です');
    expect(unsubmitted.textContent).toContain('締切 10/5 17:00');
    expect(within(unsubmitted).getByRole('link').getAttribute('href')).toBe('/request?group=g1');
    // 締切と予定は申請（/request）へのリンク
    const close = screen.getAllByTestId('portal-dated-item').find((x) => x.getAttribute('data-id') === 'furniture:request-close')!;
    expect(close.getAttribute('data-kind')).toBe('deadline');
    expect(within(close).getByRole('link').getAttribute('href')).toBe('/request');
    expect(close.textContent).toContain('10/5 17:00');
    expect(close.textContent).toContain('締切');
    // 代表する団体の欄と要対応は同じキャッシュ（リクエストは1回ずつ）。版・在庫・振り分けの行・ルールは読まない
    expect(tablesRead()).toEqual(['request_submissions', 'substitution_consents']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((x) => x.textContent)).toEqual(['あなたの立場', '要対応', '締切と予定', '代表する団体']);
  });

  it('管理者で店長も務める人：ダッシュボードに代表する団体のカードと自団体の要対応。並びは要対応・締切と予定 → 代表する団体 → 機能ごとの状況', async () => {
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
      '代表する団体',
      '機能ごとの状況',
    ]);
    const before = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByTestId('portal-dated'), screen.getByTestId('rep-card'))).toBe(true);
    expect(before(screen.getByTestId('rep-card'), screen.getByTestId('portal-cards'))).toBe(true);
    // 締切と予定は兼ねた人でも1回ずつ（申請一覧へのリンク。立場全体で決める）
    expect(datedIds().filter((id) => id === 'furniture:request-close')).toHaveLength(1);
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
  it('総務：机椅子の軽い読み取りの6つの表を1回ずつ（欄が3つでも同じキーは1回）。years・allocations・rules・requests は読まない', async () => {
    renderPortal(member('admin', [], 'requesting'));
    await screen.findByTestId('module-card');
    expect(tablesRead()).toEqual(['groups', 'request_submissions', 'room_years', 'rooms', 'stocks', 'substitution_consents']);
    const stocks = issued.find((c) => c.table === 'stocks')!;
    expect(opArgs(stocks, 'select')).toEqual([['room_id']]);
  });
});

// ---------------------------------------------------------------- 読み込み中・失敗・エラーの境界

describe('T16 ダッシュボード：欄ごとの読み込み中と失敗（04「ダッシュボード」の読み込みと失敗）', () => {
  it('読み込み中：年度の行だけで決まる項目（締切を過ぎた・締切と予定）は先に出し、机椅子の分は Skeleton（portal-loading）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    override = (call) => (call.table === 'request_submissions' ? gate.then(() => ({ data: SOUMU_ROWS.request_submissions })) : undefined);
    renderPortal(member('admin', [], 'requesting'));
    const todos = screen.getByTestId('portal-todos');
    expect(todoIds()).toEqual(['furniture:lead:close-requests']);
    expect(within(todos).getByTestId('portal-loading').getAttribute('data-module')).toBe('furniture');
    expect(within(screen.getByTestId('portal-cards')).getByTestId('portal-loading')).toBeTruthy();
    expect(within(screen.getByTestId('portal-cards')).queryByTestId('module-card')).toBeNull();
    expect(datedIds()).toHaveLength(4);
    expect(screen.queryByTestId('portal-todos-empty')).toBeNull();

    release();
    await screen.findByTestId('module-card');
    expect(todoIds()).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
    expect(screen.queryByTestId('portal-loading')).toBeNull();
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
    expect(within(cards).queryByTestId('module-card')).toBeNull();
    // ほかの欄は出したまま
    expect(datedIds()).toHaveLength(4);
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
    expect(datedIds()).toHaveLength(4);
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
    release();
    await screen.findByTestId('module-card');
    expect(datedIds()).toHaveLength(4);
    expect(issued.map((c) => c.table)).toEqual(['years']);
  });

  it('年度の行の読み込みの失敗：欄ごとに失敗ともう一度（年度の行を読み直す）', async () => {
    let fail = true;
    override = (call) => (call.table === 'years' ? (fail ? NETWORK : { data: yearRow('requesting') }) : undefined);
    const user = userEvent.setup({ advanceTimers: () => {} });
    renderPortal(member('viewer', [], 'requesting'), { year: null });
    const errs = await screen.findAllByTestId('portal-year-error');
    expect(errs).toHaveLength(2);
    expect(errs[0]!.textContent).toContain('通信できませんでした');
    fail = false;
    await user.click(within(errs[0]!).getByRole('button', { name: 'もう一度' }));
    await screen.findByTestId('module-card');
    expect(screen.queryByTestId('portal-year-error')).toBeNull();
  });
});

// ---------------------------------------------------------------- 0 件と続き

describe('T16 ダッシュボード：0 件の文言と「ほか N 件」', () => {
  it('要対応が 0 件なら「今やることはありません」、締切と予定が 0 件なら「これからの締切と予定はありません」', async () => {
    // 祭の後（2日目の翌日より後）の振り分け中：総務部門員の要対応はなく、日付もすべて過去
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    renderPortal(member('staff', [], 'allocating'));
    await screen.findByTestId('module-card');
    expect(screen.getByTestId('portal-todos-empty').textContent).toBe('今やることはありません');
    expect(screen.getByTestId('portal-dated-empty').textContent).toBe('これからの締切と予定はありません');
    expect(screen.queryByTestId('portal-dated-more')).toBeNull();
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
    expect(screen.getByTestId('portal-dated-more').textContent).toBe('ほか 1 件');
    // 日付だけの項目は「10/7」の形
    expect(screen.getAllByTestId('portal-dated-item')[0]!.querySelector('time')?.textContent).toBe('10/7');
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

  it('app/(app)/furniture/page.tsx（机椅子の状況）は Dashboard を読む（比べるための確かめ）', () => {
    const g = staticImportGraph('app/(app)/furniture/page.tsx');
    expect(g.files).toContain('components/dashboard/dashboard.tsx');
    expect(g.files).toContain('lib/data/validation.ts');
  });
});
