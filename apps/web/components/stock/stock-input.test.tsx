// @vitest-environment jsdom
// 在庫入力の部品のテスト（画面の設計 7.1「在庫入力の読み取り専用の切り替えと最新でない年度の確認」。T10）。
// Supabase は偽のクライアント（lib/testing/fake-supabase）に差し替え、立場は useAuth を差し替える。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, YearSummary } from '@/lib/auth/membership';
import type { ItemRow, RoomRow, StockDbRow, YearRow, YearStatus } from '@/lib/db/types';
import { draftKey } from '@/lib/drafts';
import { storageRooms } from '@/lib/data/stocks';
import { queryKeys } from '@/lib/query';
import { opArgs, type FakeCall, type FakeHandler, type FakeResult } from '@/lib/testing/fake-supabase';
import type { OpenYear } from './common';
import { StockInput } from './stock-input';
import { StockScreen } from './stock-screen';

const fake = vi.hoisted(() => ({ handler: null as null | FakeHandler, issued: [] as FakeCall[] }));
vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase: create } = await import('@/lib/testing/fake-supabase');
  const { client, issued } = create((call) => fake.handler!(call));
  fake.issued = issued;
  return { getSupabase: () => client, authStorageKey: () => 'sb-test-auth-token', supabaseConfigError: () => null };
});
const auth = vi.hoisted(() => ({ membership: null as unknown, reloadMembership: vi.fn(), reauthenticate: vi.fn(async () => false), setYear: vi.fn() }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: { status: 'ready', membership: auth.membership },
    session: { status: 'signedIn', session: { user: { id: USER } } },
    isRefreshing: false,
    reloadMembership: auth.reloadMembership,
    setYear: auth.setYear,
    reauthenticate: auth.reauthenticate,
    signOut: vi.fn(),
  }),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`room=${ROOM.id}`),
}));
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown> & { href: string; children: React.ReactNode }) => {
    const { href, children, onNavigate, prefetch, ...rest } = props;
    void onNavigate;
    void prefetch;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

const USER = '00000000-0000-4000-8000-000000000002';
const Y = '11111111-1111-4111-8111-111111111111';
const LATEST = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOM: RoomRow = {
  id: id(1),
  name: 'E2E倉庫A',
  aliases: [],
  kind: 'room',
  building: 'E2E棟',
  floor: 1,
  extra_cost: 0,
  is_storage: true,
  sort_order: 1,
  updated_at: 't',
};
const ROOM2: RoomRow = { ...ROOM, id: id(2), name: 'E2E倉庫B', sort_order: 2 };
const item = (n: number, name: string): ItemRow => ({
  id: id(100 + n),
  code: `i${n}`,
  name,
  aliases: [],
  requestable_categories: ['stall'],
  sort_order: n,
  updated_at: 't',
});
const DESK = item(1, '机(木)');
const CHAIR = item(2, '椅子(木)');
const ITEMS = [DESK, CHAIR];

const stock = (i: ItemRow, count: number, updatedAt = `u-${i.id}`, countedBy: string | null = USER): StockDbRow => ({
  year_id: Y,
  room_id: ROOM.id,
  item_id: i.id,
  count,
  counted_at: '2026-10-05T09:01:00+00:00',
  counted_by: countedBy,
  updated_at: updatedAt,
});

function yearRow(status: YearStatus, prev = false): YearRow {
  return {
    id: Y,
    label: 'E2E-年度',
    status,
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2001-10-13',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: prev ? id(500) : null,
    updated_at: 't',
  };
}

function membership(role: 'admin' | 'staff', status: YearStatus, latest: boolean): Membership {
  const year: YearSummary = { id: Y, label: 'E2E-年度', status, festival_start: '2001-10-13' };
  const newer: YearSummary = { id: LATEST, label: 'R8', status: 'requesting', festival_start: '2026-10-17' };
  return {
    displayName: 'テスト部員',
    year,
    role,
    groups: [],
    years: latest ? [year] : [newer, year],
    latestYear: latest ? year : newer,
    adminOfOpenYear: role === 'admin',
  };
}

interface Db {
  stocks: StockDbRow[];
  /** 2回目以降の stocks の読み込みで返す行（ほかの人の保存） */
  stocksLater?: StockDbRow[];
  /** 部屋の stocks の n 回目（1 から）の読み込みの結果（あれば stocks・stocksLater より先に使う） */
  roomRead?: (n: number) => FakeResult | PromiseLike<FakeResult> | undefined;
  /** n 回目（1 から）の upsert の結果（undefined なら保存できたことにする） */
  upsert?: (n: number) => FakeResult | PromiseLike<FakeResult> | undefined;
  allocated?: { id: string; item_id: string; count: number }[];
  prev?: { room_id: string; item_id: string; count: number }[];
  /** previous_year_stocks の失敗 */
  prevError?: boolean;
}

/** 通信の失敗（supabase-js は code '' と status 0 で返す）と、セッションの切れ（401） */
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
const EXPIRED: FakeResult = { error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 };

function serve(db: Db) {
  let stockReads = 0;
  let upsertCount = 0;
  fake.handler = (call) => {
    if (call.table === 'stocks' && opArgs(call, 'upsert').length > 0) {
      upsertCount += 1;
      const forced = db.upsert?.(upsertCount);
      if (forced) return forced;
      const rows = opArgs(call, 'upsert')[0]![0] as { item_id: string; count: number }[];
      return { data: rows.map((r) => ({ ...stock(ITEMS.find((i) => i.id === r.item_id)!, r.count, `saved-${r.item_id}`), counted_at: '2026-10-29T09:30:00+00:00' })) };
    }
    if (call.table === 'stocks') {
      const isRoom = opArgs(call, 'eq').some(([col]) => col === 'room_id');
      if (!isRoom) return { data: db.stocks };
      stockReads += 1;
      const forced = db.roomRead?.(stockReads);
      if (forced) return forced;
      return { data: stockReads > 1 && db.stocksLater ? db.stocksLater : db.stocks };
    }
    if (call.table === 'allocations') return { data: db.allocated ?? [] };
    if (call.table === 'rpc:previous_year_stocks') return db.prevError ? { error: { code: 'XX000', message: 'boom' }, status: 500 } : { data: db.prev ?? [] };
    if (call.table === 'profiles') return { data: [{ user_id: USER, display_name: 'テスト部員' }, { user_id: id(77), display_name: 'テスト管理者' }] };
    return { data: [] };
  };
}

/** qc を渡すと、その QueryClient（キャッシュ）で開く（画面を離れて同じタブで開き直す） */
function renderInput(o: { role: 'admin' | 'staff'; status: YearStatus; latest?: boolean; prev?: boolean; qc?: QueryClient }) {
  auth.membership = membership(o.role, o.status, o.latest ?? true);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role: o.role, userId: USER };
  const storage = storageRooms([ROOM, ROOM2], []);
  const qc = o.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <StockInput open={open} year={yearRow(o.status, o.prev)} target={storage[0]!} storage={storage} items={ITEMS} />
    </QueryClientProvider>,
  );
  return Object.assign(r, { qc });
}

/** 開いたままの画面で、年度の状態を変える（年度の行を読み直したら振り分け中になっていた、など） */
function rerenderStatus(r: ReturnType<typeof renderInput>, o: { role: 'admin' | 'staff'; status: YearStatus }) {
  auth.membership = membership(o.role, o.status, true);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role: o.role, userId: USER };
  const storage = storageRooms([ROOM, ROOM2], []);
  r.rerender(
    <QueryClientProvider client={r.qc}>
      <StockInput open={open} year={yearRow(o.status)} target={storage[0]!} storage={storage} items={ITEMS} />
    </QueryClientProvider>,
  );
}

const upserts = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length > 0);
const deskInput = () => screen.getByRole('textbox', { name: '机(木)の数' });
/** モーダルのダイアログを開いている間（ほかは aria-hidden）も読む机の入力 */
const deskInputBehindDialog = () => screen.getByRole('textbox', { name: '机(木)の数', hidden: true }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
/** 部屋の stocks の読み込み（upsert を除く）の回数 */
const roomReads = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length === 0 && opArgs(c, 'eq').some(([col]) => col === 'room_id')).length;
const KEY = () => draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });
/** n 番目（0 から）の upsert で送った机の数 */
const sentDesk = (n: number) => (opArgs(upserts()[n]!, 'upsert')[0]![0] as { item_id: string; count: number }[]).find((r) => r.item_id === DESK.id)!.count;

beforeEach(() => {
  localStorage.clear();
  fake.issued.length = 0;
  for (const f of Object.values(toasts)) f.mockClear();
});
afterEach(() => cleanup());

describe('StockInput：書けるか（設計 3.3 の表）', () => {
  it('部員は振り分け中に読み取り専用（「総務管理者だけが直せます」、入力できず保存のボタンがない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    renderInput({ role: 'staff', status: 'allocating' });
    expect(await screen.findByText('振り分けが始まったので、在庫は総務管理者だけが直せます')).toBeTruthy();
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect((deskInput() as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('部員は申請受付中に書ける。保存すると全品目を1回の upsert で送り「保存しました」と「次の部屋へ」', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
    expect(opArgs(upserts()[0]!, 'upsert')[0]![0]).toEqual([
      { year_id: Y, room_id: ROOM.id, item_id: DESK.id, count: 11 },
      { year_id: Y, room_id: ROOM.id, item_id: CHAIR.id, count: 20 },
    ]);
    // 最新の年度なので確かめない
    expect(screen.queryByText(/最新でない年度/)).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: /次の部屋へ（E2E倉庫B）/ })).toBeTruthy());
    expect(screen.getByTestId('last-counted').textContent).toContain('テスト部員');
  });

  it('前年度があれば品目ごとに前年の数を出し、なければ列を出さない', async () => {
    serve({ stocks: [stock(DESK, 10)], prev: [{ room_id: ROOM.id, item_id: DESK.id, count: 8 }] });
    renderInput({ role: 'staff', status: 'requesting', prev: true });
    await waitFor(() => expect(screen.getAllByTestId('stock-prev').map((e) => e.textContent)).toEqual(['前年 8', '前年 —']));
    cleanup();
    serve({ stocks: [stock(DESK, 10)] });
    renderInput({ role: 'staff', status: 'requesting', prev: false });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect(screen.queryAllByTestId('stock-prev')).toHaveLength(0);
  });
});

describe('StockInput：最新でない年度', () => {
  it('保存の前に確かめ、やめれば送らない。続ければ送る', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting', latest: false });
    expect(screen.getByTestId('latest-year-switch').textContent).toContain('最新の年度（R8）に切り替える');
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('最新でない年度（E2E-年度・申請受付中）に保存します。よろしいですか');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(upserts()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'この年度に保存する' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
  });
});

describe('StockInput：管理者と振り分けの合計', () => {
  it('確定中に振り分けの合計より少なくすると、保存の前に止まる（送らない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], allocated: [{ id: 'a', item_id: DESK.id, count: 6 }] });
    const user = userEvent.setup();
    renderInput({ role: 'admin', status: 'confirmed' });
    await waitFor(() => expect(screen.getByTestId('stock-allocated').textContent).toBe('振り分け 6台'));
    await user.clear(deskInput());
    await user.type(deskInput(), '5{Enter}');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const alert = await screen.findByTestId('stock-shortfall-blocked');
    expect(alert.textContent).toBe('確定中は振り分けの合計より少なくできません（机(木)：入力 5、振り分けの合計 6台）。確定を解除してから直してください');
    expect(upserts()).toHaveLength(0);
  });

  it('振り分け中は確かめ、やめれば送らない・続ければ送る。合計以上なら確かめない', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], allocated: [{ id: 'a', item_id: DESK.id, count: 6 }] });
    const user = userEvent.setup();
    renderInput({ role: 'admin', status: 'allocating' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.clear(deskInput());
    await user.type(deskInput(), '5{Enter}');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('保存すると振り分けに在庫超過（E001）が出ます。振り分け画面で直してください');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(upserts()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '保存する' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
  });
});

describe('StockInput：ほかの人の保存', () => {
  it('読み込んだ後にほかの人が保存していれば、名前と数を並べて選ばせる。読み直すと相手の数になり送らない', async () => {
    serve({
      stocks: [stock(DESK, 10), stock(CHAIR, 20)],
      stocksLater: [stock(DESK, 7, 'u-other', id(77)), stock(CHAIR, 20)],
    });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    const rows = within(dialog).getAllByTestId('conflict-row').map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toEqual([
      ['机(木)', '7', '11'],
      ['椅子(木)', '20', '20'],
    ]);
    await user.click(within(dialog).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(upserts()).toHaveLength(0);
  });

  it('ダイアログの「読み直す」で、「前回の入力」もほかの人の名前と日時になる', async () => {
    serve({
      stocks: [stock(DESK, 10, 'u-desk', null), stock(CHAIR, 20, 'u-chair', null)],
      stocksLater: [
        { ...stock(DESK, 7, 'u-other', id(77)), counted_at: '2026-10-28T03:15:00+00:00' },
        stock(CHAIR, 20, 'u-chair', null),
      ],
    });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await waitFor(() => expect(screen.getByTestId('last-counted').textContent).toContain('名前を表示できません'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await waitFor(() => expect(screen.getByTestId('last-counted').textContent).toContain('テスト管理者'));
    const lastCounted = screen.getByTestId('last-counted').textContent;
    expect(lastCounted).toContain('2026/10/28 12:15');
    expect(lastCounted).not.toContain('名前を表示できません');
    expect(upserts()).toHaveLength(0);
  });

  it('ダイアログを開くとフォーカスが中（やめる）へ移り、やめると「保存」に戻る（送らない）', async () => {
    serve({
      stocks: [stock(DESK, 10), stock(CHAIR, 20)],
      stocksLater: [stock(DESK, 7, 'u-other', id(77)), stock(CHAIR, 20)],
    });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'やめる' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存' })));
    expect(upserts()).toHaveLength(0);
  });

  it('ダイアログを開いている間に裏の読み直しが届いても、「あなた」と「上書きする」で送る数は「保存」を押したときの数のまま', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: [stock(DESK, 7, 'u-other', id(77)), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    // 変えずに数え直して保存
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    const reads = roomReads();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(deskInputBehindDialog().value).toBe('10');
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
    expect(sentDesk(0)).toBe(10);
  });

  it('上書きするなら自分の数で送る', async () => {
    serve({
      stocks: [stock(DESK, 10), stock(CHAIR, 20)],
      stocksLater: [stock(DESK, 7, 'u-other', id(77)), stock(CHAIR, 20)],
    });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    await screen.findByTestId('stock-saved');
    expect((opArgs(upserts()[0]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(11);
  });
});

describe('StockInput：下書き', () => {
  it('入力は部屋ごとの下書きに置き、開き直すと「戻す」で戻せる。保存すると消える', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r.unmount(); // 画面を離れる（書いていない分を書き切る）
    const key = draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });
    expect(JSON.parse(localStorage.getItem(key)!).value).toEqual({
      counts: { [DESK.id]: 11, [CHAIR.id]: 20 },
      base: { [DESK.id]: `u-${DESK.id}`, [CHAIR.id]: `u-${CHAIR.id}` },
    });

    renderInput({ role: 'staff', status: 'requesting' });
    const notice = await screen.findByTestId('draft-notice');
    await user.click(within(notice).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('下書きを作った後にほかの人が保存していれば、戻して保存するときに選ばせる（触っていない品目も黙って上書きしない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r.unmount(); // カメラで次の QR を読みに離れる（下書きが残る）

    // 離れている間に、ほかの人がこの部屋を保存した（椅子だけ 25 にした）
    const theirs = [stock(DESK, 10, 'u-other-desk', id(77)), stock(CHAIR, 25, 'u-other-chair', id(77))];
    serve({ stocks: theirs });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((screen.getByRole('textbox', { name: '椅子(木)の数' }) as HTMLInputElement).value).toBe('25'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(upserts()).toHaveLength(0);
    // 読み直すと相手の数になる（下書きは消える）
    await user.click(within(dialog).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect((screen.getByRole('textbox', { name: '椅子(木)の数' }) as HTMLInputElement).value).toBe('25');
    expect(upserts()).toHaveLength(0);
  });

  it('下書きを作った後にだれも保存していなければ、戻して保存しても確かめない', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r.unmount();
    const key = draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });
    expect(JSON.parse(localStorage.getItem(key)!).value.base).toEqual({ [DESK.id]: `u-${DESK.id}`, [CHAIR.id]: `u-${CHAIR.id}` });

    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    renderInput({ role: 'staff', status: 'requesting' });
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    // 戻した後にさらに入力しても、下書きの元は最初に読み込んだ行のまま
    await user.click(screen.getByRole('button', { name: '椅子(木)の数を1増やす' }));
    expect(JSON.parse(localStorage.getItem(key)!).value.base).toEqual({ [DESK.id]: `u-${DESK.id}`, [CHAIR.id]: `u-${CHAIR.id}` });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(opArgs(upserts()[0]!, 'upsert')[0]![0]).toEqual([
      { year_id: Y, room_id: ROOM.id, item_id: DESK.id, count: 11 },
      { year_id: Y, room_id: ROOM.id, item_id: CHAIR.id, count: 21 },
    ]);
  });

  it('読み取り専用のときは下書きを出さない', async () => {
    const key = draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });
    localStorage.setItem(key, JSON.stringify({ value: { counts: { [DESK.id]: 3 }, base: {} }, savedAt: Date.now() }));
    serve({ stocks: [stock(DESK, 10)] });
    renderInput({ role: 'staff', status: 'confirmed' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });
});

describe('StockInput：読み直し（設計 2.6）', () => {
  const theirs = () => [stock(DESK, 7, 'u-other', id(77)), stock(CHAIR, 20)];

  it('未保存の入力がなければ、裏で読み直した数で作り直す（「前回の入力」も新しくなる）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await waitFor(() => expect(screen.getByTestId('last-counted').textContent).toContain('テスト管理者'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
  });

  it('入力があれば入力を残し、ほかの人が変えたことを知らせる。保存するときはほかの人の保存を確かめる', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    const notice = await screen.findByTestId('stock-remote-change');
    await waitFor(() => expect(notice.textContent).toContain('テスト管理者さんが'));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(upserts()).toHaveLength(0);
  });

  it('知らせの「ほかの人の数を読み直す」で、相手の数にする（送らない）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    const notice = await screen.findByTestId('stock-remote-change');
    await user.click(within(notice).getByRole('button', { name: 'ほかの人の数を読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(upserts()).toHaveLength(0);
  });

  it('R1：数を変えずに「保存」を押して最新でない年度の確かめをやめても、入力を守る（裏の読み直しのほかの人の数で置き換えず知らせる）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting', latest: false });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(upserts()).toHaveLength(0);
  });

  it('R1：保存が決まったら印を下ろす（その後の裏の読み直しは、その行で作り直す）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
  });

  it('R1：下書きを戻したら入力を守る（裏の読み直しのほかの人の数で置き換えず、下書きの元と比べて知らせる）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
  });

  it('R1：戻していない下書きを「捨てる」のは下書きだけで、「保存」を押して立てた印は残る（裏の読み直しのほかの人の数で置き換えず知らせる）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const r = renderInput({ role: 'staff', status: 'requesting', latest: false });
    // 下書きを戻さずに「保存」を押して（印が立つ）最新でない年度の確かめをやめ、その後に下書きを「捨てる」
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '捨てる' }));
    expect(localStorage.getItem(KEY())).toBeNull();
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(upserts()).toHaveLength(0);
    // 入力（10）はほかの人の数と違うので保存していない入力。下書きを捨てた後でも、離れたら下書きに残す
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
  });

  it('R1：数を変えた後に書けなくなったら（振り分け中の部員）、印は効かず届いた行で作り直す。入力は下書きに残り、「上書きするか選べます」は出さない', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    rerenderStatus(r, { role: 'staff', status: 'allocating' });
    expect(await screen.findByText('振り分けが始まったので、在庫は総務管理者だけが直せます')).toBeTruthy();
    // 読み取り専用の画面には DB の数を出す
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByText(/上書きするか読み直すかを選べます/)).toBeNull();
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(11);
  });

  it('R1：ほかの人の保存を知らせている間に書けなくなったら、知らせを消して届いた行の数を出す', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await screen.findByTestId('stock-remote-change');
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    rerenderStatus(r, { role: 'staff', status: 'allocating' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
  });

  it('R1・R3：ほかの人の保存が届いた後に入力を元の数へ戻しても、保存していない入力のまま（下書きを消さない。開き直せば戻して選べる）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await screen.findByTestId('stock-remote-change');
    // 数え直したら 10 だった
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    expect(screen.getByTestId('stock-remote-change')).toBeTruthy();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);

    serve({ stocks: theirs() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(0);
  });

  it('同じ数のまま「保存」を押し、ほかの人の保存のダイアログを「やめる」と、保存していない入力として出す', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: theirs() });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
  });

  /** 開き直した画面（DB はほかの人の机 7）で、下書きの知らせの「戻す」で机 10 に戻り、「保存」でダイアログの「あなた」が 10 になる */
  async function reopenAndRestoreTen(user: ReturnType<typeof userEvent.setup>) {
    serve({ stocks: theirs() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(0);
  }

  it('R1：同じ数のまま「保存」を押し、ほかの人の保存のダイアログを「やめる」と、入力を下書きに残す（離れて開き直せば戻して選べる）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: theirs() });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    await user.click(within(await screen.findByTestId('stock-conflict-dialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
    await reopenAndRestoreTen(user);
  });

  it('R1・R3：入力を元の数へ戻した後にほかの人の保存が届いたら、入力を下書きに残す（離れて開き直せば戻して選べる）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await screen.findByTestId('stock-remote-change');
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
    await reopenAndRestoreTen(user);
  });

  it('R1：数を変えずに「保存」を押して確かめをやめた後に、ほかの人の保存が裏で届いたら、入力を下書きに残す', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting', latest: false });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await screen.findByTestId('stock-remote-change');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
  });

  it('R3：知らせの「ほかの人の数を読み直す」は、戻していない前の下書きを消さない（ほかの人が同じ数を保存した後。ほかの人の数の上に「戻す」を出す）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const r = renderInput({ role: 'staff', status: 'requesting', latest: false });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await screen.findByTestId('draft-notice');
    // 下書きを戻さずに「保存」を押して（印が立つ）確かめをやめ、ほかの人が同じ数（10）を保存した行が裏で届く
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    db.stocks = [stock(DESK, 10, 'u-other', id(77)), stock(CHAIR, 20)];
    await act(() => r.qc.invalidateQueries());
    const notice = await screen.findByTestId('stock-remote-change');
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    await user.click(within(notice).getByRole('button', { name: 'ほかの人の数を読み直す' }));
    await waitFor(() => expect(screen.queryByTestId('stock-remote-change')).toBeNull());
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(11);
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    expect(upserts()).toHaveLength(0);
  });

  it('R1・R3：下書きを戻さずに読み込んだ数で「保存」し、ダイアログの「読み直す」でほかの人の数を取ると、古い下書きも残さない（「保存」で今の入力を選んだ）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: theirs() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await screen.findByTestId('draft-notice');
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    expect(localStorage.getItem(KEY())).toBeNull();
    expect(upserts()).toHaveLength(0);
  });

  it('名前を読めない人の保存は「ほかの人が … 保存しました（名前は表示できません）」', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: [stock(DESK, 7, 'u-other', null), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    expect(dialog.textContent).toContain('ほかの人が');
    expect(dialog.textContent).toContain('保存しました（名前は表示できません）');
    expect(dialog.textContent).not.toContain('名前を表示できませんさん');
    expect(within(dialog).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['品目', 'ほかの人', 'あなた']);
  });

  it('R1・R3：戻していない古い下書きがあるまま読み込んだ数で「保存」し、ダイアログを「やめる」と、今の入力（10）を下書きに写す（開き直して「戻す」で 10。古い 11 ではない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(11);
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], stocksLater: theirs() });
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await screen.findByTestId('draft-notice');
    // 数え直して 10 で正しいと確かめ、下書きを戻さずに「保存」→ ほかの人の保存のダイアログ →「やめる」
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    // 「保存」を押した入力を選んだので、古い下書きの知らせは出さない
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
    serve({ stocks: theirs() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect(upserts()).toHaveLength(0);
  });

  it('R1・R3：戻していない古い下書きがあるまま「保存」して確かめをやめた後に、ほかの人の保存が裏で届くと、今の入力（10）を下書きに写す', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)] };
    serve(db);
    const r = renderInput({ role: 'staff', status: 'requesting', latest: false });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await screen.findByTestId('draft-notice');
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // 確かめをやめただけでは、保存していない入力はない（古い下書きの知らせは残る）
    expect(screen.getByTestId('draft-notice')).toBeTruthy();
    db.stocks = theirs();
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
  });
});

describe('StockInput：保存できたか分からないとき・401（設計 2.6 の (A)）', () => {
  // 開いたときの行は机 10・椅子 20。1回目の upsert（机 11）は応答が届かない（NETWORK）。部屋の読み込みは
  // 1回目が開いたとき、2回目が1回目の保存の前の読み直し、3回目からが「保存」をもう一度押したときの読み直しなど
  const at = '2026-10-29T09:30:00+00:00';
  const loadedRows = () => [stock(DESK, 10), stock(CHAIR, 20)];
  /** 自分の保存が入った行（desk の数を指定） */
  const mineRows = (desk: number) => [
    { ...stock(DESK, desk, 'u-mine-desk', USER), counted_at: at },
    { ...stock(CHAIR, 20, 'u-mine-chair', USER), counted_at: at },
  ];
  /** ほかの人（テスト管理者）の保存が入った行 */
  const theirRows = () => [{ ...stock(DESK, 7, 'u-other', id(77)), counted_at: at }, stock(CHAIR, 20)];
  const UNKNOWN = '保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります';

  /** 机を 1 増やして（recount なら増やさずに）保存し、応答が届かなかったところまで進める。later は部屋の3回目以降の読み込み */
  async function lostSave(later: (n: number) => FakeResult | undefined, o: { recount?: boolean; qc?: QueryClient } = {}) {
    serve({ stocks: loadedRows(), upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? later(n) : undefined) });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting', qc: o.qc });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    if (!o.recount) await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    const notice = await screen.findByTestId('stock-unknown-outcome');
    expect(upserts()).toHaveLength(1);
    expect(roomReads()).toBe(2);
    return { user, notice, qc: r.qc, unmount: r.unmount, r };
  }

  it('応答が届かなければ、入力を残して「保存できたか分かりません…」を出す。押せないボタン・「確かめる」は出さない', async () => {
    const { notice } = await lostSave(() => undefined);
    expect(notice.textContent).toContain(UNKNOWN);
    expect(within(notice).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: '確かめる' })).toBeNull();
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
  });

  it('もう一度「保存」：読み直した DB に自分の値が入っていれば、送らずに「保存されていました」', async () => {
    const { user } = await lostSave(() => ({ data: mineRows(11) }));
    await user.click(saveButton());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(roomReads()).toBeGreaterThanOrEqual(3);
    expect(upserts()).toHaveLength(1);
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(screen.queryByTestId('stock-unknown-outcome')).toBeNull();
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    expect(localStorage.getItem(KEY())).toBeNull();
  });

  it('同じ数で数え直した保存でも、DB に自分の数え直しが入っていれば「保存されていました」（送り直さない）', async () => {
    const { user } = await lostSave(() => ({ data: mineRows(10) }), { recount: true });
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存されていました');
    expect(upserts()).toHaveLength(1);
  });

  it('もう一度「保存」：DB に入っていなければ（入力の元から何も変わっていない）、そのまま送る', async () => {
    const { user } = await lostSave(() => undefined);
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(11);
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
  });

  it('自分の保存が入った後に入力を変えていれば、自分の保存をほかの人の保存として出さずに、変えた数を送る', async () => {
    const { user } = await lostSave(() => ({ data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(12);
  });

  it('もう一度「保存」：ほかの人の保存があればダイアログで選ばせ、黙って上書きしない（上書きを選べば自分の数を送る）', async () => {
    const { user } = await lostSave(() => ({ data: theirRows() }));
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)711');
    expect(upserts()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(11);
  });

  it('もう一度「保存」：読み直しが通信できなければ送らずに同じ知らせを出し、入力を残す。通信が戻ってから押せば決まる', async () => {
    const { user } = await lostSave((n) => (n === 3 ? NETWORK : { data: mineRows(11) }));
    await user.click(saveButton());
    await waitFor(() => expect(roomReads()).toBe(3));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    expect(upserts()).toHaveLength(1);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存されていました');
    expect(upserts()).toHaveLength(1);
  });

  it('応答が届かなかった後の裏の読み直しに自分の保存が入っていても、自分の保存を「ほかの人の保存」（自分の名前）として出さない', async () => {
    const { user, qc } = await lostSave(() => ({ data: mineRows(11) }));
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByText(/テスト部員さんが/)).toBeNull();
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存されていました');
    expect(upserts()).toHaveLength(1);
  });

  it('同じ数で数え直した保存の応答が届かなかった後、裏の読み直しにほかの人の保存があっても入力を置き換えず知らせる。保存すればダイアログで自分の数を選べる', async () => {
    const { user, qc } = await lostSave(() => ({ data: theirRows() }), { recount: true });
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    const notice = await screen.findByTestId('stock-remote-change');
    await waitFor(() => expect(notice.textContent).toContain('テスト管理者さんが'));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(deskInputBehindDialog().value).toBe('10');
    expect(upserts()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(10);
  });

  it('応答が届かなかった後に入力を元の数へ戻すと、裏の読み直しに自分の保存が入っていても入力を置き換えず、保存すれば戻した数を送る', async () => {
    const { user, qc } = await lostSave(() => ({ data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(10);
  });

  it('数え直しの応答が届かなかった後、ダイアログを「やめる」と、裏の読み直しが来ても入力（R1 の印）と下書きを残してほかの人の保存を知らせ続け、次の「保存」でもダイアログを出す。「分かりません」はダイアログを出したので消える（R2）', async () => {
    const { user, qc } = await lostSave(() => ({ data: theirRows() }), { recount: true });
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect(screen.queryByTestId('stock-unknown-outcome')).toBeNull();
    // 入力は下書きにも残っている（離れて戻れば、ほかの人の数の上に「戻す」が出る）
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
    await user.click(saveButton());
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(1);
  });

  it('保存できたか分からない後に振り分けの合計の確かめを「やめる」と、知らせと入力が残り、裏の読み直しでほかの人の数に置き換えない', async () => {
    serve({
      stocks: loadedRows(),
      allocated: [{ id: 'a', item_id: DESK.id, count: 12 }],
      upsert: (n) => (n === 1 ? NETWORK : undefined),
      roomRead: (n) => (n >= 3 ? { data: theirRows() } : undefined),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'admin', status: 'allocating' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    // 数え直し（机 10 のまま）。振り分けの合計 12 より少ないので確かめて送る → 応答が届かない
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '保存する' }));
    await screen.findByTestId('stock-unknown-outcome');
    expect(upserts()).toHaveLength(1);
    // もう一度「保存」→ 確かめを「やめる」
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    // 次の「保存」は自分の数を送らずに、ほかの人の保存のダイアログを出す
    await user.click(saveButton());
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '保存する' }));
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(1);
  });

  it('保存できたか分からない後に確定中の止まりにかかっても、知らせは残る', async () => {
    serve({
      stocks: loadedRows(),
      upsert: (n) => (n === 1 ? NETWORK : undefined),
      allocated: [],
    });
    const user = userEvent.setup();
    renderInput({ role: 'admin', status: 'confirmed' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    await screen.findByTestId('stock-unknown-outcome');
    // 振り分けの合計が 12 になった後に、もう一度「保存」→ 止まる
    serve({ stocks: loadedRows(), allocated: [{ id: 'a', item_id: DESK.id, count: 12 }] });
    await user.click(saveButton());
    await screen.findByTestId('stock-shortfall-blocked');
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
  });

  it('応答が届かなかった後に入力を元の数へ戻しても、下書きに残し、離れて開き直せば戻して送れる', async () => {
    const { user, unmount } = await lostSave(() => undefined);
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);

    // 1回目の保存（机 11）は DB に入っていた
    fake.issued.length = 0;
    serve({ stocks: mineRows(11) });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(1);
    expect(sentDesk(0)).toBe(10);
  });

  it('応答が届かなかった保存が DB に入っていれば、開き直したときに下書きを消す（後でほかの人が保存しても「戻す」を出さない）', async () => {
    const { unmount } = await lostSave(() => undefined);
    unmount();
    expect(localStorage.getItem(KEY())).not.toBeNull();
    serve({ stocks: mineRows(11) });
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    r.unmount();
    expect(localStorage.getItem(KEY())).toBeNull();
    serve({ stocks: theirRows() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });

  it('応答が届かなかった後に入力を変えて画面を離れ、戻って下書きを戻して保存しても、自分の保存をほかの人の保存として出さない', async () => {
    const { user, unmount } = await lostSave(() => undefined);
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    unmount(); // カメラで次の QR を読みに離れる
    // 下書きは入力と入力の元（送る前に読み直した行）だけ。送信の記録は置かない
    expect(JSON.parse(localStorage.getItem(KEY())!).value).toEqual({
      counts: { [DESK.id]: 12, [CHAIR.id]: 20 },
      base: { [DESK.id]: `u-${DESK.id}`, [CHAIR.id]: `u-${CHAIR.id}` },
    });

    // 離れている間に分かった：1回目の保存（机 11）は DB に入っていた
    fake.issued.length = 0;
    serve({ stocks: mineRows(11) });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('12'));
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(screen.queryByText(/テスト部員さんが/)).toBeNull();
    expect(upserts()).toHaveLength(1);
    expect(sentDesk(0)).toBe(12);
    expect(localStorage.getItem(KEY())).toBeNull();
  });

  it('応答が届かなかった後に画面を離れ、その間にほかの人が保存していれば、戻して保存するときにダイアログで選ばせる（黙って上書きしない）', async () => {
    const { user, unmount } = await lostSave(() => undefined);
    unmount();
    fake.issued.length = 0;
    serve({ stocks: theirRows() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(upserts()).toHaveLength(0);
  });

  it('送っている間に画面を離れて開き直し、保存を押すと、前の送信が終わってから読み直して決める（古い送信で上書きしない）', async () => {
    let release: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done = false;
    serve({
      stocks: loadedRows(),
      upsert: (n) => (n === 1 ? landed.then(() => ((done = true), { data: mineRows(11) })) : undefined),
      roomRead: () => (done ? { data: mineRows(11) } : undefined),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await waitFor(() => expect(upserts()).toHaveLength(1));
    r.unmount(); // 「保存中…」の間に離れる
    renderInput({ role: 'staff', status: 'requesting', qc: r.qc });
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    const reads = roomReads();
    await user.click(saveButton());
    // 前の送信が終わるまでは読み直さない（押せない）
    expect(screen.getByRole('button', { name: '確かめています…' })).toHaveProperty('disabled', true);
    expect(roomReads()).toBe(reads);
    await act(async () => release());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存されていました');
    expect(upserts()).toHaveLength(1);
    // 離れた画面は知らせない
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.success).toHaveBeenCalledWith('保存されていました');
  });

  it('送っている間に画面を離れ、その後に保存できたら、その送信が書いた下書きを消す（開き直してもほかの人の保存の上に「戻す」を出さない）', async () => {
    let release: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve({ stocks: loadedRows(), upsert: (n) => (n === 1 ? landed.then(() => ({ data: mineRows(11) })) : undefined) });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await waitFor(() => expect(upserts()).toHaveLength(1));
    r.unmount(); // 「保存中…」の間に離れる
    expect(localStorage.getItem(KEY())).not.toBeNull();
    await act(async () => release());
    await waitFor(() => expect(localStorage.getItem(KEY())).toBeNull());

    // 後でほかの人が保存した部屋を開き直す
    fake.issued.length = 0;
    serve({ stocks: theirRows() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });

  it('送っている間に離れて開き直し、入力を変えていれば、前の送信が届いても開き直した画面の下書きは消さない', async () => {
    let release: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve({ stocks: loadedRows(), upsert: (n) => (n === 1 ? landed.then(() => ({ data: mineRows(11) })) : undefined) });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await waitFor(() => expect(upserts()).toHaveLength(1));
    r.unmount();
    const r2 = renderInput({ role: 'staff', status: 'requesting', qc: r.qc });
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r2.unmount(); // 書いていない分を書き切る
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(12);
    await act(async () => release());
    await waitFor(() => expect(toasts.success).not.toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(12);
  });

  // ---- 入力の守りの印（R1）・「保存できたか分かりません」を消すとき（R2）・下書きを消すとき（R3）・確かめの途中で離れたとき（R4）----
  const CODED: FakeResult = { error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 };

  it('R2：数え直しの応答が届かなかった後、送る前の読み直しがコードつきで失敗しても「分かりません」と入力は残る。失敗は別に知らせ、裏の読み直しのほかの人の数で置き換えない', async () => {
    const { user, qc } = await lostSave((n) => (n === 3 ? CODED : { data: theirRows() }), { recount: true });
    await user.click(saveButton());
    await waitFor(() => expect(roomReads()).toBe(3));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(4));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    // 次の「保存」は自分の数で黙って送らず、ダイアログで選ばせる
    await user.click(saveButton());
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(1);
  });

  it('R1・R2：応答が届かなかった後に元の数へ戻し、送る前の読み直しがコードつきで失敗しても、裏の読み直しの自分の保存で入力を置き換えず、次の「保存」で戻した数を送る', async () => {
    const { user, qc } = await lostSave((n) => (n === 3 ? CODED : { data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    await user.click(saveButton());
    await waitFor(() => expect(roomReads()).toBe(3));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(4));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(10);
  });

  it('R3：応答が届かなかった後に元の数へ戻して離れ、同じタブで開き直すと、キャッシュの送る前の行では下書きを消さない（DB の自分の保存が届けば「戻す」を出す）', async () => {
    const { user, unmount, qc } = await lostSave(() => undefined);
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    unmount();
    fake.issued.length = 0;
    serve({ stocks: mineRows(11) });
    renderInput({ role: 'staff', status: 'requesting', qc });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(sentDesk(0)).toBe(10);
  });

  it('R3：キャッシュの行を読み直さないうち（staleTime の間）も、送る前の行では下書きを消さない', async () => {
    const qc0 = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const { user, unmount, qc } = await lostSave(() => undefined, { qc: qc0 });
    await user.click(screen.getByRole('button', { name: '机(木)の数を1減らす' }));
    unmount();
    fake.issued.length = 0;
    serve({ stocks: mineRows(11) });
    renderInput({ role: 'staff', status: 'requesting', qc });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
  });

  it('R3：応答が届かなかった保存が入っていれば、同じタブで開き直したとき（キャッシュは送る前の行）も、届いた行で下書きを消す', async () => {
    const { unmount, qc } = await lostSave(() => undefined);
    unmount();
    expect(localStorage.getItem(KEY())).not.toBeNull();
    fake.issued.length = 0;
    serve({ stocks: mineRows(11) });
    const r = renderInput({ role: 'staff', status: 'requesting', qc });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    r.unmount();
    expect(localStorage.getItem(KEY())).toBeNull();
    serve({ stocks: theirRows() });
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });

  it('R1・R2：戻していない下書きがあるまま同じ数で「保存」し、送る前の読み直しが通信できないと、今の入力が下書きを置き換え、裏の読み直しのほかの人の数で入力を置き換えない（次の「保存」はダイアログ）', async () => {
    serve({ stocks: loadedRows() });
    const user = userEvent.setup();
    const r0 = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    r0.unmount();
    fake.issued.length = 0;
    serve({ stocks: loadedRows(), roomRead: (n) => (n === 2 ? NETWORK : n >= 3 ? { data: theirRows() } : undefined) });
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await screen.findByTestId('draft-notice');
    await user.click(saveButton());
    await screen.findByTestId('stock-unknown-outcome');
    // 「保存」を押した入力（10）が保存していない入力になったので、戻していない古い下書き（11）はそれで置き換わる（R1・R3）
    await waitFor(() => expect(screen.queryByTestId('draft-notice')).toBeNull());
    await act(() => r.qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await waitFor(() => expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが'));
    expect(screen.getByTestId('stock-unknown-outcome').textContent).toContain(UNKNOWN);
    await user.click(saveButton());
    expect(within(await screen.findByTestId('stock-conflict-dialog')).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    expect(upserts()).toHaveLength(0);
    r.unmount();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(10);
  });

  it('R1：応答が届かなかった後に書けなくなったら、「保存できたか分かりません…入力はそのまま残しています」を出さず、DB の数を出す', async () => {
    const { qc, r } = await lostSave(() => ({ data: theirRows() }));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    rerenderStatus(r, { role: 'staff', status: 'allocating' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    expect(screen.queryByTestId('stock-unknown-outcome')).toBeNull();
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByTestId('stock-unknown-outcome')).toBeNull();
  });

  it('R4：「確かめています…」の間に離れたら、読み直しが後で返っても送らない（開き直した画面の新しい保存を古い数で上書きしない）', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dbRows = loadedRows();
    serve({
      stocks: loadedRows(),
      upsert: (n) => {
        const vals = opArgs(upserts()[n - 1]!, 'upsert')[0]![0] as { item_id: string; count: number }[];
        dbRows = mineRows(vals.find((v) => v.item_id === DESK.id)!.count);
        return { data: dbRows };
      },
      roomRead: (n) => (n === 2 ? held.then(() => ({ data: loadedRows() })) : { data: dbRows }),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await screen.findByRole('button', { name: '確かめています…' });
    r.unmount();
    renderInput({ role: 'staff', status: 'requesting', qc: r.qc });
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
    expect(sentDesk(0)).toBe(12);
    await act(async () => release());
    await act(async () => {
      await new Promise((res) => setTimeout(res, 100));
    });
    expect(upserts()).toHaveLength(1);
    expect(dbRows.find((x) => x.item_id === DESK.id)!.count).toBe(12);
    expect((deskInput() as HTMLInputElement).value).toBe('12');
  });

  it('応答が届いた失敗（conflict など）は、ふつうの失敗として出す（分からないとは言わない）', async () => {
    serve({ stocks: loadedRows(), upsert: () => ({ error: { code: 'XX000', message: 'boom' }, status: 500 }) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(saveButton());
    const banner = await screen.findByTestId('error-banner');
    expect(banner.getAttribute('data-kind')).toBe('unknown');
    expect(screen.queryByTestId('stock-unknown-outcome')).toBeNull();
  });

  it('保存の前の読み直しで 401 になり、セッションの更新が通ったら保存を続ける', async () => {
    auth.reauthenticate.mockResolvedValueOnce(true);
    serve({ stocks: loadedRows(), roomRead: (n) => (n === 2 ? EXPIRED : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    expect(upserts()).toHaveLength(1);
  });

  it('upsert が 401 で、セッションの更新が通ったら同じ数を1回だけ送り直す', async () => {
    auth.reauthenticate.mockResolvedValueOnce(true);
    serve({ stocks: loadedRows(), upsert: (n) => (n === 1 ? EXPIRED : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    expect((await screen.findByTestId('stock-saved')).textContent).toContain('保存しました');
    expect(upserts()).toHaveLength(2);
    expect(sentDesk(1)).toBe(11);
  });
});

describe('StockInput：前年の数を読めないとき', () => {
  it('失敗を出し、「前年の数を読み直す」で読み直せる（前年がないのと見分ける）', async () => {
    const db: Db = { stocks: [stock(DESK, 10), stock(CHAIR, 20)], prev: [{ room_id: ROOM.id, item_id: DESK.id, count: 8 }], prevError: true };
    serve(db);
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting', prev: true });
    const err = await screen.findByTestId('stock-prev-error');
    expect(err.textContent).toContain('前年の数を読み込めませんでした');
    expect(screen.queryAllByTestId('stock-prev').map((e) => e.textContent)).not.toContain('前年 —');
    db.prevError = false;
    await user.click(within(err).getByRole('button', { name: '前年の数を読み直す' }));
    await waitFor(() => expect(screen.getAllByTestId('stock-prev').map((e) => e.textContent)).toEqual(['前年 8', '前年 —']));
    expect(screen.queryByTestId('stock-prev-error')).toBeNull();
  });
});

describe('StockInput：下書きの書き出し', () => {
  const key = () => draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });

  it('pagehide で、待たずに下書きへ書き出す', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    expect(localStorage.getItem(key())).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(key())!).value.counts).toEqual({ [DESK.id]: 11, [CHAIR.id]: 20 });
  });

  it('裏に回った（visibilitychange で hidden）ときも書き出す', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    expect(localStorage.getItem(key())).toBeNull();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(localStorage.getItem(key())!).value.counts).toEqual({ [DESK.id]: 11, [CHAIR.id]: 20 });
  });
});

describe('StockScreen：年度の切り替え', () => {
  it('開いた部屋で年度を切り替えると（年度の行と場所・品目がキャッシュにあっても）、入力を作り直す（前の年度の入力を持ち越さず、新しい年度に送らない）', async () => {
    const r8Rows = [
      { ...stock(DESK, 3, 'r8-desk'), year_id: LATEST },
      { ...stock(CHAIR, 5, 'r8-chair'), year_id: LATEST },
    ];
    const r7Rows = [stock(DESK, 10), stock(CHAIR, 20)];
    fake.handler = (call) => {
      if (call.table === 'stocks' && opArgs(call, 'upsert').length > 0) {
        const rows = opArgs(call, 'upsert')[0]![0] as { year_id: string; item_id: string; count: number }[];
        return { data: rows.map((x) => ({ ...stock(ITEMS.find((i) => i.id === x.item_id)!, x.count, `saved-${x.item_id}`), year_id: x.year_id })) };
      }
      if (call.table === 'stocks') {
        const yearId = opArgs(call, 'eq').find(([col]) => col === 'year_id')?.[1];
        return { data: yearId === LATEST ? r8Rows : r7Rows };
      }
      if (call.table === 'profiles') return { data: [{ user_id: USER, display_name: 'テスト部員' }] };
      return { data: [] };
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const r8Year: YearRow = { ...yearRow('requesting'), id: LATEST, label: 'R8' };
    const master = { rooms: [ROOM, ROOM2], items: ITEMS, roomYears: [] };
    // 年度の行と場所・品目は両方の年度ともキャッシュにある（数分のうちに切り替えた）
    qc.setQueryData(queryKeys.yearRow(Y), yearRow('requesting'));
    qc.setQueryData(queryKeys.yearRow(LATEST), r8Year);
    qc.setQueryData(queryKeys.yearPart(Y, 'stock-master'), master);
    qc.setQueryData(queryKeys.yearPart(LATEST, 'stock-master'), master);
    // 開いているのは最新でない年度（R7）
    auth.membership = membership('admin', 'requesting', false);
    const tree = () => (
      <QueryClientProvider client={qc}>
        <StockScreen />
      </QueryClientProvider>
    );
    const r = render(tree());
    const user = userEvent.setup();
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    // 最新の年度（R8）に切り替える
    const r8: YearSummary = { id: LATEST, label: 'R8', status: 'requesting', festival_start: '2026-10-17' };
    auth.membership = { ...membership('admin', 'requesting', false), year: r8, latestYear: r8 };
    r.rerender(tree());
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('3'));
    expect((screen.getByRole('textbox', { name: '椅子(木)の数' }) as HTMLInputElement).value).toBe('5');
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    // 前の年度の入力は前の年度の下書きに残り、新しい年度の下書きには書かない
    expect(localStorage.getItem(draftKey({ userId: USER, yearId: LATEST, screen: 'stock', target: ROOM.id }))).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY())!).value.counts[DESK.id]).toBe(11);
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('確かめています…')).toBeNull());
    for (const call of upserts()) {
      const rows = opArgs(call, 'upsert')[0]![0] as { year_id: string; item_id: string; count: number }[];
      expect(rows.find((x) => x.item_id === DESK.id)!.count).toBe(3);
      expect(rows.find((x) => x.item_id === CHAIR.id)!.count).toBe(5);
    }
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
  });
});
