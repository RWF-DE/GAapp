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
  /** 模擬店A の提出の記録（null なら未提出。ほかの人・自分の提出をまねるときに差し替える） */
  submission: null as null | { group_id: string; submitted_at: string | null; note: string | null; updated_at: string; updated_by: string | null },
  /** 申請と提出の記録の読み込みを通信の失敗にする */
  down: false,
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { toast } = await import('sonner');

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

/** 本物の PostgREST と同じく、select に挙げた列だけを返す（提出の記録の updated_by は select に入れたときだけ） */
function selected<T extends Record<string, unknown>>(call: FakeCall, row: T | null): Partial<T> | null {
  if (!row) return row;
  const cols = String(opArgs(call, 'select')[0]?.[0] ?? '*');
  if (cols === '*') return row;
  const names = new Set(cols.split(',').map((c) => c.trim()));
  return Object.fromEntries(Object.entries(row).filter(([k]) => names.has(k))) as Partial<T>;
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
        if (state.down) return NETWORK;
        return { data: (opts.requests ?? []).filter((r) => r.group_id === eqValue(call, 'group_id')) };
      case 'request_submissions':
        if (state.down) return NETWORK;
        return { data: eqValue(call, 'group_id') === STALL ? selected(call, state.submission) : null };
      case 'rpc:submit_requests':
        return opts.submit ?? { data: { group_id: STALL, submitted_at: new Date().toISOString(), note: null, updated_at: T0 } };
      default:
        throw new Error(`想定していない問い合わせ：${call.table}`);
    }
  };
}

/** 通信の失敗（supabase-js は code が空で message が TypeError…、status 0 で返す） */
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

/** 最後に描いた画面の QueryClient（裏の読み直しをまねる） */
let lastClient: QueryClient | null = null;

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  lastClient = qc;
  return render(
    <QueryClientProvider client={qc}>
      <RequestScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
  state.search = '';
  state.submission = null;
  state.down = false;
  vi.mocked(toast.success).mockClear();
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

  describe('提出の応答が届かなかったとき（設計 2.6 の (A)）', () => {
    const UNKNOWN = '提出できたか分かりません。もう一度「提出」を押すと、確かめてから送ります';
    const T1 = '2026-10-29T02:00:00.654321+00:00';
    const OTHER_USER = '00000000-0000-4000-8000-000000000004';

    /** 机(木) を 1 にして提出する（確認のダイアログまで） */
    async function submitDesk(user: ReturnType<typeof userEvent.setup>, first = true) {
      if (first) await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      await user.click(screen.getByRole('button', { name: /^(提出|修正して再提出)$/ }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '提出する' }));
    }

    it('応答が落ちたら入力を残して知らせる。もう一度押すと読み直し、自分の提出が DB に入っていれば送らずに「提出されていました」', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      const base = makeHandler({ requests: rows, submit: NETWORK });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests') {
          // 届いたが応答が返らなかった（表示した品目すべてが書かれ、提出の記録は自分が書いた）
          for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'desk' ? 1 : 0, updated_at: T1 });
          state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: USER };
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
      expect((screen.getByRole('button', { name: '提出' }) as HTMLButtonElement).disabled).toBe(false);

      await submitDesk(user, false);
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('提出されていました'));
      expect(submitCalls()).toHaveLength(1);
      expect(screen.queryByTestId('submit-error')).toBeNull();
    });

    /** 画面のクエリの読み直し（団体の行から読む）を止める。返すのは止めたものを流す関数 */
    function holdScreenReload(base: (call: FakeCall) => FakeResult) {
      let held = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      state.handler = ((call: FakeCall) => (held && call.table === 'groups' ? gate.then(() => base(call)) : base(call))) as never;
      return {
        hold: () => {
          held = true;
        },
        release: () => release(),
      };
    }

    it('応答が落ちる（DB には入っている）→ もう一度押して「提出されていました」：画面の読み直しが返る前でも、欄は DB の値で「提出済み」。その間に入れても保存済みの数を消さない', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      const base = makeHandler({ requests: rows });
      const gate = holdScreenReload((call) => {
        if (call.table === 'rpc:submit_requests') {
          for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'desk' ? 1 : i.code === 'chair' ? 2 : 0, updated_at: T1 });
          state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: USER };
          return NETWORK;
        }
        return base(call);
      });
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      await user.click(screen.getByRole('button', { name: '椅子(木)の数を1増やす' }));
      await user.click(screen.getByRole('button', { name: '椅子(木)の数を1増やす' }));
      await submitDesk(user, false);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);

      gate.hold();
      await submitDesk(user, false);
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('提出されていました'));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
      expect(document.getElementById('request-chair')).toHaveProperty('value', '2');
      expect(screen.getByTestId('request-submitted').textContent).toMatch(/^提出済み/);

      // 読み直しが遅い間に机を足す → 読み直しが届く → 提出：椅子は保存済みの 2 のまま送る
      await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
      gate.release();
      await waitFor(() => expect(state.calls.filter((c) => c.table === 'groups').length).toBeGreaterThan(1));
      expect(document.getElementById('request-chair')).toHaveProperty('value', '2');
      await submitDesk(user, false);
      await waitFor(() => expect(submitCalls()).toHaveLength(2));
      const args = opArgs(submitCalls()[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
      expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(2);
      expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(2);
    });

    it('送って成功したら、画面の読み直しが返るまで確かめのダイアログを「送信中…」で開いておき、返った後は DB の値を出す', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      const base = makeHandler({ requests: rows });
      const gate = holdScreenReload((call) => {
        if (call.table === 'rpc:submit_requests') {
          for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'desk' ? 1 : 0, updated_at: T1 });
          state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: USER };
        }
        return base(call);
      });
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      gate.hold();
      await submitDesk(user, false);
      await waitFor(() => expect(submitCalls()).toHaveLength(1));
      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: '送信中…' })).toBeTruthy();
      expect(screen.getByTestId('request-submitted').textContent).toBe('未提出');

      gate.release();
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.getByTestId('request-submitted').textContent).toMatch(/^提出済み/);
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
    });

    it('応答が落ち、DB に入っていなければ、もう一度押すと送る', async () => {
      const user = userEvent.setup();
      let n = 0;
      const base = makeHandler();
      state.handler = (call) => (call.table === 'rpc:submit_requests' && n++ === 0 ? NETWORK : base(call));
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      await submitDesk(user, false);
      await waitFor(() => expect(submitCalls()).toHaveLength(2));
      await waitFor(() => expect(vi.mocked(toast.success).mock.calls.some(([m]) => String(m).startsWith('提出しました（'))).toBe(true));
      expect(screen.queryByTestId('submit-error')).toBeNull();
    });

    it('送る前の読み直しが通信できなければ、送らずに知らせて入力を残す', async () => {
      const user = userEvent.setup();
      state.handler = makeHandler();
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      state.down = true;
      await submitDesk(user, false);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      expect(submitCalls()).toHaveLength(0);
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
    });

    it('ほかの人の提出（updated_by が自分でない）が見つかれば送らずに確かめ、上書きすると送る。自分の提出なら確かめない', async () => {
      const user = userEvent.setup();
      state.handler = makeHandler();
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: OTHER_USER };
      await submitDesk(user, false);
      const ask = await screen.findByRole('alertdialog', { name: /ほかの人が提出しています。上書きしますか/ });
      expect(submitCalls()).toHaveLength(0);
      await user.click(within(ask).getByRole('button', { name: '上書きして提出する' }));
      await waitFor(() => expect(submitCalls()).toHaveLength(1));
      const args = opArgs(submitCalls()[0]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
      expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(1);
    });

    /** 自分の提出（机(木) desk、ほかは 0）が DB に届いたことにする（行と提出の記録は同じトランザクションの時刻 at） */
    const arriveMine = (rows: RequestDbRow[], desk: number, at: string) => {
      rows.length = 0;
      for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'desk' ? desk : 0, updated_at: at });
      state.submission = { group_id: STALL, submitted_at: at, note: null, updated_at: at, updated_by: USER };
    };
    const T2 = '2026-10-29T03:00:00.111111+00:00';

    it('応答が落ちる（DB には入っている）→ 入力を変える → 提出：自分の提出はほかの人の変更にせず、確かめずに送る', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      let n = 0;
      const base = makeHandler({ requests: rows });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests' && n++ === 0) {
          arriveMine(rows, 1, T1);
          return NETWORK;
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
      await submitDesk(user, false);
      await waitFor(() => expect(submitCalls()).toHaveLength(2));
      expect(screen.queryByRole('alertdialog', { name: /上書きしますか/ })).toBeNull();
      const args = opArgs(submitCalls()[1]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
      expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(2);
    });

    it('自分の提出が通った後に、ほかの人が品目の行だけを変えていれば「ほかの人がこの団体の申請を変えました」で確かめる（ほかの人の提出とは言わない）', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      const base = makeHandler({ requests: rows });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests') {
          arriveMine(rows, 1, T1);
          return NETWORK;
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      // その後にほかの人が椅子(木) を 3 にした（行だけ。提出の記録は自分のまま）
      const chair = rows.findIndex((r) => r.item_id === itemId('chair'));
      rows[chair] = { ...rows[chair]!, count: 3, updated_at: T2 };
      await submitDesk(user, false);
      const ask = await screen.findByRole('alertdialog', { name: 'ほかの人がこの団体の申請を変えました。上書きしますか' });
      expect(within(ask).getByTestId('request-conflicts').textContent).toBe('椅子(木)（0 → 3）');
      expect(submitCalls()).toHaveLength(1);
    });

    it('応答が落ちる → 画面を離れる → ほかの人が提出 → 下書きを戻して提出：送らずにほかの人の提出を確かめる', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      const base = makeHandler({ requests: rows });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests') {
          arriveMine(rows, 1, T1);
          return NETWORK;
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      cleanup();

      // 離れている間に、ほかの代表者が机(木) 2 で提出した
      for (const r of rows) if (r.item_id === itemId('desk')) Object.assign(r, { count: 2, updated_at: T2 });
      state.submission = { group_id: STALL, submitted_at: T2, note: null, updated_at: T2, updated_by: OTHER_USER };
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '戻す' }));
      await waitFor(() => expect(document.getElementById('request-desk')).toHaveProperty('value', '1'));
      await submitDesk(user, false);
      await screen.findByRole('alertdialog', { name: /ほかの人が提出しています。上書きしますか/ });
      expect(submitCalls()).toHaveLength(1);
    });

    it('机を 0 → 1 にして離れる → ほかの人が 2 にする → 戻って下書きを戻して提出：送らずに確かめる', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      state.handler = makeHandler({ requests: rows });
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
      cleanup();

      rows.push({ group_id: STALL, item_id: itemId('desk'), count: 2, updated_at: T1 });
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '戻す' }));
      await waitFor(() => expect(document.getElementById('request-desk')).toHaveProperty('value', '1'));
      await submitDesk(user, false);
      const ask = await screen.findByRole('alertdialog', { name: 'ほかの人がこの団体の申請を変えました。上書きしますか' });
      expect(within(ask).getByTestId('request-conflicts').textContent).toBe('机(木)（0 → 2）');
      expect(submitCalls()).toHaveLength(0);
    });

    /** 送った机(木) の数 */
    const sentDesk = (call: FakeCall) =>
      (opArgs(call, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] }).p_rows.find((r) => r.itemId === itemId('desk'))!.count;

    it('応答が落ちる（DB には入っている）→ 机を元の 0 に戻して提出 → また応答が落ちる：欄は 0 のまま（読み直した自分の古い 1 にしない）。もう一度押すと「提出されていました」', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      let n = 0;
      const base = makeHandler({ requests: rows });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests') {
          // 届いたが応答が返らなかった（2回とも）
          arriveMine(rows, sentDesk(call), n++ === 0 ? T1 : T2);
          return NETWORK;
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
      expect(document.getElementById('request-desk')).toHaveProperty('value', '0');
      await submitDesk(user, false);
      await waitFor(() => expect(submitCalls()).toHaveLength(2));
      expect(sentDesk(submitCalls()[1]!)).toBe(0);
      await waitFor(() => expect(screen.getByTestId('submit-error').textContent).toBe(UNKNOWN));
      expect(document.getElementById('request-desk')).toHaveProperty('value', '0');

      await submitDesk(user, false);
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('提出されていました'));
      expect(submitCalls()).toHaveLength(2);
    });

    it('応答が落ちる（DB には入っている）→ 机を元の 0 に戻す → ほかの人が椅子を変える → 提出：確かめのダイアログでも欄の机は 0 のまま。上書きすると机 0 を送る', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      let n = 0;
      const base = makeHandler({ requests: rows });
      state.handler = (call) => {
        if (call.table === 'rpc:submit_requests' && n++ === 0) {
          arriveMine(rows, 1, T1);
          return NETWORK;
        }
        return base(call);
      };
      renderScreen();
      await submitDesk(user);
      expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
      await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
      // ほかの人が椅子(木) を 3 にした（行だけ）
      const chair = rows.findIndex((r) => r.item_id === itemId('chair'));
      rows[chair] = { ...rows[chair]!, count: 3, updated_at: T2 };
      await submitDesk(user, false);
      const ask = await screen.findByRole('alertdialog', { name: 'ほかの人がこの団体の申請を変えました。上書きしますか' });
      expect(within(ask).getByTestId('request-conflicts').textContent).toBe('椅子(木)（0 → 3）');
      expect(document.getElementById('request-desk')).toHaveProperty('value', '0');
      expect(document.getElementById('request-chair')).toHaveProperty('value', '3');
      await user.click(within(ask).getByRole('button', { name: '上書きして提出する' }));
      await waitFor(() => expect(submitCalls()).toHaveLength(2));
      expect(sentDesk(submitCalls()[1]!)).toBe(0);
    });

    it('机を 0 → 1 にする → ほかの人が 2 にし椅子を 3 にする → 通信が戻ってクエリが読み直される → 提出：入力の元は変わらず、送らずに確かめる', async () => {
      const user = userEvent.setup();
      const rows: RequestDbRow[] = [];
      state.handler = makeHandler({ requests: rows });
      renderScreen();
      await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));

      rows.push({ group_id: STALL, item_id: itemId('desk'), count: 2, updated_at: T1 }, { group_id: STALL, item_id: itemId('chair'), count: 3, updated_at: T1 });
      const reads = state.calls.filter((c) => c.table === 'requests').length;
      await lastClient!.invalidateQueries();
      await waitFor(() => expect(state.calls.filter((c) => c.table === 'requests').length).toBeGreaterThan(reads));
      // 表示は入れた数と、編集を始めたときの値のまま（裏の読み直しで入力の元を置き換えない）
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
      expect(document.getElementById('request-chair')).toHaveProperty('value', '0');
      await submitDesk(user, false);
      const ask = await screen.findByRole('alertdialog', { name: 'ほかの人がこの団体の申請を変えました。上書きしますか' });
      expect(within(ask).getByTestId('request-conflicts').textContent).toContain('机(木)（0 → 2）');
      expect(submitCalls()).toHaveLength(0);
      // 確かめの後は読み直した値になり、入れた数は残る
      await waitFor(() => expect(document.getElementById('request-chair')).toHaveProperty('value', '3'));
      expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
    });

    describe('裏で届いた行（R1：触った後は入力を置き換えず、知らせだけを出す）', () => {
      /** ほかの人が椅子を 3 にして提出し直したことにして、画面のクエリを裏で読み直す */
      async function otherSubmitsInBackground(rows: RequestDbRow[]) {
        rows.push({ group_id: STALL, item_id: itemId('chair'), count: 3, updated_at: T1 });
        state.submission = { group_id: STALL, submitted_at: T1, note: '電源', updated_at: T1, updated_by: OTHER_USER };
        const reads = state.calls.filter((c) => c.table === 'requests').length;
        await lastClient!.invalidateQueries();
        await waitFor(() => expect(state.calls.filter((c) => c.table === 'requests').length).toBeGreaterThan(reads));
      }

      it('編集した後に届いた行は入力も「提出」の欄も置き換えず、知らせを出す。「ほかの人の値を読み込む」で変わった品目と備考だけを取る', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [];
        state.handler = makeHandler({ requests: rows });
        renderScreen();
        await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
        await otherSubmitsInBackground(rows);

        const notice = await screen.findByTestId('request-remote-change');
        expect(notice.textContent).toContain('椅子(木)（0 → 3）');
        expect(notice.textContent).toContain('提出日時、備考');
        // 欄と「提出」は、入力の元（編集を始めたとき）のまま。画面の値と入力の元が同じ時点
        expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
        expect(document.getElementById('request-chair')).toHaveProperty('value', '0');
        expect(screen.getByTestId('request-submitted').textContent).toBe('未提出');
        expect(screen.getByRole('button', { name: '提出' })).toBeTruthy();

        await user.click(within(notice).getByRole('button', { name: 'ほかの人の値を読み込む' }));
        expect(screen.queryByTestId('request-remote-change')).toBeNull();
        expect(document.getElementById('request-chair')).toHaveProperty('value', '3');
        expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
        expect(screen.getByTestId('request-submitted').textContent).toMatch(/^提出済み/);
        expect(document.getElementById('request-note')).toHaveProperty('value', '電源');

        // 読み込んだ後の提出は、確かめずに送る（入力の元が届いた行になった）
        await submitDesk(user, false);
        await waitFor(() => expect(submitCalls()).toHaveLength(1));
        const args = opArgs(submitCalls()[0]!, 'rpc')[0]![0] as { p_rows: { itemId: string; count: number }[] };
        expect(args.p_rows.find((r) => r.itemId === itemId('chair'))!.count).toBe(3);
        expect(args.p_rows.find((r) => r.itemId === itemId('desk'))!.count).toBe(1);
      });

      it('ほかの人の初めての提出で数が変わらない品目に 0 の行が入っても、知らせに挙げず、「ほかの人の値を読み込む」でも入れた数を残す', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [];
        state.handler = makeHandler({ requests: rows });
        renderScreen();
        await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
        await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
        // ほかの人が椅子 3（ほかは 0）で初めて提出した：全品目の行が入る
        for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'chair' ? 3 : 0, updated_at: T1 });
        state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: OTHER_USER };
        await lastClient!.invalidateQueries();
        const notice = await screen.findByTestId('request-remote-change');
        expect(notice.textContent).toContain('椅子(木)（0 → 3）');
        expect(notice.textContent).not.toContain('机(木)');
        expect(notice.textContent).not.toContain('（0 → 0）');
        expect(notice.textContent).not.toContain('備考');

        await user.click(within(notice).getByRole('button', { name: 'ほかの人の値を読み込む' }));
        expect(document.getElementById('request-desk')).toHaveProperty('value', '2');
        expect(document.getElementById('request-chair')).toHaveProperty('value', '3');
      });

      it('ほかの人が備考を変えずに出し直したら、知らせは「提出日時」だけで、「ほかの人の値を読み込む」でも書き換えた備考を残す', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [];
        state.submission = { group_id: STALL, submitted_at: T0, note: '電源', updated_at: T0, updated_by: OTHER_USER };
        state.handler = makeHandler({ requests: rows });
        renderScreen();
        const noteBox = (await screen.findByLabelText(/備考/)) as HTMLTextAreaElement;
        await waitFor(() => expect(noteBox.value).toBe('電源'));
        await user.clear(noteBox);
        await user.type(noteBox, '電源2口・延長コード');
        // ほかの人が椅子だけを 3 にして出し直した（備考は「電源」のまま）
        rows.push({ group_id: STALL, item_id: itemId('chair'), count: 3, updated_at: T1 });
        state.submission = { group_id: STALL, submitted_at: T1, note: '電源', updated_at: T1, updated_by: OTHER_USER };
        await lastClient!.invalidateQueries();
        const notice = await screen.findByTestId('request-remote-change');
        expect(notice.textContent).toContain('椅子(木)（0 → 3）、提出日時。');
        expect(notice.textContent).not.toContain('備考');

        await user.click(within(notice).getByRole('button', { name: 'ほかの人の値を読み込む' }));
        expect(document.getElementById('request-chair')).toHaveProperty('value', '3');
        expect(document.getElementById('request-note')).toHaveProperty('value', '電源2口・延長コード');
      });

      it('応答が落ちた自分の提出が裏の読み直しや下書きを戻した後に届いても、ほかの人の変更として知らせない', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [];
        const base = makeHandler({ requests: rows });
        state.handler = (call) => {
          if (call.table === 'rpc:submit_requests') {
            // 届いたが応答が返らなかった（全品目の行と、自分が書いた提出の記録）
            for (const i of ITEMS) rows.push({ group_id: STALL, item_id: i.id, count: i.code === 'desk' ? 1 : 0, updated_at: T1 });
            state.submission = { group_id: STALL, submitted_at: T1, note: null, updated_at: T1, updated_by: USER };
            return NETWORK;
          }
          return base(call);
        };
        renderScreen();
        await submitDesk(user);
        expect((await screen.findByTestId('submit-error')).textContent).toBe(UNKNOWN);
        await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
        // 通信が戻り、画面のクエリが裏で読み直される
        const reads = state.calls.filter((c) => c.table === 'request_submissions').length;
        await lastClient!.invalidateQueries();
        await waitFor(() => expect(state.calls.filter((c) => c.table === 'request_submissions').length).toBeGreaterThan(reads));
        await waitFor(() => expect(lastClient!.isFetching()).toBe(0));
        expect(screen.queryByTestId('request-remote-change')).toBeNull();
        expect(document.getElementById('request-desk')).toHaveProperty('value', '2');

        // 画面を離れて戻り、下書きを戻しても知らせない
        cleanup();
        renderScreen();
        await user.click(await screen.findByRole('button', { name: '戻す' }));
        expect(document.getElementById('request-desk')).toHaveProperty('value', '2');
        await waitFor(() => expect(lastClient!.isFetching()).toBe(0));
        expect(screen.queryByTestId('request-remote-change')).toBeNull();
      });

      it('編集せずに「提出」を押したら、送る前の読み直しの間に届いた行で欄を変えない（確かめる値・送る値と画面の値が同じ時点）', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [{ group_id: STALL, item_id: itemId('desk'), count: 1, updated_at: T0 }];
        const base = makeHandler({ requests: rows });
        let hold: (() => void) | null = null;
        let armed = false;
        state.handler = ((call: FakeCall) => {
          if (armed && call.table === 'requests') {
            armed = false;
            return new Promise<void>((r) => (hold = r)).then(() => base(call));
          }
          return base(call);
        }) as never;
        renderScreen();
        await screen.findByRole('button', { name: '机(木)の数を1増やす' });
        armed = true;
        await submitDesk(user, false);
        await waitFor(() => expect(hold).not.toBeNull());
        // 読み直しの間に、ほかの人が椅子を 3 にした行が裏で届く
        await otherSubmitsInBackground(rows);
        expect(document.getElementById('request-chair')).toHaveProperty('value', '0');
        expect(screen.getByTestId('request-submitted').textContent).toBe('未提出');
        (hold as unknown as () => void)();
        // 提出の記録は先に読んでいたので、変わったのは椅子の行だけ
        const ask = await screen.findByRole('alertdialog', { name: 'ほかの人がこの団体の申請を変えました。上書きしますか' });
        expect(within(ask).getByTestId('request-conflicts').textContent).toBe('椅子(木)（0 → 3）');
        expect(submitCalls()).toHaveLength(0);
      });

      it('編集していなければ、届いた行をそのまま出す（知らせは出さない）', async () => {
        const rows: RequestDbRow[] = [];
        state.handler = makeHandler({ requests: rows });
        renderScreen();
        await screen.findByRole('button', { name: '机(木)の数を1増やす' });
        await otherSubmitsInBackground(rows);
        await waitFor(() => expect(document.getElementById('request-chair')).toHaveProperty('value', '3'));
        expect(screen.getByTestId('request-submitted').textContent).toMatch(/^提出済み/);
        expect(screen.queryByTestId('request-remote-change')).toBeNull();
      });

      it('下書きを戻した後に、離れていた間のほかの人の変更があれば知らせる（入力は戻した下書きのまま）', async () => {
        const user = userEvent.setup();
        const rows: RequestDbRow[] = [];
        state.handler = makeHandler({ requests: rows });
        renderScreen();
        await user.click(await screen.findByRole('button', { name: '机(木)の数を1増やす' }));
        cleanup();
        rows.push({ group_id: STALL, item_id: itemId('chair'), count: 3, updated_at: T1 });
        renderScreen();
        await user.click(await screen.findByRole('button', { name: '戻す' }));
        const notice = await screen.findByTestId('request-remote-change');
        expect(notice.textContent).toContain('椅子(木)（0 → 3）');
        expect(document.getElementById('request-desk')).toHaveProperty('value', '1');
        expect(document.getElementById('request-chair')).toHaveProperty('value', '0');
      });
    });
  });
});
