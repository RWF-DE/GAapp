// @vitest-environment jsdom
// お知らせ一覧（/notices）の画面とダイアログ（04「お知らせ一覧」、notes/T17.md「後半（画面）の約束」3〜5。T17）：
// 立場ごとの一覧（書いた人・絞り込み・段の操作）、宛先の団体の名前と「宛先の団体がありません」、本文の改行、更新の表示、ピン留めが先、
// `?notice=` と `?audience=`、空の2つの文、終了した年度の帯。ダイアログの段（総務部門員は宛先とピン留めの欄がない）、欄の誤り・字数・
// 送る引数・変更なし・捨てて閉じる・下書き。読み直し（conflict・消えていた・(B1)・(B2)・削除）。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）で、save_notice・delete_notice は DB の動き（楽観ロック・作る・消す）を
// 小さくまねる。立場は useAuth の差し替え。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { draftKey } from '@/lib/drafts';
import { unknownOutcomeMessage } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  CONFLICT_NOTICE,
  NOT_EDITABLE_NOTICE,
  PINNED_NOTE,
  REREAD_FAILED_NOTICE,
  STAFF_AUDIENCE_TEXT,
  UNCONFIRMED_NOTICE,
} from './notice-form-dialog';
import { ALREADY_DELETED_MESSAGE, CLOSED_NOTICE, DELETE_CHANGED_MESSAGE, NoticesScreen } from './notices-screen';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  /** 偽の DB が段を決めるロール（renderScreen の立場） */
  role: 'head' as AppRole | null,
  userId: 'u-head',
  client: null as unknown,
  params: new URLSearchParams(),
  replace: vi.fn(),
  reloadMembership: vi.fn(),
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: h.reloadMembership,
    reauthenticate: async () => false,
    isRefreshing: false,
  }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace, refresh: vi.fn() }),
  usePathname: () => '/notices',
  useSearchParams: () => h.params,
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

// jsdom にないもの（Radix の Dialog・Checkbox が使う）
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
const G1 = uuid(11);
const G2 = uuid(12);
const G3 = uuid(13);
const HEAD = 'u-head';
const STAFF = 'u-staff';
const GROUPS = [
  { id: G2, name: '模擬店02', aliases: ['二号店'], category: 'stall', sort_order: 2 },
  { id: G1, name: '模擬店01', aliases: [], category: 'stall', sort_order: 1 },
  { id: G3, name: '部門03', aliases: [], category: 'department', sort_order: 1 },
];
const PROFILES = [
  { user_id: HEAD, display_name: '部門長 花子' },
  { user_id: STAFF, display_name: '部員 太郎' },
];

interface DbNotice {
  id: string;
  year_id: string;
  audience: 'soumu' | 'all_groups' | 'groups';
  title: string;
  body: string | null;
  pinned: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  notice_groups: { group_id: string }[];
}

const N_PIN = uuid(101);
const N_SOUMU_MINE = uuid(102);
const N_SOUMU_OTHER = uuid(103);
const N_GROUPS = uuid(104);
const N_EMPTY = uuid(105);
const N_ALL_MINE = uuid(106);

const dbNotice = (id: string, over: Partial<DbNotice>): DbNotice => ({
  id,
  year_id: Y,
  audience: 'soumu',
  title: `題名${id.slice(-3)}`,
  body: null,
  pinned: false,
  created_by: HEAD,
  created_at: '2026-10-01T00:00:00.000000+00:00',
  updated_by: HEAD,
  updated_at: '2026-10-01T00:00:00.000000+00:00',
  notice_groups: [],
  ...over,
});

function seedRows(): DbNotice[] {
  return [
    dbNotice(N_SOUMU_MINE, {
      title: '在庫の数え方',
      created_by: STAFF,
      updated_by: STAFF,
      created_at: '2026-10-05T00:00:00.000000+00:00',
      updated_at: '2026-10-06T03:00:00.000000+00:00',
    }),
    dbNotice(N_SOUMU_OTHER, { title: '総務の集合', created_at: '2026-10-04T00:00:00.000000+00:00', updated_at: '2026-10-04T00:00:00.000000+00:00' }),
    dbNotice(N_GROUPS, {
      audience: 'groups',
      title: '模擬店への連絡',
      notice_groups: [{ group_id: G2 }, { group_id: G1 }],
      created_at: '2026-10-03T00:00:00.000000+00:00',
      updated_at: '2026-10-03T00:00:00.000000+00:00',
    }),
    dbNotice(N_PIN, {
      audience: 'all_groups',
      title: '全団体へのお知らせ',
      body: '一行目\n  二行目',
      pinned: true,
      created_at: '2026-10-02T00:00:00.000000+00:00',
      updated_at: '2026-10-02T00:00:00.000000+00:00',
    }),
    dbNotice(N_EMPTY, {
      audience: 'groups',
      title: '消えた団体あて',
      created_by: null,
      created_at: '2026-10-01T00:00:00.000000+00:00',
      updated_at: '2026-10-01T00:00:00.000000+00:00',
    }),
    dbNotice(N_ALL_MINE, {
      audience: 'all_groups',
      title: '部門長だったときの連絡',
      created_by: STAFF,
      updated_by: STAFF,
      created_at: '2026-09-30T00:00:00.000000+00:00',
      updated_at: '2026-09-30T00:00:00.000000+00:00',
    }),
  ];
}

const yearRow = (status: YearStatus): YearRow => ({
  id: Y,
  label: 'R8',
  status,
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: null,
  updated_at: 't',
});

function member(role: AppRole | null, groups: GroupSummary[], status: YearStatus): Membership {
  const year = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role, groups, years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

// ---------------------------------------------------------------- 偽の DB

let rows: DbNotice[] = [];
let override: ((call: FakeCall) => FakeResult | Promise<FakeResult> | undefined) | null = null;
let issued: FakeCall[] = [];
let clock = 0;

const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
const p0001 = (message: string, details?: unknown): FakeResult => ({
  error: { code: 'P0001', message, details: details === undefined ? '' : JSON.stringify(details), hint: null },
  status: 400,
});
const argsOf = (call: FakeCall) => call.ops[0]!.args[0] as Record<string, unknown>;
const nextAt = () => `2026-10-${String(10 + ++clock).padStart(2, '0')}T00:00:00.000000+00:00`;

/**
 * save_notice の DB の動き（段・楽観ロック・作る・直す）。返り値はお知らせの行（宛先の団体は埋め込まない）。
 * 確かめる順は 0014 と同じ：宛先の段 → ない（not_found）→ 書いた人 → ピン留めを変える → 楽観ロック（conflict）。
 * ピン留めの確かめが楽観ロックより先なので、ほかの人がピン留めを付け外しした後に古いピン留めで送ると forbidden になる。
 */
function dbSave(a: Record<string, unknown>): FakeResult {
  const lead = h.role === 'admin' || h.role === 'head' || h.role === 'deputy_head';
  const groups = a.p_audience === 'groups' ? ((a.p_group_ids as string[]) ?? []).map((group_id) => ({ group_id })) : [];
  const fields = {
    audience: a.p_audience as DbNotice['audience'],
    title: a.p_title as string,
    body: typeof a.p_body === 'string' && a.p_body.trim() !== '' ? a.p_body : null,
    pinned: (a.p_pinned as boolean) ?? false,
    notice_groups: groups,
  };
  const at = nextAt();
  if (fields.audience !== 'soumu' && !lead) return p0001('forbidden');
  if (a.p_notice_id) {
    const k = rows.findIndex((r) => r.id === a.p_notice_id);
    if (k < 0) return p0001('not_found');
    if (rows[k]!.created_by !== h.userId && !lead) return p0001('forbidden');
    if (rows[k]!.pinned !== fields.pinned && !lead) return p0001('forbidden');
    if (rows[k]!.updated_at !== a.p_base_updated_at) return p0001('conflict', { id: a.p_notice_id });
    rows[k] = { ...rows[k]!, ...fields, updated_by: h.userId, updated_at: at };
    const { notice_groups, ...row } = rows[k]!;
    void notice_groups;
    return { data: row };
  }
  if (fields.pinned && !lead) return p0001('forbidden');
  const created: DbNotice = { ...dbNotice(uuid(200 + clock), {}), ...fields, created_by: h.userId, updated_by: h.userId, created_at: at, updated_at: at };
  rows.push(created);
  const { notice_groups, ...row } = created;
  void notice_groups;
  return { data: row };
}

function dbDelete(a: Record<string, unknown>): FakeResult {
  const k = rows.findIndex((r) => r.id === a.p_notice_id);
  if (k < 0) return p0001('forbidden');
  if (rows[k]!.updated_at !== a.p_base_updated_at) return p0001('conflict', { id: a.p_notice_id });
  rows.splice(k, 1);
  return { data: null };
}

function handler(call: FakeCall): FakeResult | Promise<FakeResult> {
  const o = override?.(call);
  if (o) return o;
  switch (call.table) {
    case 'notices': {
      const eq = Object.fromEntries(opArgs(call, 'eq').map(([k, v]) => [k as string, v]));
      if (call.ops.some((x) => x.op === 'maybeSingle')) return { data: rows.find((r) => r.id === eq.id) ?? null };
      return { data: eq.created_by ? rows.filter((r) => r.created_by === eq.created_by) : rows };
    }
    case 'groups':
      return { data: GROUPS };
    case 'profiles':
      return { data: PROFILES };
    case 'rpc:save_notice':
      return dbSave(argsOf(call));
    case 'rpc:delete_notice':
      return dbDelete(argsOf(call));
    default:
      return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  }
}

function renderScreen(role: AppRole | null, opts: { groups?: GroupSummary[]; status?: YearStatus; userId?: string; search?: string } = {}) {
  const status = opts.status ?? 'requesting';
  h.role = role;
  h.userId = opts.userId ?? (role === 'staff' ? STAFF : HEAD);
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, opts.groups ?? [], status) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status));
  render(
    <QueryClientProvider client={qc}>
      <NoticesScreen />
    </QueryClientProvider>,
  );
  return qc;
}

const items = () => screen.queryAllByTestId('notice-item');
const itemIds = () => items().map((x) => x.getAttribute('data-id'));
const itemOf = (id: string) => items().find((x) => x.getAttribute('data-id') === id)!;
const saveCalls = () => issued.filter((c) => c.table === 'rpc:save_notice');
const deleteCalls = () => issued.filter((c) => c.table === 'rpc:delete_notice');
const form = () => screen.getByTestId('notice-form');

beforeEach(() => {
  rows = seedRows();
  override = null;
  clock = 0;
  const fake = createFakeSupabase(handler);
  h.client = fake.client;
  issued = fake.issued;
  h.replace.mockClear();
  h.reloadMembership.mockClear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** 部門長以上の書いた・読んだお知らせの並び（ピン留め → 出した日時の新しい順） */
const ALL_ORDER = [N_PIN, N_SOUMU_MINE, N_SOUMU_OTHER, N_GROUPS, N_EMPTY, N_ALL_MINE];

// ---------------------------------------------------------------- 一覧

describe('T17 お知らせ一覧：総務部門長', () => {
  it('h1「お知らせ一覧」・最終読み込みと「読み直す」・「お知らせを書く」。ピン留めが先、出した日時の新しい順', async () => {
    renderScreen('head');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('お知らせ一覧');
    await waitFor(() => expect(itemIds()).toEqual(ALL_ORDER));
    expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy();
    expect(screen.getByText(/最終読み込み/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'お知らせを書く' })).toBeTruthy();
    expect(itemOf(N_PIN).getAttribute('data-pinned')).toBe('true');
    expect(within(itemOf(N_PIN)).getByTestId('notice-pinned').textContent).toBe('ピン留め');
    expect(within(itemOf(N_SOUMU_MINE)).queryByTestId('notice-pinned')).toBeNull();
    expect(screen.getByTestId('notices-list').tagName).toBe('UL');
  });

  it('1件：宛先の印、指定の団体あては団体の名前（団体の並びで「・」）、0 なら「宛先の団体がありません」。題名・本文（改行を残す）・書いた人・日時と更新', async () => {
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    expect(items().map((x) => within(x).getByTestId('notice-audience').textContent)).toEqual(['全団体', '総務内', '総務内', '指定の団体', '指定の団体', '全団体']);
    expect(itemOf(N_GROUPS).getAttribute('data-audience')).toBe('groups');
    const groups = within(itemOf(N_GROUPS)).getByTestId('notice-groups');
    expect(groups.textContent).toBe('模擬店01・模擬店02');
    expect(groups.getAttribute('data-empty')).toBeNull();
    const empty = within(itemOf(N_EMPTY)).getByTestId('notice-groups');
    expect(empty.textContent).toBe('宛先の団体がありません');
    expect(empty.getAttribute('data-empty')).toBe('true');
    expect(within(itemOf(N_PIN)).queryByTestId('notice-groups')).toBeNull();
    // 題名は h3、本文は書いたとおり（改行と行頭の空白を残す。テキストとして出す）
    const pin = itemOf(N_PIN);
    expect(within(pin).getByRole('heading', { level: 3 }).textContent).toBe('全団体へのお知らせ');
    expect(within(pin).getByTestId('notice-body').textContent).toBe('一行目\n  二行目');
    expect(within(pin).getByTestId('notice-body').className).toContain('whitespace-pre-wrap');
    expect(within(itemOf(N_SOUMU_OTHER)).queryByTestId('notice-body')).toBeNull();
    // 書いた人（総務だけ）。記録がない・読めないときは「名前を表示できません」
    expect(within(pin).getByTestId('notice-author').textContent).toBe('部門長 花子');
    expect(within(itemOf(N_SOUMU_MINE)).getByTestId('notice-author').textContent).toBe('部員 太郎');
    expect(within(itemOf(N_EMPTY)).getByTestId('notice-author').textContent).toBe('名前を表示できません');
    // 日時（Asia/Tokyo）。直していれば「（… に更新）」
    const mine = itemOf(N_SOUMU_MINE);
    expect(within(mine).getByTestId('notice-time').textContent).toBe('2026/10/05 09:00');
    expect(within(mine).getByTestId('notice-time').tagName).toBe('TIME');
    expect(within(mine).getByTestId('notice-updated').textContent).toBe('（2026/10/06 12:00 に更新）');
    expect(within(pin).queryByTestId('notice-updated')).toBeNull();
  });

  it('どのお知らせにも「編集」「削除」（aria-label に題名）', async () => {
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    for (const x of items()) {
      const title = within(x).getByTestId('notice-title').textContent!;
      expect(within(x).getByRole('button', { name: `「${title}」を編集` }).textContent).toBe('編集');
      expect(within(x).getByRole('button', { name: `「${title}」を削除` }).textContent).toBe('削除');
    }
  });

  it('宛先の絞り込み（件数つき）。押すと ?audience= に入れる', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    const filter = screen.getByRole('radiogroup', { name: '宛先で絞り込む' });
    expect(filter.getAttribute('data-testid')).toBe('notices-filter');
    expect(within(filter).getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['すべて（6）', 'true'],
      ['総務内（2）', 'false'],
      ['全団体（2）', 'false'],
      ['指定の団体（2）', 'false'],
    ]);
    await user.click(within(filter).getByRole('radio', { name: '総務内（2）' }));
    expect(h.replace).toHaveBeenCalledWith('/notices?audience=soumu');
  });

  it('?audience=groups なら指定の団体あてだけ。知らない値は「すべて」', async () => {
    renderScreen('head', { search: 'audience=groups' });
    await waitFor(() => expect(itemIds()).toEqual([N_GROUPS, N_EMPTY]));
    expect(within(screen.getByTestId('notices-filter')).getByRole('radio', { name: '指定の団体（2）' }).getAttribute('aria-checked')).toBe('true');
    cleanup();
    renderScreen('head', { search: 'audience=everyone' });
    await waitFor(() => expect(itemIds()).toEqual(ALL_ORDER));
  });

  it('?notice=<id> はそのお知らせを目立たせて見える所に送り、絞り込みは「すべて」。ないお知らせなら何もしない', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderScreen('head', { search: `audience=soumu&notice=${N_GROUPS}` });
    await waitFor(() => expect(itemIds()).toEqual(ALL_ORDER));
    expect(itemOf(N_GROUPS).getAttribute('data-highlighted')).toBe('true');
    expect(items().filter((x) => x.hasAttribute('data-highlighted'))).toHaveLength(1);
    expect(spy.mock.instances).toContain(itemOf(N_GROUPS));
    cleanup();
    spy.mockClear();
    renderScreen('head', { search: `audience=soumu&notice=${uuid(999)}` });
    await waitFor(() => expect(itemIds()).toEqual([N_SOUMU_MINE, N_SOUMU_OTHER]));
    expect(items().filter((x) => x.hasAttribute('data-highlighted'))).toHaveLength(0);
  });

  it('絞り込みで 0 件なら「この宛先のお知らせはありません」、お知らせがなければ「お知らせはまだありません」と書き方', async () => {
    rows = rows.filter((r) => r.audience !== 'all_groups');
    renderScreen('head', { search: 'audience=all_groups' });
    expect((await screen.findByTestId('notices-empty')).textContent).toContain('この宛先のお知らせはありません');
    cleanup();
    rows = [];
    renderScreen('head');
    const empty = await screen.findByTestId('notices-empty');
    expect(empty.textContent).toContain('お知らせはまだありません');
    expect(empty.textContent).toContain('「お知らせを書く」から出せます。');
  });

  it('終了した年度：一覧は読めるが、書く・編集・削除がなく、読むだけの帯', async () => {
    renderScreen('head', { status: 'closed' });
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    expect(screen.getByText(CLOSED_NOTICE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'お知らせを書く' })).toBeNull();
    expect(screen.queryByRole('button', { name: /を編集$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /を削除$/ })).toBeNull();
    expect(screen.getByTestId('notices-filter')).toBeTruthy();
  });
});

describe('T17 お知らせ一覧：総務部門員・閲覧のみ・店長', () => {
  it('総務部門員：自分が書いた総務内に「編集」、自分が書いたお知らせに「削除」。ほかの人のお知らせには何も出さない', async () => {
    renderScreen('staff');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    const actions = (id: string) => within(itemOf(id)).queryAllByRole('button').map((b) => b.textContent);
    expect(actions(N_SOUMU_MINE)).toEqual(['編集', '削除']);
    // 部門長以上だったときに出した団体あては削除だけ（総務部門員のダイアログは宛先を選べない）
    expect(actions(N_ALL_MINE)).toEqual(['削除']);
    for (const id of [N_PIN, N_SOUMU_OTHER, N_GROUPS, N_EMPTY]) expect(actions(id), id).toEqual([]);
    expect(screen.getByRole('button', { name: 'お知らせを書く' })).toBeTruthy();
    expect(screen.getByTestId('notices-filter')).toBeTruthy();
    expect(within(itemOf(N_PIN)).getByTestId('notice-author')).toBeTruthy();
  });

  it.each([
    { who: '閲覧のみ', role: 'viewer' as const, groups: [] as GroupSummary[] },
    { who: '店長', role: null, groups: [{ id: G1, name: '模擬店01', year_id: Y, role: 'manager' as const }] },
  ])('$who：RLS が返したものを出すだけ。書いた人・絞り込み・書く・編集・削除・帯がない。profiles を読まない', async ({ role, groups }) => {
    rows = rows.filter((r) => r.audience !== 'soumu').map((r) => (role === null ? { ...r, notice_groups: r.notice_groups.filter((g) => g.group_id === G1) } : r));
    renderScreen(role, { groups, search: 'audience=soumu' });
    await waitFor(() => expect(itemIds()).toEqual([N_PIN, N_GROUPS, N_EMPTY, N_ALL_MINE]));
    expect(screen.queryByTestId('notice-author')).toBeNull();
    expect(screen.queryByTestId('notices-filter')).toBeNull();
    expect(screen.queryByRole('button', { name: 'お知らせを書く' })).toBeNull();
    expect(within(screen.getByTestId('notices-list')).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByText(CLOSED_NOTICE)).toBeNull();
    expect(issued.map((c) => c.table)).not.toContain('profiles');
    // 店長には自団体の行しか返らないので、自団体の名前だけ
    expect(within(itemOf(N_GROUPS)).getByTestId('notice-groups').textContent).toBe(role === null ? '模擬店01' : '模擬店01・模擬店02');
  });

  it('閲覧のみ（終了した年度）：帯を出さない', async () => {
    renderScreen('viewer', { status: 'closed' });
    await waitFor(() => expect(itemIds().length).toBeGreaterThan(0));
    expect(screen.queryByText(CLOSED_NOTICE)).toBeNull();
  });

  it('お知らせがない（閲覧のみ）：「お知らせはまだありません」だけ（書き方の案内なし）', async () => {
    rows = [];
    renderScreen('viewer');
    const empty = await screen.findByTestId('notices-empty');
    expect(empty.textContent).toContain('お知らせはまだありません');
    expect(empty.textContent).not.toContain('お知らせを書く');
  });
});

// ---------------------------------------------------------------- ダイアログ（段）

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(itemIds().length).toBeGreaterThan(0));
  await user.click(screen.getByRole('button', { name: 'お知らせを書く' }));
  return screen.findByTestId('notice-form');
}

async function openEdit(user: ReturnType<typeof userEvent.setup>, title: string) {
  await waitFor(() => expect(itemIds().length).toBeGreaterThan(0));
  await user.click(screen.getByRole('button', { name: `「${title}」を編集` }));
  return screen.findByTestId('notice-form');
}

describe('T17 ダイアログ：総務部門員', () => {
  it('宛先のラジオとピン留めの欄がなく、総務内だけの文。出すと総務内・ピン留めなしで送り、閉じて一覧に入れる', async () => {
    const user = userEvent.setup();
    renderScreen('staff');
    await openNew(user);
    expect(screen.getByRole('heading', { name: 'お知らせを書く' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByTestId('notice-audience-fixed').textContent).toContain(STAFF_AUDIENCE_TEXT);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('notice-group-picker')).toBeNull();
    await user.type(screen.getByLabelText('題名'), '\u3000明日の集合 ');
    await user.click(screen.getByRole('button', { name: '出す' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(saveCalls()).toHaveLength(1);
    // 本文が空なら p_body を送らない（DB の既定値 null）。題名は前後の空白を除いた形
    expect(argsOf(saveCalls()[0]!)).toEqual({ p_year_id: Y, p_audience: 'soumu', p_title: '明日の集合', p_pinned: false, p_group_ids: [] });
    expect(toast.success).toHaveBeenCalledWith('お知らせ「明日の集合」を出しました');
    await waitFor(() => expect(screen.getAllByTestId('notice-title').map((x) => x.textContent)).toContain('明日の集合'));
  });

  it('ピン留めされた自分のお知らせを直す：ピン留めの欄の代わりに知らせを出し、今の値（ピン留め）のまま送る。読んだときの版を渡す', async () => {
    rows = rows.map((r) => (r.id === N_SOUMU_MINE ? { ...r, pinned: true } : r));
    const user = userEvent.setup();
    renderScreen('staff');
    await openEdit(user, '在庫の数え方');
    expect(screen.getByRole('heading', { name: 'お知らせを編集' })).toBeTruthy();
    expect(screen.getByTestId('notice-pinned-note').textContent).toBe(PINNED_NOTE);
    expect(screen.queryByRole('switch')).toBeNull();
    const title = screen.getByLabelText('題名');
    await user.clear(title);
    await user.type(title, '在庫の数え方（改）');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(argsOf(saveCalls()[0]!)).toEqual({
      p_year_id: Y,
      p_audience: 'soumu',
      p_title: '在庫の数え方（改）',
      p_pinned: true,
      p_group_ids: [],
      p_notice_id: N_SOUMU_MINE,
      p_base_updated_at: '2026-10-06T03:00:00.000000+00:00',
    });
    expect(toast.success).toHaveBeenCalledWith('「在庫の数え方（改）」を保存しました');
  });
});

describe('T17 ダイアログ：部門長以上', () => {
  it('宛先は3つ（説明つき。既定は総務内）、指定の団体なら宛先の団体の一覧（区分ごと・探せる・数・選択を外す）、ピン留め。送る団体は団体の並び', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(screen.getByText('総務だけが読みます')).toBeTruthy();
    expect(screen.getByText('すべての団体の店長・副店長と、閲覧のみの人が読みます')).toBeTruthy();
    expect(screen.getByText('選んだ団体の店長・副店長と、閲覧のみの人が読みます')).toBeTruthy();
    expect(screen.queryByTestId('notice-group-picker')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '指定の団体' }));
    const picker = screen.getByTestId('notice-group-picker');
    expect(within(picker).getAllByRole('group').map((g) => within(g).getAllByRole('checkbox').length)).toEqual([2, 1]);
    expect(within(picker).getByText('模擬店')).toBeTruthy();
    expect(within(picker).getByText('部門')).toBeTruthy();
    expect(within(picker).getByTestId('notice-group-count').textContent).toBe('0 団体を選んでいます');
    // 別名で探せる（模擬店02 の別名「二号店」）
    await user.type(within(picker).getByRole('searchbox', { name: '団体を探す' }), '二号');
    expect(within(picker).getAllByRole('checkbox')).toHaveLength(1);
    await user.click(within(picker).getByRole('checkbox', { name: '模擬店02' }));
    await user.clear(within(picker).getByRole('searchbox', { name: '団体を探す' }));
    await user.click(within(picker).getByRole('checkbox', { name: '模擬店01' }));
    expect(within(picker).getByTestId('notice-group-count').textContent).toBe('2 団体を選んでいます');
    await user.click(screen.getByRole('switch', { name: 'ピン留めする' }));
    await user.type(screen.getByLabelText('題名'), '模擬店の方へ');
    await user.type(screen.getByLabelText('本文（任意）'), '1行目{enter}2行目');
    await user.click(screen.getByRole('button', { name: '出す' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(argsOf(saveCalls()[0]!)).toEqual({
      p_year_id: Y,
      p_audience: 'groups',
      p_title: '模擬店の方へ',
      p_body: '1行目\n2行目',
      p_pinned: true,
      p_group_ids: [G1, G2],
    });
  });

  it('「選択を外す」で選んだ団体を外す。宛先を切り替えても選んだ団体を覚えておき、ほかの宛先では送らない', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.click(screen.getByRole('radio', { name: '指定の団体' }));
    await user.click(screen.getByRole('checkbox', { name: '部門03' }));
    await user.click(screen.getByRole('radio', { name: '全団体' }));
    expect(screen.queryByTestId('notice-group-picker')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '指定の団体' }));
    expect((screen.getByRole('checkbox', { name: '部門03' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: '選択を外す' }));
    expect(screen.getByTestId('notice-group-count').textContent).toBe('0 団体を選んでいます');
    await user.click(screen.getByRole('checkbox', { name: '部門03' }));
    await user.click(screen.getByRole('radio', { name: '全団体' }));
    await user.type(screen.getByLabelText('題名'), '全団体へ');
    await user.click(screen.getByRole('button', { name: '出す' }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(argsOf(saveCalls()[0]!)).toMatchObject({ p_audience: 'all_groups', p_group_ids: [] });
  });

  it('欄の誤りは欄の下に出して送らない（題名が空、指定の団体で団体が 0）。字数は「n/100」「n/4000」（題名は前後の空白を除く・文字で数える）', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '  😀あ ');
    expect(screen.getByTestId('notice-title-count').textContent).toBe('2/100');
    await user.type(screen.getByLabelText('本文（任意）'), '😀😀');
    expect(screen.getByTestId('notice-body-count').textContent).toBe('2/4000');
    await user.clear(screen.getByLabelText('題名'));
    await user.type(screen.getByLabelText('題名'), '   ');
    await user.click(screen.getByRole('radio', { name: '指定の団体' }));
    await user.click(screen.getByRole('button', { name: '出す' }));
    expect(saveCalls()).toHaveLength(0);
    const errors = [...form().querySelectorAll('[data-field-error]')].map((x) => [x.getAttribute('data-field-error'), x.textContent]);
    expect(errors).toEqual([
      ['groupIds', '宛先の団体を1つ以上選んでください'],
      ['title', '題名を入れてください'],
    ]);
  });

  it('DB の invalid_input（団体がこの年度にない）は宛先の団体の欄の下に出し、団体を読み直す（入力は残す）', async () => {
    override = (call) => (call.table === 'rpc:save_notice' ? p0001('invalid_input', { field: 'group_ids', reason: 'not_in_year' }) : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.click(screen.getByRole('radio', { name: '指定の団体' }));
    await user.click(screen.getByRole('checkbox', { name: '模擬店01' }));
    await user.type(screen.getByLabelText('題名'), '題名');
    const groupsReads = () => issued.filter((c) => c.table === 'groups').length;
    const before = groupsReads();
    await user.click(screen.getByRole('button', { name: '出す' }));
    expect((await within(form()).findByText(/この年度にない団体があります/)).getAttribute('data-field-error')).toBe('groupIds');
    await waitFor(() => expect(groupsReads()).toBe(before + 1));
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('題名');
  });

  it('forbidden：失敗の帯を出し、立場と年度の行を読み直す（ダイアログと入力は残す）', async () => {
    override = (call) => (call.table === 'rpc:save_notice' ? p0001('forbidden') : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '題名');
    await user.click(screen.getByRole('button', { name: '出す' }));
    expect((await within(form()).findByTestId('error-banner')).textContent).toContain('権限がありません。立場が変わった可能性があります');
    expect(h.reloadMembership).toHaveBeenCalled();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('題名');
  });

  it('編集で何も変えていなければ送らずに「変更はありません」で閉じる', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '模擬店への連絡');
    // 宛先の団体は今の値（団体の並び）で開く
    expect(screen.getByTestId('notice-group-count').textContent).toBe('2 団体を選んでいます');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(saveCalls()).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledWith('変更はありません');
    expect(screen.queryByTestId('notice-form')).toBeNull();
  });

  it('入力があれば、やめる前に「保存していない入力を捨てますか」。入力に戻る／捨てて閉じる（下書きも消す）', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '書きかけ');
    const key = draftKey({ userId: HEAD, yearId: Y, screen: 'notices', target: 'new' });
    await waitFor(() => expect(window.localStorage.getItem(key)).not.toBeNull(), { timeout: 2000 });
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('保存していない入力を捨てますか');
    expect(screen.getByRole('alertdialog').textContent).toContain('閉じると、このフォームに入れた内容は消えます。');
    await user.click(screen.getByRole('button', { name: '入力に戻る' }));
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('書きかけ');
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    await user.click(screen.getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('下書き：開いたときに下書きがあれば「保存していない入力があります」。戻すと入力が戻る', async () => {
    const key = draftKey({ userId: HEAD, yearId: Y, screen: 'notices', target: 'new' });
    const values = { audience: 'all_groups', title: '下書きの題名', body: '下書きの本文', pinned: true, groupIds: [] };
    window.localStorage.setItem(key, JSON.stringify({ value: { values, baseUpdatedAt: null }, savedAt: Date.now() }));
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    expect(screen.getByTestId('draft-notice')).toBeTruthy();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: '戻す' }));
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('下書きの題名');
    expect(screen.getByRole('radio', { name: '全団体' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'ピン留めする' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });

  it('下書き（編集）：戻した下書きは下書きの版で送り、間にほかの人が変えていれば conflict（読み直して入力を残す）', async () => {
    const key = draftKey({ userId: HEAD, yearId: Y, screen: 'notices', target: N_SOUMU_OTHER });
    const values = { audience: 'soumu', title: '下書きで直した題名', body: '', pinned: false, groupIds: [] };
    window.localStorage.setItem(key, JSON.stringify({ value: { values, baseUpdatedAt: '2026-09-01T00:00:00.000000+00:00' }, savedAt: Date.now() }));
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    await user.click(screen.getByRole('button', { name: '戻す' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(argsOf(saveCalls()[0]!)).toMatchObject({ p_notice_id: N_SOUMU_OTHER, p_base_updated_at: '2026-09-01T00:00:00.000000+00:00' });
    expect(await screen.findByTestId('notice-conflict')).toBeTruthy();
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('下書きで直した題名');
  });
});

// ---------------------------------------------------------------- 読み直し（(B1)・(B2)）

describe('T17 読み直し：編集（(B1)）', () => {
  it('conflict：今の行を読み直し、入力を残して知らせる（今の題名と更新の日時）。次の保存は読み直した版で送り、上書きできる', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    // 開いた後に、ほかの人が直した
    rows = rows.map((r) => (r.id === N_SOUMU_OTHER ? { ...r, title: 'ほかの人の題名', updated_at: '2026-10-07T01:00:00.000000+00:00' } : r));
    const title = screen.getByLabelText('題名');
    await user.clear(title);
    await user.type(title, '私の題名');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const box = await screen.findByTestId('notice-conflict');
    expect(box.textContent).toContain(CONFLICT_NOTICE);
    expect(box.textContent).toContain('今の題名：ほかの人の題名');
    expect(box.textContent).toContain('更新：2026/10/07 10:00');
    expect((title as HTMLInputElement).value).toBe('私の題名');
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(argsOf(saveCalls()[1]!)).toMatchObject({ p_title: '私の題名', p_base_updated_at: '2026-10-07T01:00:00.000000+00:00' });
    expect(rows.find((r) => r.id === N_SOUMU_OTHER)!.title).toBe('私の題名');
  });

  it('消えていた（not_found・読み直してもない）：「このお知らせは見つかりません」と出し、「保存」を押せなくする（入力は残す）', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    rows = rows.filter((r) => r.id !== N_SOUMU_OTHER);
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findByTestId('notice-missing')).textContent).toContain('このお知らせは見つかりません（ほかの人が削除した可能性があります）');
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('総務の集合！');
  });

  it('応答が届かず、読み直すと入力どおり（saved）：「保存されていました」で閉じる', async () => {
    override = (call) => {
      if (call.table !== 'rpc:save_notice') return undefined;
      dbSave(argsOf(call));
      return NETWORK;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    await user.type(screen.getByLabelText('題名'), '（変更）');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('「総務の集合（変更）」は保存されていました');
  });

  it('応答が届かず、読み直すと版が読んだときのまま（not-saved）：「保存できたか分かりません」。もう一度の保存は（入力を戻しても）送る', async () => {
    override = (call) => (call.table === 'rpc:save_notice' ? NETWORK : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    const title = screen.getByLabelText('題名');
    await user.type(title, '！');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findByTestId('unknown-outcome')).textContent).toBe(unknownOutcomeMessage());
    // 開いたときの値に戻しても、DB の行が入力の元と同じか分からないので送る（「変更はありません」で閉じない）
    await user.clear(title);
    await user.type(title, '総務の集合');
    override = null;
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    expect(toast.info).not.toHaveBeenCalledWith('変更はありません');
  });

  it('応答が届かず、読み直せない（unread）：「保存できたか分かりません」（「読み直しました」と言わない）', async () => {
    override = (call) => (call.table === 'rpc:save_notice' || (call.table === 'notices' && call.ops.some((o) => o.op === 'maybeSingle')) ? NETWORK : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const box = await screen.findByTestId('unknown-outcome');
    expect(box.textContent).toBe(unknownOutcomeMessage());
    expect(box.textContent).not.toContain('読み直しました');
  });

  it('止められた（conflict）後に読み直せない：読み直せなかったと出し、「読み直す」で一覧を読み直す', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await openEdit(user, '総務の集合');
    rows = rows.map((r) => (r.id === N_SOUMU_OTHER ? { ...r, updated_at: '2026-10-08T00:00:00.000000+00:00' } : r));
    override = (call) => (call.table === 'notices' && call.ops.some((o) => o.op === 'maybeSingle') ? NETWORK : undefined);
    await user.type(screen.getByLabelText('題名'), '！');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const box = await screen.findByTestId('unknown-outcome');
    expect(box.textContent).toContain(REREAD_FAILED_NOTICE);
    const lists = () => issued.filter((c) => c.table === 'notices' && c.ops.some((o) => o.op === 'range')).length;
    const before = lists();
    await user.click(within(box).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(lists()).toBe(before + 1));
  });
});

describe('T17 読み直し：総務部門員の編集（宛先とピン留めは入力の元の行のまま。レビューの T17-R1）', () => {
  /** 開いた後に、部門長が自分の総務内のお知らせ（在庫の数え方）を直した（版が進む） */
  const leadChanged = (patch: Partial<DbNotice>) => {
    rows = rows.map((r) => (r.id === N_SOUMU_MINE ? { ...r, ...patch, updated_by: HEAD, updated_at: '2026-10-07T01:00:00.000000+00:00' } : r));
  };
  const mine = () => rows.find((r) => r.id === N_SOUMU_MINE)!;
  const pinnedNote = () => screen.queryByTestId('notice-pinned-note');

  it.each([
    { what: '付けた', from: false, first: 'forbidden' },
    { what: '外した', from: true, first: 'forbidden' },
    { what: '付けた（1回目の応答が届かなかった）', from: false, first: 'network' },
  ] as const)(
    '部門長が間にピン留めを$what：1回目は開いたときのピン留めで送る（DB はピン留めの確かめが楽観ロックより先なので forbidden）。読み直して conflict と同じに扱い、もう一度の保存は読み直した版とピン留めで送る',
    async ({ from, first }) => {
      rows = rows.map((r) => (r.id === N_SOUMU_MINE ? { ...r, pinned: from } : r));
      const user = userEvent.setup();
      renderScreen('staff');
      await openEdit(user, '在庫の数え方');
      expect(pinnedNote() !== null).toBe(from);
      leadChanged({ pinned: !from });
      if (first === 'network') {
        // 1回目は応答が届かない（DB は古いピン留めを forbidden で止め、何も変えていない）
        let sent = 0;
        override = (call) => (call.table === 'rpc:save_notice' && sent++ === 0 ? NETWORK : undefined);
      }
      await user.type(screen.getByLabelText('本文（任意）'), '本文を足した');
      await user.click(screen.getByRole('button', { name: '保存' }));
      const box = await screen.findByTestId('notice-conflict');
      expect(argsOf(saveCalls()[0]!)).toMatchObject({ p_pinned: from, p_base_updated_at: '2026-10-06T03:00:00.000000+00:00' });
      expect(box.textContent).toContain(CONFLICT_NOTICE);
      expect(box.textContent).toContain('今の題名：在庫の数え方');
      expect(box.textContent).toContain('更新：2026/10/07 10:00');
      // forbidden の帯と立場の読み直しは出さない（立場は変わっていない）。ピン留めの知らせは読み直した行の値。入力は残す
      expect(within(form()).queryByTestId('error-banner')).toBeNull();
      expect(h.reloadMembership).not.toHaveBeenCalled();
      expect(pinnedNote() !== null).toBe(!from);
      expect((screen.getByLabelText('本文（任意）') as HTMLTextAreaElement).value).toBe('本文を足した');
      await user.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
      expect(argsOf(saveCalls()[1]!)).toMatchObject({
        p_audience: 'soumu',
        p_pinned: !from,
        p_body: '本文を足した',
        p_base_updated_at: '2026-10-07T01:00:00.000000+00:00',
      });
      expect(toast.success).toHaveBeenCalledWith('「在庫の数え方」を保存しました');
      expect(mine()).toMatchObject({ audience: 'soumu', pinned: !from, body: '本文を足した', updated_by: STAFF });
    },
  );

  it('部門長が間に宛先を全団体に変えた：conflict。総務部門員の編集できないお知らせになったので「保存」を押せなくし、理由と今の題名・宛先・更新の日時を出す（黙って総務内に戻さない）', async () => {
    const user = userEvent.setup();
    renderScreen('staff');
    await openEdit(user, '在庫の数え方');
    leadChanged({ audience: 'all_groups', title: '全団体への連絡に変えた' });
    await user.type(screen.getByLabelText('本文（任意）'), '本文を足した');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const box = await screen.findByTestId('notice-not-editable');
    expect(argsOf(saveCalls()[0]!)).toMatchObject({ p_audience: 'soumu', p_pinned: false });
    expect(box.textContent).toContain(NOT_EDITABLE_NOTICE);
    expect(box.textContent).toContain('今の題名：全団体への連絡に変えた');
    expect(box.textContent).toContain('今の宛先：全団体');
    expect(box.textContent).toContain('更新：2026/10/07 10:00');
    expect(screen.queryByTestId('notice-conflict')).toBeNull();
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('今の立場・年度の状態では保存できません')).toBeTruthy();
    await user.click(save);
    expect(saveCalls()).toHaveLength(1);
    expect(mine()).toMatchObject({ audience: 'all_groups', title: '全団体への連絡に変えた', body: null, updated_by: HEAD });
    expect((screen.getByLabelText('本文（任意）') as HTMLTextAreaElement).value).toBe('本文を足した');
  });

  it('下書きを戻しても、宛先とピン留めは開いたときの行のまま（戻すのは題名と本文）。下書きの版が古ければ conflict になり、読み直した版で保存できる', async () => {
    // 下書きを書いた後に、部門長がピン留めを付けた（下書きのピン留めは外れたまま）
    rows = rows.map((r) => (r.id === N_SOUMU_MINE ? { ...r, pinned: true } : r));
    const key = draftKey({ userId: STAFF, yearId: Y, screen: 'notices', target: N_SOUMU_MINE });
    const values = { audience: 'soumu', title: '下書きの題名', body: '下書きの本文', pinned: false, groupIds: [] };
    window.localStorage.setItem(key, JSON.stringify({ value: { values, baseUpdatedAt: '2026-10-05T00:00:00.000000+00:00' }, savedAt: Date.now() }));
    const user = userEvent.setup();
    renderScreen('staff');
    await openEdit(user, '在庫の数え方');
    expect(pinnedNote()?.textContent).toBe(PINNED_NOTE);
    await user.click(screen.getByRole('button', { name: '戻す' }));
    expect((screen.getByLabelText('題名') as HTMLInputElement).value).toBe('下書きの題名');
    expect((screen.getByLabelText('本文（任意）') as HTMLTextAreaElement).value).toBe('下書きの本文');
    expect(pinnedNote()?.textContent).toBe(PINNED_NOTE);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByTestId('notice-conflict')).toBeTruthy();
    expect(argsOf(saveCalls()[0]!)).toMatchObject({ p_title: '下書きの題名', p_pinned: true, p_base_updated_at: '2026-10-05T00:00:00.000000+00:00' });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(argsOf(saveCalls()[1]!)).toMatchObject({ p_pinned: true, p_base_updated_at: '2026-10-06T03:00:00.000000+00:00' });
    expect(mine()).toMatchObject({ title: '下書きの題名', body: '下書きの本文', pinned: true });
  });

  it('forbidden で、読み直すと版が同じ（立場が変わった）：今までの forbidden の扱い（失敗の帯と立場の読み直し。入力は残す）', async () => {
    override = (call) => (call.table === 'rpc:save_notice' ? p0001('forbidden') : undefined);
    const user = userEvent.setup();
    renderScreen('staff');
    await openEdit(user, '在庫の数え方');
    await user.type(screen.getByLabelText('本文（任意）'), '本文');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect((await within(form()).findByTestId('error-banner')).textContent).toContain('権限がありません。立場が変わった可能性があります');
    expect(h.reloadMembership).toHaveBeenCalled();
    expect(screen.queryByTestId('notice-conflict')).toBeNull();
    // そのお知らせを1回読み直して確かめた
    expect(issued.filter((c) => c.table === 'notices' && c.ops.some((o) => o.op === 'maybeSingle'))).toHaveLength(1);
    expect((screen.getByLabelText('本文（任意）') as HTMLTextAreaElement).value).toBe('本文');
  });
});

describe('T17 読み直し：出す（(B2)）', () => {
  it('応答が届かず、自分が出した最近のお知らせに同じ中身の新しいものがあれば「出されていました」で閉じる', async () => {
    override = (call) => {
      if (call.table !== 'rpc:save_notice') return undefined;
      dbSave(argsOf(call));
      return NETWORK;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '届いたか分からない');
    await user.click(screen.getByRole('button', { name: '出す' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('お知らせ「届いたか分からない」は出されていました');
    const find = issued.find((c) => c.table === 'notices' && opArgs(c, 'eq').some(([k]) => k === 'created_by'))!;
    expect(opArgs(find, 'eq')).toEqual([
      ['year_id', Y],
      ['created_by', HEAD],
    ]);
  });

  it('応答が届かず、出されていなかった（開いたときからあるものは数えない）：入力を残し、もう一度「出す」を押せる', async () => {
    // 開く前からある自分のお知らせ（同じ題名）は、開いたときの一覧にあるので取り違えない
    rows.push(dbNotice(uuid(150), { title: '同じ題名', created_by: HEAD, created_at: '2026-10-09T00:00:00.000000+00:00', updated_at: '2026-10-09T00:00:00.000000+00:00' }));
    override = (call) => (call.table === 'rpc:save_notice' ? NETWORK : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '同じ題名');
    await user.click(screen.getByRole('button', { name: '出す' }));
    expect((await within(form()).findByTestId('error-banner')).textContent).toContain('通信できませんでした');
    expect(screen.getByRole('button', { name: '出す' }).hasAttribute('disabled')).toBe(false);
    override = null;
    await user.click(screen.getByRole('button', { name: '出す' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('お知らせ「同じ題名」を出しました');
    expect(rows.filter((r) => r.title === '同じ題名')).toHaveLength(2);
  });

  it('応答が届かず、読み直せない：「出せたか確かめられません」と「確かめる」（「出す」の代わり）。確かめると出されていたので閉じる', async () => {
    let reachable = false;
    override = (call) => {
      if (call.table === 'rpc:save_notice') {
        dbSave(argsOf(call));
        return NETWORK;
      }
      if (call.table === 'notices' && opArgs(call, 'eq').some(([k]) => k === 'created_by') && !reachable) return NETWORK;
      return undefined;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await openNew(user);
    await user.type(screen.getByLabelText('題名'), '確かめる題名');
    await user.click(screen.getByRole('button', { name: '出す' }));
    expect((await screen.findByTestId('unknown-outcome')).textContent).toBe(UNCONFIRMED_NOTICE);
    expect(screen.queryByRole('button', { name: '出す' })).toBeNull();
    // 通信が戻らないうちは「確かめる」のまま
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '確かめる' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByTestId('unknown-outcome').textContent).toBe(UNCONFIRMED_NOTICE);
    reachable = true;
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(screen.queryByTestId('notice-form')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('お知らせ「確かめる題名」は出されていました');
    expect(saveCalls()).toHaveLength(1);
  });
});

describe('T17 削除', () => {
  it('確かめてから delete_notice（読んだときの版）。消えたら一覧から外して「「…」を削除しました」', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('「総務の集合」を削除しますか');
    expect(dialog.textContent).toContain('宛先の人もこのお知らせを読めなくなります。元に戻せません。');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(itemIds()).not.toContain(N_SOUMU_OTHER));
    expect(argsOf(deleteCalls()[0]!)).toEqual({ p_notice_id: N_SOUMU_OTHER, p_base_updated_at: '2026-10-04T00:00:00.000000+00:00' });
    expect(toast.success).toHaveBeenCalledWith('「総務の集合」を削除しました');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('forbidden が返り、読み直すともうない：「すでに削除されていました」', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    rows = rows.filter((r) => r.id !== N_SOUMU_OTHER); // ほかの人が先に消した（delete_notice は、ないお知らせに forbidden）
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(ALREADY_DELETED_MESSAGE));
    await waitFor(() => expect(itemIds()).not.toContain(N_SOUMU_OTHER));
  });

  it('conflict が返り、読み直すと版が違う：内容を確かめてからもう一度削除してもらう（一覧を読み直す）', async () => {
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    rows = rows.map((r) => (r.id === N_SOUMU_OTHER ? { ...r, title: '直された', updated_at: '2026-10-08T00:00:00.000000+00:00' } : r));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(DELETE_CHANGED_MESSAGE));
    await waitFor(() => expect(screen.getAllByTestId('notice-title').map((x) => x.textContent)).toContain('直された'));
    expect(rows.some((r) => r.id === N_SOUMU_OTHER)).toBe(true);
  });

  it('応答が届かず、読み直すと版が同じ：確かめのダイアログに「削除できたか分かりません…」と出して開いたまま', async () => {
    override = (call) => (call.table === 'rpc:delete_notice' ? NETWORK : undefined);
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    expect((await screen.findByTestId('notice-delete-error')).textContent).toBe(unknownOutcomeMessage('削除'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // もう一度押すと送る（今度は届く）
    override = null;
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「総務の集合」を削除しました'));
  });

  it('消せたか分からなかった後に、もう一度押すと消えていた：「「…」は削除されていました」（ほかの人が削除したとは言わない。レビューの T17-R2）', async () => {
    let reachable = false;
    override = (call) => {
      if (reachable) return undefined;
      if (call.table === 'rpc:delete_notice') {
        dbDelete(argsOf(call)); // 1回目の削除は DB に届いたが、応答が届かない
        return NETWORK;
      }
      // 読み直しも届かない（消せたか決められない）
      if (call.table === 'notices' && call.ops.some((o) => o.op === 'maybeSingle')) return NETWORK;
      return undefined;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    expect((await screen.findByTestId('notice-delete-error')).textContent).toBe(unknownOutcomeMessage('削除'));
    // 通信が戻ってもう一度：delete_notice は、ないお知らせに forbidden。読み直すともうない
    reachable = true;
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「総務の集合」は削除されていました'));
    expect(toast.info).not.toHaveBeenCalledWith(ALREADY_DELETED_MESSAGE);
    expect(deleteCalls()).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(itemIds()).not.toContain(N_SOUMU_OTHER));
  });

  it('消せたか分からなかった後に「やめる」で閉じ、開き直して消えていた：前の知らせは持ち越さず「すでに削除されていました」', async () => {
    let reachable = false;
    override = (call) => {
      if (reachable) return undefined;
      if (call.table === 'rpc:delete_notice') return NETWORK;
      if (call.table === 'notices' && call.ops.some((o) => o.op === 'maybeSingle')) return NETWORK;
      return undefined;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    expect(await screen.findByTestId('notice-delete-error')).toBeTruthy();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // 閉じている間に、ほかの人が消した
    reachable = true;
    rows = rows.filter((r) => r.id !== N_SOUMU_OTHER);
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    expect(screen.queryByTestId('notice-delete-error')).toBeNull();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(ALREADY_DELETED_MESSAGE));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('応答が届かず、読み直すともうない：消せたとして「「…」を削除しました」', async () => {
    override = (call) => {
      if (call.table !== 'rpc:delete_notice') return undefined;
      dbDelete(argsOf(call));
      return NETWORK;
    };
    const user = userEvent.setup();
    renderScreen('head');
    await waitFor(() => expect(itemIds()).toHaveLength(6));
    await user.click(screen.getByRole('button', { name: '「総務の集合」を削除' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「総務の集合」を削除しました'));
  });
});
