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

function renderInput(o: { role: 'admin' | 'staff'; status: YearStatus; latest?: boolean; prev?: boolean }) {
  auth.membership = membership(o.role, o.status, o.latest ?? true);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role: o.role, userId: USER };
  const storage = storageRooms([ROOM, ROOM2], []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <StockInput open={open} year={yearRow(o.status, o.prev)} target={storage[0]!} storage={storage} items={ITEMS} />
    </QueryClientProvider>,
  );
  return Object.assign(r, { qc });
}

const upserts = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length > 0);
const deskInput = () => screen.getByRole('textbox', { name: '机(木)の数' });
const saveButton = () => screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
/** 部屋の stocks の読み込み（upsert を除く）の回数 */
const roomReads = () => fake.issued.filter((c) => c.table === 'stocks' && opArgs(c, 'upsert').length === 0 && opArgs(c, 'eq').some(([col]) => col === 'room_id')).length;
const REBASED = '前に送った値は保存されていました。その後に変えた値はまだ保存していません';
const NOT_SAVED = '前に送った値は保存されていませんでした。もう一度「保存」を押してください';

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
});

describe('StockInput：保存できたか分からないとき・401', () => {
  // 未確定の間の決まり（notes/T10.md の決めたことの 21）。送った値は机 11・椅子 20（recount なら机 10・椅子 20）
  const at = '2026-10-29T09:30:00+00:00';
  /** 自分の保存が入った行（desk の数を指定） */
  const mineRows = (desk: number) => [
    { ...stock(DESK, desk, 'u-mine-desk', USER), counted_at: at },
    { ...stock(CHAIR, 20, 'u-mine-chair', USER), counted_at: at },
  ];
  /** ほかの人（テスト管理者）の保存が入った行 */
  const theirRows = () => [{ ...stock(DESK, 7, 'u-other', id(77)), counted_at: at }, stock(CHAIR, 20)];

  it('通信の失敗の「もう一度」で、読み直した行が送った数で数えた人が自分なら「保存されていました」（送り直さない）', async () => {
    // 1回目の upsert は DB に入ったが応答が届かなかった
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? { data: mineRows(11) } : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const banner = await screen.findByTestId('error-banner');
    await user.click(within(banner).getByRole('button', { name: 'もう一度' }));
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(1);
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
  });

  it('「もう一度」の前の読み直しで、自分の保存が入っていてその後に入力を変えていれば、知らせて送らない（もう一度「保存」でその数を送る）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? { data: mineRows(11) } : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('error-banner');
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REBASED));
    expect(upserts()).toHaveLength(1);
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect((deskInput() as HTMLInputElement).value).toBe('12');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    // 元は自分の保存の入った行になったので、ほかの人の保存のダイアログは出ずにその数で送る
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(12);
  });

  it('「もう一度」の前の読み直しで、自分の保存が入っておらずほかの人の保存があれば、ダイアログで選ばせる（送らない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? { data: theirRows() } : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const banner = await screen.findByTestId('error-banner');
    await user.click(within(banner).getByRole('button', { name: 'もう一度' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(upserts()).toHaveLength(1);
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
  });

  /** 1回目の upsert の応答が届かず（NETWORK）、「もう一度」の保存の前の読み直し（部屋の3回目の読み込み）も通信できない。
   *  4回目以降（「確かめる」・裏の読み直し）は check の結果（undefined なら読み込んだときの行） */
  async function untilUnconfirmed(check: (n: number) => FakeResult | undefined, o: { recount?: boolean } = {}) {
    serve({
      stocks: [stock(DESK, 10), stock(CHAIR, 20)],
      upsert: (n) => (n === 1 ? NETWORK : undefined),
      roomRead: (n) => (n === 3 ? NETWORK : n >= 4 ? check(n) : undefined),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    // recount：同じ数で数え直して保存する（入力を変えずに「保存」を押す）
    if (!o.recount) await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    const banner = await screen.findByTestId('error-banner');
    await user.click(within(banner).getByRole('button', { name: 'もう一度' }));
    const notice = await screen.findByTestId('stock-unconfirmed');
    expect(roomReads()).toBe(3);
    return { user, notice, qc: r.qc, unmount: r.unmount };
  }

  it('「もう一度」の保存の前の読み直しも通信できなければ、入力を残して「確かめる」まで送り直しを押せなくする', async () => {
    const { notice } = await untilUnconfirmed(() => undefined);
    expect(notice.textContent).toContain('保存できたか確かめられません。通信が戻ったら「確かめる」を押してください');
    expect(within(notice).getByRole('button', { name: '確かめる' })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(upserts()).toHaveLength(1);
  });

  it('「確かめる」で読み直し、自分の保存が入っていれば「保存されていました」（送り直さない）', async () => {
    const { user, notice } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    const saved = await screen.findByTestId('stock-saved');
    expect(roomReads()).toBeGreaterThan(3);
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
    expect(screen.queryByText('保存していない変更があります')).toBeNull();
  });

  it('「確かめる」で、自分の保存が入っていてその後に入力を変えていれば「前に送った値は保存されていました…」と知らせ、保存を押せる状態に戻す', async () => {
    const { user, notice } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REBASED));
    expect(roomReads()).toBeGreaterThan(3);
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    expect((deskInput() as HTMLInputElement).value).toBe('12');
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
    // 元は自分の保存の入った行（ダイアログを出さずに 12 を送る）
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(12);
  });

  it('「確かめる」で読み直して保存が入っておらず、ほかの人の保存もなければ「保存されていませんでした」と知らせて送り直せる状態に戻す', async () => {
    const { user, notice } = await untilUnconfirmed(() => undefined);
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-unconfirmed')).toBeNull());
    expect(roomReads()).toBeGreaterThan(3);
    expect(toasts.info).toHaveBeenCalledWith(NOT_SAVED);
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(11);
  });

  it('「確かめる」で、ほかの人の保存があれば「保存されていませんでした」と言い切らず、ダイアログで選ばせる（入力を変えていなくても置き換えない。上書きできる）', async () => {
    const { user, notice } = await untilUnconfirmed(() => ({ data: theirRows() }), { recount: true });
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(roomReads()).toBeGreaterThan(3);
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)710');
    // ダイアログの裏でも入力はほかの人の数に置き換わらない（モーダルの裏は aria-hidden なので hidden で探す）
    expect((screen.getByRole('textbox', { name: '机(木)の数', hidden: true }) as HTMLInputElement).value).toBe('10');
    expect(upserts()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: '上書きする' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(10);
  });

  it('「確かめる」でほかの人の保存があり、やめても入力は置き換えず、「保存」でもう一度ダイアログを出す。読み直すとほかの人の数になる', async () => {
    const { user, notice, qc } = await untilUnconfirmed(() => ({ data: theirRows() }));
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    let dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull());
    // やめた後の裏の読み直しでも、入力は置き換えない
    const before = roomReads();
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(roomReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('stock-input').getAttribute('data-fetching')).toBe('false'));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(screen.getByTestId('stock-remote-change').textContent).toContain('テスト管理者さんが');
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    dialog = await screen.findByTestId('stock-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('7'));
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    expect(upserts()).toHaveLength(1);
  });

  it('「確かめる」の読み直しも通信できなければ、押した後に読み直したうえで、知らせを残して送り直しを押せないまま', async () => {
    const { user, notice } = await untilUnconfirmed(() => NETWORK);
    expect(toasts.error).not.toHaveBeenCalled();
    await user.click(within(notice).getByRole('button', { name: '確かめる' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('まだ通信できません。通信が戻ったらもう一度「確かめる」を押してください'));
    expect(roomReads()).toBe(4);
    expect(screen.getByTestId('stock-unconfirmed')).toBe(notice);
    expect(within(notice).getByRole('button', { name: '確かめる' })).toHaveProperty('disabled', false);
    expect(saveButton().disabled).toBe(true);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(upserts()).toHaveLength(1);
  });

  it('未確定の間の裏の読み直し（通信が戻ったときなど）で自分の保存が入っていれば、入力を置き換えずに「保存されていました」で終える', async () => {
    // 同じ数（10・20）で数え直した保存が DB に入っていた
    const { qc } = await untilUnconfirmed(() => ({ data: mineRows(10) }), { recount: true });
    await act(() => qc.invalidateQueries());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
  });

  it('未確定の間の裏の読み直しで自分の保存が入っていれば、自分の保存を「ほかの人の保存」（自分の名前）として出さない', async () => {
    const { qc } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    await act(() => qc.invalidateQueries());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByText(/テスト部員さんが/)).toBeNull();
    expect(upserts()).toHaveLength(1);
  });

  it('未確定の間の裏の読み直しで、自分の保存が入っていてその後に入力を変えていれば、入力を残して知らせ、保存を押せる状態に戻す', async () => {
    const { user, qc } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REBASED));
    expect((deskInput() as HTMLInputElement).value).toBe('12');
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
  });

  it('未確定の間の裏の読み直しで、保存が入っておらずほかの人の保存もなければ「保存されていませんでした」と知らせ、入力を残して送り直せる', async () => {
    const { qc } = await untilUnconfirmed(() => undefined);
    await act(() => qc.invalidateQueries());
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(NOT_SAVED));
    expect(roomReads()).toBeGreaterThan(3);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(upserts()).toHaveLength(1);
  });

  it('未確定の間の裏の読み直しでほかの人の保存があれば、入力を変えていなくても置き換えずに知らせる（「保存」でダイアログ）', async () => {
    // 通信の失敗の ErrorBanner が出ている間（確かめられないの前）に、通信が戻って部屋の行が読み直された
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? { data: theirRows() } : undefined) });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('error-banner');
    await act(() => r.qc.invalidateQueries());
    const remote = await screen.findByTestId('stock-remote-change');
    await waitFor(() => expect(remote.textContent).toContain('テスト管理者さんが'));
    await waitFor(() => expect(screen.getByTestId('last-counted').textContent).toContain('テスト管理者'));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    expect(screen.queryByTestId('stock-saved')).toBeNull();
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(upserts()).toHaveLength(1);
  });

  it('通信の失敗の後の裏の読み直しで自分の保存が入っていれば、「もう一度」を待たずに「保存されていました」（送り直さない）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], upsert: (n) => (n === 1 ? NETWORK : undefined), roomRead: (n) => (n >= 3 ? { data: mineRows(10) } : undefined) });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('error-banner');
    await act(() => r.qc.invalidateQueries());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect(screen.queryByTestId('stock-remote-change')).toBeNull();
    expect(upserts()).toHaveLength(1);
  });
  /** 届くまで止めておける結果（release で返す） */
  function held(result: FakeResult) {
    let release: () => void = () => undefined;
    const promise = new Promise<FakeResult>((resolve) => {
      release = () => resolve(result);
    });
    return { promise, release: () => release() };
  }
  const loadedRows = () => [stock(DESK, 10), stock(CHAIR, 20)];

  it('送る前に始まった部屋の行の再取得が送信の失敗の後に届いても、「保存されていませんでした」と決めない（未確定のまま）', async () => {
    // 2回目の読み込み（開いた後の裏の読み直し）は送る前の行を読んだが、届くのが送信の失敗の後になった
    const late = held({ data: loadedRows() });
    serve({
      stocks: loadedRows(),
      upsert: (n) => (n === 1 ? NETWORK : undefined),
      roomRead: (n) => (n === 2 ? late.promise : n >= 4 ? { data: mineRows(11) } : undefined),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await act(async () => {
      void r.qc.invalidateQueries();
    });
    await waitFor(() => expect(roomReads()).toBe(2));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await screen.findByTestId('error-banner');
    expect(roomReads()).toBe(3);
    await act(async () => late.release());
    await act(async () => undefined);
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    // 未確定のまま：この後に読み直した行に自分の保存が入っていれば「保存されていました」
    await act(() => r.qc.invalidateQueries());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(screen.queryByText(/テスト部員さんが/)).toBeNull();
    expect(upserts()).toHaveLength(1);
  });

  it('送っている間に始まった部屋の行の再取得が送信の失敗の後に届いても、「保存されていませんでした」と決めない（未確定のまま）', async () => {
    const lost = held(NETWORK);
    const late = held({ data: loadedRows() });
    serve({
      stocks: loadedRows(),
      upsert: (n) => (n === 1 ? lost.promise : undefined),
      roomRead: (n) => (n === 3 ? late.promise : n >= 4 ? { data: mineRows(11) } : undefined),
    });
    const user = userEvent.setup();
    const r = renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    await waitFor(() => expect(upserts()).toHaveLength(1));
    await act(async () => {
      void r.qc.invalidateQueries();
    });
    await waitFor(() => expect(roomReads()).toBe(3));
    await act(async () => lost.release());
    await screen.findByTestId('error-banner');
    await act(async () => late.release());
    await act(async () => undefined);
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    await act(() => r.qc.invalidateQueries());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect(upserts()).toHaveLength(1);
  });

  it('未確定のまま入力を変えて画面を離れ、開き直して下書きを戻して保存しても、自分の保存をほかの人の保存として出さない（rebased）', async () => {
    const { user, unmount } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    unmount(); // カメラで次の QR を読みに離れる
    const key = draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id });
    expect(JSON.parse(localStorage.getItem(key)!).value.sent.counts).toEqual({ [DESK.id]: 11, [CHAIR.id]: 20 });

    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REBASED));
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    const notice = await screen.findByTestId('draft-notice');
    await user.click(within(notice).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('12'));
    await user.click(saveButton());
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存しました');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(screen.queryByText(/テスト部員さんが/)).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(12);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('未確定のまま画面を離れ、開き直したときに自分の保存が入っていれば「保存されていました」（下書きを出さず、送り直さない）', async () => {
    const { unmount } = await untilUnconfirmed(() => ({ data: mineRows(11) }));
    unmount();
    renderInput({ role: 'staff', status: 'requesting' });
    const saved = await screen.findByTestId('stock-saved');
    expect(saved.textContent).toContain('保存されていました');
    expect((deskInput() as HTMLInputElement).value).toBe('11');
    expect(screen.queryByTestId('draft-notice')).toBeNull();
    expect(localStorage.getItem(draftKey({ userId: USER, yearId: Y, screen: 'stock', target: ROOM.id }))).toBeNull();
    expect(upserts()).toHaveLength(1);
  });

  it('未確定のまま画面を離れ、開き直したときに保存が入っておらずほかの人の保存もなければ「保存されていませんでした」。戻して保存すると確かめずに送る', async () => {
    const { user, unmount } = await untilUnconfirmed(() => undefined);
    unmount();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(NOT_SAVED));
    expect((deskInput() as HTMLInputElement).value).toBe('10');
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(saveButton());
    await screen.findByTestId('stock-saved');
    expect(screen.queryByTestId('stock-conflict-dialog')).toBeNull();
    expect(upserts()).toHaveLength(2);
    expect((opArgs(upserts()[1]!, 'upsert')[0]![0] as { count: number }[])[0]!.count).toBe(11);
  });

  it('未確定のまま画面を離れ、開き直したときにほかの人の保存があれば、言い切らずに知らせ、戻して保存するとダイアログで選ばせる', async () => {
    const { user, unmount } = await untilUnconfirmed(() => ({ data: theirRows() }));
    unmount();
    renderInput({ role: 'staff', status: 'requesting' });
    const remote = await screen.findByTestId('stock-remote-change');
    await waitFor(() => expect(remote.textContent).toContain('テスト管理者さんが'));
    expect(toasts.info).not.toHaveBeenCalledWith(NOT_SAVED);
    await user.click(within(await screen.findByTestId('draft-notice')).getByRole('button', { name: '戻す' }));
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('11'));
    await user.click(saveButton());
    const dialog = await screen.findByTestId('stock-conflict-dialog');
    await waitFor(() => expect(dialog.textContent).toContain('テスト管理者さんが'));
    expect(within(dialog).getAllByTestId('conflict-row')[0]!.textContent).toBe('机(木)711');
    expect(upserts()).toHaveLength(1);
  });

  it('応答が届かなかった送信がなければ、保存の前の読み直しの通信の失敗はふつうのエラー（「もう一度」で送れる）', async () => {
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], roomRead: (n) => (n === 2 ? NETWORK : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(saveButton());
    const banner = await screen.findByTestId('error-banner');
    expect(screen.queryByTestId('stock-unconfirmed')).toBeNull();
    expect(upserts()).toHaveLength(0);
    await user.click(within(banner).getByRole('button', { name: 'もう一度' }));
    await screen.findByTestId('stock-saved');
    expect(upserts()).toHaveLength(1);
  });

  it('保存の前の読み直しで 401 になり、セッションの更新が通ったら保存を続ける', async () => {
    auth.reauthenticate.mockResolvedValueOnce(true);
    serve({ stocks: [stock(DESK, 10), stock(CHAIR, 20)], roomRead: (n) => (n === 2 ? EXPIRED : undefined) });
    const user = userEvent.setup();
    renderInput({ role: 'staff', status: 'requesting' });
    await waitFor(() => expect((deskInput() as HTMLInputElement).value).toBe('10'));
    await user.click(screen.getByRole('button', { name: '机(木)の数を1増やす' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('stock-saved');
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    expect(upserts()).toHaveLength(1);
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
