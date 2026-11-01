// @vitest-environment jsdom
// シフト表（/shifts）・自分のシフト（/shift）・印刷（/shifts/print）の画面（04「シフト表」「自分のシフト」「シフト表の印刷」、notes/T20.md
// 「画面の約束」4〜6・13。T20）：部門長以上は操作あり（ダイアログは動的 import）、部門員は読むだけで自分の名前を目立たせる、終了は帯、
// `?day=`・`?filter=short`、ますのダイアログ（必要人数は送る前に読み直す〔(A)〕・人を選ぶ一覧の in・busy・free と入れる）、1日分（並ぶ
// 時間枠・重なりで押せない・RPC の引数）、自分のシフト（今・次・同じますの人・空・終わった日）、印刷（表を 8 列で分ける・人ごと）。
// Supabase は偽のクライアントで、5表の読み書きと RPC を小さくまねる。立場は useAuth の差し替え。時計は Date だけを止める。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, Membership, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import type { BoardDuty, BoardSlot } from '@/lib/modules/shifts/board';
import { queryKeys } from '@/lib/query';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { MY_SHIFT_TEXTS, MyShiftScreen } from './my-shift-screen';
import { ShiftsPrintScreen } from './shifts-print-screen';
import { SHIFTS_EMPTY_TEXTS, ShiftsScreen } from './shifts-screen';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  role: 'head' as AppRole | null,
  userId: 'u',
  client: null as unknown,
  params: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: h.membership,
    session: { status: 'signedIn', session: { user: { id: h.userId } } },
    reloadMembership: vi.fn(),
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
  usePathname: () => '/shifts',
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

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const U_HEAD = uuid(2);
const U_STAFF = uuid(3);
const U_B = uuid(4);
const U_VIEWER = uuid(5);
const D_RECEPTION = uuid(11);
const D_CARRY = uuid(12);
const D_SPARE = uuid(13);
const S1 = uuid(21);
const S2 = uuid(22);
const S3 = uuid(23);
const V0 = '2027-10-01T00:00:00.123456+00:00';
/** 今：2027-10-15（金・前日）09:30 Asia/Tokyo。1日目は 10/16 */
const NOW = '2027-10-15T00:30:00Z';

let duties: BoardDuty[] = [];
let slots: BoardSlot[] = [];
let issued: FakeCall[] = [];
let override: ((call: FakeCall) => FakeResult | undefined) | null = null;
let clock = 0;
const nextAt = () => `2027-10-02T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
const has = (call: FakeCall, op: string) => call.ops.some((o) => o.op === op);
const eqOf = (call: FakeCall) => Object.fromEntries(opArgs(call, 'eq').map(([k, v]) => [k as string, v]));
const duty = (id: string, name: string, sort_order: number, place: string | null = null): BoardDuty => ({ id, name, place, note: null, sort_order, updated_at: V0 });
const need = (duty_id: string, required_count: number, users: string[]) => ({
  duty_id,
  required_count,
  updated_at: V0,
  shift_assignments: users.map((user_id) => ({ user_id, updated_at: V0 })),
});

function seed() {
  duties = [duty(D_RECEPTION, '受付', 1, '正門'), duty(D_CARRY, '運搬', 2), duty(D_SPARE, '予備', 3)];
  slots = [
    // 前日（10/15）09:00〜10:00：受付 2/3（あと1人）、運搬 1/1
    { id: S1, starts_at: '2027-10-15T00:00:00Z', ends_at: '2027-10-15T01:00:00Z', updated_at: V0, shift_needs: [need(D_RECEPTION, 3, [U_STAFF, U_HEAD]), need(D_CARRY, 1, [U_B])] },
    // 前日 10:00〜11:00：受付 1/1
    { id: S2, starts_at: '2027-10-15T01:00:00Z', ends_at: '2027-10-15T02:00:00Z', updated_at: V0, shift_needs: [need(D_RECEPTION, 1, [U_B])] },
    // 1日目（10/16）09:00〜10:00：運搬 1/2（閲覧のみに変わった人）
    { id: S3, starts_at: '2027-10-16T00:00:00Z', ends_at: '2027-10-16T01:00:00Z', updated_at: V0, shift_needs: [need(D_CARRY, 2, [U_VIEWER, U_STAFF])] },
  ];
}

const yearRow = (status: YearStatus): YearRow =>
  ({ id: Y, label: 'R9', status, allocation_version: 1, auto_allocated_at: null, festival_start: '2027-10-16', request_open_at: null, request_close_at: null, prev_year_id: null, updated_at: 't' }) as YearRow;

/** 自分の割り当て（/shift の読み取りの形） */
function mine(userId: string) {
  const out = [];
  for (const s of slots) {
    for (const n of s.shift_needs) {
      if (!n.shift_assignments.some((a) => a.user_id === userId)) continue;
      const d = duties.find((x) => x.id === n.duty_id)!;
      out.push({
        slot_id: s.id,
        duty_id: n.duty_id,
        updated_at: V0,
        shift_needs: {
          required_count: n.required_count,
          shift_slots: { id: s.id, starts_at: s.starts_at, ends_at: s.ends_at },
          shift_duties: { id: d.id, name: d.name, place: d.place, note: d.note },
          shift_assignments: n.shift_assignments.map((a) => ({ user_id: a.user_id })),
        },
      });
    }
  }
  return out;
}

function handler(call: FakeCall): FakeResult {
  const o = override?.(call);
  if (o) return o;
  switch (call.table) {
    case 'profiles':
      return {
        data: [
          { user_id: U_HEAD, display_name: '部門長A' },
          { user_id: U_STAFF, display_name: '部門員A' },
          { user_id: U_B, display_name: '部門員B' },
          { user_id: U_VIEWER, display_name: '閲覧C' },
        ],
      };
    case 'year_roles':
      return {
        data: [
          { user_id: U_HEAD, role: 'head' },
          { user_id: U_STAFF, role: 'staff' },
          { user_id: U_B, role: 'staff' },
          { user_id: U_VIEWER, role: 'viewer' },
        ],
      };
    case 'shift_duties': {
      if (has(call, 'insert')) {
        const v = opArgs(call, 'insert')[0]![0] as BoardDuty & { year_id: string };
        if (duties.some((d) => d.name === v.name)) return { error: { code: '23505', message: 'duplicate key', details: '' }, status: 409 };
        const row = { ...v, updated_at: nextAt() };
        duties.push(row);
        return { data: row };
      }
      if (has(call, 'maybeSingle')) return { data: duties.find((d) => d.id === eqOf(call).id) ?? null };
      return { data: duties };
    }
    case 'shift_slots': {
      if (has(call, 'delete')) {
        const id = (opArgs(call, 'match')[0]?.[0] as { id: string }).id;
        const k = slots.findIndex((x) => x.id === id && x.updated_at === eqOf(call).updated_at);
        if (k < 0) return { data: [] };
        const [gone] = slots.splice(k, 1);
        return { data: [gone] };
      }
      if (has(call, 'insert')) {
        const v = opArgs(call, 'insert')[0]![0] as { id: string; starts_at: string; ends_at: string };
        const hit = slots.find((x) => Date.parse(x.starts_at) < Date.parse(v.ends_at) && Date.parse(v.starts_at) < Date.parse(x.ends_at));
        if (hit) {
          return { error: { code: 'P0001', message: 'invalid_input', details: JSON.stringify({ field: 'starts_at', reason: 'overlap', slot_id: hit.id }) }, status: 400 };
        }
        const row = { id: v.id, starts_at: v.starts_at, ends_at: v.ends_at, updated_at: nextAt(), shift_needs: [] };
        slots.push(row);
        return { data: row };
      }
      return { data: slots };
    }
    case 'shift_assignments': {
      if (has(call, 'delete')) {
        const m = opArgs(call, 'match')[0]![0] as { slot_id: string; user_id: string };
        const n = slots.find((x) => x.id === m.slot_id)?.shift_needs.find((x) => x.shift_assignments.some((a) => a.user_id === m.user_id));
        const a = n?.shift_assignments.find((x) => x.user_id === m.user_id);
        if (!n || !a || a.updated_at !== eqOf(call).updated_at) return { data: [] };
        n.shift_assignments = n.shift_assignments.filter((x) => x !== a);
        return { data: [{ ...m, duty_id: n.duty_id, updated_at: a.updated_at }] };
      }
      if (has(call, 'update')) {
        const m = opArgs(call, 'match')[0]![0] as { slot_id: string; user_id: string };
        const { duty_id } = opArgs(call, 'update')[0]![0] as { duty_id: string };
        const s = slots.find((x) => x.id === m.slot_id)!;
        const from = s.shift_needs.find((x) => x.shift_assignments.some((a) => a.user_id === m.user_id));
        const a = from?.shift_assignments.find((x) => x.user_id === m.user_id);
        if (!from || !a || a.updated_at !== eqOf(call).updated_at) return { data: null };
        from.shift_assignments = from.shift_assignments.filter((x) => x !== a);
        const at = nextAt();
        s.shift_needs.find((x) => x.duty_id === duty_id)!.shift_assignments.push({ user_id: m.user_id, updated_at: at });
        return { data: { ...m, duty_id, updated_at: at, year_id: Y, created_at: 'c' } };
      }
      if (has(call, 'insert')) {
        const v = opArgs(call, 'insert')[0]![0] as { slot_id: string; duty_id: string; user_id: string };
        const s = slots.find((x) => x.id === v.slot_id)!;
        if (s.shift_needs.some((n) => n.shift_assignments.some((a) => a.user_id === v.user_id))) {
          return { error: { code: '23505', message: 'duplicate key', details: '' }, status: 409 };
        }
        const at = nextAt();
        s.shift_needs.find((n) => n.duty_id === v.duty_id)!.shift_assignments.push({ user_id: v.user_id, updated_at: at });
        return { data: { ...v, updated_at: at } };
      }
      if (has(call, 'maybeSingle')) {
        const { slot_id, user_id } = eqOf(call) as { slot_id: string; user_id: string };
        const s = slots.find((x) => x.id === slot_id);
        const n = s?.shift_needs.find((x) => x.shift_assignments.some((a) => a.user_id === user_id));
        const a = n?.shift_assignments.find((x) => x.user_id === user_id);
        return { data: n && a ? { slot_id, duty_id: n.duty_id, user_id, updated_at: a.updated_at } : null };
      }
      return { data: mine(eqOf(call).user_id as string) };
    }
    case 'shift_needs': {
      if (has(call, 'upsert')) {
        const [v] = opArgs(call, 'upsert')[0] as [{ slot_id: string; duty_id: string; required_count: number }];
        const s = slots.find((x) => x.id === v.slot_id)!;
        const at = nextAt();
        const n = s.shift_needs.find((x) => x.duty_id === v.duty_id);
        if (n) Object.assign(n, { required_count: v.required_count, updated_at: at });
        else s.shift_needs.push({ duty_id: v.duty_id, required_count: v.required_count, updated_at: at, shift_assignments: [] });
        return { data: { slot_id: v.slot_id, duty_id: v.duty_id, required_count: v.required_count, updated_at: at } };
      }
      const { slot_id, duty_id } = eqOf(call) as { slot_id: string; duty_id: string };
      const n = slots.find((x) => x.id === slot_id)?.shift_needs.find((x) => x.duty_id === duty_id);
      return { data: n ? { slot_id, duty_id, required_count: n.required_count, updated_at: n.updated_at } : null };
    }
    case 'rpc:add_shift_slots':
      return { data: ((call.ops[0]!.args[0] as { p_slots: unknown[] }).p_slots ?? []).map((_, k) => ({ id: uuid(900 + k), starts_at: 'a', ends_at: 'b', updated_at: 'v', year_id: Y, created_at: 'c' })) };
    default:
      return { data: [] };
  }
}

function member(role: AppRole, status: YearStatus): Membership {
  const year = { id: Y, label: 'R9', status, festival_start: '2027-10-16' };
  return { displayName: 'テスト', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

function renderWith(node: React.ReactNode, role: AppRole, opts: { status?: YearStatus; search?: string; userId?: string } = {}) {
  const status = opts.status ?? 'requesting';
  h.role = role;
  h.userId = opts.userId ?? (role === 'staff' ? U_STAFF : U_HEAD);
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, status) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status));
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  return qc;
}

const cellOf = (slotId: string, dutyId: string) =>
  screen.getAllByTestId('shift-cell').find((c) => c.getAttribute('data-slot-id') === slotId && c.getAttribute('data-duty-id') === dutyId)!;
const tableLoaded = () => waitFor(() => expect(screen.getByTestId('shifts-table')).toBeTruthy());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  seed();
  override = null;
  clock = 0;
  const fake = createFakeSupabase(handler);
  // 自分の割り当て（/shift）は queryFn の中でセッションの user_id を読む
  h.client = Object.assign(fake.client, {
    auth: { getSession: async () => ({ data: { session: { user: { id: h.userId } } }, error: null }) },
  });
  issued = fake.issued;
  toast.info.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  h.replace.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('T20 シフト表：部門員（読むだけ）', () => {
  it('既定の日は今日（前日 10/15）。列はその日にますのある持ち場だけ。操作のボタンはなく、ますは押せない。自分の名前を目立たせる', async () => {
    renderWith(<ShiftsScreen />, 'staff');
    await tableLoaded();
    expect(screen.getAllByTestId('shifts-day-tab').map((t) => [t.getAttribute('data-day'), t.textContent, t.getAttribute('aria-current')])).toEqual([
      ['2027-10-15', '前日（10/15）', 'page'],
      ['2027-10-16', '1日目（10/16）', null],
    ]);
    const heads = within(screen.getByTestId('shifts-table')).getAllByRole('columnheader').map((x) => x.textContent);
    expect(heads).toEqual(['時間枠', '受付正門', '運搬', '合計']);
    for (const id of ['shifts-add-day', 'shifts-add-slot', 'shifts-add-duty']) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryAllByTestId('shift-slot-edit')).toEqual([]);
    expect(within(cellOf(S1, D_RECEPTION)).queryByRole('button')).toBeNull();
    const reception = cellOf(S1, D_RECEPTION);
    expect(reception.getAttribute('data-state')).toBe('short');
    expect(within(reception).getByTestId('shift-cell-count').textContent).toBe('2/3');
    expect(within(reception).getByTestId('shift-cell-short').textContent).toBe('あと1人');
    const me = within(reception).getAllByTestId('shift-cell-member').find((x) => x.getAttribute('data-me') === 'true')!;
    expect(me.textContent).toContain('部門員A');
    expect(screen.getAllByTestId('shift-row-total').map((x) => x.textContent)).toEqual(['合計3/4', '合計1/1']);
    expect(screen.getByTestId('shifts-print-link').getAttribute('href')).toBe('/shifts/print?day=2027-10-15');
    // 部門員はロールの一覧を読まない
    expect(issued.some((c) => c.table === 'year_roles')).toBe(false);
  });

  it('?day=：その日を開く。部門員は閲覧のみに変わった人も数える（ロールを読めない）', async () => {
    renderWith(<ShiftsScreen />, 'staff', { search: 'day=2027-10-16' });
    await tableLoaded();
    const carry = cellOf(S3, D_CARRY);
    expect(within(carry).getByTestId('shift-cell-count').textContent).toBe('2/2');
    expect(within(carry).queryAllByTestId('shift-cell-member').some((x) => x.getAttribute('data-not-soumu') === 'true')).toBe(false);
  });

  it('終了した年度：帯を出す', async () => {
    renderWith(<ShiftsScreen />, 'staff', { status: 'closed' });
    await tableLoaded();
    expect(screen.getByTestId('read-only-notice').textContent).toBe('終了した年度のため、シフトと作業は読むだけです');
  });
});

describe('T20 シフト表：部門長以上', () => {
  it('列は持ち場の全部。操作のボタン。閲覧のみに変わった人に「総務でない人」と出し、数に入れない', async () => {
    renderWith(<ShiftsScreen />, 'head', { search: 'day=2027-10-16' });
    await tableLoaded();
    const heads = within(screen.getByTestId('shifts-table')).getAllByRole('columnheader').map((x) => x.textContent);
    expect(heads.slice(0, 4)).toEqual(['時間枠', '受付正門', '運搬', '予備']);
    for (const id of ['shifts-add-day', 'shifts-add-slot', 'shifts-add-duty']) expect(screen.getByTestId(id)).toBeTruthy();
    await waitFor(() => expect(within(cellOf(S3, D_CARRY)).getByTestId('shift-cell-count').textContent).toBe('1/2'));
    const viewer = within(cellOf(S3, D_CARRY))
      .getAllByTestId('shift-cell-member')
      .find((x) => x.getAttribute('data-user-id') === U_VIEWER)!;
    expect(viewer.getAttribute('data-not-soumu')).toBe('true');
    expect(viewer.textContent).toContain('総務でない人');
    // ますのボタンの読み上げの名前
    expect(within(cellOf(S3, D_CARRY)).getByRole('button').getAttribute('aria-label')).toBe('09:00〜10:00 運搬 1/2 人、あと1人');
    expect(within(cellOf(S3, D_RECEPTION)).getByRole('button').getAttribute('aria-label')).toBe('09:00〜10:00 受付 ますなし');
  });

  it('?filter=short：これからの時間枠の足りないますを目立たせ、ほかを薄くする（切り替えは URL）', async () => {
    renderWith(<ShiftsScreen />, 'head', { search: 'filter=short' });
    await tableLoaded();
    expect(cellOf(S1, D_RECEPTION).getAttribute('data-short-highlight')).toBe('true');
    expect(cellOf(S1, D_CARRY).getAttribute('data-short-highlight')).toBeNull();
    fireEvent.click(screen.getByTestId('shifts-filter-short'));
    expect(h.replace).toHaveBeenCalledWith('/shifts?day=2027-10-15');
  });

  it('ますのダイアログ：人を選ぶ一覧（in・busy・free とこの日の枠）。入れると insert して一覧が変わる', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(within(cellOf(S2, D_RECEPTION)).getByRole('button'));
    const dialog = await screen.findByTestId('shift-cell-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('10:00〜11:00 受付');
    await waitFor(() => expect(within(dialog).getAllByTestId('shift-member-option')).toHaveLength(3));
    const opts = within(dialog).getAllByTestId('shift-member-option');
    expect(opts.map((o) => [o.getAttribute('data-user-id'), o.getAttribute('data-state')])).toEqual([
      [U_STAFF, 'free'],
      [U_B, 'in'],
      [U_HEAD, 'free'],
    ]);
    expect(within(opts[1]!).getByText('この日 2 枠')).toBeTruthy();
    fireEvent.click(within(opts[0]!).getByTestId('shift-member-assign'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('部門員Aを受付に入れました'));
    const ins = issued.find((c) => c.table === 'shift_assignments' && has(c, 'insert'))!;
    expect(opArgs(ins, 'insert')[0]![0]).toEqual({ year_id: Y, slot_id: S2, duty_id: D_RECEPTION, user_id: U_STAFF });
    await waitFor(() =>
      expect(within(dialog).getAllByTestId('shift-member-option').find((o) => o.getAttribute('data-user-id') === U_STAFF)!.getAttribute('data-state')).toBe('in'),
    );
  });

  it('ますのダイアログ：同じ時間枠のほかのますにいる人は「{持ち場}に入っています」で選べない。23505 で読み直してほかのますなら知らせる', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(within(cellOf(S1, D_CARRY)).getByRole('button'));
    const dialog = await screen.findByTestId('shift-cell-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('shift-member-option').length).toBeGreaterThan(0));
    const staff = within(dialog).getAllByTestId('shift-member-option').find((o) => o.getAttribute('data-user-id') === U_STAFF)!;
    expect(staff.getAttribute('data-state')).toBe('busy');
    expect(within(staff).getByTestId('shift-member-busy').textContent).toBe('受付に入っています');
    expect(within(staff).queryByTestId('shift-member-assign')).toBeNull();
  });

  it('必要人数（(A)）：送る前に読み直し、同じ数なら送らずに「保存されていました」。違えば upsert', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(within(cellOf(S1, D_RECEPTION)).getByRole('button'));
    const dialog = await screen.findByTestId('shift-cell-dialog');
    // ほかの人が先に 4 にしていた
    slots[0]!.shift_needs[0]!.required_count = 4;
    fireEvent.click(within(within(dialog).getByTestId('shift-need-count')).getByRole('button', { name: '必要人数を1増やす' }));
    fireEvent.click(within(dialog).getByTestId('shift-need-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存されていました'));
    expect(issued.some((c) => c.table === 'shift_needs' && has(c, 'upsert'))).toBe(false);
    fireEvent.click(within(within(dialog).getByTestId('shift-need-count')).getByRole('button', { name: '必要人数を1増やす' }));
    fireEvent.click(within(dialog).getByTestId('shift-need-save'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存しました'));
    const up = issued.find((c) => c.table === 'shift_needs' && has(c, 'upsert'))!;
    expect(opArgs(up, 'upsert')[0]).toEqual([{ year_id: Y, slot_id: S1, duty_id: D_RECEPTION, required_count: 5 }, { onConflict: 'slot_id,duty_id' }]);
  });

  it('1日分：並ぶ時間枠を見せ、今ある時間枠と重なれば押せない。重ならなければ add_shift_slots（時間枠と置く持ち場のます）', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(screen.getByTestId('shifts-add-day'));
    const dialog = await screen.findByTestId('shift-day-dialog');
    expect((within(dialog).getByTestId('shift-day-date') as HTMLInputElement).value).toBe('2027-10-15');
    // 既定 09:00〜17:00 の 60 分は、今ある 09:00〜11:00 と重なる
    expect(within(dialog).getAllByTestId('shift-day-preview-slot')).toHaveLength(8);
    expect(within(dialog).getByTestId('shift-day-overlap').textContent).toContain('09:00〜10:00');
    expect((within(dialog).getByTestId('shift-day-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByTestId('shift-day-start'), { target: { value: '13:00' } });
    fireEvent.change(within(dialog).getByTestId('shift-day-end'), { target: { value: '15:00' } });
    // 予備は置かない
    const spare = within(dialog).getAllByTestId('shift-day-need').find((x) => x.getAttribute('data-duty-id') === D_SPARE)!;
    fireEvent.click(within(spare).getByRole('checkbox'));
    expect(within(dialog).getAllByTestId('shift-day-preview-slot').map((x) => x.textContent)).toEqual(['13:00〜14:00', '14:00〜15:00']);
    fireEvent.click(within(dialog).getByTestId('shift-day-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('10/15（金） の時間枠を 2 作りました'));
    const rpc = issued.find((c) => c.table === 'rpc:add_shift_slots')!;
    expect(rpc.ops[0]!.args[0]).toEqual({
      p_year_id: Y,
      p_slots: [
        { starts_at: '2027-10-15T13:00:00+09:00', ends_at: '2027-10-15T14:00:00+09:00' },
        { starts_at: '2027-10-15T14:00:00+09:00', ends_at: '2027-10-15T15:00:00+09:00' },
      ],
      p_needs: [
        { duty_id: D_RECEPTION, required_count: 1 },
        { duty_id: D_CARRY, required_count: 1 },
      ],
    });
    expect(h.replace).toHaveBeenCalledWith('/shifts?day=2027-10-15');
  });

  it('終了した年度：帯を出し、操作を出さない（ますは押せない）', async () => {
    renderWith(<ShiftsScreen />, 'admin', { status: 'closed' });
    await tableLoaded();
    expect(screen.getByTestId('read-only-notice').textContent).toBe('終了した年度のため、シフトと作業は読むだけです');
    expect(screen.queryByTestId('shifts-add-day')).toBeNull();
    expect(within(cellOf(S1, D_RECEPTION)).queryByRole('button')).toBeNull();
  });

  it('空：時間枠がなければ「シフトの時間枠はまだありません」と作り方（持ち場もなければ持ち場の足し方）', async () => {
    slots = [];
    duties = [];
    renderWith(<ShiftsScreen />, 'head');
    await waitFor(() => expect(screen.getByTestId('shifts-empty').textContent).toContain(SHIFTS_EMPTY_TEXTS.noSlots));
    expect(screen.getByTestId('shifts-empty').textContent).toContain(SHIFTS_EMPTY_TEXTS.addDayHint);
    expect(screen.getByTestId('shifts-empty').textContent).toContain(SHIFTS_EMPTY_TEXTS.noDuties);
  });
});

describe('T20 シフト表：部門長以上の書き込み（持ち場・時間枠・外す・移す）', () => {
  it('持ち場を足す：並び順の既定は今の最大＋1、画面の id で insert。同じ名前は「同じ名前の持ち場があります」', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(screen.getByTestId('shifts-add-duty'));
    const dialog = await screen.findByTestId('shift-duty-dialog');
    expect((within(dialog).getByTestId('shift-duty-order') as HTMLInputElement).value).toBe('4');
    fireEvent.change(within(dialog).getByTestId('shift-duty-name'), { target: { value: ' 受付 ' } });
    fireEvent.click(within(dialog).getByTestId('shift-duty-submit'));
    expect(await within(dialog).findByText('同じ名前の持ち場があります')).toBeTruthy();
    fireEvent.change(within(dialog).getByTestId('shift-duty-name'), { target: { value: '見回り' } });
    fireEvent.change(within(dialog).getByTestId('shift-duty-place'), { target: { value: ' 中庭 ' } });
    expect(within(dialog).getByTestId('shift-duty-name-count').textContent).toBe('3/50');
    fireEvent.click(within(dialog).getByTestId('shift-duty-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「見回り」を足しました'));
    const inserts = issued.filter((c) => c.table === 'shift_duties' && has(c, 'insert'));
    expect(opArgs(inserts.at(-1)!, 'insert')[0]![0]).toMatchObject({ year_id: Y, name: '見回り', place: '中庭', note: null, sort_order: 4 });
    // 送り直しても同じ id（ダイアログを開いたときに作った id）
    expect((opArgs(inserts[0]!, 'insert')[0]![0] as { id: string }).id).toBe((opArgs(inserts.at(-1)!, 'insert')[0]![0] as { id: string }).id);
  });

  it('時間枠を足す：重なれば「ほかの時間枠と時間が重なっています（09:00〜10:00）」。終わりが始まり以前なら翌日', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(screen.getByTestId('shifts-add-slot'));
    const dialog = await screen.findByTestId('shift-slot-dialog');
    fireEvent.change(within(dialog).getByTestId('shift-slot-start'), { target: { value: '09:30' } });
    fireEvent.change(within(dialog).getByTestId('shift-slot-end'), { target: { value: '09:45' } });
    fireEvent.click(within(dialog).getByTestId('shift-slot-submit'));
    await waitFor(() => expect(within(dialog).getByTestId('shift-slot-error').textContent).toContain('ほかの時間枠と時間が重なっています（09:00〜10:00）'));
    fireEvent.change(within(dialog).getByTestId('shift-slot-start'), { target: { value: '23:00' } });
    fireEvent.change(within(dialog).getByTestId('shift-slot-end'), { target: { value: '01:00' } });
    expect(within(dialog).getByTestId('shift-slot-next-day').textContent).toBe('翌日');
    fireEvent.click(within(dialog).getByTestId('shift-slot-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('時間枠を足しました'));
    const ins = issued.filter((c) => c.table === 'shift_slots' && has(c, 'insert')).at(-1)!;
    expect(opArgs(ins, 'insert')[0]![0]).toMatchObject({ year_id: Y, starts_at: '2027-10-15T23:00:00+09:00', ends_at: '2027-10-16T01:00:00+09:00' });
  });

  it('時間枠の削除：割り当ての人数を出して確かめ、updated_at を条件に入れて消す', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    const row = screen.getAllByTestId('shift-row').find((r) => r.getAttribute('data-slot-id') === S1)!;
    fireEvent.click(within(row).getByTestId('shift-slot-delete'));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('この時間枠を削除しますか')).toBeTruthy();
    expect(confirm.textContent).toContain('この時間枠の 3 人の割り当ても消えます。');
    fireEvent.click(within(confirm).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('この時間枠を削除しました'));
    const del = issued.find((c) => c.table === 'shift_slots' && has(c, 'delete'))!;
    expect(opArgs(del, 'match')).toEqual([[{ id: S1 }]]);
    expect(opArgs(del, 'eq')).toEqual([['updated_at', V0]]);
  });

  it('ますのダイアログ：外す（updated_at を条件に入れた delete）・ほかの持ち場へ移す（duty_id の update 1回）', async () => {
    renderWith(<ShiftsScreen />, 'head');
    await tableLoaded();
    fireEvent.click(within(cellOf(S1, D_RECEPTION)).getByRole('button'));
    const dialog = await screen.findByTestId('shift-cell-dialog');
    await waitFor(() => expect(within(dialog).getAllByTestId('shift-member-option').length).toBeGreaterThan(0));
    const head = () => within(dialog).getAllByTestId('shift-member-option').find((o) => o.getAttribute('data-user-id') === U_HEAD)!;
    fireEvent.change(within(head()).getByTestId('shift-member-move'), { target: { value: D_CARRY } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('部門長Aを運搬に移しました'));
    const up = issued.find((c) => c.table === 'shift_assignments' && has(c, 'update'))!;
    expect(opArgs(up, 'update')[0]![0]).toEqual({ duty_id: D_CARRY });
    expect(issued.some((c) => c.table === 'shift_assignments' && has(c, 'delete'))).toBe(false);
    await waitFor(() => expect(head().getAttribute('data-state')).toBe('busy'));
    const staff = within(dialog).getAllByTestId('shift-member-option').find((o) => o.getAttribute('data-user-id') === U_STAFF)!;
    fireEvent.click(within(staff).getByTestId('shift-member-unassign'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('部門員Aを外しました'));
    const del = issued.find((c) => c.table === 'shift_assignments' && has(c, 'delete'))!;
    expect(opArgs(del, 'match')).toEqual([[{ slot_id: S1, user_id: U_STAFF }]]);
    expect(opArgs(del, 'eq')).toEqual([['updated_at', V0]]);
  });
});

describe('T20 自分のシフト（/shift）', () => {
  it('日ごと（今日 → これから）。今の枠に「今」、次の枠に「次」、同じますの人（自分を除く）、場所', async () => {
    renderWith(<MyShiftScreen />, 'staff');
    await waitFor(() => expect(screen.getAllByTestId('my-shift-item').length).toBe(2));
    expect(screen.getAllByTestId('my-shift-day').map((d) => [d.getAttribute('data-day'), d.getAttribute('data-past')])).toEqual([
      ['2027-10-15', 'false'],
      ['2027-10-16', 'false'],
    ]);
    const [today, tomorrow] = screen.getAllByTestId('my-shift-item');
    expect(within(today!).getByTestId('my-shift-time').textContent).toBe('09:00〜10:00');
    expect(within(today!).getByTestId('my-shift-now').textContent).toBe('今');
    expect(within(today!).getByTestId('my-shift-place').textContent).toContain('正門');
    await waitFor(() => expect(within(today!).getByTestId('my-shift-mates').textContent).toContain('部門長A'));
    expect(within(tomorrow!).getByTestId('my-shift-next').textContent).toBe('次');
    expect(within(tomorrow!).getByTestId('my-shift-mates').textContent).toContain('閲覧C');
    // 読むのは自分の割り当てと表示名の2本だけ
    expect(issued.map((c) => c.table).sort()).toEqual(['profiles', 'shift_assignments']);
    expect(screen.getByTestId('my-shift-board-link').getAttribute('href')).toBe('/shifts');
  });

  it('空：割り当てがなければ「あなたのシフトはまだありません」、終わった日しかなければ「これからのシフトはありません」と畳んだ終わった日', async () => {
    renderWith(<MyShiftScreen />, 'staff', { userId: uuid(77) });
    await waitFor(() => expect(screen.getByTestId('my-shift-empty').textContent).toContain(MY_SHIFT_TEXTS.empty));
    cleanup();
    vi.setSystemTime(new Date('2027-10-20T00:00:00Z'));
    renderWith(<MyShiftScreen />, 'staff');
    await waitFor(() => expect(screen.getByTestId('my-shift-empty').textContent).toContain(MY_SHIFT_TEXTS.noUpcoming));
    const toggle = screen.getByTestId('my-shift-past-toggle');
    expect(toggle.textContent).toContain('終わった日（2 日）');
    expect(screen.queryAllByTestId('my-shift-item')).toEqual([]);
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('my-shift-day').map((d) => d.getAttribute('data-day'))).toEqual(['2027-10-16', '2027-10-15']);
  });
});

describe('T20 シフト表の印刷（/shifts/print）', () => {
  it('日ごとの表（その日にますのある持ち場。足りなければ文字で）と、人ごとのカード（?view=people）', async () => {
    renderWith(<ShiftsPrintScreen />, 'staff', { search: 'day=2027-10-15' });
    await waitFor(() => expect(screen.getAllByTestId('shifts-print-table')).toHaveLength(1));
    const t = screen.getByTestId('shifts-print-table');
    expect(t.textContent).toContain('R9 シフト表 前日（10/15）');
    expect(t.textContent).toContain('あと1人');
    expect(within(t).getAllByRole('columnheader').map((x) => x.textContent)).toEqual(['時間枠', '受付正門', '運搬']);
    cleanup();
    renderWith(<ShiftsPrintScreen />, 'staff', { search: 'day=2027-10-15&view=people' });
    await waitFor(() => expect(screen.getAllByTestId('shifts-print-person').length).toBe(3));
    expect(screen.getAllByTestId('shifts-print-person').map((p) => p.querySelector('h2')?.textContent)).toEqual(['部門員A', '部門員B', '部門長A']);
  });

  it('持ち場が 8 を超える日は 8 ずつ別の表にする', async () => {
    duties = Array.from({ length: 10 }, (_, k) => duty(uuid(300 + k), `持ち場${k + 1}`, k));
    slots = [{ id: S1, starts_at: '2027-10-15T00:00:00Z', ends_at: '2027-10-15T01:00:00Z', updated_at: V0, shift_needs: duties.map((d) => need(d.id, 1, [])) }];
    renderWith(<ShiftsPrintScreen />, 'head', { search: 'day=2027-10-15' });
    await waitFor(() => expect(screen.getAllByTestId('shifts-print-table')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('shifts-print-table');
    expect(within(first!).getAllByRole('columnheader')).toHaveLength(9);
    expect(within(second!).getAllByRole('columnheader')).toHaveLength(3);
    expect(second!.textContent).toContain('（2／2）');
  });
});

describe('T20 最初に読む JS（import のグラフ。動的 import はたどらない）', () => {
  it('/ はシフト・作業のプロバイダと軽い読み取りだけを読み、シフト表・作業一覧の画面・組み立て・書き込みを読まない', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    for (const f of ['lib/modules/shifts/portal.ts', 'lib/modules/shifts/portal-read.ts']) expect(g.files).toContain(f);
    expect(g.files.filter((f) => f.startsWith('components/shifts/') || f.startsWith('components/tasks/'))).toEqual([]);
    for (const f of ['lib/modules/shifts/board.ts', 'lib/modules/shifts/my-shift.ts', 'lib/data/shifts.ts', 'lib/data/tasks.ts', 'lib/schemas/shifts.ts', 'lib/schemas/tasks.ts']) {
      expect(g.files).not.toContain(f);
    }
  });

  it('/shift（部門員がスマホで開く）はシフト表の組み立て・ダイアログ・書き込み・RPC を読まない', () => {
    const g = staticImportGraph('app/(app)/shift/page.tsx');
    expect(g.files).toContain('components/shifts/my-shift-screen.tsx');
    for (const f of ['lib/modules/shifts/board.ts', 'components/shifts/shift-write.ts', 'components/shifts/shift-lead-dialogs.tsx', 'lib/data/shifts.ts', 'lib/rpc/index.ts', 'lib/schemas/shifts.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.packages).not.toContain('zod');
  });

  it('/shifts と /tasks は部門長以上のダイアログ（動的 import）を最初の JS に入れない', () => {
    const shifts = staticImportGraph('app/(app)/shifts/page.tsx');
    for (const f of ['components/shifts/shift-lead-dialogs.tsx', 'components/shifts/shift-cell-dialog.tsx', 'components/shifts/shift-day-dialog.tsx', 'components/shifts/shift-write.ts', 'lib/data/shifts.ts']) {
      expect(shifts.files).not.toContain(f);
    }
    const tasks = staticImportGraph('app/(app)/tasks/page.tsx');
    expect(tasks.files).toContain('components/tasks/task-list.tsx');
    // 作業のダイアログと入力の zod は部門長以上だけ（下書き〔lib/drafts.ts〕はログアウトの処理でどのページにも入る）
    for (const f of ['components/tasks/task-form-dialog.tsx', 'lib/schemas/tasks.ts']) expect(tasks.files).not.toContain(f);
  });
});
