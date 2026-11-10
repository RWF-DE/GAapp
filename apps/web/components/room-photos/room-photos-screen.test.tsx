// @vitest-environment jsdom
// 現状復帰の写真 /room-photos（04「現状復帰の写真」。T25・D-63）：部屋の一覧（建物ごと・今年と前年の枚数・名前で絞る）、部屋の写真
// （今年・前年。署名つき URL は bucket room-photos に1回でまとめる）、書ける人の出し分け（総務・部門の代表・終了した年度・6 枚）、
// 写真を足す（reserve → upload → add。失敗は同じ id で送り直す）・メモを直す・並べ替える・消す。
// Supabase は偽のクライアント（lib/testing/fake-supabase に storage を足したもの）。写真の作り直し（canvas）は差し替える。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary, Membership, YearSummary } from '@/lib/auth/membership';
import type { YearStatus } from '@/lib/db/types';
import type { RoomPhotoRow } from '@/lib/data/room-photos';
import { type FakeCall, type FakeHandler } from '@/lib/testing/fake-supabase';
import { RoomPhotosScreen } from './room-photos-screen';

const fake = vi.hoisted(() => ({
  handler: null as null | FakeHandler,
  issued: [] as FakeCall[],
  log: [] as string[],
  signed: [] as { bucket: string; paths: string[] }[],
  uploads: [] as { bucket: string; path: string; options: unknown }[],
  removes: [] as { bucket: string; paths: string[] }[],
}));
vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase: create } = await import('@/lib/testing/fake-supabase');
  const { client, issued } = create((call) => {
    fake.log.push(call.table);
    return fake.handler!(call);
  });
  fake.issued = issued;
  const storage = {
    from: (bucket: string) => ({
      createSignedUrls: async (paths: string[]) => {
        fake.signed.push({ bucket, paths });
        return { data: paths.map((p) => ({ path: p, signedUrl: `https://img.test/${p}`, error: null })), error: null };
      },
      upload: async (path: string, _body: Blob, options: unknown) => {
        fake.log.push('upload');
        fake.uploads.push({ bucket, path, options });
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        fake.log.push('remove');
        fake.removes.push({ bucket, paths });
        return { data: [], error: null };
      },
      list: async () => ({ data: [], error: null }),
    }),
  };
  return { getSupabase: () => ({ ...client, storage }), authStorageKey: () => 'sb-test-auth-token', supabaseConfigError: () => null };
});
vi.mock('@/lib/item-images/image', async (orig) => {
  const actual = await orig<typeof import('@/lib/item-images/image')>();
  return { ...actual, prepareItemImage: async () => ({ blob: new Blob(['webp'], { type: 'image/webp' }), contentType: 'image/webp' as const }) };
});
const auth = vi.hoisted(() => ({ membership: null as unknown, reloadMembership: vi.fn() }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: { status: 'ready', membership: auth.membership },
    session: { status: 'signedIn', session: { user: { id: 'u1' } } },
    isRefreshing: false,
    reloadMembership: auth.reloadMembership,
    setYear: vi.fn(),
    signOut: vi.fn(),
  }),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = id(9001);
const P = id(9000);
const R1 = id(1);
const R2 = id(2);
const R3 = id(3);
const ROOMS = [
  { id: R1, name: '1年1組', aliases: ['いちねんいちくみ'], kind: 'room', building: '一般棟', floor: 1, sort_order: 1 },
  { id: R2, name: '物理実験室', aliases: [], kind: 'room', building: '実験棟', floor: 2, sort_order: 2 },
  { id: R3, name: '1年2組', aliases: [], kind: 'room', building: '一般棟', floor: 1, sort_order: 3 },
];
const photo = (n: number, over: Partial<RoomPhotoRow> = {}): RoomPhotoRow => ({
  id: id(500 + n),
  year_id: Y,
  room_id: R1,
  object_path: `${over.year_id ?? Y}/${over.room_id ?? R1}/${id(500 + n)}.webp`,
  memo: '',
  sort_order: n,
  created_at: '2026-11-10T01:00:00Z',
  created_by: null,
  updated_at: '2026-11-10T01:00:00Z',
  ...over,
});

const world = { photos: [] as RoomPhotoRow[], prevReadable: true, status: 'preparing' as YearStatus, prevYear: P as string | null };

function yearRow(yid: string) {
  return {
    id: yid,
    label: yid === Y ? 'R9' : 'R8',
    status: yid === Y ? world.status : 'closed',
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2027-10-16',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: yid === Y ? world.prevYear : null,
    updated_at: 't',
  };
}

function serve(extra: (call: FakeCall) => ReturnType<FakeHandler> | undefined = () => undefined) {
  fake.handler = (call) => {
    const o = extra(call);
    if (o) return o;
    if (call.table === 'years') {
      const yid = call.ops.find((op) => op.op === 'eq')?.args[1] as string;
      if (yid === P && !world.prevReadable) return { data: null };
      return { data: yearRow(yid) };
    }
    if (call.table === 'rooms') return { data: ROOMS };
    if (call.table === 'rpc:room_photos_with_previous') {
      const a = call.ops[0]!.args[0] as { p_room_id: string | null };
      return { data: world.photos.filter((p) => a.p_room_id === null || p.room_id === a.p_room_id) };
    }
    if (call.table === 'rpc:reserve_room_photo') {
      const a = call.ops[0]!.args[0] as { p_year_id: string; p_room_id: string; p_photo_id: string };
      return { data: { id: a.p_photo_id, object_path: `${a.p_year_id}/${a.p_room_id}/${a.p_photo_id}.webp`, used_at: null, expires_at: '2999-01-01T00:00:00Z' } };
    }
    // add は送ったメモの行を返す（新しい予約の add。0024）
    if (call.table === 'rpc:add_room_photo') return { data: photo(9, { memo: (call.ops[0]!.args[0] as { p_memo: string }).p_memo }) };
    if (call.table === 'rpc:update_room_photo') return { data: photo(9) };
    if (call.table === 'rpc:delete_room_photo') return { data: world.photos[0]?.object_path ?? null };
    return { data: [] };
  };
}

function membershipOf(o: { role?: Membership['role']; groups?: GroupSummary[] }): Membership {
  const year: YearSummary = { id: Y, label: 'R9', status: world.status, festival_start: '2027-10-16' };
  return { displayName: 'テスト', year, role: o.role ?? null, groups: o.groups ?? [], years: [year], latestYear: year, adminOfOpenYear: false };
}
const DEPT_REP = membershipOf({ groups: [{ id: 'g', name: '執行部', year_id: Y, role: 'deputy_manager', category: 'department' }] });

function renderScreen(m: Membership, search = '') {
  auth.membership = m;
  nav.search = search;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoomPhotosScreen />
    </QueryClientProvider>,
  );
}

const rpcArgs = (name: string) => fake.issued.filter((c) => c.table === `rpc:${name}`).map((c) => c.ops[0]!.args[0]);

beforeEach(() => {
  fake.issued.length = 0;
  fake.log = [];
  fake.signed = [];
  fake.uploads = [];
  fake.removes = [];
  world.photos = [];
  world.prevReadable = true;
  world.status = 'preparing';
  world.prevYear = P;
  auth.reloadMembership.mockClear();
  for (const f of Object.values(toasts)) f.mockClear();
});
afterEach(() => cleanup());

describe('T25 部屋の一覧', () => {
  it('建物ごと（sort_order → 名前 → id）に部屋と「今年 n 枚・前年 m 枚」（0 は「まだ」）。全部の場所を1回で数える。上に見られる人の注意', async () => {
    world.photos = [photo(1), photo(2), photo(3, { year_id: P }), photo(4, { room_id: R2, year_id: P })];
    serve();
    renderScreen(membershipOf({ role: 'staff' }));
    await screen.findByTestId('room-photos-list');
    await waitFor(() => expect(screen.getAllByTestId('room-photo-room')).toHaveLength(3));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('現状復帰の写真');
    expect(document.body.textContent).toContain('写真は総務と執行部（各部門の部門長・副部門長）だけが見られます');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['一般棟', '実験棟']);
    const rows = screen.getAllByTestId('room-photo-room');
    expect(rows.map((r) => [r.textContent?.replace(/今年.*/, ''), within(r).getByTestId('room-photo-count').textContent])).toEqual([
      ['1年1組', '今年 2 枚・前年 1 枚'],
      ['1年2組', '今年 まだ・前年 まだ'],
      ['物理実験室', '今年 まだ・前年 1 枚'],
    ]);
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe(`/room-photos?room=${R1}`);
    expect(rpcArgs('room_photos_with_previous')).toEqual([{ p_year_id: Y, p_room_id: null }]);
    // 一覧では URL を作らない
    expect(fake.signed).toEqual([]);
  });

  it('名前（別名も）で絞る。前の年度がなければ前年を出さない', async () => {
    world.prevYear = null;
    serve();
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'admin' }));
    await waitFor(() => expect(screen.getAllByTestId('room-photo-room')).toHaveLength(3));
    expect(screen.getAllByTestId('room-photo-count').map((e) => e.textContent)).toEqual(['今年 まだ', '今年 まだ', '今年 まだ']);
    await user.type(screen.getByPlaceholderText('場所の名前で絞る'), 'いちねん');
    expect(screen.getAllByTestId('room-photo-room').map((r) => r.dataset.roomId)).toEqual([R1]);
  });
});

describe('T25 部屋の写真', () => {
  it('総務：今年（R9）と前年（R8）を並び順に。URL は出す写真の分を bucket room-photos で1回に。「写真を足す」と写真ごとのメニュー', async () => {
    world.photos = [photo(2, { memo: '黒板の前' }), photo(1), photo(3, { year_id: P })];
    serve();
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    expect((await screen.findByTestId('room-photo-room-name')).textContent).toBe('1年1組');
    const current = await screen.findByTestId('room-photos-current');
    const previous = screen.getByTestId('room-photos-previous');
    expect(within(current).getByRole('heading').textContent).toBe('今年（R9）');
    expect(within(previous).getByRole('heading').textContent).toBe('前年（R8）');
    await waitFor(() => expect(within(current).getAllByRole('img')).toHaveLength(2));
    expect(within(current).getAllByTestId('room-photo').map((li) => li.dataset.photoId)).toEqual([id(501), id(502)]);
    expect(within(current).getAllByRole('img')[1]!.getAttribute('src')).toBe(`https://img.test/${photo(2).object_path}`);
    expect(within(current).getByTestId('room-photo-memo').textContent).toBe('黒板の前');
    expect(fake.signed).toEqual([{ bucket: 'room-photos', paths: [photo(1).object_path, photo(2).object_path, photo(3, { year_id: P }).object_path].sort() }]);
    expect(screen.getByTestId('room-photo-add')).toBeTruthy();
    expect(within(current).getAllByTestId('room-photo-menu')).toHaveLength(2);
    // 前年の写真は直せない
    expect(within(previous).queryByTestId('room-photo-menu')).toBeNull();
    // 押すと大きく出し、総務には足した日時
    await user.click(within(current).getByRole('button', { name: '1年1組 の今年の写真 2（黒板の前）を大きく見る' }));
    const large = await screen.findByTestId('room-photo-large');
    expect(large.textContent).toContain('黒板の前');
    expect(within(large).getByTestId('room-photo-created-at')).toBeTruthy();
  });

  it('部門の代表：見るだけ（足す・メニューを出さない。足した日時も出さない）。前の年度の名前を読めなければ「前年」', async () => {
    world.photos = [photo(1), photo(3, { year_id: P })];
    world.prevReadable = false;
    serve();
    const user = userEvent.setup();
    renderScreen(DEPT_REP, `room=${R1}`);
    const current = await screen.findByTestId('room-photos-current');
    await waitFor(() => expect(within(current).getAllByRole('img')).toHaveLength(1));
    expect(within(screen.getByTestId('room-photos-previous')).getByRole('heading').textContent).toBe('前年');
    expect(screen.queryByTestId('room-photo-add')).toBeNull();
    expect(screen.queryByTestId('room-photo-menu')).toBeNull();
    expect(screen.queryByText('終了した年度のため、写真は見るだけです')).toBeNull();
    await user.click(within(current).getByRole('button', { name: /を大きく見る$/ }));
    expect(within(await screen.findByTestId('room-photo-large')).queryByTestId('room-photo-created-at')).toBeNull();
  });

  it('写真がなければ「まだ写真がありません」「前の年度の写真はありません」、前の年度がなければ「前の年度はありません」', async () => {
    serve();
    renderScreen(membershipOf({ role: 'head' }), `room=${R1}`);
    expect((await screen.findByTestId('room-photos-current')).textContent).toContain('まだ写真がありません');
    expect(screen.getByTestId('room-photos-previous').textContent).toContain('前の年度の写真はありません');
    cleanup();
    world.prevYear = null;
    renderScreen(membershipOf({ role: 'head' }), `room=${R1}`);
    expect((await screen.findByTestId('room-photos-previous')).textContent).toContain('前の年度はありません');
  });

  it('終了した年度：総務には帯を出し、足す・メニューを出さない', async () => {
    world.status = 'closed';
    world.photos = [photo(1)];
    serve();
    renderScreen(membershipOf({ role: 'admin' }), `room=${R1}`);
    expect((await screen.findByTestId('read-only-notice')).textContent).toBe('終了した年度のため、写真は見るだけです');
    await screen.findByTestId('room-photos-current');
    expect(screen.queryByTestId('room-photo-add')).toBeNull();
    expect(screen.queryByTestId('room-photo-menu')).toBeNull();
  });

  it('6 枚あれば「写真を足す」を出さず「1 部屋 6 枚までです…」', async () => {
    world.photos = [1, 2, 3, 4, 5, 6].map((n) => photo(n));
    serve();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    expect((await screen.findByTestId('room-photo-full')).textContent).toBe('1 部屋 6 枚までです。足すときは先に消してください');
    expect(screen.queryByTestId('room-photo-add')).toBeNull();
  });

  it('room が場所の一覧にない・形が違うときは「この場所は見つかりません」と一覧へのリンク', async () => {
    serve();
    renderScreen(membershipOf({ role: 'staff' }), `room=${id(77)}`);
    expect(await screen.findByText('この場所は見つかりません')).toBeTruthy();
    expect(screen.getByRole('link', { name: '一覧へ' }).getAttribute('href')).toBe('/room-photos');
    cleanup();
    renderScreen(membershipOf({ role: 'staff' }), 'room=abc');
    expect(await screen.findByText('この場所は見つかりません')).toBeTruthy();
  });
});

describe('T25 書き込み', () => {
  it('写真を足す：注意の文とメモ（{n}/50）。reserve → upload（room-photos・upsert: false）→ add の順に送り、閉じて知らせる', async () => {
    serve();
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    await user.click(await screen.findByTestId('room-photo-add'));
    const dialog = await screen.findByTestId('room-photo-add-dialog');
    expect(dialog.textContent).toContain('人の顔・名前・掲示物が写らないように撮ってください');
    expect(within(dialog).getByRole('button', { name: '撮る' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '写真を選ぶ' })).toBeTruthy();
    expect(within(dialog).getByTestId('item-photo-camera').getAttribute('capture')).toBe('environment');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.type(within(dialog).getByTestId('room-photo-memo-input'), ' 机は後ろ ');
    expect(within(dialog).getByTestId('room-photo-memo-count').textContent).toBe('4/50');
    await user.click(within(dialog).getByTestId('room-photo-submit'));
    await waitFor(() => expect(screen.queryByTestId('room-photo-add-dialog')).toBeNull());
    expect(fake.log.filter((t) => t.startsWith('rpc:') && t !== 'rpc:room_photos_with_previous').concat()).toEqual(['rpc:reserve_room_photo', 'rpc:add_room_photo']);
    expect(fake.log.indexOf('upload')).toBeGreaterThan(fake.log.indexOf('rpc:reserve_room_photo'));
    expect(fake.log.indexOf('upload')).toBeLessThan(fake.log.indexOf('rpc:add_room_photo'));
    expect(fake.uploads[0]).toMatchObject({ bucket: 'room-photos', options: { contentType: 'image/webp', upsert: false } });
    const reserve = rpcArgs('reserve_room_photo')[0] as { p_photo_id: string };
    expect(reserve).toMatchObject({ p_year_id: Y, p_room_id: R1, p_content_type: 'image/webp' });
    expect(rpcArgs('add_room_photo')).toEqual([{ p_photo_id: reserve.p_photo_id, p_memo: '机は後ろ' }]);
    expect(toasts.success).toHaveBeenCalledWith('写真を足しました');
  });

  it('失敗はダイアログの中に出し、もう一度「送る」は同じ photo_id で送り直す。51 字のメモは送らない', async () => {
    let n = 0;
    serve((c) => (c.table === 'rpc:add_room_photo' && n++ === 0 ? { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'not_uploaded' }) } } : undefined));
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    await user.click(await screen.findByTestId('room-photo-add'));
    const dialog = await screen.findByTestId('room-photo-add-dialog');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.type(within(dialog).getByTestId('room-photo-memo-input'), 'あ'.repeat(51));
    await user.click(within(dialog).getByTestId('room-photo-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('メモは 50 字までです');
    expect(rpcArgs('reserve_room_photo')).toEqual([]);
    await user.clear(within(dialog).getByTestId('room-photo-memo-input'));
    await user.click(within(dialog).getByTestId('room-photo-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('写真がまだ届いていません。もう一度「送る」を押してください');
    await user.click(within(dialog).getByTestId('room-photo-submit'));
    await waitFor(() => expect(screen.queryByTestId('room-photo-add-dialog')).toBeNull());
    const ids = rpcArgs('reserve_room_photo').map((a) => (a as { p_photo_id: string }).p_photo_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('権限なし（forbidden）は「写真を足す権限がありません」と立場の読み直し', async () => {
    serve((c) => (c.table === 'rpc:reserve_room_photo' ? { error: { code: 'P0001', message: 'forbidden', details: null } } : undefined));
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    await user.click(await screen.findByTestId('room-photo-add'));
    const dialog = await screen.findByTestId('room-photo-add-dialog');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByTestId('room-photo-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('写真を足す権限がありません');
    expect(auth.reloadMembership).toHaveBeenCalled();
  });

  it('メモを直す（memo だけ）・後ろへ（隣と sort_order を入れ替えて2回）・消す（確かめの後に delete → remove）', async () => {
    world.photos = [photo(0, { memo: '前のメモ' }), photo(1)];
    serve();
    const user = userEvent.setup();
    renderScreen(membershipOf({ role: 'staff' }), `room=${R1}`);
    const current = await screen.findByTestId('room-photos-current');
    await waitFor(() => expect(within(current).getAllByTestId('room-photo-menu')).toHaveLength(2));

    await user.click(within(current).getAllByTestId('room-photo-menu')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'メモを直す' }));
    const memoDialog = await screen.findByTestId('room-photo-memo-dialog');
    const input = within(memoDialog).getByTestId('room-photo-memo-input') as HTMLInputElement;
    expect(input.value).toBe('前のメモ');
    await user.clear(input);
    await user.type(input, '新しいメモ');
    await user.click(within(memoDialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.queryByTestId('room-photo-memo-dialog')).toBeNull());
    expect(rpcArgs('update_room_photo')).toEqual([{ p_photo_id: id(500), p_memo: '新しいメモ', p_sort_order: null }]);

    await user.click(within(screen.getByTestId('room-photos-current')).getAllByTestId('room-photo-menu')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: '後ろへ' }));
    await waitFor(() => expect(rpcArgs('update_room_photo')).toHaveLength(3));
    expect(rpcArgs('update_room_photo').slice(1)).toEqual([
      { p_photo_id: id(500), p_memo: null, p_sort_order: 1 },
      { p_photo_id: id(501), p_memo: null, p_sort_order: 0 },
    ]);

    await user.click(within(screen.getByTestId('room-photos-current')).getAllByTestId('room-photo-menu')[0]!);
    await user.click(await screen.findByRole('menuitem', { name: '消す' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('この写真を消します。元に戻せません');
    await user.click(within(confirm).getByRole('button', { name: '消す' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rpcArgs('delete_room_photo')).toEqual([{ p_photo_id: id(500) }]);
    expect(fake.removes).toEqual([{ bucket: 'room-photos', paths: [photo(0).object_path] }]);
    expect(toasts.success).toHaveBeenCalledWith('写真を消しました');
  });
});
