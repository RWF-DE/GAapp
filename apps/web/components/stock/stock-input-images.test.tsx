// @vitest-environment jsdom
// 在庫入力の品目の画像（04「在庫入力」の品目の画像。T23・D-61）：9 品目と備品（数えるだけ）の行の画像（署名つき URL を1回にまとめる）、
// 「その他を足す」の画像のカード、「新しく登録」の写真（add_count_item → reserve_item_image → upload → set_item_image の順。画像の段で
// 失敗しても名前の登録〔行〕は残す）、行のメニューの「写真を足す」、読み取り専用ではメニューを出さないこと。
// Supabase は偽のクライアント（lib/testing/fake-supabase に storage を足したもの）。写真の作り直し（canvas）は差し替える。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, YearSummary } from '@/lib/auth/membership';
import type { CountItemRow, ItemRow, RoomRow, YearRow, YearStatus } from '@/lib/db/types';
import { storageRooms } from '@/lib/data/stocks';
import { type FakeCall, type FakeHandler, type FakeResult } from '@/lib/testing/fake-supabase';
import type { OpenYear } from './common';
import { StockInput } from './stock-input';

const fake = vi.hoisted(() => ({
  handler: null as null | FakeHandler,
  issued: [] as FakeCall[],
  /** Storage の操作（順番を見るため、RPC と同じ列に入れる） */
  log: [] as string[],
  signed: [] as string[][],
  uploads: [] as { path: string; options: unknown; type: string }[],
  removes: [] as string[][],
}));
vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase: create } = await import('@/lib/testing/fake-supabase');
  const { client, issued } = create((call) => {
    fake.log.push(call.table);
    return fake.handler!(call);
  });
  fake.issued = issued;
  const storage = {
    from: () => ({
      createSignedUrls: async (paths: string[]) => {
        fake.signed.push(paths);
        return { data: paths.map((p) => ({ path: p, signedUrl: `https://img.test/${p}`, error: null })), error: null };
      },
      upload: async (path: string, body: Blob, options: unknown) => {
        fake.log.push('upload');
        fake.uploads.push({ path, options, type: body.type });
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        fake.log.push('remove');
        fake.removes.push(paths);
        return { data: [], error: null };
      },
    }),
  };
  return { getSupabase: () => ({ ...client, storage }), authStorageKey: () => 'sb-test-auth-token', supabaseConfigError: () => null };
});
const prep = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/item-images/image', async (orig) => {
  const actual = await orig<typeof import('@/lib/item-images/image')>();
  return {
    ...actual,
    prepareItemImage: async () => {
      if (prep.fail) throw new actual.ItemImageDecodeError();
      return { blob: new Blob(['webp'], { type: 'image/webp' }), contentType: 'image/webp' as const };
    },
  };
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
const DESK: ItemRow = { id: id(101), code: 'i1', name: '机(木)', aliases: [], requestable_categories: ['stall'], sort_order: 1, updated_at: 't' };
const CHAIR: ItemRow = { ...DESK, id: id(102), code: 'i2', name: 'パイプ椅子', sort_order: 2 };
const ci = (n: number, name: string, always: boolean): CountItemRow => ({ id: id(200 + n), name, always_shown: always, sort_order: n, updated_at: 't' });
const TRASH = ci(1, 'ゴミ箱', true);
const FAN = ci(3, '扇風機', true);
const VACUUM = ci(6, '掃除機', false);
const WHITE = ci(5, '白椅子', false);
const COUNT_ITEMS = [TRASH, FAN, WHITE, VACUUM];
const NEW_ID = id(299);
const DESK_IMG = `items/${DESK.id}/${id(901)}.webp`;
const TRASH_IMG = `count-items/${TRASH.id}/${id(902)}.webp`;
const VACUUM_IMG = `count-items/${VACUUM.id}/${id(903)}.jpg`;

function yearRow(status: YearStatus): YearRow {
  return {
    id: Y,
    label: 'E2E-年度',
    status,
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2001-10-13',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: null,
    updated_at: 't',
  };
}

function membership(role: 'admin' | 'head' | 'staff', status: YearStatus): Membership {
  const year: YearSummary = { id: Y, label: 'E2E-年度', status, festival_start: '2001-10-13' };
  return { displayName: 'テスト部員', year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
}

const reserveArgs = () => fake.issued.filter((c) => c.table === 'rpc:reserve_item_image').map((c) => c.ops[0]!.args[0]);
const setArgs = () => fake.issued.filter((c) => c.table === 'rpc:set_item_image').map((c) => c.ops[0]!.args[0]);

function serve(o: { reserve?: FakeResult; addReturns?: string } = {}) {
  fake.handler = (call) => {
    if (call.table === 'items') return { data: [{ id: DESK.id, image_path: DESK_IMG }, { id: CHAIR.id, image_path: null }] };
    if (call.table === 'count_items' && call.ops.some((op) => op.op === 'eq')) {
      // 1行の今の画像（fetchItemImagePath）
      const target = call.ops.find((op) => op.op === 'eq')!.args[1];
      const paths: Record<string, string> = { [TRASH.id]: TRASH_IMG, [VACUUM.id]: VACUUM_IMG };
      return { data: { image_path: paths[target as string] ?? null } };
    }
    if (call.table === 'count_items') {
      // 画像の path の読み込み（id, image_path）
      return { data: [{ id: TRASH.id, image_path: TRASH_IMG }, { id: VACUUM.id, image_path: VACUUM_IMG }, { id: FAN.id, image_path: null }] };
    }
    if (call.table === 'stocks' || call.table === 'count_stocks') return { data: [] };
    if (call.table === 'rpc:add_count_item') return { data: o.addReturns ?? NEW_ID };
    if (call.table === 'rpc:reserve_item_image') {
      if (o.reserve) return o.reserve;
      const a = call.ops[0]!.args[0] as { p_target_id: string; p_image_id: string };
      return { data: { id: a.p_image_id, object_path: `count-items/${a.p_target_id}/${a.p_image_id}.webp` } };
    }
    if (call.table === 'rpc:set_item_image') return { data: null };
    return { data: [] };
  };
}

function renderInput(role: 'admin' | 'head' | 'staff', status: YearStatus) {
  auth.membership = membership(role, status);
  const open: OpenYear = { membership: auth.membership as Membership, year: (auth.membership as Membership).year!, role, userId: USER };
  const storage = storageRooms([ROOM], []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StockInput open={open} year={yearRow(status)} target={storage[0]!} storage={storage} items={[DESK, CHAIR]} countItems={COUNT_ITEMS} />
    </QueryClientProvider>,
  );
}

const rowOf = (testId: string, name: string) => screen.getAllByTestId(testId).find((li) => li.textContent?.includes(name))!;

beforeEach(() => {
  localStorage.clear();
  fake.issued.length = 0;
  fake.log = [];
  fake.signed = [];
  fake.uploads = [];
  fake.removes = [];
  prep.fail = false;
  for (const f of Object.values(toasts)) f.mockClear();
});
afterEach(() => cleanup());

describe('T23 在庫入力の品目の画像：行', () => {
  it('9 品目と備品の行に画像（URL は createSignedUrls を1回で全部）。画像のない物は頭文字のカード。押すと大きく出す', async () => {
    serve();
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await waitFor(() => expect(within(rowOf('stock-item-row', '机(木)')).getByTestId('item-image').querySelector('img')).not.toBeNull());
    expect(within(rowOf('stock-item-row', '机(木)')).getByRole('img', { name: '机(木)' }).getAttribute('src')).toBe(`https://img.test/${DESK_IMG}`);
    expect(within(rowOf('stock-item-row', 'パイプ椅子')).getByTestId('item-image').dataset.state).toBe('none');
    await waitFor(() => expect(within(rowOf('count-item-row', 'ゴミ箱')).getByRole('img', { name: 'ゴミ箱' })).toBeTruthy());
    expect(within(rowOf('count-item-row', '扇風機')).getByTestId('item-image').dataset.initial).toBe('扇');
    // まとめて1回（その他のカードに出す掃除機も含む）
    expect(fake.signed).toEqual([[DESK_IMG, TRASH_IMG, VACUUM_IMG].sort()]);
    await user.click(within(rowOf('stock-item-row', '机(木)')).getByRole('button', { name: '机(木)の画像を大きく見る' }));
    expect((await screen.findByTestId('item-image-large')).querySelector('img')!.getAttribute('src')).toBe(`https://img.test/${DESK_IMG}`);
  });

  it('「その他を足す」の選択肢は画像のカード（画像のない物は頭文字）', async () => {
    serve();
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await waitFor(() => expect(fake.signed).toHaveLength(1));
    await user.click(screen.getByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    const options = within(dialog).getAllByTestId('add-count-item-option');
    expect(options.map((o) => o.textContent)).toEqual(['白椅子', '掃除機']);
    expect(within(options[0]!).getByTestId('item-image').dataset.state).toBe('none');
    expect(options[1]!.querySelector('img')!.getAttribute('src')).toBe(`https://img.test/${VACUUM_IMG}`);
    // カードの名前は1回だけ読み上げる（画像の代替の文字は空）
    expect(within(dialog).getByRole('button', { name: '掃除機' })).toBe(options[1]);
  });

  it('総務部門員は振り分け中に読み取り専用：画像は出し、写真のメニューは出さない', async () => {
    serve();
    renderInput('staff', 'allocating');
    await waitFor(() => expect(within(rowOf('count-item-row', 'ゴミ箱')).getByRole('img', { name: 'ゴミ箱' })).toBeTruthy());
    expect(screen.queryByTestId('count-item-menu')).toBeNull();
  });
});

describe('T23 在庫入力の「新しく登録」の写真', () => {
  it('写真つき：add_count_item → reserve_item_image → upload（upsert: false）→ set_item_image の順で送り、行を出す', async () => {
    serve();
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await waitFor(() => expect(fake.signed).toHaveLength(1));
    await user.click(screen.getByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    expect(within(dialog).getByText('人の顔・名前・掲示物が写らないように撮ってください')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), '台形机');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'photo.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
    expect(fake.log.filter((t) => t === 'rpc:add_count_item' || t === 'rpc:reserve_item_image' || t === 'upload' || t === 'rpc:set_item_image')).toEqual([
      'rpc:add_count_item',
      'rpc:reserve_item_image',
      'upload',
      'rpc:set_item_image',
    ]);
    const r = reserveArgs()[0] as { p_kind: string; p_target_id: string; p_image_id: string; p_content_type: string };
    expect(r).toMatchObject({ p_kind: 'count_item', p_target_id: NEW_ID, p_content_type: 'image/webp' });
    expect(fake.uploads).toEqual([{ path: `count-items/${NEW_ID}/${r.p_image_id}.webp`, options: { contentType: 'image/webp', upsert: false }, type: 'image/webp' }]);
    expect(setArgs()).toEqual([{ p_kind: 'count_item', p_target_id: NEW_ID, p_image_id: r.p_image_id }]);
    expect(screen.getByRole('textbox', { name: '台形机の数' })).toBeTruthy();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('写真なしなら画像の RPC を送らない', async () => {
    serve();
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await user.click(await screen.findByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), '台形机');
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '台形机の数' })).toBeTruthy());
    expect(reserveArgs()).toEqual([]);
  });

  it('画像の段で失敗しても（予約の storage_full・写真を読めない）名前の登録と行は残し、「画像は後から足せます」', async () => {
    serve({ reserve: { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'storage_full' }) } } });
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await user.click(await screen.findByTestId('count-item-add'));
    let dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), '台形机');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '台形机の数' })).toBeTruthy());
    expect(toasts.error).toHaveBeenCalledWith('名前は登録しました。画像は後から足せます', {
      description: '画像の置き場がいっぱいです（上限 100 MB）。管理者に知らせてください',
    });
    expect(fake.uploads).toEqual([]);

    prep.fail = true;
    toasts.error.mockClear();
    await user.click(screen.getByTestId('count-item-add'));
    dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), '丸椅子');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('名前は登録しました。画像は後から足せます', { description: '写真を読み込めませんでした。別の写真を選んでください' }),
    );
  });
});

describe('T23 レビューで直したこと：「新しく登録」で既にある名前に写真をつけたとき', () => {
  const register = async (name: string) => {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), name);
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() => expect(screen.queryByTestId('add-count-item-dialog')).toBeNull());
  };

  it('手元の一覧にある画像のない物（白椅子）：写真を捨てずに、その物の画像として送り、知らせる', async () => {
    serve({ addReturns: WHITE.id });
    renderInput('staff', 'requesting');
    await register('白椅子');
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「白椅子」は既にある物でした。写真を足しました'));
    expect(fake.log.filter((t) => t === 'rpc:add_count_item')).toHaveLength(1);
    expect(reserveArgs()).toMatchObject([{ p_kind: 'count_item', p_target_id: WHITE.id }]);
    expect(setArgs()).toMatchObject([{ p_kind: 'count_item', p_target_id: WHITE.id }]);
    expect(screen.getByRole('textbox', { name: '白椅子の数' })).toBeTruthy();
  });

  it('手元の一覧にある画像のある物（掃除機）：写真は送らず（黙って替えない）、行のメニューから替えるよう知らせる', async () => {
    serve({ addReturns: VACUUM.id });
    renderInput('staff', 'requesting');
    await register('掃除機');
    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledWith('「掃除機」は既にある物で、画像もあります。写真は送っていません。替えるときは行のメニューの「写真を替える」から'),
    );
    expect(reserveArgs()).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(fake.removes).toEqual([]);
    expect(screen.getByRole('textbox', { name: '掃除機の数' })).toBeTruthy();
  });

  it('手元の一覧にない名前で、add_count_item が画像のある既存の id を返した（ほかの人が同時に足した）：送らない', async () => {
    serve({ addReturns: VACUUM.id });
    renderInput('staff', 'requesting');
    await register('そうじき');
    await waitFor(() => expect(toasts.info).toHaveBeenCalled());
    expect(reserveArgs()).toEqual([]);
    expect(fake.removes).toEqual([]);
  });

  it('写真がなければ、手元の一覧の同じ名前は今までどおり RPC を呼ばずに行を出す', async () => {
    serve();
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await user.click(await screen.findByTestId('count-item-add'));
    const dialog = await screen.findByTestId('add-count-item-dialog');
    await user.type(within(dialog).getByLabelText('新しく登録する名前'), '白椅子');
    await user.click(within(dialog).getByRole('button', { name: '新しく登録' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '白椅子の数' })).toBeTruthy());
    expect(fake.log.filter((t) => t === 'rpc:add_count_item')).toEqual([]);
  });
});

describe('T23 在庫入力の行のメニュー「写真を足す」「写真を替える」', () => {
  it('画像のない物は「写真を足す」、ある物は「写真を替える」。送ると set_item_image まで送り、前の物を消す', async () => {
    serve();
    fake.handler = ((base) => (call: FakeCall) => (call.table === 'rpc:set_item_image' ? { data: TRASH_IMG } : base(call)))(fake.handler!);
    const user = userEvent.setup();
    renderInput('staff', 'requesting');
    await waitFor(() => expect(fake.signed).toHaveLength(1));
    await user.click(within(rowOf('count-item-row', '扇風機')).getByRole('button', { name: '扇風機のメニュー' }));
    expect((await screen.findByTestId('count-item-photo')).textContent).toBe('写真を足す');
    await user.keyboard('{Escape}');
    await user.click(within(rowOf('count-item-row', 'ゴミ箱')).getByRole('button', { name: 'ゴミ箱のメニュー' }));
    await user.click(await screen.findByRole('menuitem', { name: '写真を替える' }));
    const dialog = await screen.findByTestId('item-photo-dialog');
    expect(dialog.textContent).toContain('「ゴミ箱」の写真を替える');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByTestId('item-photo-submit'));
    await waitFor(() => expect(screen.queryByTestId('item-photo-dialog')).toBeNull());
    expect(reserveArgs()).toMatchObject([{ p_kind: 'count_item', p_target_id: TRASH.id }]);
    expect(setArgs()).toMatchObject([{ p_kind: 'count_item', p_target_id: TRASH.id }]);
    expect(fake.removes).toEqual([[TRASH_IMG]]);
    expect(toasts.success).toHaveBeenCalledWith('写真を送りました');
  });
});
