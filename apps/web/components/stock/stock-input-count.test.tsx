// @vitest-environment jsdom
// 在庫入力の備品（数えるだけ）のテスト（04「在庫入力」の備品〔数えるだけ〕。T22・D-60）。
// 最初から出す4つの行と「その他」、「＋ その他を足す」（一覧から選ぶ・新しい名前・同じ名前）、保存の順番（在庫の upsert の後に
// 数の upsert。出ている行を全部。0 を含む）、数の保存だけが失敗したとき、ほかの人の保存（数の行）、下書き、読み取り専用。
// Supabase は偽のクライアント（lib/testing/fake-supabase）に差し替え、立場は useAuth を差し替える（stock-input.test.tsx と同じ形）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, YearSummary } from '@/lib/auth/membership';
import type { CountItemRow, CountStockDbRow, ItemRow, RoomRow, StockDbRow, YearRow, YearStatus } from '@/lib/db/types';
import { draftKey } from '@/lib/drafts';
import { storageRooms } from '@/lib/data/stocks';
import { opArgs, type FakeCall, type FakeHandler, type FakeResult } from '@/lib/testing/fake-supabase';
import type { OpenYear } from './common';
import { StockInput } from './stock-input';

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
  useSearchParams: () => new URLSearchParams(''),
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
const OTHER = '00000000-0000-4000-8000-000000000077';
const Y = '11111111-1111-4111-8111-111111111111';
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
const DESK: ItemRow = { id: id(101), code: 'i1', name: '机(木)', aliases: [], requestable_categories: ['stall'], sort_order: 1, updated_at: 't' };
const ITEMS = [DESK];
const ci = (n: number, name: string, always: boolean): CountItemRow => ({ id: id(200 + n), name, always_shown: always, sort_order: n, updated_at: 't' });
const TRASH = ci(1, 'ゴミ箱', true);
const CORD = ci(2, '延長コード', true);
const FAN = ci(3, '扇風機', true);
const ORANGE = ci(4, 'オレンジ椅子', true);
const WHITE = ci(5, '白椅子', false);
const VACUUM = ci(6, '掃除機', false);
const COUNT_ITEMS = [TRASH, CORD, FAN, ORANGE, WHITE, VACUUM];

const stock = (count: number, updatedAt = 'u-desk', countedBy: string | null = USER): StockDbRow => ({
  year_id: Y,
  room_id: ROOM.id,
  item_id: DESK.id,
  count,
  counted_at: '2026-10-05T09:01:00+00:00',
  counted_by: countedBy,
  updated_at: updatedAt,
});
const cs = (c: CountItemRow, count: number, updatedAt = `cu-${c.id}`, countedBy: string | null = USER): CountStockDbRow => ({
  year_id: Y,
  room_id: ROOM.id,
  count_item_id: c.id,
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

function membership(role: 'admin' | 'head' | 'staff', status: YearStatus): Membership {
  const year: YearSummary = { id: Y, label: 'E2E-年度', status, festival_start: '2001-10-13' };
  return { displayName: 'テスト部員', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

interface Db {
  stocks: StockDbRow[];
  counts: CountStockDbRow[];
  /** 2回目以降の部屋の数の読み込みで返す行（ほかの人の保存） */
  countsLater?: CountStockDbRow[];
  prevCounts?: { room_id: string; count_item_id: string; count: number }[];
  /** n 回目（1 から）の count_stocks の upsert の結果（undefined なら保存できたことにする） */
  countUpsert?: (n: number) => FakeResult | undefined;
  /** add_count_item の結果（既定は新しい id） */
  addResult?: FakeResult;
}

const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
const NEW_ID = id(299);

function serve(db: Db) {
  let countReads = 0;
  let countUpserts = 0;
  fake.handler = (call) => {
    if (call.table === 'stocks' && opArgs(call, 'upsert').length > 0) {
      const rows = opArgs(call, 'upsert')[0]![0] as { count: number }[];
      return { data: rows.map((r) => ({ ...stock(r.count, 'saved-desk'), counted_at: '2026-10-29T09:30:00+00:00' })) };
    }
    if (call.table === 'stocks') return { data: db.stocks };
    if (call.table === 'count_stocks' && opArgs(call, 'upsert').length > 0) {
      countUpserts += 1;
      const forced = db.countUpsert?.(countUpserts);
      if (forced) return forced;
      const rows = opArgs(call, 'upsert')[0]![0] as { count_item_id: string; count: number }[];
      return {
        data: rows.map((r) => ({
          ...cs(COUNT_ITEMS.find((c) => c.id === r.count_item_id) ?? { ...WHITE, id: r.count_item_id }, r.count, `saved-${r.count_item_id}`),
          counted_at: '2026-10-29T09:30:00+00:00',
        })),
      };
    }
    if (call.table === 'count_stocks') {
      countReads += 1;
      return { data: countReads > 1 && db.countsLater ? db.countsLater : db.counts };
    }
    if (call.table === 'rpc:previous_year_stocks') return { data: [] };
    if (call.table === 'rpc:previous_year_count_stocks') return { data: db.prevCounts ?? [] };
    if (call.table === 'rpc:add_count_item') return db.addResult ?? { data: NEW_ID };
    if (call.table === 'profiles') return { data: [{ user_id: USER, display_name: 'テスト部員' }, { user_id: OTHER, display_name: 'テスト管理者' }] };
    return { data: [] };
  };
}

function renderInput(o: { role: 'admin' | 'head' | 'staff'; status: YearStatus; prev?: boolean; countItems?: CountItemRow[] }) {
  auth.membership = membership(o.role, o.status);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role: o.role, userId: USER };
  const storage = storageRooms([ROOM, ROOM2], []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StockInput open={open} year={yearRow(o.status, o.prev)} target={storage[0]!} storage={storage} items={ITEMS} countItems={o.countItems ?? COUNT_ITEMS} />
    </QueryClientProvider>,
  );
}

const countRows = () => screen.getAllByTestId('count-item-row').map((li) => within(li).getByText(/./, { selector: 'p.font-medium' }).textContent);
const countInput = (name: string) => screen.getByRole('textbox', { name: `${name}の数` }) as HTMLInputElement;
const stockUpserts = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length > 0);
const countUpserts = () => fake.issued.filter((c) => c.table === 'count_stocks' && opArgs(c, 'upsert').length > 0);
const sentCounts = (n: number) => opArgs(countUpserts()[n]!, 'upsert')[0]![0] as { year_id: string; room_id: string; count_item_id: string; count: number }[];
const KEY = () => draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });

beforeEach(() => {
  localStorage.clear();
  fake.issued.length = 0;
  for (const f of Object.values(toasts)) f.mockClear();
});
afterEach(() => cleanup());

describe('StockInput の備品（数えるだけ）：行', () => {
  it('9 品目の下に、最初から出す4つと、この部屋に数の行がある「その他」だけを出す（行のない物は 0。前年の数も出す）', async () => {
    serve({
      stocks: [stock(10)],
      counts: [cs(TRASH, 3), cs(WHITE, 2)],
      prevCounts: [{ room_id: ROOM.id, count_item_id: TRASH.id, count: 5 }],
    });
    renderInput({ role: 'staff', status: 'requesting', prev: true });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('3'));
    expect(countRows()).toEqual(['ゴミ箱', '延長コード', '扇風機', 'オレンジ椅子', '白椅子']);
    expect(countInput('延長コード').value).toBe('0');
    expect(countInput('白椅子').value).toBe('2');
    // 掃除機（行がない「その他」）は出さない
    expect(screen.queryByRole('textbox', { name: '掃除機の数' })).toBeNull();
    const trashRow = screen.getAllByTestId('count-item-row')[0]!;
    await waitFor(() => expect(within(trashRow).getByTestId('stock-prev').textContent).toBe('前年 5'));
    expect(within(screen.getAllByTestId('count-item-row')[1]!).getByTestId('stock-prev').textContent).toBe('前年 —');
  });

  it('保存は在庫の upsert の後に、出ている数の行を全部（0 を含む）1回の upsert で送る', async () => {
    serve({ stocks: [stock(10)], counts: [cs(WHITE, 2)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('白椅子').value).toBe('2'));
    await user.click(screen.getByRole('button', { name: 'ゴミ箱の数を1増やす' }));
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(stockUpserts()).toHaveLength(1);
    expect(countUpserts()).toHaveLength(1);
    // 在庫の後に数（発行の順）
    expect(fake.issued.indexOf(stockUpserts()[0]!)).toBeLessThan(fake.issued.indexOf(countUpserts()[0]!));
    expect(sentCounts(0)).toEqual([
      { year_id: Y, room_id: ROOM.id, count_item_id: TRASH.id, count: 1 },
      { year_id: Y, room_id: ROOM.id, count_item_id: CORD.id, count: 0 },
      { year_id: Y, room_id: ROOM.id, count_item_id: FAN.id, count: 0 },
      { year_id: Y, room_id: ROOM.id, count_item_id: ORANGE.id, count: 0 },
      { year_id: Y, room_id: ROOM.id, count_item_id: WHITE.id, count: 2 },
    ]);
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
  });

  it('備品（数えるだけ）の名前が1つもなければ、欄を出さず数の upsert も送らない', async () => {
    serve({ stocks: [stock(10)], counts: [] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting', countItems: [] });
    await waitFor(() => expect((screen.getByRole('textbox', { name: '机(木)の数' }) as HTMLInputElement).value).toBe('10'));
    expect(screen.queryByTestId('count-items-section')).toBeNull();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(countUpserts()).toHaveLength(0);
  });

  it('総務部門員は振り分け中に読み取り専用：数の欄も押せず、「＋ その他を足す」を出さない', async () => {
    serve({ stocks: [stock(10)], counts: [cs(TRASH, 3)] });
    renderInput({ role: 'staff', status: 'allocating' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('3'));
    expect(countInput('ゴミ箱').disabled).toBe(true);
    expect(screen.queryByTestId('count-item-add')).toBeNull();
  });
});

describe('StockInput の備品（数えるだけ）：「＋ その他を足す」', () => {
  it('一覧（最初から出す物ともう出ている物を除く。名前で絞れる）から選ぶと、数 0 の行が出て保存していない入力になり、保存で送る', async () => {
    serve({ stocks: [stock(10)], counts: [cs(WHITE, 2)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('白椅子').value).toBe('2'));
    await user.click(screen.getByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    // 選べるのは掃除機だけ（4つと白椅子は除く）
    expect(within(dialog).getAllByTestId('add-count-item-option').map((b) => b.textContent)).toEqual(['掃除機']);
    await user.type(within(dialog).getByLabelText('名前で絞る'), 'ｿｳｼﾞ');
    expect(within(dialog).getByTestId('add-count-item-empty').textContent).toBe('当てはまる物はありません。');
    await user.clear(within(dialog).getByLabelText('名前で絞る'));
    await user.type(within(dialog).getByLabelText('名前で絞る'), '掃除');
    await user.click(within(dialog).getByRole('button', { name: '掃除機' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
    expect(countInput('掃除機').value).toBe('0');
    // 数 0 でも、行がまだないので保存していない入力（離れるときに確かめ、下書きに入る）
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY()) ?? 'null')?.value.counts[`c:${VACUUM.id}`]).toBe(0));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(sentCounts(0).map((r) => [r.count_item_id, r.count])).toContainEqual([VACUUM.id, 0]);
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
    expect(localStorage.getItem(KEY())).toBeNull();
  });

  it('「新しい名前で足す」は前後の空白を除いて add_count_item を呼び、返った id の行を出す', async () => {
    serve({ stocks: [stock(10)], counts: [] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しい名前で足す'), '  台形机 ');
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
    const rpc = fake.issued.filter((c) => c.table === 'rpc:add_count_item');
    expect(rpc).toHaveLength(1);
    expect(opArgs(rpc[0]!, 'rpc')[0]![0]).toEqual({ p_year_id: Y, p_name: '台形机' });
    expect(countInput('台形机').value).toBe('0');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(sentCounts(0).map((r) => r.count_item_id)).toContain(NEW_ID);
  });

  it('同じ名前（全角・半角と大文字小文字を無視）があれば RPC を呼ばずにその物を足す。空・51 字以上は送らずに知らせる', async () => {
    serve({ stocks: [stock(10)], counts: [] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByTestId('count-item-add'));
    let dialog = await screen.findByTestId('add-count-item-dialog');
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('名前を入れてください');
    await user.type(within(dialog).getByLabelText('新しい名前で足す'), 'あ'.repeat(51));
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('名前は 50 字までです');
    await user.clear(within(dialog).getByLabelText('新しい名前で足す'));
    await user.type(within(dialog).getByLabelText('新しい名前で足す'), '白椅子');
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
    expect(countInput('白椅子').value).toBe('0');
    expect(fake.issued.filter((c) => c.table === 'rpc:add_count_item')).toHaveLength(0);
    // 最初から出す物の名前を書いても、行が増えない（もう出ている）
    await user.click(screen.getByTestId('count-item-add'));
    dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しい名前で足す'), 'ｺﾞﾐ箱');
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
    expect(screen.getAllByRole('textbox', { name: 'ゴミ箱の数' })).toHaveLength(1);
    expect(fake.issued.filter((c) => c.table === 'rpc:add_count_item')).toHaveLength(0);
  });

  it('add_count_item が forbidden なら、ダイアログに文言を出して行を足さない', async () => {
    serve({ stocks: [stock(10)], counts: [], addResult: { error: { code: 'P0001', message: 'forbidden', details: null, hint: null }, status: 400 } });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しい名前で足す'), '台形机');
    await user.click(within(dialog).getByRole('button', { name: '新しい名前で足す' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('権限がありません。立場が変わった可能性があります');
    expect(screen.queryByRole('textbox', { name: '台形机の数', hidden: true })).toBeNull();
  });
});

describe('StockInput の備品（数えるだけ）：保存の失敗・ほかの人の保存・下書き', () => {
  it('在庫が通って数の保存が失敗したら、在庫の保存は決まり、数は保存していない入力として残す。もう一度「保存」で数も送る', async () => {
    serve({ stocks: [stock(10)], counts: [], countUpsert: (n) => (n === 1 ? { error: { code: 'XX000', message: 'boom' }, status: 500 } : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByRole('button', { name: 'ゴミ箱の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('在庫の数は保存しました。備品（数えるだけ）の数はまだ保存していません'));
    expect(stockUpserts()).toHaveLength(1);
    expect(countUpserts()).toHaveLength(1);
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    expect(countInput('ゴミ箱').value).toBe('1');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY()) ?? 'null')?.value.counts[`c:${TRASH.id}`]).toBe(1));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(countUpserts()).toHaveLength(2);
    expect(sentCounts(1)[0]).toEqual({ year_id: Y, room_id: ROOM.id, count_item_id: TRASH.id, count: 1 });
  });

  it('在庫の保存が失敗したら、数は送らない', async () => {
    serve({ stocks: [stock(10)], counts: [] });
    const base = fake.handler!;
    fake.handler = (call) => (call.table === 'stocks' && opArgs(call, 'upsert').length > 0 ? { error: { code: '42501', message: 'denied' }, status: 403 } : base(call));
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByRole('button', { name: 'ゴミ箱の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/権限がありません/);
    expect(countUpserts()).toHaveLength(0);
  });

  it('数の保存の応答が届かなければ「保存できたか分かりません」を出し、入力を残す', async () => {
    serve({ stocks: [stock(10)], counts: [], countUpsert: (n) => (n === 1 ? NETWORK : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByRole('button', { name: 'ゴミ箱の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-unknown-outcome');
    expect(countInput('ゴミ箱').value).toBe('1');
  });

  it('読み込んだ後にほかの人が数を保存していれば、保存の前に選ばせる（ダイアログに数の行も並ぶ）', async () => {
    serve({ stocks: [stock(10)], counts: [cs(TRASH, 3)], countsLater: [cs(TRASH, 7, 'cu-other', OTHER)] });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('3'));
    await user.click(screen.getByRole('button', { name: 'ゴミ箱の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    const row = within(dialog)
      .getAllByTestId('conflict-row')
      .find((r) => r.textContent?.startsWith('ゴミ箱'))!;
    expect(row.textContent).toBe('ゴミ箱74');
    expect(stockUpserts()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    await screen.findByTestId('stock-saved');
    expect(sentCounts(0)[0]).toEqual({ year_id: Y, room_id: ROOM.id, count_item_id: TRASH.id, count: 4 });
  });

  it('足した物の下書きは、開き直して「戻す」と「その他」の行に戻る', async () => {
    serve({ stocks: [stock(10)], counts: [] });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    await user.click(screen.getByTestId('count-item-add'));
    await user.click(within(await screen.findByTestId('add-count-item-dialog')).getByRole('button', { name: '白椅子' }));
    await user.click(screen.getByRole('button', { name: '白椅子の数を1増やす' }));
    r.unmount();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(countInput('ゴミ箱').value).toBe('0'));
    expect(screen.queryByRole('textbox', { name: '白椅子の数' })).toBeNull();
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect(countInput('白椅子').value).toBe('1'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(sentCounts(0).find((x) => x.count_item_id === WHITE.id)?.count).toBe(1);
    expect(localStorage.getItem(KEY())).toBeNull();
  });
});
