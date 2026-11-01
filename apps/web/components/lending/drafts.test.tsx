// @vitest-environment jsdom
// テント等の貸し出しの保存していない入力（T21・D-57。計画 3.3・3.4、notes/T21.md「画面の約束」4・5、レビューの T21-R3）：
// 下書き（lib/drafts.ts）と、離れるときの確かめ（UnsavedChangesProvider・useUnsavedChanges・UnsavedChangesGuard）と、
// /lending の「変更を取り消す」。
// - 備品と割り当て（/lending）の割り当て：アンマウントで下書きが残る → 開き直すと DraftNotice →「戻す」で入力と、入力を始めたときの版
//   （保存はその updatedAt で送る）／「捨てる」／保存できると下書きを消す／未保存の間の確かめ／「変更を取り消す」。
// - 備品の登録・編集のダイアログ：「戻す」で入力と登録の id・編集の版／「捨てる」／保存できると消す／ダイアログの入力の間の確かめ。
// - 受け渡し・返却（/lending/records）の団体の欄：「戻す」で入力と入力の元の版（stamps）／「捨てる」／保存できると消す／確かめ。
// 申請のテント等のタブの下書きと確かめは request-tabs.test.tsx。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）と偽の DB（lib/testing/fake-lending-db.ts）。立場は useAuth の差し替え。
// ナビと年度の選択の代わりに、同じ部品と関数（AppLink・useGuardedSetYear）で未保存の入力の確かめを通す（T18 の calendar.test.tsx と同じ）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLink } from '@/components/common/app-link';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import type { AppRole, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { draftKey, saveDraft, type DraftKey } from '@/lib/drafts';
import { queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import { lendingHandler, nextAt, type FakeLendingDb } from '@/lib/testing/fake-lending-db';
import { LEAVE_MESSAGES } from '@/lib/unsaved-changes';
import { ITEM_CONFLICT_NOTICE } from './item-dialog';
import { LendingScreen } from './lending-screen';
import { RECORDS_CONFLICT_TITLE } from './records-panel';
import { LendingRecordsScreen } from './records-screen';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  role: 'head' as AppRole | null,
  status: 'requesting' as YearStatus,
  userId: 'u-head',
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
  usePathname: () => '/lending',
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
const Y_PREV = uuid(2);
const TENT = uuid(101);
const WEIGHT = uuid(102);
const G1 = uuid(11);
const G2 = uuid(12);
const V0 = '2026-10-01T00:00:00.123456+00:00';
/** 受付の締切 10/5 17:00（Asia/Tokyo）。1日目 10/17。画面を開いた時刻は締切の後 */
const CLOSE = '2026-10-05T08:00:00Z';
const AFTER = '2026-10-06T00:00:00Z';

const yearRow = (status: YearStatus): YearRow => ({
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
});

function seed(): FakeLendingDb {
  return {
    items: [
      { id: TENT, year_id: Y, name: 'テント', unit: '張', stock: 3, requestable_categories: ['stall', 'department'], sort_order: 1, updated_at: V0 },
      { id: WEIGHT, year_id: Y, name: '重し', unit: '個', stock: 20, requestable_categories: ['stall', 'department'], sort_order: 2, updated_at: V0 },
    ],
    groups: [
      { id: G1, year_id: Y, name: '模擬店01', display_name: null, aliases: [], category: 'stall', sort_order: 1, location_room_id: null, location_room: null },
      { id: G2, year_id: Y, name: '模擬店02', display_name: null, aliases: [], category: 'stall', sort_order: 2, location_room_id: null, location_room: null },
    ],
    // テント：G1・G2 が 2 ずつ。G1 だけ割り当て 2（G2 は未入力）
    requests: [
      { group_id: G1, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-rep', updated_at: V0 },
      { group_id: G2, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-rep2', updated_at: V0 },
      { group_id: G1, lending_item_id: WEIGHT, year_id: Y, count: 8, updated_by: 'u-rep', updated_at: V0 },
    ],
    assignments: [
      { group_id: G1, lending_item_id: TENT, year_id: Y, count: 2, updated_by: 'u-head', updated_at: V0 },
      { group_id: G1, lending_item_id: WEIGHT, year_id: Y, count: 8, updated_by: 'u-head', updated_at: V0 },
    ],
    records: [],
    confirmedAt: null,
    prevItems: [],
  };
}

let db: FakeLendingDb = seed();
let issued: FakeCall[] = [];

const LEAD = ['admin', 'head', 'deputy_head'];
const SOUMU = [...LEAD, 'staff'];

function member(role: AppRole | null, status: YearStatus): Membership {
  const year = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

/**
 * ナビ（AppLink）と年度の選択（useGuardedSetYear）の代わり。AppShell の代わりに、同じ部品と関数で未保存の入力の確かめを通す
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

/** 画面を開く（毎回新しい QueryClient。開き直しは DB から読み直す）。アプリと同じく未保存の入力の守りの中に置く */
function mount(node: React.ReactNode, role: AppRole, opts: { search?: string } = {}) {
  h.role = role;
  h.status = 'requesting';
  h.userId = `u-${role}`;
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, 'requesting') };
  const handle = lendingHandler(db, {
    userId: h.userId,
    canLead: () => LEAD.includes(h.role ?? ''),
    canRecord: () => SOUMU.includes(h.role ?? ''),
    canRequest: () => false,
    closed: () => false,
  });
  const fake = createFakeSupabase((call) => {
    if (call.table === 'years') return { data: yearRow(h.status) };
    return handle(call) ?? { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  });
  issued = fake.issued;
  h.client = fake.client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(h.status));
  return render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider>
        <OutsideProbe />
        {node}
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const user = () => userEvent.setup({ advanceTimers: () => {} });
const rpcCalls = (name: string) => issued.filter((c) => c.table === `rpc:${name}`);
const rpcArgs = (c: FakeCall) => opArgs(c, 'rpc')[0]![0] as Record<string, unknown>;
const writes = (table: string, op: string) => issued.filter((c) => c.table === table && c.ops.some((o) => o.op === op));
const cell = (g: string, i: string) => screen.getAllByTestId('lending-cell').find((c) => c.getAttribute('data-group-id') === g && c.getAttribute('data-item-id') === i)!;
const cellInput = (g: string, i: string) => within(cell(g, i)).getByTestId('lending-cell-input') as HTMLInputElement;
const setCell = (g: string, i: string, value: string) => {
  fireEvent.change(cellInput(g, i), { target: { value } });
  fireEvent.blur(cellInput(g, i));
};
const stepper = (label: string) => screen.getByRole('textbox', { name: label }) as HTMLInputElement;
/** 下書き（localStorage）の値。なければ null */
const draftValue = (k: DraftKey): unknown => {
  const raw = localStorage.getItem(draftKey(k));
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value;
};
const lastPush = () => h.push.mock.calls.at(-1)?.[0];

/** 離れるときの確かめのダイアログ（LEAVE_MESSAGES）で「やめる（入力を続ける）」を押し、閉じ終わるまで待つ */
async function stayOnLeave(kind: 'navigate' | 'year') {
  const leave = await screen.findByRole('alertdialog');
  expect(leave.textContent).toContain(LEAVE_MESSAGES[kind].description);
  await user().click(within(leave).getByRole('button', { name: 'やめる（入力を続ける）' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
}

const ASSIGN_DRAFT: DraftKey = { userId: 'u-head', yearId: Y, screen: 'lending', target: 'assignments' };
const RECORDS_DRAFT: DraftKey = { userId: 'u-staff', yearId: Y, screen: 'lending-records', target: G1 };
const itemDraft = (target: string): DraftKey => ({ userId: 'u-head', yearId: Y, screen: 'lending-item', target });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AFTER));
  db = seed();
  toast.info.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
  h.push.mockClear();
  h.replace.mockClear();
  h.setYear.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- 備品と割り当て /lending：割り当て

describe('T21 備品と割り当て（/lending）：割り当ての下書き・離れるときの確かめ・変更を取り消す（レビューの T21-R3）', () => {
  it('入力してアンマウントすると下書きが残り、開き直すと「保存していない入力があります」。「戻す」で入力が戻り、保存は入力を始めたときの版（updatedAt）で送る', async () => {
    const first = mount(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    setCell(G1, TENT, '3');
    expect(cell(G1, TENT).getAttribute('data-unsaved')).toBe('true');
    first.unmount(); // 画面を離れる（書いていない分を書き切る）
    expect(draftValue(ASSIGN_DRAFT)).toEqual([[`${G1}:${TENT}`, { count: 3, base: V0 }]]);

    // 下書きの後に、ほかの人が同じセルを 1 にした
    const V1 = nextAt();
    db.assignments[0] = { ...db.assignments[0]!, count: 1, updated_by: 'u-other', updated_at: V1 };
    mount(<LendingScreen />, 'head');
    const notice = await screen.findByTestId('draft-notice');
    // 開いたときは今の値。戻すまでは未保存の変更にしない
    expect(cellInput(G1, TENT).value).toBe('1');
    expect(screen.queryByTestId('lending-save')).toBeNull();
    await user().click(within(notice).getByRole('button', { name: '戻す' }));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(cellInput(G1, TENT).value).toBe('3');
    expect(cell(G1, TENT).getAttribute('data-unsaved')).toBe('true');

    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(rpcCalls('save_lending_assignments')).toHaveLength(1));
    // 開き直したときの版（V1）でなく、入力を始めたときの版（V0）で送る（ほかの人の変更を黙って上書きしない）
    expect(rpcArgs(rpcCalls('save_lending_assignments')[0]!).p_changes).toEqual([{ groupId: G1, itemId: TENT, count: 3, updatedAt: V0 }]);
    expect((await screen.findByTestId('lending-save-error')).textContent).toContain('模擬店01のテントの割り当てを、ほかの人が先に変えました');
    expect(db.assignments[0]!.count).toBe(1);
    expect(cellInput(G1, TENT).value).toBe('3');

    // 確かめた後の保存は読み直した版（V1）で送って上書きし、保存できると下書きを消す
    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(rpcCalls('save_lending_assignments')).toHaveLength(2));
    expect(rpcArgs(rpcCalls('save_lending_assignments')[1]!).p_changes).toEqual([{ groupId: G1, itemId: TENT, count: 3, updatedAt: V1 }]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('割り当てを保存しました（1件）'));
    expect(db.assignments[0]!.count).toBe(3);
    expect(draftValue(ASSIGN_DRAFT)).toBeNull();
  });

  it('「捨てる」で下書きを消し、保存してある数のまま（未保存の変更にしない）', async () => {
    saveDraft(ASSIGN_DRAFT, [[`${G2}:${TENT}`, { count: 1, base: null }]]);
    mount(<LendingScreen />, 'head');
    const notice = await screen.findByTestId('draft-notice');
    await user().click(within(notice).getByRole('button', { name: '捨てる' }));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(draftValue(ASSIGN_DRAFT)).toBeNull();
    expect(cellInput(G2, TENT).value).toBe('');
    expect(cell(G2, TENT).getAttribute('data-unsaved')).toBeNull();
    expect(screen.queryByTestId('lending-save')).toBeNull();
  });

  it('形の違う下書き（壊れた・古い形）は戻さない（DraftNotice を出さない）', async () => {
    const bad: unknown[] = [
      [['キーに区切りがない', { count: 1, base: null }]],
      [[`${G2}:${TENT}`, { count: -1, base: null }]],
      [[`${G2}:${TENT}`, { count: 1.5, base: null }]],
      [[`${G2}:${TENT}`, { count: 1, base: 5 }]],
      { not: 'array' },
    ];
    for (const value of bad) {
      saveDraft(ASSIGN_DRAFT, value);
      const r = mount(<LendingScreen />, 'head');
      await screen.findByTestId('lending-assignments');
      expect(screen.queryByTestId('draft-notice')).toBeNull();
      expect(screen.queryByTestId('lending-save')).toBeNull();
      r.unmount();
    }
  });

  it('保存できると下書きを消す（入力のたびに書いた下書きが残らない）', async () => {
    mount(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    setCell(G2, TENT, '1');
    await waitFor(() => expect(draftValue(ASSIGN_DRAFT)).toEqual([[`${G2}:${TENT}`, { count: 1, base: null }]]), { timeout: 2000 });
    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('割り当てを保存しました（1件）'));
    expect(draftValue(ASSIGN_DRAFT)).toBeNull();
  });

  it('保存していない変更がある間は、アプリの中の移動と年度の切り替えの前に確かめる。変更がない・保存した後は確かめない', async () => {
    mount(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    h.push.mockClear();

    setCell(G2, TENT, '1');
    fireEvent.click(screen.getByTestId('probe-nav'));
    await stayOnLeave('navigate');
    expect(h.push).not.toHaveBeenCalled();
    expect(cellInput(G2, TENT).value).toBe('1');
    fireEvent.click(screen.getByTestId('probe-year'));
    await stayOnLeave('year');
    expect(h.setYear).not.toHaveBeenCalled();
    expect(cell(G2, TENT).getAttribute('data-unsaved')).toBe('true');
    // 「移る」なら移る（入力は下書きに残る）
    fireEvent.click(screen.getByTestId('probe-nav'));
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm }));
    await waitFor(() => expect(lastPush()).toBe('/notices'));
    h.push.mockClear();

    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(screen.queryByTestId('lending-save')).toBeNull());
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('「変更を取り消す」は確かめてから、保存してある数に戻す（下書きも消し、送らない）。「やめる」なら変更は残る', async () => {
    mount(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    setCell(G1, TENT, '3');
    setCell(G2, TENT, '1');
    expect(screen.getByTestId('lending-save').textContent).toBe('保存（2件）');
    await waitFor(() => expect(draftValue(ASSIGN_DRAFT)).not.toBeNull(), { timeout: 2000 });

    await user().click(screen.getByRole('button', { name: '変更を取り消す' }));
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('保存していない変更を取り消しますか');
    expect(ask.textContent).toContain('割り当ての表に入れた数を、保存してある数に戻します。');
    await user().click(within(ask).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cellInput(G1, TENT).value).toBe('3');
    expect(screen.getByTestId('lending-save').textContent).toBe('保存（2件）');

    await user().click(screen.getByRole('button', { name: '変更を取り消す' }));
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(screen.queryByTestId('lending-save')).toBeNull());
    expect(cellInput(G1, TENT).value).toBe('2');
    expect(cellInput(G2, TENT).value).toBe('');
    expect(cell(G1, TENT).getAttribute('data-unsaved')).toBeNull();
    expect(cell(G2, TENT).getAttribute('data-state')).toBe('unassigned');
    expect(draftValue(ASSIGN_DRAFT)).toBeNull();
    expect(rpcCalls('save_lending_assignments')).toHaveLength(0);
    // 取り消した後は確かめずに移る
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// ---------------------------------------------------------------- 備品と割り当て /lending：備品のダイアログ

describe('T21 備品の登録・編集のダイアログ：下書き・離れるときの確かめ（レビューの T21-R3）', () => {
  const nameInput = () => within(screen.getByTestId('lending-item-dialog')).getByTestId('lending-item-name') as HTMLInputElement;
  const stockInput = () => within(screen.getByTestId('lending-item-dialog')).getByTestId('lending-item-stock') as HTMLInputElement;
  const openEdit = async (id: string) => {
    await screen.findByTestId('lending-items');
    const row = screen.getAllByTestId('lending-item-row').find((r) => r.getAttribute('data-id') === id)!;
    await user().click(within(row).getByTestId('lending-item-edit'));
    return screen.findByTestId('lending-item-dialog');
  };

  it('登録：入力して画面を離れると下書きが残り、開き直して「戻す」で入力と登録の id が戻る。登録できると下書きを消す', async () => {
    const first = mount(<LendingScreen />, 'head');
    await user().click(await screen.findByTestId('lending-item-add'));
    await screen.findByTestId('lending-item-dialog');
    await user().type(nameInput(), '三方幕');
    first.unmount();
    const saved = draftValue(itemDraft('new')) as { values: { name: string }; id: string; baseUpdatedAt: string | null };
    expect(saved.values.name).toBe('三方幕');
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.baseUpdatedAt).toBeNull();

    mount(<LendingScreen />, 'head');
    await user().click(await screen.findByTestId('lending-item-add'));
    const dialog = await screen.findByTestId('lending-item-dialog');
    expect(nameInput().value).toBe('');
    await user().click(within(dialog).getByRole('button', { name: '戻す' }));
    expect(within(dialog).queryByTestId('draft-notice')).toBeNull();
    expect(nameInput().value).toBe('三方幕');
    await user().click(within(dialog).getByTestId('lending-item-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「三方幕」を登録しました'));
    // 下書きの id（ダイアログを開いたときに作った id）で入れる（送り直しは 23505 で止まる）
    const [row] = opArgs(writes('lending_items', 'insert')[0]!, 'insert')[0]![0] as { id: string; name: string }[];
    expect(row).toMatchObject({ id: saved.id, name: '三方幕' });
    expect(draftValue(itemDraft('new'))).toBeNull();
  });

  it('編集：戻した下書きは下書きの版（読んだときの updated_at）で送る。間にほかの人が変えていれば衝突の知らせで入力を残し、次の保存は読み直した版で上書きする', async () => {
    // 下書き（読んだときの版 V0）を書いた後に、ほかの人がテントの在庫を 5 にした（一覧とダイアログは新しい版 V1 で開く）
    const V1 = nextAt();
    db.items[0] = { ...db.items[0]!, stock: 5, updated_at: V1 };
    saveDraft(itemDraft(TENT), {
      values: { name: 'テント', unit: '張', stock: '4', categories: ['stall', 'department'], sortOrder: '1' },
      id: TENT,
      baseUpdatedAt: V0,
    });
    mount(<LendingScreen />, 'head');
    const dialog = await openEdit(TENT);
    expect(stockInput().value).toBe('5');
    await user().click(within(dialog).getByRole('button', { name: '戻す' }));
    expect(stockInput().value).toBe('4');
    await user().click(within(dialog).getByTestId('lending-item-submit'));
    expect((await within(dialog).findByTestId('lending-item-conflict')).textContent).toContain(ITEM_CONFLICT_NOTICE);
    // 開いたときの版（V1）でなく、下書きの版（V0）を条件に入れて送った（黙ってほかの人の変更を上書きしない）
    expect(opArgs(writes('lending_items', 'update')[0]!, 'eq')).toContainEqual(['updated_at', V0]);
    expect(db.items[0]!.stock).toBe(5);
    expect(stockInput().value).toBe('4');
    await user().click(within(dialog).getByTestId('lending-item-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「テント」を保存しました'));
    expect(opArgs(writes('lending_items', 'update')[1]!, 'eq')).toContainEqual(['updated_at', V1]);
    expect(db.items[0]!.stock).toBe(4);
    expect(draftValue(itemDraft(TENT))).toBeNull();
  });

  it('「捨てる」で下書きを消し、空の入力のまま', async () => {
    saveDraft(itemDraft('new'), {
      values: { name: '下書きの備品', unit: '個', stock: '1', categories: ['stall'], sortOrder: '3' },
      id: uuid(555),
      baseUpdatedAt: null,
    });
    mount(<LendingScreen />, 'head');
    await user().click(await screen.findByTestId('lending-item-add'));
    const dialog = await screen.findByTestId('lending-item-dialog');
    await user().click(within(dialog).getByRole('button', { name: '捨てる' }));
    expect(within(dialog).queryByTestId('draft-notice')).toBeNull();
    expect(draftValue(itemDraft('new'))).toBeNull();
    expect(nameInput().value).toBe('');
  });

  it('形の違う下書きは戻さない（DraftNotice を出さない）', async () => {
    const values = { name: '下書きの備品', unit: '個', stock: '1', categories: ['stall'], sortOrder: '3' };
    const bad: unknown[] = [
      { values: { ...values, name: 1 }, id: uuid(555), baseUpdatedAt: null },
      { values: { ...values, categories: 'stall' }, id: uuid(555), baseUpdatedAt: null },
      { values, id: 555, baseUpdatedAt: null },
      { values, id: uuid(555), baseUpdatedAt: 5 },
      null,
    ];
    for (const value of bad) {
      saveDraft(itemDraft('new'), value);
      const r = mount(<LendingScreen />, 'head');
      await user().click(await screen.findByTestId('lending-item-add'));
      const dialog = await screen.findByTestId('lending-item-dialog');
      expect(within(dialog).queryByTestId('draft-notice')).toBeNull();
      expect(nameInput().value).toBe('');
      r.unmount();
    }
  });

  it('入力がある間は、ダイアログの外のアプリの中の移動と年度の切り替えの前に確かめる。やめれば入力が残る', async () => {
    mount(<LendingScreen />, 'head');
    await user().click(await screen.findByTestId('lending-item-add'));
    await screen.findByTestId('lending-item-dialog');
    // モーダルのダイアログの外はポインタで押せないので、要素に直接 click を送る
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    h.push.mockClear();
    await user().type(nameInput(), '途中');
    fireEvent.click(screen.getByTestId('probe-nav'));
    await stayOnLeave('navigate');
    expect(h.push).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('途中');
    fireEvent.click(screen.getByTestId('probe-year'));
    await stayOnLeave('year');
    expect(h.setYear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('probe-year'));
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.year.confirm }));
    await waitFor(() => expect(h.setYear).toHaveBeenCalledWith(Y_PREV));
  });
});

// ---------------------------------------------------------------- 受け渡し・返却 /lending/records：団体の欄

describe('T21 受け渡し・返却（/lending/records）：団体の欄の下書き・離れるときの確かめ（レビューの T21-R3）', () => {
  const lent = (name: string) => stepper(`${name}の渡した数`);
  const returned = (name: string) => stepper(`${name}の返った数`);
  const upserts = () => writes('lending_records', 'upsert');

  it('入力してアンマウントすると下書き（入力と入力の元の版）が残り、開き直して「戻す」で両方が戻る。その後にほかの人が保存していれば、送らずに衝突のダイアログ', async () => {
    db.records.push({ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 1, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 });
    const first = mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    await user().click(within(panel).getByTestId('records-lend-all'));
    expect(lent('テント').value).toBe('2');
    first.unmount();
    expect(draftValue(RECORDS_DRAFT)).toEqual({
      values: { [TENT]: { lent: 2, returned: 0, damaged: 0, note: '' }, [WEIGHT]: { lent: 8, returned: 0, damaged: 0, note: '' } },
      base: { [TENT]: V0, [WEIGHT]: null },
    });

    // 下書きの後に、ほかの人がこの団体の記録を保存した（テントは 2 渡して 1 返った）
    db.records[0] = { ...db.records[0]!, lent_count: 2, returned_count: 1, updated_by: 'u-other', updated_at: nextAt() };
    mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const notice = await screen.findByTestId('draft-notice');
    // 開いたときは今の値
    expect(returned('テント').value).toBe('1');
    expect(lent('重し').value).toBe('0');
    await user().click(within(notice).getByRole('button', { name: '戻す' }));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(lent('テント').value).toBe('2');
    expect(returned('テント').value).toBe('0');
    expect(lent('重し').value).toBe('8');
    await user().click(screen.getByTestId('records-save'));
    // 戻した入力の元の版（V0）の後に、ほかの人が保存した：上書きしてよいか確かめる（黙って返った数を 0 に戻さない）
    const dialog = await screen.findByTestId('records-conflict');
    expect(dialog.textContent).toContain(RECORDS_CONFLICT_TITLE);
    expect(within(dialog).getAllByTestId('records-conflict-row')[0]!.textContent).toBe('テント渡2・返1・破0渡2・返0・破0');
    expect(upserts()).toHaveLength(0);
  });

  it('「捨てる」で下書きを消し、保存してある数のまま', async () => {
    saveDraft(RECORDS_DRAFT, {
      values: { [TENT]: { lent: 2, returned: 0, damaged: 0, note: '' }, [WEIGHT]: { lent: 8, returned: 0, damaged: 0, note: '' } },
      base: { [TENT]: null, [WEIGHT]: null },
    });
    mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const notice = await screen.findByTestId('draft-notice');
    await user().click(within(notice).getByRole('button', { name: '捨てる' }));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(draftValue(RECORDS_DRAFT)).toBeNull();
    expect(lent('テント').value).toBe('0');
    expect(lent('重し').value).toBe('0');
  });

  it('形の違う下書き・今の値と同じ下書きは戻さない（DraftNotice を出さない）', async () => {
    const ok = { lent: 2, returned: 0, damaged: 0, note: '' };
    const zero = { lent: 0, returned: 0, damaged: 0, note: '' };
    const bad: unknown[] = [
      { values: { [TENT]: { ...ok, lent: 'x' }, [WEIGHT]: zero }, base: {} },
      { values: { [TENT]: { ...ok, lent: 1.5 }, [WEIGHT]: zero }, base: {} },
      { values: { [TENT]: ok }, base: {} }, // 備品が足りない
      { values: { [TENT]: { ...ok, note: null }, [WEIGHT]: zero }, base: {} },
      { values: { [TENT]: ok, [WEIGHT]: zero }, base: { [TENT]: 5 } },
      { values: { [TENT]: zero, [WEIGHT]: zero }, base: {} }, // 今の値（記録なし）と同じ
      'garbage',
    ];
    for (const value of bad) {
      saveDraft(RECORDS_DRAFT, value);
      const r = mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
      await screen.findByTestId('records-panel');
      expect(screen.queryByTestId('draft-notice')).toBeNull();
      expect(lent('テント').value).toBe('0');
      r.unmount();
    }
  });

  it('保存できると下書きを消す', async () => {
    mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    await user().click(within(panel).getByTestId('records-lend-all'));
    await waitFor(() => expect(draftValue(RECORDS_DRAFT)).not.toBeNull(), { timeout: 2000 });
    await user().click(screen.getByTestId('records-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存しました'));
    expect(upserts()).toHaveLength(1);
    expect(draftValue(RECORDS_DRAFT)).toBeNull();
  });

  it('保存していない入力がある間は、移る前（「一覧へ」・アプリの中の移動・年度の切り替え）に確かめる。入力がなければ確かめない', async () => {
    mount(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    fireEvent.click(screen.getByTestId('probe-nav'));
    expect(lastPush()).toBe('/notices');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    h.push.mockClear();

    await user().click(within(panel).getByRole('button', { name: 'テントの渡した数を1増やす' }));
    await user().click(within(panel).getByRole('button', { name: '一覧へ' }));
    await stayOnLeave('navigate');
    fireEvent.click(screen.getByTestId('probe-nav'));
    await stayOnLeave('navigate');
    fireEvent.click(screen.getByTestId('probe-year'));
    await stayOnLeave('year');
    expect(h.push).not.toHaveBeenCalled();
    expect(h.setYear).not.toHaveBeenCalled();
    expect(lent('テント').value).toBe('1');
    // 「移る」なら一覧へ移る（入力は下書きに残る）
    await user().click(within(panel).getByRole('button', { name: '一覧へ' }));
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm }));
    await waitFor(() => expect(lastPush()).toBe('/lending/records'));
  });
});
