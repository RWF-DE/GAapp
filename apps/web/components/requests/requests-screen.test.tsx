// @vitest-environment jsdom
import { INITIAL_ITEMS } from '@gaapp/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, YearRow } from '@/lib/db/types';
import { opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';

const state = vi.hoisted(() => ({
  handler: null as null | ((call: FakeCall) => FakeResult),
  calls: [] as FakeCall[],
  role: 'admin' as 'admin' | 'staff',
}));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/lib/testing/fake-supabase');
  return { getSupabase: () => createFakeSupabase((call) => (state.calls.push(call), state.handler!(call))).client };
});

const USER = '00000000-0000-4000-8000-000000000001';
const YEAR = '00000000-0000-4000-8000-0000000000a1';
const STALL = '00000000-0000-4000-8000-000000000010';
const DEPT = '00000000-0000-4000-8000-000000000011';

vi.mock('@/lib/auth/auth-provider', () => {
  const year = { id: YEAR, label: 'R8', status: 'requesting', festival_start: '2026-10-17' };
  return {
    useAuth: () => ({
      session: { status: 'signedIn', session: { user: { id: USER } } },
      membership: {
        status: 'ready',
        membership: { displayName: '総務', year, role: state.role, groups: [], years: [year], latestYear: year, adminOfOpenYear: true },
      },
      isRefreshing: false,
      reloadMembership: vi.fn(),
      setYear: vi.fn(),
      signOut: vi.fn(),
      reauthenticate: vi.fn(async () => true),
    }),
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { RequestsScreen } = await import('./requests-screen');

const T0 = '2026-10-29T01:02:03.123456+00:00';
const ITEMS: ItemRow[] = INITIAL_ITEMS.map((i, n) => ({
  id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
  code: i.code,
  name: i.name,
  aliases: [...i.aliases],
  requestable_categories: [...i.requestableCategories],
  sort_order: i.sortOrder,
  updated_at: T0,
}));
const itemId = (code: string) => ITEMS.find((i) => i.code === code)!.id;
const group = (id: string, name: string, category: GroupRow['category'], sort: number): GroupRow => ({
  id,
  year_id: YEAR,
  name,
  display_name: null,
  aliases: [],
  category,
  is_food: false,
  location_room_id: null,
  sort_order: sort,
  updated_at: T0,
});
const GROUPS = [group(STALL, '模擬店A', 'stall', 1), group(DEPT, '部門A', 'department', 2)];
const REQUESTS: RequestDbRow[] = [
  { group_id: STALL, item_id: itemId('desk'), count: 3, updated_at: T0 },
  { group_id: STALL, item_id: itemId('long_desk_3'), count: 2, updated_at: T0 },
];

const yearRow = (): YearRow => ({
  id: YEAR,
  label: 'R8',
  status: 'requesting',
  allocation_version: 0,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: new Date(Date.now() - 86_400_000).toISOString(),
  request_close_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  prev_year_id: null,
  updated_at: T0,
});

function makeHandler(over: (call: FakeCall) => FakeResult | undefined = () => undefined) {
  return (call: FakeCall): FakeResult => {
    const o = over(call);
    if (o) return o;
    switch (call.table) {
      case 'years':
        return { data: yearRow() };
      case 'groups':
        return { data: GROUPS };
      case 'items':
        return { data: ITEMS };
      case 'requests':
        if (call.ops.some((x) => x.op === 'update')) return { data: null };
        if (call.ops.some((x) => x.op === 'select') && opArgs(call, 'select')[0]?.[0] === 'updated_at') return { data: { updated_at: T0 } };
        return { data: REQUESTS.map((r) => ({ ...r, groups: { year_id: YEAR } })) };
      case 'request_submissions':
        return { data: [{ group_id: STALL, submitted_at: T0, note: '電源がほしい', updated_at: T0, groups: { year_id: YEAR } }] };
      case 'rpc:update_requests_after_deadline':
        return { data: null };
      default:
        throw new Error(`想定していない問い合わせ：${call.table}`);
    }
  };
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RequestsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.role = 'admin';
  try {
    localStorage.clear();
  } catch {
    // 使えなくてもよい
  }
});
afterEach(() => cleanup());

const writes = () => state.calls.filter((c) => c.table === 'requests' && c.ops.some((o) => o.op === 'update' || o.op === 'insert'));

describe('申請一覧 /requests', () => {
  it('表：申請できない品目のセルは「—」、残っている数は灰色で印つき。未提出の団体と合計が出る', async () => {
    state.handler = makeHandler();
    renderScreen();
    const table = await screen.findByTestId('requests-table');
    expect(within(table).getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');
    const ld3 = table.querySelector('[data-cell="模擬店A:long_desk_3"]')!;
    expect(ld3.textContent).toContain('2');
    expect(ld3.textContent).toContain('長机(2人掛)として扱う');
    expect(table.querySelector('[data-cell="部門A:long_desk_3"]')!.textContent).toBe('—');
    expect(screen.getByTestId('unsubmitted').textContent).toContain('部門A');
    expect(table.querySelector('[data-total="desk"]')!.textContent).toBe('3');
    // 管理者には取り込みのボタンが出る
    expect(screen.getByRole('button', { name: 'Googleフォームの回答を取り込む' })).toBeTruthy();
  });

  it('部員は読み取りだけ（入力欄・保存がない）', async () => {
    state.role = 'staff';
    state.handler = makeHandler();
    renderScreen();
    const table = await screen.findByTestId('requests-table');
    expect(within(table).queryByLabelText('模擬店Aの机(木)')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Googleフォームの回答を取り込む' })).toBeNull();
    expect(screen.getByTestId('read-only-notice').textContent).toContain('部員は申請一覧を見るだけです');
  });

  it('締切前の直接の更新が RLS で拒否され、年度が受付中のままなら、締切後の書き方に切り替えて入力を残し、直接の更新を繰り返さない', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    const input = await screen.findByLabelText('模擬店Aの机(木)');
    await user.clear(input);
    await user.type(input, '5{Enter}');
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));

    await screen.findByText(/DB が締切後と判断しました（端末の時計がずれている可能性があります）。変更は理由をつけて保存します/);
    expect(writes()).toHaveLength(1);
    // 未保存のセルは残る
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(screen.getByTestId('deadline-text').textContent).toBe('締切後（変更には理由が要ります）');

    // もう一度保存すると、理由のダイアログ → update_requests_after_deadline（直接の更新はしない）
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')).toHaveLength(1));
    expect(writes()).toHaveLength(1);
    const rpc = state.calls.find((c) => c.table === 'rpc:update_requests_after_deadline')!;
    expect(opArgs(rpc, 'rpc')[0]![0]).toEqual({
      p_group_id: STALL,
      p_rows: [{ itemId: itemId('desk'), count: 5, updatedAt: T0 }],
      p_reason: '団体の希望',
    });
  });
});
