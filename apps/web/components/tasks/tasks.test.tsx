// @vitest-environment jsdom
// 作業一覧（/tasks）の画面とダイアログ（04「作業一覧」、notes/T20.md「画面の約束」7・13。T20）：立場ごとの一覧（状態のボタンは担当者と
// 部門長以上だけ、作る・編集・削除は部門長以上だけ）、進み具合・絞り込み（段の既定と件数）・`?task=`、「担当者が総務でない」、締切を過ぎた、
// 終了した年度の帯、状態のボタン（set_task_status と conflict）、作るダイアログ（動的 import。既定・締切の時刻の既定・誤り・送る値）。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts）で、tasks の読み書きと RPC を小さくまねる。立場は useAuth の差し替え。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, Membership, YearStatus } from '@/lib/auth/membership';
import type { TaskRow } from '@/lib/data/tasks';
import type { YearRow } from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import { TASK_FORM_MESSAGES } from '@/lib/schemas/tasks';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { STATUS_UNKNOWN_MESSAGE, TASKS_EMPTY_TEXTS, TasksScreen } from './tasks-screen';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  role: 'head' as AppRole | null,
  status: 'requesting' as YearStatus,
  userId: 'u-head',
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
  usePathname: () => '/tasks',
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
const U_VIEWER = uuid(4);
/** 今：2027-10-14（木）12:00 Asia/Tokyo */
const NOW = '2027-10-14T03:00:00Z';
const V0 = '2027-10-01T00:00:00.123456+00:00';
const T_MINE = uuid(11);
const T_OTHER = uuid(12);
const T_NONE = uuid(13);
const T_DONE = uuid(14);
const T_VIEWER = uuid(15);

const task = (id: string, over: Partial<TaskRow>): TaskRow & { year_id: string } => ({
  id,
  year_id: Y,
  title: `作業${id.slice(-2)}`,
  note: null,
  assignee_id: null,
  due_at: null,
  status: 'todo',
  created_by: U_HEAD,
  updated_by: U_HEAD,
  created_at: V0,
  updated_at: V0,
  ...over,
});

let rows: (TaskRow & { year_id: string })[] = [];
let issued: FakeCall[] = [];
let override: ((call: FakeCall) => FakeResult | undefined) | null = null;
let clock = 0;
const nextAt = () => `2027-10-02T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
const LEAD = ['admin', 'head', 'deputy_head'];
const has = (call: FakeCall, op: string) => call.ops.some((o) => o.op === op);
const eqOf = (call: FakeCall) => Object.fromEntries(opArgs(call, 'eq').map(([k, v]) => [k as string, v]));

function seed() {
  rows = [
    task(T_MINE, { title: '名札を作る', assignee_id: U_STAFF, due_at: '2027-10-14T02:00:00Z', note: '30 人分\n厚紙で' }),
    task(T_OTHER, { title: '備品の確認', assignee_id: U_HEAD, status: 'doing', due_at: '2027-10-15T08:00:00Z' }),
    task(T_NONE, { title: '机の数を数える' }),
    task(T_DONE, { title: '会議室の予約', assignee_id: U_STAFF, status: 'done' }),
    task(T_VIEWER, { title: '看板の確認', assignee_id: U_VIEWER }),
  ];
}

const yearRow = (status: YearStatus): YearRow =>
  ({ id: Y, label: 'R9', status, allocation_version: 1, auto_allocated_at: null, festival_start: '2027-10-16', request_open_at: null, request_close_at: null, prev_year_id: null, updated_at: 't' }) as YearRow;

function handler(call: FakeCall): FakeResult {
  const o = override?.(call);
  if (o) return o;
  if (call.table === 'profiles') {
    return {
      data: [
        { user_id: U_HEAD, display_name: '部門長A' },
        { user_id: U_STAFF, display_name: '部門員A' },
        { user_id: U_VIEWER, display_name: '閲覧B' },
      ],
    };
  }
  if (call.table === 'year_roles') {
    return {
      data: [
        { user_id: U_HEAD, role: 'head' },
        { user_id: U_STAFF, role: 'staff' },
        { user_id: U_VIEWER, role: 'viewer' },
      ],
    };
  }
  if (call.table === 'rpc:set_task_status') {
    const args = call.ops[0]!.args[0] as { p_task_id: string; p_status: TaskRow['status']; p_base_updated_at: string };
    const k = rows.findIndex((r) => r.id === args.p_task_id);
    if (k < 0) return { error: { code: 'P0001', message: 'forbidden', details: '' }, status: 400 };
    if (rows[k]!.updated_at !== args.p_base_updated_at) return { error: { code: 'P0001', message: 'conflict', details: JSON.stringify({ id: args.p_task_id }) }, status: 400 };
    rows[k] = { ...rows[k]!, status: args.p_status, updated_by: h.userId, updated_at: nextAt() };
    return { data: rows[k] };
  }
  if (call.table !== 'tasks') return { data: [] };
  if (has(call, 'insert')) {
    const v = opArgs(call, 'insert')[0]![0] as Partial<TaskRow>;
    if (!LEAD.includes(h.role ?? '')) return { error: { code: '42501', message: 'x' }, status: 403 };
    const at = nextAt();
    const r = task(v.id!, { ...v, created_at: at, updated_at: at });
    rows.push(r);
    return { data: r };
  }
  if (has(call, 'maybeSingle')) return { data: rows.find((r) => r.id === eqOf(call).id) ?? null };
  return { data: rows.filter((r) => r.year_id === eqOf(call).year_id) };
}

function member(role: AppRole, status: YearStatus): Membership {
  const year = { id: Y, label: 'R9', status, festival_start: '2027-10-16' };
  return { displayName: 'テスト', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

function renderScreen(role: AppRole, opts: { status?: YearStatus; userId?: string; search?: string } = {}) {
  const status = opts.status ?? 'requesting';
  h.role = role;
  h.status = status;
  h.userId = opts.userId ?? (role === 'staff' ? U_STAFF : U_HEAD);
  h.params = new URLSearchParams(opts.search ?? '');
  h.membership = { status: 'ready', membership: member(role, status) };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  qc.setQueryData(queryKeys.yearRow(Y), yearRow(status));
  render(
    <QueryClientProvider client={qc}>
      <TasksScreen />
    </QueryClientProvider>,
  );
  return qc;
}

const items = () => screen.queryAllByTestId('tasks-item');
const itemOf = (id: string) => items().find((x) => x.getAttribute('data-id') === id)!;
const loaded = () => waitFor(() => expect(items().length).toBeGreaterThan(0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  seed();
  override = null;
  clock = 0;
  const fake = createFakeSupabase(handler);
  h.client = fake.client;
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

describe('T20 作業一覧：立場ごと', () => {
  it('総務部門員：既定は自分の作業。状態のボタンは自分が担当の作業だけ（完了も戻せる）。作る・編集・削除は出さない', async () => {
    renderScreen('staff');
    await loaded();
    expect(items().map((x) => x.getAttribute('data-id'))).toEqual([T_MINE, T_DONE]);
    expect(screen.getByTestId('tasks-progress').textContent).toBe('完了 1／5（作業中 1・未着手 3・締切を過ぎた 1）');
    for (const id of [T_MINE, T_DONE]) expect(within(itemOf(id)).getByTestId('tasks-item-status-buttons')).toBeTruthy();
    expect(screen.queryByTestId('tasks-add')).toBeNull();
    expect(screen.queryAllByTestId('tasks-item-edit')).toEqual([]);
    // 「すべて」にしても、ほかの人の作業には状態のボタンがない
    const filter = screen.getByTestId('tasks-filter');
    expect(within(filter).getAllByRole('radio').map((b) => b.textContent)).toEqual([
      '自分の作業（2）',
      'すべて（5）',
      '未完了（4）',
      '締切を過ぎた（1）',
      '締切が近い（1）',
      '担当者なし（1）',
    ]);
    fireEvent.click(within(filter).getByText('すべて（5）'));
    expect(h.replace).toHaveBeenCalledWith('/tasks?filter=all');
  });

  it('総務部門員の「すべて」：ほかの人の作業は読むだけ。総務でない担当者は分けない（ロールを読まない）', async () => {
    renderScreen('staff', { search: 'filter=all' });
    await loaded();
    expect(items()).toHaveLength(5);
    expect(within(itemOf(T_OTHER)).queryByTestId('tasks-item-status-buttons')).toBeNull();
    expect(screen.queryAllByTestId('tasks-item-not-soumu')).toEqual([]);
    expect(issued.some((c) => c.table === 'year_roles')).toBe(false);
  });

  it('部門長：既定はすべて（完了でないものを締切の順に、完了は後）。状態のボタン・編集・削除、担当者が総務でない、締切を過ぎた', async () => {
    renderScreen('head');
    await loaded();
    expect(items().map((x) => x.getAttribute('data-id'))).toEqual([T_MINE, T_OTHER, T_NONE, T_VIEWER, T_DONE]);
    const mine = itemOf(T_MINE);
    expect(within(mine).getByTestId('tasks-item-assignee').textContent).toBe('部門員A');
    expect(within(mine).getByTestId('tasks-item-due').getAttribute('data-overdue')).toBe('true');
    expect(within(mine).getByTestId('tasks-item-due').textContent).toContain('締切を過ぎました');
    expect(within(mine).getByTestId('tasks-item-note').textContent).toBe('30 人分\n厚紙で');
    expect(within(mine).getByTestId('tasks-item-updated').textContent).toBe('部門長Aが 10/1 09:00 に更新');
    expect(within(itemOf(T_NONE)).getByTestId('tasks-item-assignee').textContent).toBe('担当者なし');
    await waitFor(() => expect(within(itemOf(T_VIEWER)).getByTestId('tasks-item-not-soumu').textContent).toBe('担当者が総務でない'));
    expect(screen.getAllByTestId('tasks-item-status-buttons')).toHaveLength(5);
    expect(screen.getAllByTestId('tasks-item-edit')).toHaveLength(5);
    expect(screen.getByTestId('tasks-add')).toBeTruthy();
  });

  it('終了した年度：帯を出し、状態のボタン・作る・編集・削除を出さない', async () => {
    renderScreen('head', { status: 'closed' });
    await loaded();
    expect(screen.getByTestId('read-only-notice').textContent).toBe('終了した年度のため、シフトと作業は読むだけです');
    expect(screen.queryAllByTestId('tasks-item-status-buttons')).toEqual([]);
    expect(screen.queryByTestId('tasks-add')).toBeNull();
    expect(screen.queryAllByTestId('tasks-item-edit')).toEqual([]);
  });

  it('?task=（ダッシュボードから）：絞り込みは「すべて」にして目立たせる。読めない id なら何もしない', async () => {
    renderScreen('staff', { search: `task=${T_OTHER}` });
    await loaded();
    expect(items()).toHaveLength(5);
    expect(itemOf(T_OTHER).getAttribute('data-highlighted')).toBe('true');
    cleanup();
    renderScreen('staff', { search: `task=${uuid(99)}` });
    await loaded();
    expect(items().map((x) => x.getAttribute('data-id'))).toEqual([T_MINE, T_DONE]);
  });

  it('空：作業がなければ「作業はまだありません」（部門長以上に足し方）、絞り込んで 0 件なら「条件に合う作業はありません」', async () => {
    rows = [];
    renderScreen('head');
    await waitFor(() => expect(screen.getByTestId('tasks-empty').textContent).toContain(TASKS_EMPTY_TEXTS.none));
    expect(screen.getByTestId('tasks-empty').textContent).toContain(TASKS_EMPTY_TEXTS.addHint);
    cleanup();
    seed();
    renderScreen('head', { search: 'filter=unassigned' });
    await loaded();
    cleanup();
    rows = rows.filter((r) => r.id !== T_NONE);
    renderScreen('head', { search: 'filter=unassigned' });
    await waitFor(() => expect(screen.getByTestId('tasks-empty').textContent).toContain(TASKS_EMPTY_TEXTS.filtered));
  });
});

describe('T20 作業一覧：状態のボタン（set_task_status）', () => {
  it('押すと読んだときの updated_at で送り、「「{題名}」を{状態}にしました」。一覧の状態が変わる', async () => {
    renderScreen('staff');
    await loaded();
    fireEvent.click(within(itemOf(T_MINE)).getByTestId('task-set-doing'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「名札を作る」を作業中にしました'));
    const rpc = issued.find((c) => c.table === 'rpc:set_task_status')!;
    expect(rpc.ops[0]!.args[0]).toEqual({ p_task_id: T_MINE, p_status: 'doing', p_base_updated_at: V0 });
    await waitFor(() => expect(itemOf(T_MINE).getAttribute('data-status')).toBe('doing'));
    // 今の状態のボタンは押せない
    expect((within(itemOf(T_MINE)).getByTestId('task-set-doing') as HTMLButtonElement).disabled).toBe(true);
  });

  it('conflict：読み直して今の状態を知らせる（押したものと同じなら「保存されていました」）', async () => {
    renderScreen('staff');
    await loaded();
    rows = rows.map((r) => (r.id === T_MINE ? { ...r, status: 'done', updated_at: 'v-other' } : r));
    fireEvent.click(within(itemOf(T_MINE)).getByTestId('task-set-doing'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ほかの人がこの作業を先に変えました。読み直しました（今は「完了」です）'));
  });

  it('応答が届かず版が読んだときのまま：「保存できたか分かりません。もう一度押すと、確かめてから送ります」', async () => {
    renderScreen('staff');
    await loaded();
    override = (call) => (call.table === 'rpc:set_task_status' ? { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 } : undefined);
    fireEvent.click(within(itemOf(T_MINE)).getByTestId('task-set-done'));
    await waitFor(() => expect(within(itemOf(T_MINE)).getByTestId('tasks-error').textContent).toBe(STATUS_UNKNOWN_MESSAGE));
  });
});

describe('T20 作業一覧：作る（部門長以上。動的 import のダイアログ）', () => {
  it('既定は担当者なし・締切なし。日付を入れると時刻は 17:00。誤りは欄の下。送る値は画面の id と `+09:00`', async () => {
    renderScreen('head');
    await loaded();
    fireEvent.click(screen.getByTestId('tasks-add'));
    const dialog = await screen.findByTestId('task-dialog');
    expect((within(dialog).getByTestId('task-assignee') as HTMLSelectElement).value).toBe('');
    // 担当者の選択肢はその年度の総務だけ（閲覧のみは出さない）
    await waitFor(() =>
      expect(Array.from((within(dialog).getByTestId('task-assignee') as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
        '担当者なし',
        '部門員A（総務部門員）',
        '部門長A（総務部門長）',
      ]),
    );
    fireEvent.click(within(dialog).getByTestId('task-submit'));
    expect(await within(dialog).findByText(TASK_FORM_MESSAGES.titleRequired)).toBeTruthy();
    fireEvent.change(within(dialog).getByTestId('task-title'), { target: { value: ' 受付の準備 ' } });
    fireEvent.change(within(dialog).getByTestId('task-assignee'), { target: { value: U_STAFF } });
    fireEvent.change(within(dialog).getByTestId('task-due-date'), { target: { value: '2027-10-15' } });
    expect((within(dialog).getByTestId('task-due-time') as HTMLInputElement).value).toBe('17:00');
    expect(within(dialog).getByTestId('task-title-count').textContent).toBe('5/100');
    fireEvent.click(within(dialog).getByTestId('task-submit'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('「受付の準備」を足しました'));
    const ins = issued.find((c) => c.table === 'tasks' && has(c, 'insert'))!;
    const v = opArgs(ins, 'insert')[0]![0] as Record<string, unknown>;
    expect(v).toMatchObject({ year_id: Y, title: '受付の準備', note: null, assignee_id: U_STAFF, due_at: '2027-10-15T17:00:00+09:00' });
    expect(Object.keys(v).sort()).toEqual(['assignee_id', 'due_at', 'id', 'note', 'title', 'year_id']);
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).toBeNull());
  });

  it('時刻だけは誤り（締切の日付を入れてください）', async () => {
    renderScreen('head');
    await loaded();
    fireEvent.click(screen.getByTestId('tasks-add'));
    const dialog = await screen.findByTestId('task-dialog');
    fireEvent.change(within(dialog).getByTestId('task-title'), { target: { value: '名札' } });
    fireEvent.change(within(dialog).getByTestId('task-due-time'), { target: { value: '09:00' } });
    fireEvent.click(within(dialog).getByTestId('task-submit'));
    expect(await within(dialog).findByText(TASK_FORM_MESSAGES.dueDateRequired)).toBeTruthy();
    expect(issued.some((c) => c.table === 'tasks' && has(c, 'insert'))).toBe(false);
  });

  it('権限か年度の状態が変わった（42501）：入力とダイアログを残し、送るボタンを押せなくする', async () => {
    renderScreen('head');
    await loaded();
    fireEvent.click(screen.getByTestId('tasks-add'));
    const dialog = await screen.findByTestId('task-dialog');
    fireEvent.change(within(dialog).getByTestId('task-title'), { target: { value: '名札' } });
    h.role = 'staff';
    fireEvent.click(within(dialog).getByTestId('task-submit'));
    await waitFor(() => expect(within(dialog).getByText('今の立場・年度の状態では保存できません')).toBeTruthy());
    expect((within(dialog).getByTestId('task-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByTestId('task-title') as HTMLInputElement).value).toBe('名札');
    expect(within(dialog).getByTestId('task-error').textContent).toContain('権限がありません');
  });

  it('総務部門員にはダイアログの部品を読み込まない（作るボタンがない）', async () => {
    renderScreen('staff');
    await loaded();
    expect(screen.queryByTestId('tasks-add')).toBeNull();
    expect(screen.queryByTestId('task-dialog')).toBeNull();
  });
});
