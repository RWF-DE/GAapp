// @vitest-environment jsdom
// 在庫入力の部品のテスト（画面の設計 7.1「在庫入力の読み取り専用の切り替えと最新でない年度の確認」。T10）。
// Supabase は偽のクライアント（lib/testing/fake-supabase）に差し替え、立場は useAuth を差し替える。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, YearSummary } from '@/lib/auth/membership';
import type { ItemRow, RoomRow, StockDbRow, YearRow, YearStatus } from '@/lib/db/types';
import { draftKey } from '@/lib/drafts';
import { storageRooms } from '@/lib/data/stocks';
import { opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import type { OpenYear } from './common';
import { StockInput } from './stock-input';

const fake = vi.hoisted(() => ({ handler: null as null | ((call: FakeCall) => FakeResult), issued: [] as FakeCall[] }));
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
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
  allocated?: { id: string; item_id: string; count: number }[];
  prev?: { room_id: string; item_id: string; count: number }[];
}

function serve(db: Db) {
  let stockReads = 0;
  fake.handler = (call) => {
    if (call.table === 'stocks' && opArgs(call, 'upsert').length > 0) {
      const rows = opArgs(call, 'upsert')[0]![0] as { item_id: string; count: number }[];
      return { data: rows.map((r) => ({ ...stock(ITEMS.find((i) => i.id === r.item_id)!, r.count, `saved-${r.item_id}`), counted_at: '2026-10-29T09:30:00+00:00' })) };
    }
    if (call.table === 'stocks') {
      const isRoom = opArgs(call, 'eq').some(([col]) => col === 'room_id');
      if (!isRoom) return { data: db.stocks };
      stockReads += 1;
      return { data: stockReads > 1 && db.stocksLater ? db.stocksLater : db.stocks };
    }
    if (call.table === 'allocations') return { data: db.allocated ?? [] };
    if (call.table === 'rpc:previous_year_stocks') return { data: db.prev ?? [] };
    if (call.table === 'profiles') return { data: [{ user_id: USER, display_name: 'テスト部員' }, { user_id: id(77), display_name: 'テスト管理者' }] };
    return { data: [] };
  };
}

function renderInput(o: { role: 'admin' | 'staff'; status: YearStatus; latest?: boolean; prev?: boolean }) {
  auth.membership = membership(o.role, o.status, o.latest ?? true);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role: o.role, userId: USER };
  const storage = storageRooms([ROOM, ROOM2], []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StockInput open={open} year={yearRow(o.status, o.prev)} target={storage[0]!} storage={storage} items={ITEMS} />
    </QueryClientProvider>,
  );
}

const upserts = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length > 0);
const deskInput = () => screen.getByRole('textbox', { name: '机(木)の数' });

beforeEach(() => {
  localStorage.clear();
  fake.issued.length = 0;
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
