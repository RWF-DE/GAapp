// @vitest-environment jsdom
// テント等の貸し出しの画面（T21・D-57。04「テント等の貸し出し」、notes/T21.md「画面の約束」4・5・9）：
// - 備品と割り当て（/lending）：段ごとの出し分け（部門長以上・総務部門員・閲覧のみの確定前と確定後・終了の年度）、備品の表の印、
//   割り当ての編集と保存（送る形・conflict の読み直しと入力を残す・応答なしで保存されていた）、申請どおりに入れる、確定の押せない理由と
//   確定・解除（理由）、備品の登録（画面の id・trim）と削除の 23503。
// - 受け渡し・返却（/lending/records）：一覧（既定の団体・状態のチップ・探す）、団体の欄（割り当てどおり渡した・全部返った・確かめ）、
//   保存の (A)（送る・保存されていた・ほかの人の保存のダイアログ・割り当てより多く渡す確かめ）、終了と確定前の帯。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）と偽の DB（./fake-lending-db.ts）。立場は useAuth の差し替え。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { lendingHandler, NETWORK, nextAt, type FakeLendingDb } from '@/lib/testing/fake-lending-db';
import { LENDING_TEXTS, LendingScreen } from './lending-screen';
import { LendingRecordsScreen, RECORDS_BEFORE_CONFIRM } from './records-screen';

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
  reloadMembership: vi.fn(),
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: h.reloadMembership,
    setYear: vi.fn(),
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
const TENT = uuid(101);
const WEIGHT = uuid(102);
const G1 = uuid(11);
const G2 = uuid(12);
const CO = uuid(13);
const V0 = '2026-10-01T00:00:00.123456+00:00';
/** 受付の締切 10/5 17:00（Asia/Tokyo）。1日目 10/17 */
const CLOSE = '2026-10-05T08:00:00Z';
const BEFORE = '2026-10-01T00:00:00Z';
const AFTER = '2026-10-06T00:00:00Z';

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
    ],
    groups: [
      { id: G1, year_id: Y, name: '模擬店01', display_name: null, aliases: ['もぎ1'], category: 'stall', sort_order: 1, location_room_id: 'r1', location_room: { name: '中庭', kind: 'outdoor' } },
      { id: G2, year_id: Y, name: '模擬店02', display_name: '二号店', aliases: [], category: 'stall', sort_order: 2, location_room_id: null, location_room: null },
      { id: CO, year_id: Y, name: '企業A', display_name: null, aliases: [], category: 'company', sort_order: 1, location_room_id: null, location_room: null },
    ],
    // テント：G1・G2 が 2 ずつ（申請 4 > 在庫 3）。G1 だけ割り当て 2（G2 は未入力）
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
let override: ((call: FakeCall) => FakeResult | undefined) | null = null;

const LEAD = ['admin', 'head', 'deputy_head'];
const SOUMU = [...LEAD, 'staff'];

function member(role: AppRole | null, status: YearStatus): Membership {
  const year = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: 'テスト', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

function renderWith(node: React.ReactNode, role: AppRole | null, opts: { status?: YearStatus; search?: string; now?: string } = {}) {
  const status = opts.status ?? 'requesting';
  h.role = role;
  h.status = status;
  h.userId = `u-${role ?? 'rep'}`;
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, status) };
  vi.setSystemTime(new Date(opts.now ?? AFTER));
  const handle = lendingHandler(db, {
    userId: h.userId,
    canLead: () => LEAD.includes(h.role ?? '') && h.status !== 'closed',
    canRecord: () => SOUMU.includes(h.role ?? '') && h.status !== 'closed',
    canRequest: () => false,
    closed: () => h.status === 'closed',
  });
  const fake = createFakeSupabase((call) => {
    const o = override?.(call);
    if (o) return o;
    if (call.table === 'years') return { data: yearRow(h.status) };
    return handle(call) ?? { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
  });
  issued = fake.issued;
  h.client = fake.client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status));
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider>{node}</UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const rpcCalls = (name: string) => issued.filter((c) => c.table === `rpc:${name}`);
const rpcArgs = (c: FakeCall) => opArgs(c, 'rpc')[0]![0] as Record<string, unknown>;
const cell = (g: string, i: string) => screen.getAllByTestId('lending-cell').find((c) => c.getAttribute('data-group-id') === g && c.getAttribute('data-item-id') === i)!;
const user = () => userEvent.setup({ advanceTimers: () => {} });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db = seed();
  override = null;
  toast.info.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
  h.push.mockClear();
  h.replace.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- /lending

describe('T21 備品と割り当て（/lending）', () => {
  it('部門長以上：備品の表の印（申請が在庫を超える）、割り当ての表（既定は申請・割り当て・記録のある団体）、未入力のセル、確定の押せない理由', async () => {
    renderWith(<LendingScreen />, 'head');
    await screen.findByTestId('lending-items');
    const tent = screen.getAllByTestId('lending-item-row').find((r) => r.getAttribute('data-id') === TENT)!;
    expect(tent.getAttribute('data-over')).toBe('requested');
    expect(within(tent).getByText('申請が在庫を超えています')).toBeTruthy();
    expect(screen.getByTestId('lending-status').getAttribute('data-confirmed')).toBe('false');
    expect(screen.getByTestId('lending-status').textContent).toContain('割り当て：確定前');
    expect(screen.getByTestId('lending-status').textContent).toContain('受付の締切 10/5 17:00');
    // 企業（申請・割り当て・記録がない）は既定では出さない
    expect(screen.getAllByTestId('lending-assignment-row').map((r) => r.getAttribute('data-group-id'))).toEqual([G1, G2]);
    expect(cell(G2, TENT).getAttribute('data-state')).toBe('unassigned');
    expect(cell(G1, TENT).getAttribute('data-state')).toBe('same');
    // 屋外の印と使用場所
    expect(within(screen.getAllByTestId('lending-assignment-row')[0]!).getByText('屋外')).toBeTruthy();
    expect(within(screen.getAllByTestId('lending-assignment-row')[1]!).getByText('校内に分散')).toBeTruthy();
    expect((screen.getByTestId('lending-confirm') as HTMLButtonElement).disabled).toBe(true);
    const blockers = within(screen.getByTestId('lending-confirm-blockers')).getAllByRole('listitem');
    expect(blockers.map((li) => li.getAttribute('data-kind'))).toEqual(['unassigned']);
    expect(blockers[0]!.textContent).toBe('申請があるのに割り当てていない組があります：テント 1 団体');
    expect(screen.getByTestId('lending-csv')).toBeTruthy();
    expect(screen.getByTestId('lending-item-add')).toBeTruthy();
  });

  it('締切の前は「受付の締切の後に確定できます（締切 10/5 17:00）」も出す', async () => {
    renderWith(<LendingScreen />, 'head', { now: BEFORE });
    await screen.findByTestId('lending-confirm-blockers');
    const kinds = within(screen.getByTestId('lending-confirm-blockers'))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-kind'));
    expect(kinds).toEqual(['before_deadline', 'unassigned']);
    expect(screen.getByText('受付の締切の後に確定できます（締切 10/5 17:00）')).toBeTruthy();
  });

  it('セルを直すと未保存の変更になり、「保存（N件）」で save_lending_assignments を1回（行の版つき。未入力のセルは null）', async () => {
    renderWith(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    const inputOf = (g: string, i: string) => within(cell(g, i)).getByTestId('lending-cell-input') as HTMLInputElement;
    fireEvent.change(inputOf(G2, TENT), { target: { value: '1' } });
    fireEvent.blur(inputOf(G2, TENT));
    fireEvent.change(inputOf(G1, TENT), { target: { value: '' } });
    fireEvent.blur(inputOf(G1, TENT));
    expect(cell(G2, TENT).getAttribute('data-unsaved')).toBe('true');
    expect(cell(G1, TENT).getAttribute('data-state')).toBe('unassigned');
    // 未保存の変更がある間は確定できない
    expect(within(screen.getByTestId('lending-confirm-blockers')).getAllByRole('listitem').map((li) => li.getAttribute('data-kind'))).toContain('unsaved');
    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(rpcCalls('save_lending_assignments')).toHaveLength(1));
    expect(rpcArgs(rpcCalls('save_lending_assignments')[0]!)).toEqual({
      p_year_id: Y,
      p_changes: [
        { groupId: G1, itemId: TENT, count: null, updatedAt: V0 },
        { groupId: G2, itemId: TENT, count: 1, updatedAt: null },
      ],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('割り当てを保存しました（2件）'));
    await waitFor(() => expect(screen.queryByTestId('lending-save')).toBeNull());
    expect(db.assignments.find((a) => a.group_id === G2 && a.lending_item_id === TENT)?.count).toBe(1);
  });

  it('「申請どおりに入れる」：割り当てのないセルに申請の数を未保存の変更として入れる（割り当てのあるセルは変えない）', async () => {
    renderWith(<LendingScreen />, 'admin');
    await screen.findByTestId('lending-assignments');
    const fill = screen.getAllByTestId('lending-fill-requested').find((b) => b.getAttribute('data-item-id') === TENT)!;
    await user().click(fill);
    expect(cell(G2, TENT).getAttribute('data-unsaved')).toBe('true');
    expect((within(cell(G2, TENT)).getByTestId('lending-cell-input') as HTMLInputElement).value).toBe('2');
    expect(cell(G1, TENT).getAttribute('data-unsaved')).toBeNull();
    expect(screen.getByTestId('lending-save').textContent).toBe('保存（1件）');
  });

  it('conflict：送った組を読み直し、ほかの人の変更を出して入力を残す。もう一度の保存は読み直した版で送る', async () => {
    renderWith(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    // 入力を始めた後に、ほかの人が G1 のテントを 1 にした
    const at = nextAt();
    db.assignments[0] = { ...db.assignments[0]!, count: 1, updated_at: at, updated_by: 'u-other' };
    const input = within(cell(G1, TENT)).getByTestId('lending-cell-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    await user().click(screen.getByTestId('lending-save'));
    await screen.findByTestId('lending-save-error');
    expect(screen.getByTestId('lending-save-error').textContent).toContain('模擬店01のテントの割り当てを、ほかの人が先に変えました。読み直しました');
    expect(input.value).toBe('3');
    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(rpcCalls('save_lending_assignments')).toHaveLength(2));
    expect(rpcArgs(rpcCalls('save_lending_assignments')[1]!).p_changes).toEqual([{ groupId: G1, itemId: TENT, count: 3, updatedAt: at }]);
    await waitFor(() => expect(db.assignments[0]!.count).toBe(3));
  });

  it('応答が届かなかった：送った組を読み直し、入力と同じなら「保存されていました」', async () => {
    renderWith(<LendingScreen />, 'head');
    await screen.findByTestId('lending-assignments');
    override = (call) => {
      if (call.table !== 'rpc:save_lending_assignments') return undefined;
      // DB には届いて書けたが、応答が届かなかった
      db.assignments.push({ group_id: G2, lending_item_id: TENT, year_id: Y, count: 1, updated_by: 'u-head', updated_at: nextAt() });
      return NETWORK;
    };
    const input = within(cell(G2, TENT)).getByTestId('lending-cell-input');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    await user().click(screen.getByTestId('lending-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存されていました'));
    expect(screen.queryByTestId('lending-save')).toBeNull();
  });

  it('確定：押せるときはダイアログ（割り当て合計／在庫）→ set_lending_confirmed。確定中は表を読むだけで「確定を解除」（理由が要る）', async () => {
    db.assignments.push({ group_id: G2, lending_item_id: TENT, year_id: Y, count: 1, updated_by: 'u-head', updated_at: V0 });
    renderWith(<LendingScreen />, 'head');
    const confirmBtn = await screen.findByTestId('lending-confirm');
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    await user().click(confirmBtn);
    const dialog = await screen.findByTestId('lending-confirm-dialog');
    expect(dialog.textContent).toContain('3／3');
    await user().click(screen.getByRole('button', { name: '確定する' }));
    await waitFor(() => expect(rpcArgs(rpcCalls('set_lending_confirmed')[0]!)).toEqual({ p_year_id: Y, p_confirmed: true }));
    await waitFor(() => expect(screen.getByTestId('lending-status').getAttribute('data-confirmed')).toBe('true'));
    expect(screen.getByTestId('lending-confirmed-note').textContent).toContain(LENDING_TEXTS.confirmed);
    expect(screen.queryAllByTestId('lending-cell-input')).toHaveLength(0);
    // 解除は理由が要る
    await user().click(screen.getByTestId('lending-unconfirm'));
    await user().click(await screen.findByRole('button', { name: '確定を解除する' }));
    expect(await screen.findByText('理由を入れてください')).toBeTruthy();
    expect(rpcCalls('set_lending_confirmed')).toHaveLength(1);
    await user().type(screen.getByLabelText('理由（必須）'), '数え直し');
    await user().click(screen.getByRole('button', { name: '確定を解除する' }));
    await waitFor(() => expect(rpcArgs(rpcCalls('set_lending_confirmed')[1]!)).toEqual({ p_year_id: Y, p_confirmed: false, p_reason: '数え直し' }));
  });

  it('総務部門員：読むだけ（帯・登録と確定のボタンなし・セルは数の欄でない）。CSV は出せる', async () => {
    renderWith(<LendingScreen />, 'staff');
    await screen.findByTestId('lending-assignments');
    expect(screen.getByTestId('lending-staff-note').textContent).toBe(LENDING_TEXTS.staff);
    expect(screen.queryByTestId('lending-item-add')).toBeNull();
    expect(screen.queryByTestId('lending-item-edit')).toBeNull();
    expect(screen.queryByTestId('lending-confirm')).toBeNull();
    expect(screen.queryAllByTestId('lending-cell-input')).toHaveLength(0);
    expect(screen.queryAllByTestId('lending-fill-requested')).toHaveLength(0);
    expect(screen.getByTestId('lending-csv')).toBeTruthy();
  });

  it('閲覧のみ：確定前は「割り当ては確定後に表示されます」だけ（表なし。申請・記録は読まない）。確定後は備品と割り当てだけ（申請の列なし）', async () => {
    renderWith(<LendingScreen />, 'viewer');
    expect((await screen.findByTestId('lending-before-confirm')).textContent).toBe(LENDING_TEXTS.viewerBefore);
    expect(screen.queryByTestId('lending-items')).toBeNull();
    expect(screen.queryByTestId('lending-csv')).toBeNull();
    expect(issued.some((c) => c.table === 'lending_requests' || c.table === 'lending_records')).toBe(false);
    cleanup();
    db.confirmedAt = '2026-10-12T08:00:00Z';
    renderWith(<LendingScreen />, 'viewer');
    await screen.findByTestId('lending-assignments');
    expect(screen.getByTestId('lending-status').textContent).toContain('割り当て：確定（10/12 17:00）');
    expect(within(screen.getByTestId('lending-items')).queryByText('申請合計')).toBeNull();
    expect(within(screen.getByTestId('lending-assignments')).queryByText('申請')).toBeNull();
    expect(screen.queryByTestId('lending-unconfirm')).toBeNull();
  });

  it('終了した年度：総務に帯「終了した年度のため、テント等の貸し出しは読むだけです」。書くためのボタンと欄を出さない', async () => {
    renderWith(<LendingScreen />, 'admin', { status: 'closed' });
    expect((await screen.findByTestId('lending-readonly')).textContent).toBe('終了した年度のため、テント等の貸し出しは読むだけです');
    await screen.findByTestId('lending-assignments');
    expect(screen.queryByTestId('lending-item-add')).toBeNull();
    expect(screen.queryByTestId('lending-confirm')).toBeNull();
    expect(screen.queryAllByTestId('lending-cell-input')).toHaveLength(0);
  });

  it('「すべての団体」で申請のない企業にも入れられる（URL の ?view=all）', async () => {
    renderWith(<LendingScreen />, 'head', { search: 'view=all' });
    await screen.findByTestId('lending-assignments');
    expect(screen.getAllByTestId('lending-assignment-row').map((r) => r.getAttribute('data-group-id'))).toEqual([G1, G2, CO]);
    expect(cell(CO, TENT).getAttribute('data-state')).toBe('empty');
    await user().click(screen.getByTestId('lending-view-all'));
    expect(h.replace).toHaveBeenCalledWith('/lending');
  });

  it('備品の登録：画面が作った id で insert（名前・単位は trim）。削除の 23503 は「申請・割り当て・記録のある備品は削除できません」', async () => {
    renderWith(<LendingScreen />, 'head');
    await user().click(await screen.findByTestId('lending-item-add'));
    const dialog = await screen.findByTestId('lending-item-dialog');
    await user().type(within(dialog).getByTestId('lending-item-name'), ' 三方幕 ');
    await user().clear(within(dialog).getByTestId('lending-item-unit'));
    await user().type(within(dialog).getByTestId('lending-item-unit'), '枚');
    await user().clear(within(dialog).getByTestId('lending-item-stock'));
    await user().type(within(dialog).getByTestId('lending-item-stock'), '2');
    await user().click(within(dialog).getByTestId('lending-item-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「三方幕」を登録しました'));
    const insert = issued.find((c) => c.table === 'lending_items' && c.ops.some((o) => o.op === 'insert'))!;
    const [row] = opArgs(insert, 'insert')[0]![0] as Record<string, unknown>[];
    expect(row).toMatchObject({ year_id: Y, name: '三方幕', unit: '枚', stock: 2, requestable_categories: ['stall', 'department'], sort_order: 3 });
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    // 削除：テントは申請・割り当てがあるので 23503
    const tent = screen.getAllByTestId('lending-item-row').find((r) => r.getAttribute('data-id') === TENT)!;
    await user().click(within(tent).getByTestId('lending-item-delete'));
    await user().click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('申請・割り当て・記録のある備品は削除できません'));
  });
});

// ---------------------------------------------------------------- /lending/records

describe('T21 受け渡し・返却（/lending/records）', () => {
  const DAY2 = '2026-10-17T15:00:00Z';

  it('一覧：割り当てか記録のある団体（団体の並び）・要約・状態、チップの件数、探すと全部の団体から', async () => {
    db.records.push({ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 2, returned_count: 1, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: V0 });
    renderWith(<LendingRecordsScreen />, 'staff', { now: DAY2 });
    const list = await screen.findByTestId('records-list');
    const groups = within(list).getAllByTestId('records-group');
    expect(groups.map((g) => [g.getAttribute('data-group-id'), g.getAttribute('data-state')])).toEqual([[G1, 'unreturned']]);
    expect(groups[0]!.textContent).toContain('テント 2・重し 8');
    expect(screen.getByTestId('records-before-confirm').textContent).toBe(RECORDS_BEFORE_CONFIRM);
    const filter = screen.getByTestId('records-filter');
    expect(within(filter).getByText('未返却（1）')).toBeTruthy();
    expect(within(filter).getByText('すべて（1）')).toBeTruthy();
    // 探す（表示名・別名も）：割り当てのない団体も出る
    await user().type(screen.getByTestId('records-search'), '二号');
    expect(within(screen.getByTestId('records-list')).getAllByTestId('records-group').map((g) => g.getAttribute('data-group-id'))).toEqual([G2]);
    expect(within(screen.getByTestId('records-list')).getByText('割り当てなし')).toBeTruthy();
    await user().click(within(screen.getByTestId('records-list')).getAllByTestId('records-group')[0]!.querySelector('button')!);
    expect(h.push.mock.calls[0]?.[0]).toBe(`/lending/records?group=${G2}`);
  });

  it('団体の欄：割り当てどおり渡した → 保存（送る前に読み直し、欄の全部の備品の upsert）', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    expect(within(panel).getAllByTestId('records-item').map((x) => x.getAttribute('data-item-id'))).toEqual([TENT, WEIGHT]);
    await user().click(within(panel).getByTestId('records-lend-all'));
    await user().click(screen.getByTestId('records-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存しました'));
    const upsert = issued.find((c) => c.table === 'lending_records' && c.ops.some((o) => o.op === 'upsert'))!;
    expect(opArgs(upsert, 'upsert')[0]).toEqual([
      [
        { group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 2, returned_count: 0, damaged_count: 0, note: null },
        { group_id: G1, lending_item_id: WEIGHT, year_id: Y, lent_count: 8, returned_count: 0, damaged_count: 0, note: null },
      ],
      { onConflict: 'group_id,lending_item_id' },
    ]);
    // 送る前に、その団体の記録を読み直した
    const reads = issued.filter((c) => c.table === 'lending_records' && !c.ops.some((o) => o.op === 'upsert'));
    expect(reads.some((c) => opArgs(c, 'eq').some(([k, v]) => k === 'group_id' && v === G1))).toBe(true);
  });

  it('入力の確かめ：返った数は渡した数以下、破損の数は返った数以下（欄の下の文言。送らない）', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    const tent = within(panel).getAllByTestId('records-item')[0]!;
    await user().click(within(within(tent).getByTestId('records-returned')).getByRole('button', { name: 'テントの返った数を1増やす' }));
    await user().click(screen.getByTestId('records-save'));
    expect(await within(tent).findByText('返った数は渡した数以下にしてください')).toBeTruthy();
    expect(issued.some((c) => c.ops.some((o) => o.op === 'upsert'))).toBe(false);
  });

  it('割り当てより多く渡すときは確かめてから記録する', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    await user().click(within(panel).getByTestId('records-lend-all'));
    const tent = within(panel).getAllByTestId('records-item')[0]!;
    await user().click(within(within(tent).getByTestId('records-lent')).getByRole('button', { name: 'テントの渡した数を1増やす' }));
    await user().click(screen.getByTestId('records-save'));
    expect((await screen.findByTestId('records-over-assigned')).textContent).toBe('割り当てより多く渡します：テント（割り当て 2・渡した 3）。記録してよいですか');
    await user().click(screen.getByRole('button', { name: '記録する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存しました'));
    expect(db.records.find((r) => r.lending_item_id === TENT)?.lent_count).toBe(3);
  });

  it('入力を始めた後にほかの人が保存していれば、相手と自分の数を並べて「上書きする」「読み直す」', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    await user().click(within(panel).getByTestId('records-lend-all'));
    db.records.push({ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 1, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-other', updated_at: nextAt() });
    await user().click(screen.getByTestId('records-save'));
    const dialog = await screen.findByTestId('records-conflict');
    expect(dialog.textContent).toContain('入力を始めた後に、ほかの人がこの団体の記録を保存しました');
    expect(within(dialog).getAllByTestId('records-conflict-row')[0]!.textContent).toBe('テント渡1・返0・破0渡2・返0・破0');
    expect(issued.some((c) => c.ops.some((o) => o.op === 'upsert'))).toBe(false);
    await user().click(within(dialog).getByRole('button', { name: '上書きする' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存しました'));
    expect(db.records.find((r) => r.lending_item_id === TENT)?.lent_count).toBe(2);
  });

  it('前の保存が通っていた（読み直すと入力と同じ）なら送らずに「保存されていました」', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { search: `group=${G1}` });
    const panel = await screen.findByTestId('records-panel');
    await user().click(within(panel).getByTestId('records-lend-all'));
    db.records.push(
      { group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 2, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: nextAt() },
      { group_id: G1, lending_item_id: WEIGHT, year_id: Y, lent_count: 8, returned_count: 0, damaged_count: 0, note: null, updated_by: 'u-staff', updated_at: nextAt() },
    );
    await user().click(screen.getByTestId('records-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存されていました'));
    expect(issued.some((c) => c.ops.some((o) => o.op === 'upsert'))).toBe(false);
  });

  it('終了した年度：帯を出し、入力と保存を出さない', async () => {
    renderWith(<LendingRecordsScreen />, 'staff', { status: 'closed', search: `group=${G1}` });
    expect((await screen.findByTestId('lending-readonly')).textContent).toBe('終了した年度のため、テント等の貸し出しは読むだけです');
    await screen.findByTestId('records-panel');
    expect(screen.queryByTestId('records-save')).toBeNull();
    expect(screen.queryByTestId('records-lend-all')).toBeNull();
  });

  it('印刷用の表：割り当てか記録のある団体と、備品ごとの割り当て（渡した・返ったは空欄）。確定前なら「割り当ては確定前です」', async () => {
    renderWith(<LendingRecordsScreen />, 'staff');
    const sheet = await screen.findByTestId('records-print-sheet');
    expect(sheet.textContent).toContain('割り当ては確定前です');
    expect(sheet.textContent).toContain('模擬店01');
    expect(sheet.textContent).not.toContain('企業A');
  });
});
