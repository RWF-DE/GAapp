// @vitest-environment jsdom
import { INITIAL_ITEMS } from '@gaapp/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, YearRow } from '@/lib/db/types';
import { opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';

const state = vi.hoisted(() => ({
  handler: null as null | ((call: FakeCall) => FakeResult | PromiseLike<FakeResult>),
  calls: [] as FakeCall[],
  role: 'admin' as 'admin' | 'staff',
  /** 申請の行（null なら REQUESTS。ほかの人の変更をまねるときに差し替える） */
  requests: null as null | { group_id: string; item_id: string; count: number; updated_at: string }[],
  /** 提出の記録の備考（ほかの人の変更をまねるときに差し替える） */
  note: '電源がほしい',
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
        return { data: (state.requests ?? REQUESTS).map((r) => ({ ...r, groups: { year_id: YEAR } })) };
      case 'request_submissions': {
        const rows = [{ group_id: STALL, submitted_at: T0, note: state.note, updated_at: T0, groups: { year_id: YEAR } }];
        if (call.ops.some((x) => x.op === 'maybeSingle')) {
          const id = opArgs(call, 'eq').find((a) => a[0] === 'group_id')?.[1];
          const { groups: _g, ...row } = rows.find((r) => r.group_id === id) ?? { groups: null };
          void _g;
          return { data: 'group_id' in row ? row : null };
        }
        return { data: rows };
      }
      case 'rpc:update_requests_after_deadline':
        return { data: null };
      case 'rpc:submit_requests':
        return { data: { group_id: STALL, submitted_at: T1, note: null, updated_at: T1 } };
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
  state.requests = null;
  state.note = '電源がほしい';
  try {
    localStorage.clear();
  } catch {
    // 使えなくてもよい
  }
});
afterEach(() => cleanup());

const T1 = '2026-10-29T02:00:00.654321+00:00';
const cellOf = (name: string) => document.querySelector(`[data-cell="${name}"]`)!;

async function typeCell(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const input = await screen.findByLabelText(label);
  await user.clear(input);
  await user.type(input, `${value}{Enter}`);
}

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
  it('未保存のセルの後に、ほかの人が同じセルを変えて読み直すと、読み直した値に戻して印をつけ、上書きしない（楽観ロックの基準は編集したときの行）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    expect(screen.getByRole('button', { name: '保存（2件）' })).toBeTruthy();

    // ほかの人が模擬店Aの机(木)を 4 にした（updated_at が進む）→ 読み直す
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('conflict');
    expect(cellOf('模擬店A:desk').hasAttribute('data-pending')).toBe(false);
    // ほかの人が変えていないセルの入力は残る
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '2');
    expect(cellOf('部門A:chair').getAttribute('data-pending')).toBe('true');

    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // 模擬店Aの机(木)は送らない（新しい updated_at で 5 を書かない）
    expect(writes()[0]!.ops.find((o) => o.op === 'insert')?.args[0]).toEqual({ group_id: DEPT, item_id: itemId('chair'), count: 2 });
  });

  it('戻した下書きは、編集したときの行と今の行を比べ、ほかの人が変えたセルは読み直した値に戻して印をつける', async () => {
    const user = userEvent.setup();
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    const key = (g: string, code: string) => `${g}:${itemId(code)}`;
    localStorage.setItem(
      `gaapp:draft:${USER}:${YEAR}:requests`,
      JSON.stringify({
        savedAt: Date.now() - 60_000,
        value: {
          [key(STALL, 'desk')]: { value: 5, baseCount: 3, baseUpdatedAt: T0 },
          [key(STALL, 'long_desk_3')]: { value: 0, baseCount: 2, baseUpdatedAt: T0 },
          [key(DEPT, 'chair')]: 9, // 形の違う古い下書きの値は捨てる
        },
      }),
    );
    state.handler = makeHandler();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: '戻す' }));
    await waitFor(() => expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('conflict'));
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4');
    expect(cellOf('模擬店A:long_desk_3').getAttribute('data-pending')).toBe('true');
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '0');
    expect(screen.getByRole('button', { name: '保存（1件）' })).toBeTruthy();
  });

  it('締切前の保存中はセルを編集できず、保存の後に入力が古い写しで戻らない', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    state.handler = makeHandler((call) => {
      if (call.table !== 'requests') return undefined;
      if (call.ops.some((o) => o.op === 'insert')) {
        const row = opArgs(call, 'insert')[0]![0] as { group_id: string; item_id: string; count: number };
        return { data: { ...row, updated_at: T1 } };
      }
      return undefined;
    });
    const base = state.handler;
    state.handler = (call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        return gate.then(() => ({ data: { ...REQUESTS[0]!, count: 5, updated_at: T1 } }));
      }
      return base(call);
    };
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    await user.click(screen.getByRole('button', { name: '保存（2件）' }));
    await screen.findByRole('button', { name: '保存中…' });
    // 保存中はセルを編集できない（代理入力・提出済みにするも押せない）
    const lectern = screen.getByLabelText('部門Aの教卓') as HTMLInputElement;
    expect(lectern.readOnly).toBe(true);
    expect(screen.getAllByRole('button', { name: '代理入力' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!, { group_id: DEPT, item_id: itemId('chair'), count: 2, updated_at: T1 }];
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: '保存（0件）' })).toBeTruthy());
    // 自分の保存で updated_at が進んだセルは、ほかの人の変更として扱わない
    expect(cellOf('模擬店A:desk').hasAttribute('data-mark')).toBe(false);
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
  });

  it('代理入力（締切前）：開いた後にほかの人が申請を変えていれば、送らずに読み直し、入れた数を残して上書きしてよいか確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('代理入力：模擬店A')).toBeTruthy();
    const chair = within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' });
    await user.click(chair);
    await user.click(chair);

    // シートを開いた後に、ほかの人が机(木)を 4 にし、備考を変えた
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    state.note = '電源が2つほしい';
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));

    // 送らずに確かめる
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('ほかの人が変更しました');
    expect(confirm.textContent).toContain('机(木)');
    expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(0);
    // シートは読み直した値（机(木) 4・備考）になり、入れた数（椅子(木) 2）は残る
    await waitFor(() => expect(document.getElementById(`proxy-${STALL}-desk`)).toHaveProperty('value', '4'));
    expect(document.getElementById(`proxy-${STALL}-chair`)).toHaveProperty('value', '2');
    expect(document.getElementById(`proxy-${STALL}-note`)).toHaveProperty('value', '電源が2つほしい');
    // 表も読み直す
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));

    await user.click(within(confirm).getByRole('button', { name: '上書きして提出する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(1));
    const args = opArgs(state.calls.find((c) => c.table === 'rpc:submit_requests')!, 'rpc')[0]![0] as {
      p_rows: { itemId: string; count: number }[];
      p_note: string | null;
    };
    expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(4);
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(2);
    expect(args.p_note).toBe('電源が2つほしい');
  });

  it('代理入力（締切前）：ほかの人が変えていなければ、確かめずにそのまま提出する', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
