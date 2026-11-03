// @vitest-environment jsdom
// 申請（/request）のテント等のタブ（T21・D-57。04「申請の「テント等」のタブ」、notes/T21.md「画面の約束」6）：
// - タブを出すか（その団体の区分で申請できる備品があるか、その団体に読める割り当て〔数が1以上。確定後〕か渡した記録〔渡した数が
//   1以上〕があるとき。2026-11-01 のリードの決定）、読み込みの失敗（机・椅子のまま）、机・椅子のパネルを作り直さない（入力が残る）、
//   `?tab=lending`。
// - 申請できる備品のない団体（企業）：タブを出すかの読み取り（1本。埋め込みの絞りと年度の確定の印）、確定前・数が 0 だけでは出さない、
//   管理者が代表を兼ねて確定前の割り当てを読めても確定前は出さない（ダッシュボードの「割り当てが決まりました」も。タブの直しの
//   レビューの T21-R6）、ダッシュボードの
//   要対応（割り当てが決まりました・返してください）の行き先でタブを開く（同じ偽の DB を、ダッシュボードと同じ読み取りで読んで作った
//   href）、申請の欄と保存を出さず、数は総務が決める旨の1行と割り当て・記録を読むだけで出す。
// - テント等のパネル：申請できる備品の欄・保存（(A)。すべて 0 の確かめ・申請できる備品の全部の行の upsert・保存されていた・ほかの人の
//   変更の確かめ）・受付の前と締切後の読み取り専用・時計のずれ（42501）・確定後の割り当て（0・未定）と記録・2日目からの未返却。
// - 下書き・離れるときの確かめ（レビューの T21-R3）：アンマウントで下書きが残る → 開き直すと DraftNotice →「戻す」で入力と入力の元
//   （保存の確かめに使う）／「捨てる」／保存できると下書きを消す／未保存の間は、テント等のタブを隠していても移る前に確かめる。
// - `?tab=lending` で開いたときは、タブを出すかの読み取りを待たずにパネルの JS を読み始める（レビューの T21-R1）。
// 机・椅子のパネルは本物の RequestScreen の代わりに入力が1つの部品を置く（RequestScreen は request-screen.test.tsx が確かめる）。
// ナビと年度の選択の代わりに、同じ部品と関数（AppLink・useGuardedSetYear）で未保存の入力の確かめを通す（calendar.test.tsx と同じ）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '@/components/common/app-link';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { draftKey, saveDraft, type DraftKey } from '@/lib/drafts';
import { queryKeys } from '@/lib/query';
import { lendingPortal } from '@/lib/modules/lending/portal';
import { LENDING_REQUEST_ITEMS_SELECT } from '@/lib/modules/lending/queries';
import { loadLendingRep } from '@/lib/modules/lending/summary';
import type { PortalContext, TodoItem } from '@/lib/modules/portal';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { lendingHandler, nextAt, pgError, type FakeGroup, type FakeLendingDb } from '@/lib/testing/fake-lending-db';
import { LEAVE_MESSAGES } from '@/lib/unsaved-changes';
import { LENDING_REQUEST_OUTSIDE, LENDING_REQUEST_ZERO } from './lending-request-panel';
import { REQUEST_TABS_ERROR, RequestTabs } from './request-tabs';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  status: 'requesting' as YearStatus,
  userId: 'u-rep',
  client: null as unknown,
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  setYear: vi.fn(),
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: vi.fn(),
    setYear: h.setYear,
    reauthenticate: async () => false,
    isRefreshing: false,
  }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, refresh: vi.fn() }),
  usePathname: () => '/request',
  useSearchParams: () => h.params,
}));
// テント等のパネルの JS の読み込み（読み始めた回数を数える。中身は本物）
// （fail の間は読めない〔通信が切れた〕ことにし、forget の間は読み終えたものを覚えていないことにする）
const loader = vi.hoisted(() => ({ calls: 0, fail: false, forget: false }));
vi.mock('./request-panel-loader', async (orig) => {
  const m = await orig<typeof import('./request-panel-loader')>();
  return {
    ...m,
    loadLendingRequestPanel: () => {
      loader.calls++;
      return loader.fail ? Promise.reject(new Error('ChunkLoadError')) : m.loadLendingRequestPanel();
    },
    loadedLendingRequestPanel: () => (loader.forget ? null : m.loadedLendingRequestPanel()),
  };
});
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

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const Y_PREV = uuid(2);
const TENT = uuid(101);
const WEIGHT = uuid(102);
const CURTAIN = uuid(103);
const G1 = uuid(11);
const V0 = '2026-10-01T00:00:00.123456+00:00';
const CLOSE = '2026-10-05T08:00:00Z';
const OPEN_NOW = '2026-10-01T00:00:00Z';

const G1s: GroupSummary = { id: G1, name: '模擬店01', year_id: Y, role: 'manager' };
/** 企業（テント・重し・三方幕のどれも申請できない区分。総務が申請なしに割り当てる） */
const G3 = uuid(13);
const G3s: GroupSummary = { id: G3, name: '企業01', year_id: Y, role: 'deputy_manager' };
const G3_ROW: FakeGroup = { id: G3, year_id: Y, name: '企業01', display_name: null, aliases: [], category: 'company', sort_order: 3, location_room_id: null, location_room: null };

const yearRow = (status: YearStatus, over: Partial<YearRow> = {}): YearRow => ({
  id: Y,
  label: 'R8',
  status,
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: '2026-09-20T00:00:00Z',
  request_close_at: CLOSE,
  prev_year_id: null,
  updated_at: 't',
  ...over,
});

function seed(): FakeLendingDb {
  return {
    items: [
      { id: TENT, year_id: Y, name: 'テント', unit: '張', stock: 3, requestable_categories: ['stall', 'department'], sort_order: 1, updated_at: V0 },
      { id: WEIGHT, year_id: Y, name: '重し', unit: '個', stock: 20, requestable_categories: ['stall', 'department'], sort_order: 2, updated_at: V0 },
      { id: CURTAIN, year_id: Y, name: '三方幕', unit: '枚', stock: 2, requestable_categories: ['department'], sort_order: 3, updated_at: V0 },
    ],
    groups: [{ id: G1, year_id: Y, name: '模擬店01', display_name: null, aliases: [], category: 'stall', sort_order: 1, location_room_id: null, location_room: null }],
    requests: [],
    assignments: [],
    records: [],
    confirmedAt: null,
    prevItems: [],
  };
}

let db: FakeLendingDb = seed();
let issued: FakeCall[] = [];
/** 偽の DB の前に差し込む応答（Promise を返すと、その間は応答を止められる） */
let override: ((call: FakeCall) => FakeResult | PromiseLike<FakeResult> | undefined) | null = null;
/**
 * 割り当てを確定の前も読める人として読む（管理者が団体の代表を兼ねている。02 の権限：admin は同じ年度の団体代表を兼ねられ、
 * 割り当ての RLS は admin に確定前の行も返す）。既定は店長・副店長（確定後だけ読める）
 */
let seesAllAssignments = false;

function member(status: YearStatus, groups: GroupSummary[] = [G1s], role: AppRole | null = null): Membership {
  const year = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role, groups, years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

/** 机・椅子のパネルの代わり（入力が残るか＝作り直さないかを見る） */
function FurnitureStub() {
  return <input aria-label="机の数" data-testid="furniture-input" defaultValue="" />;
}

/** ナビ（AppLink）と年度の選択（useGuardedSetYear）の代わり（AppShell の代わりに、同じ部品と関数で未保存の入力の確かめを通す） */
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

function tree() {
  return (
    <UnsavedChangesProvider>
      <OutsideProbe />
      <RequestTabs>
        <FurnitureStub />
      </RequestTabs>
    </UnsavedChangesProvider>
  );
}

/**
 * 偽の Supabase の受け手（店長・副店長として読む：割り当ては確定後だけ読める〔RLS〕。seesAllAssignments の間は、代表を兼ねた
 * 管理者として確定前も読める。申請は受付期間内だけ書ける）。ダッシュボードの読み取り（loadLendingRep）にも同じものを使う
 */
function handler(): (call: FakeCall) => FakeResult | PromiseLike<FakeResult> {
  const handle = lendingHandler(db, {
    userId: h.userId,
    canLead: () => false,
    canRecord: () => false,
    canRequest: () => h.status === 'requesting' && Date.now() < Date.parse(CLOSE),
    closed: () => h.status === 'closed',
    seesAssignments: () => seesAllAssignments || !!db.confirmedAt,
  });
  return (call) => {
    const o = override?.(call);
    if (o) return o;
    if (call.table === 'years') return { data: yearRow(h.status) };
    // 申請の画面のデータ（repRequestOptions）：団体・品目・申請・提出
    if (call.table === 'items' || call.table === 'requests') return { data: [] };
    if (call.table === 'request_submissions') return { data: null };
    return handle(call) ?? { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  };
}

function renderTabs(opts: { status?: YearStatus; search?: string; now?: string; groups?: GroupSummary[]; role?: AppRole | null } = {}) {
  const status = opts.status ?? 'requesting';
  h.status = status;
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(status, opts.groups, opts.role ?? null) };
  vi.setSystemTime(new Date(opts.now ?? OPEN_NOW));
  const fake = createFakeSupabase(handler());
  issued = fake.issued;
  h.client = fake.client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status));
  const r = render(<QueryClientProvider client={qc}>{tree()}</QueryClientProvider>);
  return { ...r, rerenderTree: () => r.rerender(<QueryClientProvider client={qc}>{tree()}</QueryClientProvider>) };
}

const user = () => userEvent.setup({ advanceTimers: () => {} });
const upserts = () => issued.filter((c) => c.table === 'lending_requests' && c.ops.some((o) => o.op === 'upsert'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db = seed();
  override = null;
  seesAllAssignments = false;
  toast.info.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
  h.push.mockClear();
  h.replace.mockClear();
  h.setYear.mockClear();
  loader.calls = 0;
  loader.fail = false;
  loader.forget = false;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T21 申請のタブ（RequestTabs）', () => {
  it('その団体の区分で申請できる備品がなければタブを出さない（机・椅子のまま）', async () => {
    db.items = db.items.map((i) => ({ ...i, requestable_categories: ['department'] }));
    renderTabs();
    await waitFor(() => expect(issued.some((c) => c.table === 'lending_items')).toBe(true));
    await waitFor(() => expect(issued.some((c) => c.table === 'groups')).toBe(true));
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.getByTestId('furniture-input')).toBeTruthy();
  });

  it('申請できる備品があればタブ「机・椅子」「テント等」。机・椅子のパネルを作り直さず、テント等を開くと入力が残ったまま隠す', async () => {
    const r = renderTabs();
    const tabs = await screen.findByTestId('request-tabs');
    expect(within(tabs).getByRole('tab', { name: '机・椅子' }).getAttribute('aria-selected')).toBe('true');
    const input = screen.getByTestId('furniture-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    await user().click(screen.getByTestId('request-tab-lending'));
    expect(h.replace).toHaveBeenCalledWith('/request?tab=lending');
    h.params = new URLSearchParams('tab=lending');
    r.rerenderTree();
    expect(await screen.findByTestId('lending-request')).toBeTruthy();
    // 机・椅子のパネルは同じ部品のまま隠れている（入力が残る）
    expect((screen.getByTestId('furniture-input') as HTMLInputElement).value).toBe('3');
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).not.toBeNull();
    // 戻すとテント等のパネルは残ったまま隠れる
    h.params = new URLSearchParams('');
    r.rerenderTree();
    expect(screen.getByTestId('lending-request').closest('[hidden]')).not.toBeNull();
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
  });

  it('備品の読み込みが失敗したら、タブを出さずに机・椅子のまま「テント等の申請を読み込めませんでした」と「もう一度」', async () => {
    override = (call) => (call.table === 'lending_items' ? pgError('XX000', 500) : undefined);
    renderTabs({ search: 'tab=lending' });
    const err = await screen.findByTestId('request-tabs-error');
    expect(err.textContent).toContain(REQUEST_TABS_ERROR);
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
    override = null;
    await user().click(within(err).getByRole('button', { name: 'もう一度' }));
    expect(await screen.findByTestId('request-tabs')).toBeTruthy();
  });
});

describe('T21 申請のテント等のパネル', () => {
  it('申請できる備品だけの欄（区分で申請できない備品は出さない）。すべて 0 で保存すると確かめの文、申請できる備品の全部の行（0 を含む）の upsert', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    expect(within(panel).getAllByTestId('lending-request-item').map((x) => x.getAttribute('data-item-id'))).toEqual([TENT, WEIGHT]);
    expect(within(panel).getByTestId('lending-request-saved-at').textContent).toBe('まだ保存していません');
    await user().click(within(panel).getByTestId('lending-request-save'));
    expect(await screen.findByText(LENDING_REQUEST_ZERO)).toBeTruthy();
    await user().click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(upserts()).toHaveLength(1));
    expect(opArgs(upserts()[0]!, 'upsert')[0]).toEqual([
      [
        { group_id: G1, lending_item_id: TENT, year_id: Y, count: 0 },
        { group_id: G1, lending_item_id: WEIGHT, year_id: Y, count: 0 },
      ],
      { onConflict: 'group_id,lending_item_id' },
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(within(panel).getByTestId('lending-request-saved-at').textContent).toMatch(/^保存済み/);
  });

  it('入れた数で保存（確かめのダイアログに 1 以上の備品）。タブに未保存の印', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(panel).getByRole('button', { name: 'テントの数を1増やす' }));
    expect(screen.getByTestId('request-tab-lending').getAttribute('data-unsaved')).toBe('true');
    await user().click(within(panel).getByTestId('lending-request-save'));
    expect((await screen.findByTestId('lending-request-summary')).textContent).toContain('テント1 張');
    await user().click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(db.requests.find((r) => r.lending_item_id === TENT)?.count).toBe(1));
    await waitFor(() => expect(screen.getByTestId('request-tab-lending').getAttribute('data-unsaved')).toBeNull());
  });

  it('入力を始めた後にほかの人が変えていれば、変わった備品（前 → 今）を出して上書きしてよいか確かめる', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(panel).getByRole('button', { name: 'テントの数を1増やす' }));
    db.requests.push({ group_id: G1, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-rep2', updated_at: nextAt() });
    await user().click(within(panel).getByTestId('lending-request-save'));
    await user().click(await screen.findByRole('button', { name: '保存する' }));
    expect((await screen.findByTestId('lending-request-conflicts')).textContent).toBe('テント（0 → 2）');
    expect(upserts()).toHaveLength(0);
    await user().click(screen.getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(db.requests.find((r) => r.lending_item_id === TENT)?.count).toBe(1));
  });

  it('前の保存が通っていた（読み直すと入力と同じ）なら送らずに「保存されていました」', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(panel).getByRole('button', { name: 'テントの数を1増やす' }));
    const at = nextAt();
    db.requests.push(
      { group_id: G1, lending_item_id: TENT, year_id: Y, count: 1, updated_by: h.userId, updated_at: at },
      { group_id: G1, lending_item_id: WEIGHT, year_id: Y, count: 0, updated_by: h.userId, updated_at: at },
    );
    await user().click(within(panel).getByTestId('lending-request-save'));
    await user().click(await screen.findByRole('button', { name: '保存する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存されていました'));
    expect(upserts()).toHaveLength(0);
  });

  it('DB が拒否して（42501）年度を読み直しても受付中のままなら、読み取り専用にして端末の時計のずれの文', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    override = (call) => (call.table === 'lending_requests' && call.ops.some((o) => o.op === 'upsert') ? pgError('42501', 403) : undefined);
    await user().click(within(panel).getByTestId('lending-request-save'));
    await user().click(await screen.findByRole('button', { name: '保存する' }));
    expect((await screen.findByTestId('lending-request-error')).textContent).toBe(LENDING_REQUEST_OUTSIDE);
    expect(await screen.findByTestId('lending-request-readonly')).toBeTruthy();
    expect(screen.queryByTestId('lending-request-save')).toBeNull();
  });

  it('締切後は読み取り専用（「締切を過ぎました。変更は総務へ」）。確定後は割り当て（0・未定も）、記録は確定の前でも、2日目から未返却', async () => {
    db.confirmedAt = '2026-10-12T08:00:00Z';
    db.requests.push(
      { group_id: G1, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-rep', updated_at: V0 },
      { group_id: G1, lending_item_id: WEIGHT, year_id: Y, count: 4, updated_by: 'u-rep', updated_at: V0 },
    );
    db.assignments.push({ group_id: G1, lending_item_id: TENT, year_id: Y, count: 0, updated_by: 'u-head', updated_at: V0 });
    db.records.push({ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 0, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 });
    db.records.push({ group_id: G1, lending_item_id: WEIGHT, year_id: Y, lent_count: 4, returned_count: 1, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 });
    renderTabs({ search: 'tab=lending', status: 'allocating', now: '2026-10-17T14:59:00Z' });
    const panel = await screen.findByTestId('lending-request');
    expect(within(panel).getByTestId('lending-request-readonly').textContent).toBe('締切を過ぎました。変更は総務へ');
    expect(within(panel).queryByTestId('lending-request-save')).toBeNull();
    const assigned = within(panel).getByTestId('lending-request-assigned');
    expect(within(assigned).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['割り当て：テント 0 張（申請 2）', '割り当て：重し 未定（申請 4）']);
    expect(within(panel).getByTestId('lending-request-records').textContent).toContain('渡した：重し 4 個');
    // 2日目の前は未返却を出さない
    expect(within(panel).queryByTestId('lending-request-unreturned')).toBeNull();
    cleanup();
    renderTabs({ search: 'tab=lending', status: 'allocating', now: '2026-10-17T15:00:00Z' });
    expect((await screen.findByTestId('lending-request-unreturned')).textContent).toBe('未返却：重し 3 個');
  });

  it('受付の前（準備中）は「受付の前です」で読み取り専用', async () => {
    renderTabs({ search: 'tab=lending', status: 'preparing' });
    const panel = await screen.findByTestId('lending-request');
    expect(within(panel).getByTestId('lending-request-readonly').textContent).toBe('受付の前です');
    expect((within(panel).getByRole('button', { name: 'テントの数を1増やす' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('T21 申請のテント等のパネル：下書き・離れるときの確かめ（レビューの T21-R3）', () => {
  const DRAFT: DraftKey = { userId: 'u-rep', yearId: Y, screen: 'request-lending', target: G1 };
  const draftValue = (): unknown => {
    const raw = localStorage.getItem(draftKey(DRAFT));
    return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value;
  };
  const count = (name: string) => screen.getByRole('textbox', { name: `${name}の数` }) as HTMLInputElement;
  const lastPush = () => h.push.mock.calls.at(-1)?.[0];
  /** 離れるときの確かめのダイアログで「やめる（入力を続ける）」を押し、閉じ終わるまで待つ */
  const stayOnLeave = async (kind: 'navigate' | 'year') => {
    const leave = await screen.findByRole('alertdialog');
    expect(leave.textContent).toContain(LEAVE_MESSAGES[kind].description);
    await user().click(within(leave).getByRole('button', { name: 'やめる（入力を続ける）' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  };

  it('入力してアンマウントすると下書き（入力と入力の元）が残り、開き直して「戻す」で両方が戻る。その後にほかの人が変えていれば、送らずに上書きの確かめ', async () => {
    const first = renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(panel).getByRole('button', { name: 'テントの数を1増やす' }));
    first.unmount(); // 画面を離れる（書いていない分を書き切る）
    expect(draftValue()).toEqual({ edits: { [TENT]: 1 }, base: [] });

    // 下書きの後に、ほかの人（副店長）がテントを 2 にした
    db.requests.push({ group_id: G1, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-rep2', updated_at: nextAt() });
    renderTabs({ search: 'tab=lending' });
    const again = await screen.findByTestId('lending-request');
    const notice = await within(again).findByTestId('draft-notice');
    // 開いたときは今の値。戻すまでは保存していない入力にしない
    expect(count('テント').value).toBe('2');
    expect(screen.getByTestId('request-tab-lending').getAttribute('data-unsaved')).toBeNull();
    await user().click(within(notice).getByRole('button', { name: '戻す' }));
    expect(within(again).queryByTestId('draft-notice')).toBeNull();
    expect(count('テント').value).toBe('1');
    await waitFor(() => expect(screen.getByTestId('request-tab-lending').getAttribute('data-unsaved')).toBe('true'));
    await user().click(within(again).getByTestId('lending-request-save'));
    await user().click(await screen.findByRole('button', { name: '保存する' }));
    // 戻した入力の元（行なし）の後に、ほかの人が変えた：黙って上書きしない
    expect((await screen.findByTestId('lending-request-conflicts')).textContent).toBe('テント（0 → 2）');
    expect(upserts()).toHaveLength(0);
    await user().click(screen.getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(db.requests.find((r) => r.lending_item_id === TENT)?.count).toBe(1));
    // 保存できると下書きを消す
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  it('「捨てる」で下書きを消し、保存してある数のまま', async () => {
    saveDraft(DRAFT, { edits: { [TENT]: 3 }, base: [] });
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(await within(panel).findByTestId('draft-notice')).getByRole('button', { name: '捨てる' }));
    expect(within(panel).queryByTestId('draft-notice')).toBeNull();
    expect(draftValue()).toBeNull();
    expect(count('テント').value).toBe('0');
    expect(screen.getByTestId('request-tab-lending').getAttribute('data-unsaved')).toBeNull();
  });

  it('形の違う下書き・入力のない下書きは戻さない（DraftNotice を出さない）', async () => {
    const bad: unknown[] = [
      { edits: { [TENT]: 1.5 }, base: [] },
      { edits: { [TENT]: 10001 }, base: [] },
      { edits: { [TENT]: 1 }, base: [{ lending_item_id: TENT }] },
      { edits: [], base: [] },
      { edits: {}, base: [] },
      'garbage',
    ];
    for (const value of bad) {
      saveDraft(DRAFT, value);
      const r = renderTabs({ search: 'tab=lending' });
      const panel = await screen.findByTestId('lending-request');
      expect(within(panel).queryByTestId('draft-notice')).toBeNull();
      expect(count('テント').value).toBe('0');
      r.unmount();
    }
  });

  it('保存できると下書きを消す', async () => {
    renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    await user().click(within(panel).getByRole('button', { name: '重しの数を1増やす' }));
    await waitFor(() => expect(draftValue()).toEqual({ edits: { [WEIGHT]: 1 }, base: [] }), { timeout: 2000 });
    await user().click(within(panel).getByTestId('lending-request-save'));
    await user().click(await screen.findByRole('button', { name: '保存する' }));
    await waitFor(() => expect(db.requests.find((r) => r.lending_item_id === WEIGHT)?.count).toBe(1));
    await waitFor(() => expect(draftValue()).toBeNull());
  });

  it('保存していない入力がある間は、移る前に確かめる（机・椅子のタブを開いてテント等を隠していても）。入力がなければ確かめない', async () => {
    const r = renderTabs({ search: 'tab=lending' });
    const panel = await screen.findByTestId('lending-request');
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    h.push.mockClear();

    await user().click(within(panel).getByRole('button', { name: 'テントの数を1増やす' }));
    fireEvent.click(screen.getByTestId('probe-nav'));
    await stayOnLeave('navigate');
    expect(h.push).not.toHaveBeenCalled();
    expect(count('テント').value).toBe('1');
    // 机・椅子のタブへ（テント等のパネルは隠れたまま残る）
    h.params = new URLSearchParams('');
    r.rerenderTree();
    expect(screen.getByTestId('lending-request').closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('probe-year'));
    await stayOnLeave('year');
    expect(h.setYear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('probe-nav'));
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm }));
    await waitFor(() => expect(lastPush()).toBe('/notices'));
  });
});

describe('T21 テント等のパネルの JS の読み始め（レビューの T21-R1）', () => {
  it('`?tab=lending` で開いたら、タブを出すかを決める読み取り（備品）を待たずに、パネルの JS を読み始める（読み取りと並行に）', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 備品の読み取りの応答を止める（4G で、タブを出すかが決まる前）
    override = (call) => (call.table === 'lending_items' ? held.then(() => ({ data: db.items })) : undefined);
    renderTabs({ search: 'tab=lending' });
    await waitFor(() => expect(issued.some((c) => c.table === 'lending_items')).toBe(true));
    await waitFor(() => expect(loader.calls).toBeGreaterThan(0));
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.queryByTestId('lending-request')).toBeNull();
    // 机・椅子のパネルは、タブを出すかが決まるまで作らない（テント等を先に出す）
    expect(screen.queryByTestId('furniture-input')).toBeNull();
    release();
    expect(await screen.findByTestId('lending-request')).toBeTruthy();
  });

  it('`?tab=lending` で開いたときは、テント等のパネルを出した後に机・椅子のパネルを作る（隠したまま）。机・椅子を開いても作り直さない', async () => {
    const r = renderTabs({ search: 'tab=lending' });
    expect(await screen.findByTestId('lending-request')).toBeTruthy();
    const input = (await screen.findByTestId('furniture-input')) as HTMLInputElement;
    expect(input.closest('[hidden]')).not.toBeNull();
    fireEvent.change(input, { target: { value: '5' } });
    h.params = new URLSearchParams('');
    r.rerenderTree();
    expect((screen.getByTestId('furniture-input') as HTMLInputElement).value).toBe('5');
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('lending-request').closest('[hidden]')).not.toBeNull();
  });

  it('パネルの JS を読めなければ「テント等の申請を読み込めませんでした」と「もう一度読み込む」（読み直す）。机・椅子は使える', async () => {
    loader.forget = true;
    loader.fail = true;
    const r = renderTabs({ search: 'tab=lending' });
    const failed = await screen.findByText(REQUEST_TABS_ERROR, { selector: '#request-panel-lending *' });
    expect(failed).toBeTruthy();
    expect(screen.queryByTestId('lending-request')).toBeNull();
    loader.fail = false;
    await user().click(within(document.getElementById('request-panel-lending')!).getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByTestId('lending-request')).toBeTruthy();
    // 机・椅子のタブはそのまま使える
    h.params = new URLSearchParams('');
    r.rerenderTree();
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
  });

  it('`?tab=lending` でなければ、テント等のタブを開くまでパネルの JS を読まない（机・椅子のタブを軽く保つ）', async () => {
    const r = renderTabs();
    await screen.findByTestId('request-tabs');
    expect(loader.calls).toBe(0);
    h.params = new URLSearchParams('tab=lending');
    r.rerenderTree();
    expect(await screen.findByTestId('lending-request')).toBeTruthy();
    expect(loader.calls).toBeGreaterThan(0);
  });
});

describe('T21 割り当てか記録のある団体のテント等のタブ（2026-11-01 のリードの決定。D-57）', () => {
  /** 2日目（1日目 2026-10-17 の翌日の 0 時、Asia/Tokyo）の後 */
  const DAY2 = '2026-10-17T15:30:00Z';
  /** 締切の後（振り分け中） */
  const AFTER_CLOSE = '2026-10-06T00:00:00Z';
  const NOT_REQUESTABLE = '企業の団体はテント等を申請しません。数は総務が決めます';

  /**
   * ダッシュボード（店長・副店長の分）の要対応：同じ偽の DB を、ダッシュボードと同じ読み取り（loadLendingRep。割り当ては RLS で
   * 確定後だけ。seesAllAssignments の間は、代表を兼ねた管理者として確定前も読める）で読み、lendingPortal が作る
   */
  async function repTodos(opts: { status: YearStatus; now: string; role?: AppRole | null }): Promise<readonly TodoItem[]> {
    h.status = opts.status;
    const { client } = createFakeSupabase(handler());
    const raw = await loadLendingRep([G3], client);
    const ctx: PortalContext = { kind: 'rep', year: yearRow(opts.status), role: opts.role ?? null, groups: [G3s], audiences: ['rep'], now: Date.parse(opts.now) };
    return lendingPortal({ kind: 'rep', ...raw }, ctx).todos;
  }

  /** ダッシュボード（店長・副店長の分）の要対応の行き先（/request の `?` の後ろ） */
  async function portalHref(todoId: string, opts: { status: YearStatus; now: string; role?: AppRole | null }): Promise<string> {
    const todo = (await repTodos(opts)).find((t) => t.id === todoId);
    expect(todo, `要対応 ${todoId}`).toBeDefined();
    const url = new URL(todo!.href, 'http://localhost');
    expect(url.pathname).toBe('/request');
    return url.search.slice(1);
  }

  /** タブを出すかが決まった（机・椅子のパネルを作った）のを待つ */
  const decided = async () => {
    await waitFor(() => expect(issued.some((c) => c.table === 'lending_items')).toBe(true));
    await screen.findByTestId('furniture-input');
  };

  beforeEach(() => {
    db.groups.push(G3_ROW);
  });

  it('タブを出すかを決める読み取りは1本：備品に、その団体の割り当て（数が1以上）と記録（渡した数が1以上）の備品の id だけと、年度の確定の印を埋め込む（埋め込みの列に count を選ばない）', async () => {
    renderTabs({ search: `group=${G3}`, groups: [G1s, G3s] });
    await decided();
    const calls = issued.filter((c) => c.table === 'lending_items');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(opArgs(call, 'select')[0]![0]).toBe(LENDING_REQUEST_ITEMS_SELECT);
    expect(LENDING_REQUEST_ITEMS_SELECT).toBe(
      'id, name, unit, requestable_categories, sort_order, lending_assignments(lending_item_id), lending_records(lending_item_id), years(lending_years(confirmed_at))',
    );
    const sorted = (xs: unknown[][]) => xs.map((x) => JSON.stringify(x)).sort();
    expect(sorted(opArgs(call, 'eq'))).toEqual(sorted([['year_id', Y], ['lending_assignments.group_id', G3], ['lending_records.group_id', G3]]));
    expect(sorted(opArgs(call, 'gt'))).toEqual(sorted([['lending_assignments.count', 0], ['lending_records.lent_count', 0]]));
  });

  it('申請できる備品のない区分の団体（企業）：確定前（割り当てを RLS が返さない）で記録もなければ、`?tab=lending` でもタブを出さない。確定後も割り当てが 0 だけ・渡した数が 0 の記録だけなら出さない', async () => {
    db.assignments.push({ group_id: G3, lending_item_id: TENT, year_id: Y, count: 1, updated_by: 'u-head', updated_at: V0 });
    renderTabs({ search: `group=${G3}&tab=lending`, groups: [G1s, G3s], status: 'allocating', now: AFTER_CLOSE });
    await decided();
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.queryByTestId('lending-request')).toBeNull();
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
    cleanup();

    // 確定後：企業01 は割り当て 0・渡した数 0 の記録だけ。同じ人が代表する模擬店01 の割り当てと記録は企業01 のタブに数えない
    db.confirmedAt = '2026-10-12T08:00:00Z';
    db.assignments = [
      { group_id: G3, lending_item_id: TENT, year_id: Y, count: 0, updated_by: 'u-head', updated_at: V0 },
      { group_id: G1, lending_item_id: CURTAIN, year_id: Y, count: 1, updated_by: 'u-head', updated_at: V0 },
    ];
    db.records.push(
      { group_id: G3, lending_item_id: WEIGHT, year_id: Y, lent_count: 0, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 },
      { group_id: G1, lending_item_id: CURTAIN, year_id: Y, lent_count: 1, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 },
    );
    renderTabs({ search: `group=${G3}&tab=lending`, groups: [G1s, G3s], status: 'allocating', now: AFTER_CLOSE });
    await decided();
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.queryByTestId('lending-request')).toBeNull();
  });

  it('管理者が団体の代表を兼ねていると確定前の割り当ても読める（RLS）が、数えるのは確定後の割り当てだけ：確定前は割り当てだけではタブも要対応「割り当てが決まりました」も出さず、確定すると要対応の行き先でタブを開いて割り当てを出す（タブの直しのレビューの T21-R6）', async () => {
    // 02 の権限：admin は同じ年度の団体代表を兼ねられ、割り当ての RLS は admin に確定前の行も返す
    seesAllAssignments = true;
    db.assignments.push({ group_id: G3, lending_item_id: TENT, year_id: Y, count: 1, updated_by: 'u-head', updated_at: V0 });
    renderTabs({ search: `group=${G3}&tab=lending`, groups: [G1s, G3s], status: 'allocating', now: AFTER_CLOSE, role: 'admin' });
    await decided();
    // タブを出すかの読み取りは確定前の割り当てを返している（読める範囲は RLS のまま）が、年度の確定の印がないので数えない
    const read = issued.find((c) => c.table === 'lending_items')!;
    const res = (await handler()(read)) as { data: { id: string; lending_assignments: unknown[] }[] };
    expect(res.data.find((i) => i.id === TENT)?.lending_assignments).toHaveLength(1);
    expect(screen.queryByTestId('request-tabs')).toBeNull();
    expect(screen.queryByTestId('lending-request')).toBeNull();
    expect(screen.getByTestId('furniture-input').closest('[hidden]')).toBeNull();
    // ダッシュボードの店長・副店長の分も、確定前の割り当てでは「割り当てが決まりました」を出さない（出すと、その行き先でタブが開かない）
    expect((await repTodos({ status: 'allocating', now: AFTER_CLOSE, role: 'admin' })).map((t) => t.id)).toEqual([]);
    cleanup();

    // 確定すると、「割り当てが決まりました」の行き先でテント等のタブを開き、割り当てを出す
    db.confirmedAt = '2026-10-12T08:00:00Z';
    const search = await portalHref(`lending:rep:${G3}:assigned`, { status: 'allocating', now: AFTER_CLOSE, role: 'admin' });
    expect(search).toBe(`group=${G3}&tab=lending`);
    renderTabs({ search, groups: [G1s, G3s], status: 'allocating', now: AFTER_CLOSE, role: 'admin' });
    const panel = await screen.findByTestId('lending-request');
    expect(screen.getByTestId('request-tab-lending').getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getByTestId('lending-request-not-requestable').textContent).toBe(NOT_REQUESTABLE);
    expect(within(within(panel).getByTestId('lending-request-assigned')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['割り当て：テント 1 張']);
  });

  it('確定後に割り当て（1以上）があれば、ダッシュボードの「割り当てが決まりました」の行き先でテント等のタブを開く。申請の欄・保存・締切・保存した日時はなく、数は総務が決める旨の1行と割り当てを読むだけで出す', async () => {
    db.confirmedAt = '2026-10-12T08:00:00Z';
    db.assignments.push({ group_id: G3, lending_item_id: TENT, year_id: Y, count: 1, updated_by: 'u-head', updated_at: V0 });
    const search = await portalHref(`lending:rep:${G3}:assigned`, { status: 'allocating', now: AFTER_CLOSE });
    expect(search).toBe(`group=${G3}&tab=lending`);
    renderTabs({ search, groups: [G1s, G3s], status: 'allocating', now: AFTER_CLOSE });
    const panel = await screen.findByTestId('lending-request');
    expect(screen.getByTestId('request-tab-lending').getAttribute('aria-selected')).toBe('true');
    expect(panel.closest('[hidden]')).toBeNull();
    expect(within(panel).getByTestId('lending-request-not-requestable').textContent).toBe(NOT_REQUESTABLE);
    for (const id of ['lending-request-item', 'lending-request-save', 'lending-request-saved-at', 'lending-request-readonly']) {
      expect(within(panel).queryByTestId(id)).toBeNull();
    }
    expect(within(panel).queryByText('締切')).toBeNull();
    expect(within(panel).queryByText('テント等の数')).toBeNull();
    // 割り当て（確定）：申請がないので「（申請 0）」を添えない
    expect(within(within(panel).getByTestId('lending-request-assigned')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['割り当て：テント 1 張']);
    // 机・椅子のタブもそのまま使える
    await user().click(screen.getByTestId('request-tab-furniture'));
    expect(h.replace).toHaveBeenCalledWith(`/request?group=${G3}`);
    // 申請できる備品のある団体（模擬店01）はこれまでどおり（欄と保存。数は総務が決める旨の1行は出さない）
    cleanup();
    renderTabs({ search: `group=${G1}&tab=lending`, groups: [G1s, G3s] });
    const own = await screen.findByTestId('lending-request');
    expect(within(own).getAllByTestId('lending-request-item')).toHaveLength(2);
    expect(within(own).getByTestId('lending-request-save')).toBeTruthy();
    expect(within(own).queryByTestId('lending-request-not-requestable')).toBeNull();
  });

  it('記録（渡した数が1以上）があれば確定の前でもタブを出し、2日目からの「返してください」の行き先もテント等のタブを開く（渡した・返った・未返却。割り当ては確定前なので出さない）', async () => {
    // 割り当ては確定前（RLS で読めない）。記録は確定の前でも読める
    db.assignments.push({ group_id: G3, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-head', updated_at: V0 });
    db.records.push({ group_id: G3, lending_item_id: TENT, year_id: Y, lent_count: 2, returned_count: 1, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 });
    const search = await portalHref(`lending:rep:${G3}:unreturned`, { status: 'allocating', now: DAY2 });
    expect(search).toBe(`group=${G3}&tab=lending`);
    renderTabs({ search, groups: [G1s, G3s], status: 'allocating', now: DAY2 });
    const panel = await screen.findByTestId('lending-request');
    expect(screen.getByTestId('request-tab-lending').getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getByTestId('lending-request-not-requestable').textContent).toBe(NOT_REQUESTABLE);
    expect(within(panel).queryByTestId('lending-request-assigned')).toBeNull();
    expect(within(within(panel).getByTestId('lending-request-records')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '渡した：テント 2 張',
      '返った：テント 1 張',
      '未返却：テント 1 張',
    ]);
    expect(within(panel).queryByTestId('lending-request-save')).toBeNull();
  });
});
