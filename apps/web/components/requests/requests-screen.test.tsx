// @vitest-environment jsdom
import { INITIAL_ITEMS } from '@gaapp/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, YearRow } from '@/lib/db/types';
import { opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';

const OTHER_USER = vi.hoisted(() => '00000000-0000-4000-8000-000000000002');
const state = vi.hoisted(() => ({
  handler: null as null | ((call: FakeCall) => FakeResult | PromiseLike<FakeResult>),
  calls: [] as FakeCall[],
  role: 'admin' as 'admin' | 'head' | 'deputy_head' | 'staff',
  /** 申請の行（null なら REQUESTS。ほかの人の変更をまねるときに差し替える） */
  requests: null as null | { group_id: string; item_id: string; count: number; updated_at: string }[],
  /** 提出の記録の備考（ほかの人の変更をまねるときに差し替える） */
  note: '電源がほしい',
  /** 締切を過ぎた年度にする */
  closed: false,
  /** 申請一覧の表の読み込みを通信の失敗にする */
  tableDown: false,
  /** 部門A の提出の記録（1件を読むときだけ。表を読んだ後にほかの人が提出したことをまねる） */
  deptSubmittedAt: null as string | null,
  /** 模擬店A の提出の記録の updated_at（自分の提出が届いたことをまねるときに進める） */
  stallSubUpdatedAt: '2026-10-29T01:02:03.123456+00:00',
  /** 模擬店A の提出の記録の updated_by（自分の提出が届いたことをまねるときは USER にする） */
  stallSubUpdatedBy: OTHER_USER as string | null,
  /** 1団体の申請の読み直し（代理入力の送る前の読み直し）を通信の失敗にする */
  groupDown: false,
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
  request_close_at: new Date(Date.now() + (state.closed ? -1 : 30) * 86_400_000).toISOString(),
  prev_year_id: null,
  updated_at: T0,
});

/** 本物の PostgREST と同じく、select に挙げた列（join は表の名前）だけを返す（提出の記録の updated_by は select に入れたときだけ） */
function selected<T extends Record<string, unknown>>(call: FakeCall, row: T): Partial<T> {
  const cols = String(opArgs(call, 'select')[0]?.[0] ?? '*');
  if (cols === '*') return row;
  const names = new Set(cols.split(/,(?![^(]*\))/).map((c) => c.trim().replace(/[!(].*$/, '')));
  return Object.fromEntries(Object.entries(row).filter(([k]) => names.has(k))) as Partial<T>;
}

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
        if (state.tableDown && opArgs(call, 'eq').some((a) => a[0] === 'groups.year_id')) return NETWORK;
        if (state.groupDown && opArgs(call, 'eq').some((a) => a[0] === 'group_id')) return NETWORK;
        return { data: (state.requests ?? REQUESTS).map((r) => ({ ...r, groups: { year_id: YEAR } })) };
      case 'request_submissions': {
        const rows = [
          { group_id: STALL, submitted_at: T0, note: state.note, updated_at: state.stallSubUpdatedAt, updated_by: state.stallSubUpdatedBy, groups: { year_id: YEAR } },
        ];
        if (call.ops.some((x) => x.op === 'maybeSingle')) {
          const id = opArgs(call, 'eq').find((a) => a[0] === 'group_id')?.[1];
          if (id === DEPT && state.deptSubmittedAt) return { data: selected(call, { group_id: DEPT, submitted_at: state.deptSubmittedAt, note: null, updated_at: T1, updated_by: OTHER_USER }) };
          const { groups: _g, ...row } = rows.find((r) => r.group_id === id) ?? { groups: null };
          void _g;
          return { data: 'group_id' in row ? selected(call, row) : null };
        }
        return { data: rows.map((r) => selected(call, r)) };
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

/** 通信の失敗（supabase-js は code が空で message が TypeError…、status 0 で返す） */
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  lastClient = qc;
  return render(
    <QueryClientProvider client={qc}>
      <RequestsScreen />
    </QueryClientProvider>,
  );
}
/** 最後に描いた画面の QueryClient（裏の読み直しをまねる） */
let lastClient: QueryClient | null = null;

beforeEach(() => {
  state.calls = [];
  state.role = 'admin';
  state.requests = null;
  state.note = '電源がほしい';
  state.closed = false;
  state.tableDown = false;
  state.deptSubmittedAt = null;
  state.stallSubUpdatedAt = T0;
  state.stallSubUpdatedBy = OTHER_USER;
  state.groupDown = false;
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

  it('総務部門員は読み取りだけ（入力欄・保存がない）', async () => {
    state.role = 'staff';
    state.handler = makeHandler();
    renderScreen();
    const table = await screen.findByTestId('requests-table');
    expect(within(table).queryByLabelText('模擬店Aの机(木)')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Googleフォームの回答を取り込む' })).toBeNull();
    expect(screen.queryByRole('button', { name: '代理入力' })).toBeNull();
    expect(screen.getByTestId('read-only-notice').textContent).toBe('総務部門員は申請一覧を見るだけです');
  });

  it.each(['head', 'deputy_head'] as const)('部門長以上（%s）は管理者と同じく、セル・代理入力・提出済みにする・取り込みを使える（T15b・D-50）', async (role) => {
    state.role = role;
    state.handler = makeHandler();
    renderScreen();
    const table = await screen.findByTestId('requests-table');
    expect(within(table).getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');
    expect(within(table).getAllByRole('button', { name: '代理入力' }).length).toBeGreaterThan(0);
    expect(within(table).getAllByRole('button', { name: '提出済みにする' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Googleフォームの回答を取り込む' })).toBeTruthy();
    expect(screen.queryByTestId('read-only-notice')).toBeNull();
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
  it('未保存のセルの後に、ほかの人が同じセルを変えて表が読み直されても、入力と入力の元は残す。保存の読み直しで確かめ、上書きしない（楽観ロックの基準は編集したときの行）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    expect(screen.getByRole('button', { name: '保存（2件）' })).toBeTruthy();

    // ほかの人が模擬店Aの机(木)を 4 にした（updated_at が進む）→ 読み直す：入力は捨てない
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    const reads = state.calls.length;
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(state.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存（2件）' })).toBeTruthy());
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');
    expect(cellOf('模擬店A:desk').hasAttribute('data-mark')).toBe(false);
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '2');

    // 保存：送る前の読み直しで、入力の元（3）とも入力（5）とも違う 4 → 送らずに確かめる。「読み直す」で読み直した値に戻す
    await user.click(screen.getByRole('button', { name: '保存（2件）' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    await user.click(within(ask).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('conflict');
    expect(writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // 模擬店Aの机(木)は送らない（新しい updated_at で 5 を書かない）
    expect(writes()[0]!.ops.find((o) => o.op === 'insert')?.args[0]).toEqual({ group_id: DEPT, item_id: itemId('chair'), count: 2 });
  });

  it('戻した下書きは入れた数と編集したときの行を戻し（DB と同じになったセルだけ外す）、ほかの人が変えたセルは保存の読み直しで確かめる', async () => {
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
          [key(DEPT, 'lectern')]: { value: 0, baseCount: 1, baseUpdatedAt: T0 }, // DB と同じ数（行がない＝0）になった
          [key(DEPT, 'chair')]: 9, // 形の違う古い下書きの値は捨てる
        },
      }),
    );
    state.handler = makeHandler();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: '戻す' }));
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5'));
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');
    expect(cellOf('模擬店A:desk').hasAttribute('data-mark')).toBe(false);
    expect(cellOf('模擬店A:long_desk_3').getAttribute('data-pending')).toBe('true');
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '0');
    expect(screen.getByRole('button', { name: '保存（2件）' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '保存（2件）' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    expect(writes()).toHaveLength(0);
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
    // 送る前の読み直しの後、机(木) の更新を送っている
    await waitFor(() => expect(state.calls.some((c) => c.table === 'requests' && c.ops.some((o) => o.op === 'update'))).toBe(true));
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

  it('締切前の直接の保存：最初の失敗が conflict でも、後の forbidden で時計のずれを判断し、conflict の数も出す', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table !== 'requests') return undefined;
      if (call.ops.some((o) => o.op === 'insert')) {
        return { error: { code: '42501', message: 'new row violates row-level security policy for table "requests"' }, status: 403 };
      }
      if (opArgs(call, 'select')[0]?.[0] === 'updated_at') return { data: { updated_at: T1 } }; // 机(木)はほかの人が先に変えた
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    await user.click(screen.getByRole('button', { name: '保存（2件）' }));
    await screen.findByText(/DB が締切後と判断しました（端末の時計がずれている可能性があります）。変更は理由をつけて保存します/);
    const err = screen.getByTestId('save-error').textContent!;
    expect(err).toContain('1 件はほかの人が先に変えたので、読み直した値に戻しました');
    expect(err).toContain('DB が締切後と判断しました');
  });

  it('締切前の「提出済みにする」：表を読んだ後にほかの人が提出していれば書かない（提出日時を今に変えない）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'request_submissions' && call.ops.some((o) => ['insert', 'update', 'upsert'].includes(o.op))) {
        return { data: { group_id: DEPT, submitted_at: T1, note: null, updated_at: T1 } };
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    state.deptSubmittedAt = T0;
    await user.click(screen.getByRole('button', { name: '提出済みにする' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: '提出済みにする' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.calls.filter((c) => c.table === 'request_submissions' && c.ops.some((o) => ['insert', 'update', 'upsert'].includes(o.op)))).toHaveLength(0);
  });

  it('代理入力（締切前）：上書きの確かめの後に、もう一度ほかの人が変えていれば、送らずに最新の値でもう一度確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByTestId('proxy-conflicts').textContent).toContain('机(木)（3 → 4）');

    // 確かめている間に、ほかの人が机(木)を 6 にした
    const T2 = '2026-10-29T03:00:00.111111+00:00';
    state.requests = [{ ...REQUESTS[0]!, count: 6, updated_at: T2 }, REQUESTS[1]!];
    await user.click(within(confirm).getByRole('button', { name: '上書きして提出する' }));
    await waitFor(() => expect(screen.getByTestId('proxy-conflicts').textContent).toContain('机(木)（4 → 6）'));
    expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(0);
    await waitFor(() => expect(document.getElementById(`proxy-${STALL}-desk`)).toHaveProperty('value', '6'));

    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '上書きして提出する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(1));
    const args = opArgs(state.calls.find((c) => c.table === 'rpc:submit_requests')!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(6);
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(1);
  });

  it('代理入力（締切後）：備考を変えていなければ p_submission に備考を送らない（ほかの人が変えた備考を上書きしない）', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    const reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')).toHaveLength(1));
    const args = opArgs(state.calls.find((c) => c.table === 'rpc:update_requests_after_deadline')!, 'rpc')[0]![0] as { p_submission: unknown };
    expect(args.p_submission).toEqual({ submitted: true });
  });

  it('代理入力（締切後）：備考を変えたときだけ備考を送る', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    const note = document.getElementById(`proxy-${STALL}-note`)!;
    await user.clear(note);
    await user.type(note, '電源が2つ');
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    const reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')).toHaveLength(1));
    const args = opArgs(state.calls.find((c) => c.table === 'rpc:update_requests_after_deadline')!, 'rpc')[0]![0] as { p_submission: unknown };
    expect(args.p_submission).toEqual({ submitted: true, note: '電源が2つ' });
  });

  it('締切前の直接の保存：DB からコードつきで返った知らないエラーは届いた失敗として出し、「保存できたか分かりません」にしない', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) =>
      call.table === 'requests' && call.ops.some((o) => o.op === 'update')
        ? { error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }
        : undefined,
    );
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain('コード：57014'));
    expect(screen.getByTestId('save-error').textContent).toContain('1 件は保存できませんでした');
    expect(screen.getByTestId('save-error').textContent).not.toContain('分かりません');
    expect(screen.getByTestId('save-error').textContent).not.toContain('保存されていませんでした');
  });

  it('代理入力：未保存の入力があれば、Esc で閉じる前に確かめる。送信中は閉じない', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    state.handler = makeHandler();
    const base = state.handler;
    state.handler = (call) => (call.table === 'rpc:submit_requests' ? gate.then(() => base(call)) : base(call));
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));

    await user.keyboard('{Escape}');
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('入力を捨てて閉じますか');
    await user.click(within(ask).getByRole('button', { name: '入力に戻る' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.getElementById(`proxy-${STALL}-chair`)).toHaveProperty('value', '1');

    // 送信中は Esc でも閉じない
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '提出する' }));
    await screen.findByRole('button', { name: '保存中…' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('代理入力：入力がなければ確かめずに閉じる。「やめる」も入力があれば確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: 'やめる' }));
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('保存の応答が届かなかったとき（数を絶対値で書く書き込み。設計 2.6 の (A)）', () => {
  const UNKNOWN = '保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります';
  const UNKNOWN_SUBMIT = '提出できたか分かりません。もう一度「提出」を押すと、確かめてから送ります';
  const submits = () => state.calls.filter((c) => c.table === 'rpc:submit_requests').length;
  const deadlines = () => state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline').length;
  /** 申請一覧の表の読み込みの回数 */
  const tableReads = () => state.calls.filter((c) => c.table === 'requests' && opArgs(c, 'eq').some((a) => a[0] === 'groups.year_id')).length;
  const value = (code: string) => (document.getElementById(`proxy-${STALL}-${code}`) as HTMLInputElement).value;
  const saveButton = (n: number) => screen.getByRole('button', { name: `保存（${n}件）` }) as HTMLButtonElement;

  /** 自分の提出（椅子(木) を 1 に）が DB に届いたことにする（提出の記録は自分が書き直した） */
  const arriveMySubmit = () => {
    state.requests = [...REQUESTS, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
    state.stallSubUpdatedAt = T1;
    state.stallSubUpdatedBy = USER;
  };

  async function openProxy(user: ReturnType<typeof userEvent.setup>) {
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    return sheet;
  }

  async function giveReason(user: ReturnType<typeof userEvent.setup>) {
    const reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
  }

  it('申請一覧（締切前）：応答が落ちたら入力を残して知らせる（押せないボタン・「確かめる」は出さない）。もう一度押すと読み直し、DB に入っていれば送らずに「保存されていました」', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        // 届いたが応答が返らず、保存の後の読み直しも落ちた
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        state.tableDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(saveButton(1).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '確かめる' })).toBeNull();

    state.tableDown = false;
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-info').textContent).toContain('保存されていました'));
    expect(writes()).toHaveLength(1);
    expect(saveButton(0)).toBeTruthy();
    expect(cellOf('模擬店A:desk').hasAttribute('data-mark')).toBe(false);
  });

  it('申請一覧（締切前）：応答が落ち、保存の後の読み直しでほかの人の数（入力の元とも入力とも違う）が見つかっても、入力と印を残して「分かりません」と出す（保存したと数えない）。もう一度押すと確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        // 自分の書き込みは通らず（応答も届かず）、ほかの人が 4 にした
        state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    const err = screen.getByTestId('save-error').textContent!;
    expect(err).toContain('0 件を保存しました');
    expect(err).toContain('1 件は保存できたか分かりません');
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('error');

    await user.click(saveButton(1));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    expect(writes()).toHaveLength(1);
  });

  it('申請一覧（締切後）：応答が落ち、保存の後の読み直しでほかの人の数が見つかっても、入力を残して「分かりません」と出す。もう一度押すと確かめる', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline') {
        state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    const err = screen.getByTestId('save-error').textContent!;
    expect(err).toContain('0 団体を保存しました');
    expect(err).toContain('1 団体は保存できたか分かりません');
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('error');

    await user.click(saveButton(1));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    expect(deadlines()).toBe(1);
  });

  it('申請一覧：応答が落ちた（DB には入っている）後に入力を変えると、表が読み直されても（読み直す・通信が戻る）入力が残る。保存では値で決めて確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        state.tableDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    await typeCell(user, '模擬店Aの机(木)', '7');

    // 「読み直す」と、裏の読み直し（通信が戻ったとき）：入力の 7 は自分の 5 に戻らない
    state.tableDown = false;
    const reads = tableReads();
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(tableReads()).toBeGreaterThan(reads));
    await lastClient!.invalidateQueries();
    await waitFor(() => expect(tableReads()).toBeGreaterThan(reads + 1));
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '7');
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).not.toBe('conflict');
    expect(saveButton(1)).toBeTruthy();

    // 保存：セルは書いた人を持たないので値で決める（5 は入力の元 3 とも入力 7 とも違う → 確かめる。notes/T11.md の決めたこと 33）
    await user.click(saveButton(1));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 5（入れた数 7）');
    expect(writes()).toHaveLength(1);
  });

  it('申請一覧：応答が落ち（DB には入っている）、保存の後の読み直しも落ちた後にセルを元の数へ戻しても、入力と下書きを残す。表が読み直されると保存でき、値で確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        state.tableDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    await typeCell(user, '模擬店Aの机(木)', '3');
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');
    // 古い表と同じ数でも未保存のセルとして数え、色をつけ、保存・取り消しを押せる（知らせの「もう一度「保存」を押すと」が押せる）
    expect(saveButton(1).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '変更を取り消す' }) as HTMLButtonElement).disabled).toBe(false);
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');
    // 下書きにも残る（画面を離れても戻せる）
    await waitFor(() => expect(localStorage.length).toBeGreaterThan(0));

    // 読み直しが落ちたまま押す：送らずに知らせて入力を残す
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toBe(UNKNOWN));
    expect(writes()).toHaveLength(1);
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');

    // 通信が戻って表が読み直される：DB の 5 を出さず、入れた 3 を残す
    state.tableDown = false;
    const reads = tableReads();
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(tableReads()).toBeGreaterThan(reads));
    await waitFor(() => expect(saveButton(1)).toBeTruthy());
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');
    expect(cellOf('模擬店A:desk').getAttribute('data-pending')).toBe('true');

    // 保存：セルは書いた人を持たないので値で決める（5 は入力の元 3 とも入力 3 とも違う → 確かめる。決めたこと 33）
    await user.click(saveButton(1));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 5（入れた数 3）');
    await user.click(within(ask).getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(opArgs(writes()[1]!, 'update')[0]![0]).toEqual({ count: 3 });
  });

  it('申請一覧：ほかの人が変えて表が読み直された後に、セルを入力の元の数へ戻しても入力を残す（読み直した数にしない）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    const reads = tableReads();
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(tableReads()).toBeGreaterThan(reads));
    await typeCell(user, '模擬店Aの机(木)', '3');
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '3');
    await user.click(saveButton(1));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 3）');
    expect(writes()).toHaveLength(0);
  });

  it('申請一覧（締切前）：応答が落ち、DB に入っていなければ、もう一度押すと送る', async () => {
    const user = userEvent.setup();
    let n = 0;
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update') && n++ === 0) return NETWORK;
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) return { data: { ...REQUESTS[0]!, count: 5, updated_at: T1 } };
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    await user.click(saveButton(1));
    await waitFor(() => expect(writes()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('save-error')).toBeNull());
  });

  it('申請一覧：送る前の読み直しが通信できなければ、送らずに知らせて入力を残す', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    state.tableDown = true;
    await user.click(saveButton(1));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toBe(UNKNOWN));
    expect(writes()).toHaveLength(0);
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(saveButton(1).disabled).toBe(false);
  });

  it('申請一覧：送る前の読み直しでほかの人の変更（数が入力の元とも入れた数とも違う）が見つかれば、送らずに確かめる。「読み直す」で読み直した値に戻して印をつける', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await user.click(saveButton(2));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    expect(writes()).toHaveLength(0);
    await user.click(within(ask).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('conflict');
    // ほかの人が変えていないセルは残る（黙って送らない）
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '2');
    expect(writes()).toHaveLength(0);
  });

  it('申請一覧：ほかの人の変更を「上書きして保存する」と、もう一度読み直してから読み直した行の updated_at で送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) =>
      call.table === 'requests' && call.ops.some((o) => o.op === 'update') ? { data: { ...REQUESTS[0]!, count: 5, updated_at: T1 } } : undefined,
    );
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await user.click(saveButton(1));
    const ask = await screen.findByRole('alertdialog');
    const reads = tableReads();
    await user.click(within(ask).getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(tableReads()).toBeGreaterThan(reads);
    expect(opArgs(writes()[0]!, 'eq')).toContainEqual(['updated_at', T1]);
    expect(opArgs(writes()[0]!, 'update')[0]![0]).toEqual({ count: 5 });
  });

  it('申請一覧：「上書きして保存する」の読み直しで、またほかの人が変えていれば、送らずにダイアログを開いたまま最新の値で確かめ直す（入力は捨てない）', async () => {
    const user = userEvent.setup();
    const T2 = '2026-10-29T03:00:00.111111+00:00';
    state.handler = makeHandler((call) =>
      call.table === 'requests' && call.ops.some((o) => o.op === 'update') ? { data: { ...REQUESTS[0]!, count: 5, updated_at: T2 } } : undefined,
    );
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await user.click(saveButton(1));
    let ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：3 → 4（入れた数 5）');
    // ダイアログを見ている間に、ほかの人が 6 にした
    state.requests = [{ ...REQUESTS[0]!, count: 6, updated_at: T2 }, REQUESTS[1]!];
    await user.click(within(ask).getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(within(screen.getByRole('alertdialog')).getByTestId('cell-conflicts').textContent).toBe('模擬店Aの机(木)：4 → 6（入れた数 5）'));
    expect(writes()).toHaveLength(0);
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).not.toBe('conflict');

    // もう一度「上書きして保存する」：読み直した行の updated_at で送る
    ask = screen.getByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: '上書きして保存する' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(opArgs(writes()[0]!, 'eq')).toContainEqual(['updated_at', T2]);
    expect(opArgs(writes()[0]!, 'update')[0]![0]).toEqual({ count: 5 });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('申請一覧（締切後）：応答が落ちた後、もう一度保存すると読み直し、団体の変更が DB に入っていれば送らずに「保存されていました」', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline') {
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        state.tableDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(saveButton(1));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain(UNKNOWN));
    state.tableDown = false;
    await user.click(saveButton(1));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.getByTestId('save-info').textContent).toContain('保存されていました'));
    expect(deadlines()).toBe(1);
  });

  it('代理入力（締切前）：応答が落ちたら入力を残して知らせる。もう一度押すと読み直し、自分の提出が DB に入っていれば送らずに「保存されていました」で閉じる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    expect(value('chair')).toBe('1');
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(sheet).queryByRole('button', { name: '確かめる' })).toBeNull();

    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submits()).toBe(1);
    // 自分の提出（updated_by が自分）なので、ほかの人の変更の確かめは出ない
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('代理入力（締切前）：応答が落ち、DB に入っていなければ、もう一度押すと送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => (call.table === 'rpc:submit_requests' && submits() === 1 ? NETWORK : undefined));
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submits()).toBe(2);
    const args = opArgs(state.calls.filter((c) => c.table === 'rpc:submit_requests')[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(1);
  });

  it('代理入力：送る前の読み直しが通信できなければ、送らずに知らせて入力を残す', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    const sheet = await openProxy(user);
    state.groupDown = true;
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    expect(submits()).toBe(0);
    expect(value('chair')).toBe('1');
  });

  it('代理入力：提出の記録がほかの人に書き直されていれば（updated_by が自分でない）、数・備考が同じでも上書きするか確かめる。自分が書き直したものなら確かめずに送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    let sheet = await openProxy(user);
    // ほかの人が同じ内容で出し直した（提出の記録の updated_at だけが進んだ）
    state.stallSubUpdatedAt = T1;
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('proxy-conflicts').textContent).toBe('提出の記録');
    expect(submits()).toBe(0);
    await user.click(within(ask).getByRole('button', { name: '提出しないで見直す' }));
    await user.click(within(sheet).getByRole('button', { name: 'やめる' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();

    // 同じことを自分がしていた（前に送った提出の応答が届かなかったなど）：ほかの人の変更として扱わない
    state.calls = [];
    state.stallSubUpdatedAt = T0;
    sheet = await openProxy(user);
    state.stallSubUpdatedAt = T1;
    state.stallSubUpdatedBy = USER;
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submits()).toBe(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('代理入力（締切後）：応答が落ちた後、もう一度保存すると読み直し、DB に入っていれば送らずに「保存されていました」で閉じる', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline') {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    await giveReason(user);
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN));
    expect(value('chair')).toBe('1');
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    await giveReason(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deadlines()).toBe(1);
  });

  it('代理入力（締切前）：応答が落ちる（DB には入っている）→ 入力を変える → 提出：自分の提出はほかの人の変更にせず、確かめずに送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests' && submits() === 1) {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submits()).toBe(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const args = opArgs(state.calls.filter((c) => c.table === 'rpc:submit_requests')[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(2);
  });

  it('代理入力（締切前）：自分の提出が通った後に、ほかの人が品目の行だけを変えていれば、その品目だけを出して確かめる（「提出日時・備考」は出さない）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    // その後にほかの人が机(木) を 4 にした
    const T2 = '2026-10-29T03:00:00.111111+00:00';
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T2 }, REQUESTS[1]!, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    const ask = await screen.findByRole('alertdialog');
    const text = within(ask).getByTestId('proxy-conflicts').textContent!;
    expect(text).toContain('机(木)（3 → 4）');
    expect(text).not.toContain('提出');
    expect(text).not.toContain('備考');
    expect(text).not.toContain('椅子(木)');
    expect(submits()).toBe(1);
  });

  it('代理入力（締切前）：応答が落ちる（DB には入っている）→ 椅子を元の 0 に戻して提出 → また応答が落ちる：欄は 0 のまま。もう一度押すと送らずに閉じる', async () => {
    const user = userEvent.setup();
    const T2 = '2026-10-29T03:00:00.111111+00:00';
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        // 届いたが応答が返らなかった（2回とも。2回目は椅子(木) 0）
        const rows = (opArgs(call, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] }).p_rows;
        const at = submits() === 1 ? T1 : T2;
        state.requests = [...REQUESTS, { group_id: STALL, item_id: itemId('chair'), count: rows.find((r) => r.itemId === itemId('chair'))!.count, updated_at: at }];
        state.stallSubUpdatedAt = at;
        state.stallSubUpdatedBy = USER;
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1減らす' }));
    expect(value('chair')).toBe('0');
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submits()).toBe(2));
    const second = opArgs(state.calls.filter((c) => c.table === 'rpc:submit_requests')[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(second.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(0);
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    expect(value('chair')).toBe('0');

    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submits()).toBe(2);
  });

  it('代理入力（締切前）：応答が落ちる（DB には入っている）→ 椅子を元の 0 に戻す → ほかの人が机を変える → 提出：確かめのダイアログでも欄の椅子は 0 のまま。上書きすると椅子 0 を送る', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests' && submits() === 1) {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1減らす' }));
    // その後にほかの人が机(木) を 4 にした
    const T2 = '2026-10-29T03:00:00.111111+00:00';
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T2 }, REQUESTS[1]!, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('proxy-conflicts').textContent).toContain('机(木)（3 → 4）');
    expect(value('chair')).toBe('0');
    expect(value('desk')).toBe('4');
    await user.click(within(ask).getByRole('button', { name: '上書きして提出する' }));
    await waitFor(() => expect(submits()).toBe(2));
    const args = opArgs(state.calls.filter((c) => c.table === 'rpc:submit_requests')[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(0);
    expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(4);
  });

  it('代理入力：保存できたか分からないまま閉じるときは確かめ、閉じたら表を読み直す（開き直すと入力は残っていない）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => (call.table === 'rpc:submit_requests' ? NETWORK : undefined));
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));

    await user.keyboard('{Escape}');
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('保存できたか分かりません。閉じると入力は消えます（表を読み直します）');
    const reads = tableReads();
    await user.click(within(ask).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(tableReads()).toBe(reads + 1));

    // 開き直すと表の行から始まる（送った入力も知らせも持ち回さない）
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const again = await screen.findByRole('dialog');
    expect(value('chair')).toBe('0');
    expect(within(again).queryByRole('alert')).toBeNull();
    expect(submits()).toBe(1);
  });

  it('代理入力：裏の表の読み直しでは入力の元も入力も置き換わらない（送る前の読み直しでほかの人の変更として確かめる）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    const sheet = await openProxy(user);
    // ほかの人が机(木) を 4 にし、表が裏で読み直された
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await lastClient!.invalidateQueries();
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));
    expect(value('desk')).toBe('3');
    expect(value('chair')).toBe('1');
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByTestId('proxy-conflicts').textContent).toContain('机(木)（3 → 4）');
    expect(submits()).toBe(0);
  });

  it('代理入力：触った後に裏で届いた行は、入力を置き換えず知らせる。「ほかの人の値を読み込む」で変わった品目だけを取り、入れた数は残す（R1）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    const sheet = await openProxy(user);
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await lastClient!.invalidateQueries();
    const notice = await within(sheet).findByTestId('proxy-remote-change');
    expect(notice.textContent).toContain('机(木)（3 → 4）');
    expect(value('desk')).toBe('3');
    expect(value('chair')).toBe('1');

    await user.click(within(notice).getByRole('button', { name: 'ほかの人の値を読み込む' }));
    expect(within(sheet).queryByTestId('proxy-remote-change')).toBeNull();
    expect(value('desk')).toBe('4');
    expect(value('chair')).toBe('1');
    // 読み込んだ後の提出は確かめずに送る
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submits()).toBe(1));
    const args = opArgs(state.calls.find((c) => c.table === 'rpc:submit_requests')!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(4);
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(1);
  });

  it('代理入力：応答が落ちた自分の提出が表の読み直しで届いても、ほかの人の変更として知らせない', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        arriveMySubmit();
        return NETWORK;
      }
      return undefined;
    });
    const sheet = await openProxy(user);
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toBe(UNKNOWN_SUBMIT));
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    const reads = tableReads();
    await lastClient!.invalidateQueries();
    await waitFor(() => expect(tableReads()).toBeGreaterThan(reads));
    await waitFor(() => expect(lastClient!.isFetching()).toBe(0));
    expect(within(sheet).queryByTestId('proxy-remote-change')).toBeNull();
    expect(value('chair')).toBe('2');
  });

  it('代理入力：触る前に裏で届いた行は、そのままシートに出す（知らせは出さない）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await lastClient!.invalidateQueries();
    await waitFor(() => expect(value('desk')).toBe('4'));
    expect(within(sheet).queryByTestId('proxy-remote-change')).toBeNull();
    // そのまま提出すると、届いた行と比べるので確かめない
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submits()).toBe(1));
  });

  it('申請一覧：未保存のセルの行が裏で変わったら、入力を置き換えず知らせる。「変わったセルを読み直した値に戻す」で戻して印をつける（R1）', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await typeCell(user, '部門Aの椅子(木)', '2');
    expect(screen.queryByTestId('requests-remote-change')).toBeNull();
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await lastClient!.invalidateQueries();
    const notice = await screen.findByTestId('requests-remote-change');
    expect(notice.textContent).toContain('模擬店Aの机(木)：3 → 4（入れた数 5）');
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect(saveButton(2)).toBeTruthy();

    await user.click(within(notice).getByRole('button', { name: '変わったセルを読み直した値に戻す' }));
    expect(screen.queryByTestId('requests-remote-change')).toBeNull();
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4');
    expect(cellOf('模擬店A:desk').getAttribute('data-mark')).toBe('conflict');
    expect(screen.getByLabelText('部門Aの椅子(木)')).toHaveProperty('value', '2');
    expect(saveButton(1)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });
});
