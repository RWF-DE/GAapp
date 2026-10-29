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
  /** 締切を過ぎた年度にする */
  closed: false,
  /** 申請一覧の表の読み込みを通信の失敗にする */
  tableDown: false,
  /** 部門A の提出の記録（1件を読むときだけ。表を読んだ後にほかの人が提出したことをまねる） */
  deptSubmittedAt: null as string | null,
  /** 模擬店A の提出の記録の updated_at（自分の提出が届いたことをまねるときに進める） */
  stallSubUpdatedAt: '2026-10-29T01:02:03.123456+00:00',
  /** 1団体の申請の読み直し（代理入力の確かめ）を通信の失敗にする */
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
        const rows = [{ group_id: STALL, submitted_at: T0, note: state.note, updated_at: state.stallSubUpdatedAt, groups: { year_id: YEAR } }];
        if (call.ops.some((x) => x.op === 'maybeSingle')) {
          const id = opArgs(call, 'eq').find((a) => a[0] === 'group_id')?.[1];
          if (id === DEPT && state.deptSubmittedAt) return { data: { group_id: DEPT, submitted_at: state.deptSubmittedAt, note: null, updated_at: T1 } };
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

  it('締切前の直接の保存：通信が途切れたら読み直して確かめ、送った数になっていれば「保存されていました」', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        // 届いたが応答が返らなかった
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    await waitFor(() => expect(screen.getByTestId('save-info').textContent).toContain('保存されていました'));
    expect(screen.getByRole('button', { name: '保存（0件）' })).toBeTruthy();
    expect(cellOf('模擬店A:desk').hasAttribute('data-mark')).toBe(false);
    expect(screen.queryByTestId('save-error')).toBeNull();
  });

  it('締切前の直接の保存：通信が途切れて読み直しもできなければ、確かめるまで保存を押せない。確かめて保存されていなければ送り直せる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'requests' && call.ops.some((o) => o.op === 'update')) {
        state.tableDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain('保存できたか確かめられません'));
    // 表はそのまま（画面全体をエラーにしない）。入力は残り、保存は押せない
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
    expect((screen.getByRole('button', { name: '保存（1件）' }) as HTMLButtonElement).disabled).toBe(true);

    // 通信が戻った。保存されていなかった
    state.tableDown = false;
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain('保存されていませんでした'));
    expect(screen.queryByRole('button', { name: '確かめる' })).toBeNull();
    expect((screen.getByRole('button', { name: '保存（1件）' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '5');
  });

  it('締切後の保存：通信が途切れたら読み直して、団体の変更が届いていれば「保存されていました」', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline') {
        state.requests = [{ ...REQUESTS[0]!, count: 5, updated_at: T1 }, REQUESTS[1]!];
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await typeCell(user, '模擬店Aの机(木)', '5');
    await user.click(screen.getByRole('button', { name: '保存（1件）' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('理由（必須）'), '団体の希望');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.getByTestId('save-info').textContent).toContain('保存されていました'));
    expect(screen.getByRole('button', { name: '保存（0件）' })).toBeTruthy();
    expect(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')).toHaveLength(1);
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

  it('代理入力（締切前）：提出の通信が途切れたら、送り直さずに読み直し、送った数・備考になっていれば「保存されていました」として閉じる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        // 届いたが応答が返らなかった（椅子(木) が 1 になり、提出の記録が書き直された）
        state.requests = [...REQUESTS, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
        state.stallSubUpdatedAt = T1;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(1);
  });

  it('代理入力（締切前）：提出の通信が途切れ、読み直しもできなければ、確かめるまで提出を押せない。確かめて保存されていなければ送り直せる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests') {
        state.groupDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('保存できたか確かめられません'));
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(`proxy-${STALL}-chair`)).toHaveProperty('value', '1');

    // 通信が戻った。保存されていなかった
    state.groupDown = false;
    await user.click(within(sheet).getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('保存されていませんでした'));
    expect(within(sheet).queryByRole('button', { name: '確かめる' })).toBeNull();
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById(`proxy-${STALL}-chair`)).toHaveProperty('value', '1');
    expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(1);

    // 送り直す
    state.handler = makeHandler();
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === 'rpc:submit_requests')).toHaveLength(2));
  });

  it('代理入力（締切後）：保存の通信が途切れたら、読み直して変えた品目と提出の記録が届いていれば「保存されていました」として閉じる', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline') {
        state.requests = [...REQUESTS, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
        state.stallSubUpdatedAt = T1;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    const reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')).toHaveLength(1);
  });

  it('代理入力（締切後）：保存の通信が途切れ、読み直して届いていなければ「保存されていませんでした」と出して入力を残す', async () => {
    const user = userEvent.setup();
    state.closed = true;
    state.handler = makeHandler((call) => (call.table === 'rpc:update_requests_after_deadline' ? NETWORK : undefined));
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    const reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('保存されていませんでした'));
    expect(document.getElementById(`proxy-${STALL}-chair`)).toHaveProperty('value', '1');
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

describe('代理入力の未確定の送信（応答が届かず、保存されたか分からない。2.6）', () => {
  /** 1団体の申請の読み直し（代理入力の確かめ）の回数 */
  const groupReads = () => state.calls.filter((c) => c.table === 'requests' && opArgs(c, 'eq').some((a) => a[0] === 'group_id')).length;
  const submits = () => state.calls.filter((c) => c.table === 'rpc:submit_requests').length;
  const value = (code: string) => (document.getElementById(`proxy-${STALL}-${code}`) as HTMLInputElement).value;

  /** 代理入力で椅子(木) を 1 にして提出し、応答と読み直しを落とす（arrived なら提出は届いている） */
  async function submitUnverified(user: ReturnType<typeof userEvent.setup>, arrived: boolean) {
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:submit_requests' && submits() === 1) {
        if (arrived) {
          state.requests = [...REQUESTS, { group_id: STALL, item_id: itemId('chair'), count: 1, updated_at: T1 }];
          state.stallSubUpdatedAt = T1;
        }
        state.groupDown = true;
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('保存できたか確かめられません'));
    return sheet;
  }

  it('「確かめる」は本当に読み直し、前の送信が届いていて入力がそのままなら「保存されていました」で閉じる', async () => {
    const user = userEvent.setup();
    await submitUnverified(user, true);
    const reads = groupReads();
    state.groupDown = false;
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(groupReads()).toBe(reads + 1);
    expect(submits()).toBe(1);
  });

  it('未確定の間に入力を変え、「確かめる」で前の送信が届いていたと分かれば、閉じずに知らせて後から変えた値を残す（rebased）', async () => {
    const user = userEvent.setup();
    const sheet = await submitUnverified(user, true);
    // 未確定の間に椅子(木) を 2 にした
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    expect(value('chair')).toBe('2');
    state.groupDown = false;
    await user.click(within(sheet).getByRole('button', { name: '確かめる' }));
    await waitFor(() =>
      expect(within(sheet).getByRole('status').textContent).toContain('前に送った値は保存されていました。その後に変えた値はまだ保存していません'),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(value('chair')).toBe('2');
    expect(within(sheet).queryByRole('button', { name: '確かめる' })).toBeNull();
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(false);

    // 保存すると、届いていた記録を基準に、後から変えた値を送る（ほかの人の変更として確かめない）
    await user.click(within(sheet).getByRole('button', { name: '提出する' }));
    await waitFor(() => expect(submits()).toBe(2));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const args = opArgs(state.calls.filter((c) => c.table === 'rpc:submit_requests')[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
    expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(2);
  });

  it('「確かめる」でほかの人の保存が見つかれば「保存されていませんでした」と言い切らず、上書きするか確かめる', async () => {
    const user = userEvent.setup();
    const sheet = await submitUnverified(user, false);
    // 自分の提出は届かず、ほかの人が机(木) を 4 にした
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    state.groupDown = false;
    await user.click(within(sheet).getByRole('button', { name: '確かめる' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('ほかの人が変更しました');
    expect(confirm.textContent).toContain('机(木)');
    expect(confirm.textContent).toContain('前に送った値が保存されたかは決められません');
    // シートの知らせ（ダイアログの間は支援技術から隠れるので文字で見る）も言い切らない
    expect(sheet.textContent).toContain('前に送った値が保存されたか決められません');
    expect(sheet.textContent).not.toContain('保存されていませんでした');
    // 入れた数は残し、ほかの人の値を読み直した
    expect(value('chair')).toBe('1');
    expect(value('desk')).toBe('4');
    expect(submits()).toBe(1);
    await user.click(within(confirm).getByRole('button', { name: '上書きして提出する' }));
    await waitFor(() => expect(submits()).toBe(2));
  });

  it('締切後：確かめてほかの人の保存が見つかれば、上書きするかを確かめ、上書きするなら理由を入れて読み直した行の値で保存する', async () => {
    const user = userEvent.setup();
    state.closed = true;
    let sends = 0;
    state.handler = makeHandler((call) => {
      if (call.table === 'rpc:update_requests_after_deadline' && ++sends === 1) {
        // 自分の保存は届かず、ほかの人が机(木) を 4 にした
        state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
        return NETWORK;
      }
      return undefined;
    });
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await user.click(within(sheet).getByRole('button', { name: '理由をつけて保存・提出済みにする' }));
    let reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('前に送った値が保存されたかは決められません');
    expect(value('desk')).toBe('4');
    expect(value('chair')).toBe('1');
    await user.click(within(confirm).getByRole('button', { name: '上書きして保存する' }));
    reason = await screen.findByRole('dialog', { name: /締切後に変更する/ });
    await user.type(within(reason).getByLabelText('理由（必須）'), '代理入力');
    await user.click(within(reason).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(sends).toBe(2));
    const args = opArgs(state.calls.filter((c) => c.table === 'rpc:update_requests_after_deadline')[1]!, 'rpc')[0]![0] as {
      p_rows: { itemId: string; count: number; updatedAt?: string }[];
    };
    expect(args.p_rows).toEqual([{ itemId: itemId('chair'), count: 1 }]);
  });

  it('裏の読み直しで入力は置き換わらない（未確定でなくても）。未確定の間の裏の読み直しでも、まず送った値が入ったかを確かめる', async () => {
    const user = userEvent.setup();
    state.handler = makeHandler();
    renderScreen();
    await screen.findByTestId('requests-table');
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    let sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    // ほかの人が机(木) を 4 にし、表が裏で読み直された
    state.requests = [{ ...REQUESTS[0]!, count: 4, updated_at: T1 }, REQUESTS[1]!];
    await lastClient!.invalidateQueries();
    await waitFor(() => expect(screen.getByLabelText('模擬店Aの机(木)')).toHaveProperty('value', '4'));
    expect(value('desk')).toBe('3');
    expect(value('chair')).toBe('1');
    await user.click(within(sheet).getByRole('button', { name: 'やめる' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '捨てて閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();

    // 未確定の間：提出は届いていた。後から椅子(木) を 2 にした後で、表が裏で読み直された
    state.requests = null;
    state.calls = [];
    sheet = await submitUnverified(user, true);
    await user.click(within(sheet).getByRole('button', { name: '椅子(木)の数を1増やす' }));
    await lastClient!.invalidateQueries();
    await waitFor(() =>
      expect(within(sheet).getByRole('status').textContent).toContain('前に送った値は保存されていました。その後に変えた値はまだ保存していません'),
    );
    expect(value('chair')).toBe('2');
    expect(within(sheet).queryByRole('button', { name: '確かめる' })).toBeNull();
  });

  it('未確定の間に閉じるときは「保存されたか分かりません」と伝えて表を読み直す。読み直せなければ、開き直しても確かめるまで送り直せない', async () => {
    const user = userEvent.setup();
    await submitUnverified(user, false);
    state.tableDown = true;
    await user.keyboard('{Escape}');
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('保存されたか分からないまま閉じますか');
    await user.click(within(ask).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('proxy-notice').textContent).toContain('保存されたか分かりません'));

    // 開き直す：送った入力が戻り、確かめるまで提出を押せない
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(value('chair')).toBe('1');
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByRole('alert').textContent).toContain('確かめる');
    expect(submits()).toBe(1);

    state.tableDown = false;
    state.groupDown = false;
    await user.click(within(sheet).getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('保存されていませんでした'));
    expect((within(sheet).getByRole('button', { name: '提出する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('未確定の間に閉じ、表を読み直せたら送った値が入ったかを確かめて知らせる（入っていれば「保存されていました」）', async () => {
    const user = userEvent.setup();
    await submitUnverified(user, true);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'やめる' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.getByTestId('proxy-notice').textContent).toContain('模擬店Aの代理入力は保存されていました'));
    // 印は消え、開き直せばそのまま送れる
    await user.click(screen.getAllByRole('button', { name: '代理入力' })[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: '確かめる' })).toBeNull();
    expect(value('chair')).toBe('1');
  });
});
