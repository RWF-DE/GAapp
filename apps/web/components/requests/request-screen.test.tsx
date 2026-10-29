// @vitest-environment jsdom
import { INITIAL_ITEMS } from '@gaapp/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, YearRow } from '@/lib/db/types';
import { opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';

// ---- 差し替え（Supabase・立場・ルーター） ----
const state = vi.hoisted(() => ({
  handler: null as null | ((call: FakeCall) => FakeResult),
  calls: [] as { table: string; ops: { op: string; args: unknown[] }[] }[],
  search: '',
}));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase: make } = await import('@/lib/testing/fake-supabase');
  return {
    getSupabase: () => make((call) => (state.calls.push(call), state.handler!(call))).client,
  };
});

const USER = '00000000-0000-4000-8000-000000000003';
const YEAR = '00000000-0000-4000-8000-0000000000a1';
const STALL = '00000000-0000-4000-8000-000000000010';
const COMPANY = '00000000-0000-4000-8000-000000000011';
const OTHER = '00000000-0000-4000-8000-000000000099';

vi.mock('@/lib/auth/auth-provider', () => {
  const year = { id: YEAR, label: 'R8', status: 'requesting', festival_start: '2026-10-17' };
  const membership = {
    displayName: '代表',
    year,
    role: null,
    groups: [
      { id: STALL, name: '模擬店A', year_id: YEAR },
      { id: COMPANY, name: '企業A', year_id: YEAR },
    ],
    years: [year],
    latestYear: year,
    adminOfOpenYear: false,
  };
  return {
    useAuth: () => ({
      session: { status: 'signedIn', session: { user: { id: USER } } },
      membership: { status: 'ready', membership },
      isRefreshing: false,
      reloadMembership: vi.fn(),
      setYear: vi.fn(),
      signOut: vi.fn(),
      reauthenticate: vi.fn(async () => true),
    }),
  };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { RequestScreen } = await import('./request-screen');

// ---- データ ----
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
const group = (id: string, name: string, category: GroupRow['category']): GroupRow => ({
  id,
  year_id: YEAR,
  name,
  display_name: null,
  aliases: [],
  category,
  is_food: false,
  location_room_id: null,
  sort_order: 1,
  updated_at: T0,
});
const GROUPS: Record<string, GroupRow> = { [STALL]: group(STALL, '模擬店A', 'stall'), [COMPANY]: group(COMPANY, '企業A', 'company') };

/** 端末の時計では受付期間内（締切は 30 日後） */
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

function eqValue(call: FakeCall, col: string): unknown {
  return opArgs(call, 'eq').find((a) => a[0] === col)?.[1];
}

function makeHandler(opts: { requests?: RequestDbRow[]; submit?: FakeResult } = {}) {
  return (call: FakeCall): FakeResult => {
    switch (call.table) {
      case 'years':
        return { data: yearRow() };
      case 'groups':
        return { data: GROUPS[eqValue(call, 'id') as string] ?? null };
      case 'items':
        return { data: ITEMS };
      case 'requests':
        return { data: (opts.requests ?? []).filter((r) => r.group_id === eqValue(call, 'group_id')) };
      case 'request_submissions':
        return { data: null };
      case 'rpc:submit_requests':
        return opts.submit ?? { data: { group_id: STALL, submitted_at: new Date().toISOString(), note: null, updated_at: T0 } };
      default:
        throw new Error(`想定していない問い合わせ：${call.table}`);
    }
  };
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RequestScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.search = '';
  try {
    localStorage.clear();
  } catch {
    // 使えなくてもよい
  }
});
afterEach(() => cleanup());

const submitCalls = () => state.calls.filter((c) => c.table === 'rpc:submit_requests');

describe('申請 /request', () => {
  it('企業以外には長机(3人掛)の欄がなく、DB に残っている長机(3人掛)は読み取り専用の行で出る', async () => {
    state.handler = makeHandler({ requests: [{ group_id: STALL, item_id: itemId('long_desk_3'), count: 2, updated_at: T0 }] });
    renderScreen();
    await screen.findByTestId('request-group-name');
    expect(screen.getByTestId('request-group-name').textContent).toBe('模擬店A');
    const codes = screen.getAllByTestId('request-field').map((li) => li.getAttribute('data-item-code'));
    expect(codes).not.toContain('long_desk_3');
    expect(codes).toContain('long_desk_2');
    const extra = screen.getByTestId('request-extra');
    expect(extra.textContent).toContain('長机(3人掛) 2台');
    expect(extra.textContent).toContain('長机(2人掛)として扱います。変えるときは総務へ');
  });

  it('企業には長机(3人掛)の欄が出る。ほかの団体の id をクエリに入れても自団体（最初の団体）に戻る', async () => {
    state.handler = makeHandler();
    state.search = `group=${COMPANY}`;
    renderScreen();
    await screen.findByTestId('request-group-name');
    expect(screen.getByTestId('request-group-name').textContent).toBe('企業A');
    expect(screen.getAllByTestId('request-field').map((li) => li.getAttribute('data-item-code'))).toContain('long_desk_3');
    cleanup();
    state.search = `group=${OTHER}`;
    renderScreen();
    await screen.findByTestId('request-group-name');
    expect(screen.getByTestId('request-group-name').textContent).toBe('模擬店A');
    expect(state.calls.some((c) => c.table === 'groups' && eqValue(c, 'id') === OTHER)).toBe(false);
  });

  it('提出は表示した入力欄の品目すべてを送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '提出' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('submit-summary').textContent).toContain('机(木)');
    await user.click(within(dialog).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    const args = opArgs(submitCalls()[0]!, 'rpc')[0]![0] as { p_group_id: string; p_rows: { itemId: string; count: number }[] };
    expect(args.p_group_id).toBe(STALL);
    expect(args.p_rows).toHaveLength(6);
    expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(1);
    expect(args.p_rows.map((r) => r.itemId)).not.toContain(itemId('long_desk_3'));
  });

  it('端末の時計では受付中でも DB が締切後と判断したら、読み取り専用にして同じ提出を繰り返さない', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler({
      submit: { error: { code: 'P0001', message: 'invalid_state', details: '{"status":"requesting"}', hint: null }, status: 400 },
    });
    renderScreen();
    await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '提出' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '提出する' }));

    const alert = await screen.findByTestId('submit-error');
    expect(alert.textContent).toBe('締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります');
    expect((await screen.findByTestId('read-only-notice')).textContent).toContain('端末の時計がずれている可能性があります。変更は総務へ');
    // 年度の行を読み直した（1回目の読み込み＋失敗の後の読み直し）
    expect(state.calls.filter((c) => c.table === 'years').length).toBeGreaterThanOrEqual(2);
    // 提出のボタンがなくなり、入力欄も押せない
    expect(screen.queryByRole('button', { name: /提出|再提出/ })).toBeNull();
    expect((screen.getByRole('button', { name: '机(木)の数を1増やす' }) as HTMLButtonElement).disabled).toBe(true);
    expect(submitCalls()).toHaveLength(1);
  });

  it('年度の状態が変わっていた（振り分け中）なら、印ではなく状態の文言を出す', async () => {
    const user = userEvent.setup();
    let failed = false;
    const base = makeHandler({
      submit: { error: { code: 'P0001', message: 'invalid_state', details: '{"status":"requesting"}', hint: null }, status: 400 },
    });
    state.handler = (call) => {
      if (call.table === 'rpc:submit_requests') failed = true;
      if (call.table === 'years' && failed) return { data: { ...yearRow(), status: 'allocating' } };
      return base(call);
    };
    renderScreen();
    await user.click(await screen.findByRole('button', { name: '提出' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '提出する' }));
    expect((await screen.findByTestId('submit-error')).textContent).toBe('年度が「振り分け中」のため、この操作はできません');
    expect((await screen.findByTestId('read-only-notice')).textContent).toBe('締切を過ぎました。変更は総務へ');
  });
});
