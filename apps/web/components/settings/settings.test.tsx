// @vitest-environment jsdom
// マスタ設定の部品のテスト（T09）：楽観ロックの更新・一意のキーの insert の (B1)（画面の設計 2.6）と、終了した年度の
// GlobalReadOnlyNote。データの層（lib/data）は差し替え、runLockedWrite・matchesWritten・roomYearMatches は本物を使う。
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@/lib/auth/membership';
import type { RoomRow, RoomYearRow, YearRow } from '@/lib/db/types';
import { appError, unknownOutcomeMessage } from '@/lib/errors';
import { DistanceTab } from './distance-tab';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { GroupsTab } from './groups-tab';
import { ItemsTab } from './items-tab';
import { RoomsTab } from './rooms-tab';
import { LOCKED_REREAD_NOT_SAVED_MESSAGE, LOCKED_UNREAD_MESSAGE, SettingsContext, type SettingsContextValue } from './shared';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

const data = vi.hoisted(() => ({
  fetchRooms: vi.fn(),
  fetchRoomYears: vi.fn(),
  fetchAllocationSources: vi.fn(),
  fetchMyYearRoles: vi.fn(),
  fetchItems: vi.fn(),
  fetchCountItems: vi.fn(),
  insertCountItem: vi.fn(),
  updateCountItem: vi.fn(),
  deleteCountItem: vi.fn(),
  readCountItem: vi.fn(),
  readCountItemByName: vi.fn(),
  fetchGroups: vi.fn(),
  fetchMembers: vi.fn(),
  insertRoom: vi.fn(),
  updateRoom: vi.fn(),
  readRoom: vi.fn(),
  readRoomByName: vi.fn(),
  insertGroup: vi.fn(),
  updateGroup: vi.fn(),
  readGroup: vi.fn(),
  readGroupByName: vi.fn(),
  insertItem: vi.fn(),
  updateItem: vi.fn(),
  readItem: vi.fn(),
  readItemByCode: vi.fn(),
  fetchDistanceOverrides: vi.fn(),
  insertDistance: vi.fn(),
  updateDistance: vi.fn(),
  readDistance: vi.fn(),
}));
vi.mock('@/lib/data/settings', async (orig) => ({ ...(await orig<typeof import('@/lib/data/settings')>()), ...data }));

// 品目の画像（T23）：path の読み込み・URL・送る・外すを差し替える（Storage と canvas は lib/item-images のテストで確かめる）
const imageApi = vi.hoisted(() => ({
  paths: { item: new Map<string, string>(), count_item: new Map<string, string>() } as Record<'item' | 'count_item', Map<string, string>>,
  urlCache: new Map<string, unknown>(),
  sendItemImage: vi.fn<(...a: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(async () => ({ ok: true })),
  removeItemImage: vi.fn<(...a: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(async () => ({ ok: true })),
  removeDeletedItemImages: vi.fn(async () => {}),
}));
vi.mock('@/lib/data/item-images', async (orig) => {
  const actual = await orig<typeof import('@/lib/data/item-images')>();
  return {
    ...actual,
    itemImagePathsOptions: (kind: 'item' | 'count_item') => ({ queryKey: ['item-images', 'paths', kind], queryFn: async () => imageApi.paths[kind] }),
    // 本物と同じく、同じ path の並びなら同じ物を返す（表の列が描き直しのたびに変わらないように）
    useItemImageUrls: (paths: readonly (string | null | undefined)[]) => {
      const key = paths.filter((p): p is string => !!p).join('\n');
      const hit = imageApi.urlCache.get(key);
      if (hit) return hit;
      const v = { urls: new Map(key ? key.split('\n').map((p) => [p, `https://img.test/${p}`]) : []), pending: false, reportError: () => false };
      imageApi.urlCache.set(key, v);
      return v;
    },
    // 本物と同じく、送る・外すの後に（成否によらず）path と行の一覧を読み直す（invalidateItemImagePaths は本物）
    sendItemImage: async (...a: unknown[]) => {
      try {
        return await imageApi.sendItemImage(...a);
      } finally {
        await actual.invalidateItemImagePaths(a[0] as never, a[1] as 'item' | 'count_item');
      }
    },
    removeItemImage: async (...a: unknown[]) => {
      try {
        return await imageApi.removeItemImage(...a);
      } finally {
        await actual.invalidateItemImagePaths(a[0] as never, a[1] as 'item' | 'count_item');
      }
    },
    removeDeletedItemImages: imageApi.removeDeletedItemImages,
  };
});

const roomYearsApi = vi.hoisted(() => ({ setRoomUsable: vi.fn(), readRoomYear: vi.fn() }));
vi.mock('@/lib/data/room-years', async (orig) => ({ ...(await orig<typeof import('@/lib/data/room-years')>()), ...roomYearsApi }));

const ROOM = '00000000-0000-4000-8000-0000000000a1';
const T0 = '2026-10-29T01:00:00.000001+00:00';
const T1 = '2026-10-29T01:00:01.000002+00:00';
const network = () => new TypeError('Failed to fetch');

const yearRow = (status: YearRow['status']): YearRow =>
  ({ id: 'y9', label: 'R9', status, festival_start: '2027-10-16', updated_at: T0 }) as unknown as YearRow;

const room: RoomRow = {
  id: ROOM,
  name: '1-1',
  aliases: [],
  kind: 'room',
  building: '本館',
  floor: 1,
  is_storage: false,
  extra_cost: 0,
  sort_order: 1,
  updated_at: T0,
} as unknown as RoomRow;

const ry = (usable: boolean, note: string | null, updated_at: string): RoomYearRow =>
  ({ year_id: 'y9', room_id: ROOM, usable, note, updated_at }) as unknown as RoomYearRow;

function renderWith(ui: React.ReactNode, ctx: Partial<SettingsContextValue> & { status?: YearRow['status'] } = {}) {
  const status = ctx.status ?? 'preparing';
  const year = yearRow(status);
  const value: SettingsContextValue = {
    year,
    membership: (ctx.membership ?? { years: [], adminOfOpenYear: true }) as Membership,
    yearWritable: ctx.yearWritable ?? status !== 'closed',
    globalWritable: ctx.globalWritable ?? status !== 'closed',
  };
  return render(
    <TestProviders>
      <SettingsContext.Provider value={value}>{ui}</SettingsContext.Provider>
    </TestProviders>,
  );
}

/** 「ほかの人が変えました」の帯が一度でも出たか（成功の後の読み直しで一瞬出るのも拾う） */
function watchChangedByOther(): () => boolean {
  let seen = false;
  const check = () => {
    if (document.querySelector('[data-testid="usable-changed-by-other"]')) seen = true;
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true });
  return () => {
    check();
    obs.disconnect();
    return seen;
  };
}

// jsdom にないもの（Radix の Checkbox・Popover が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fakeAuth.session = { user: { id: 'u1' } };
  fakeAuth.sources.u1 = sourceOf({
    years: [{ id: 'y9', label: 'R9', status: 'preparing', festival_start: '2027-10-16' }],
    roles: [{ year_id: 'y9', role: 'admin' }],
  });
  for (const f of [...Object.values(data), ...Object.values(roomYearsApi), toasts.success, toasts.error, toasts.info]) f.mockReset();
  data.fetchRooms.mockResolvedValue([room]);
  data.fetchAllocationSources.mockResolvedValue({ all: new Map(), fixed: new Map() });
  data.fetchCountItems.mockResolvedValue([]);
});
afterEach(() => cleanup());

async function openUsable(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '1-1の今年の使用を変える' }));
  return screen.findByRole('dialog');
}

describe('今年の使用のダイアログ（setRoomUsable。2.6 の (B1)）', () => {
  it('成功したら閉じてから読み直す：自分の保存を「ほかの人が変えました」と出さない', async () => {
    data.fetchRoomYears.mockResolvedValueOnce([]).mockResolvedValue([ry(false, '工事', T1)]);
    roomYearsApi.setRoomUsable.mockResolvedValue(ry(false, '工事', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    const seen = watchChangedByOther();
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '工事');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(data.fetchRoomYears).toHaveBeenCalledTimes(2));
    expect(roomYearsApi.setRoomUsable).toHaveBeenCalledWith('y9', ROOM, null, false, '工事');
    expect(toasts.success).toHaveBeenCalledWith('「1-1」を今年は使用不可にしました');
    expect(seen()).toBe(false);
  });

  it('応答が届かなかったが通っていた：読み直して「保存されていました」で閉じ、「ほかの人が変えました」と出さない', async () => {
    data.fetchRoomYears.mockResolvedValueOnce([ry(true, null, T0)]).mockResolvedValue([ry(false, '工事', T1)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(network());
    roomYearsApi.readRoomYear.mockResolvedValue(ry(false, '工事', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    const seen = watchChangedByOther();
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), ' 工事 ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(roomYearsApi.readRoomYear).toHaveBeenCalledWith('y9', ROOM);
    expect(toasts.success).toHaveBeenCalledWith('「1-1」の今年の使用は保存されていました');
    expect(toasts.error).not.toHaveBeenCalled();
    expect(seen()).toBe(false);
  });

  it('応答が届かず、読み直すと保存されていない（not-saved）・読み直せない（unread）：入力を残して unknownOutcomeMessage()、保存は押せるまま、次はふつうに送る', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(network());
    roomYearsApi.readRoomYear.mockResolvedValueOnce(ry(true, null, T0)).mockRejectedValueOnce(network());
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    const save = within(dialog).getByRole('button', { name: '保存' });
    await user.click(save);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(unknownOutcomeMessage()));
    expect((within(dialog).getByLabelText('今年は使用する') as HTMLInputElement | HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(within(dialog).queryByRole('button', { name: '確かめる' })).toBeNull();
    // 次の保存も同じ版（入力の元）で送る。読み直しが届かなくても同じ文言
    await user.click(save);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(2));
    expect(toasts.error).toHaveBeenLastCalledWith(unknownOutcomeMessage());
    expect(roomYearsApi.setRoomUsable.mock.calls.map((c) => c[2])).toEqual([T0, T0]);
    expect(screen.queryByTestId('usable-changed-by-other')).toBeNull();
  });

  it('応答が届かなかった後のデータの読み直しが終わらなくても（通信が切れたまま）、保存は「保存中…」のままにならない', async () => {
    data.fetchRoomYears.mockResolvedValueOnce([ry(true, null, T0)]).mockReturnValue(new Promise(() => {}));
    roomYearsApi.setRoomUsable.mockRejectedValue(network());
    roomYearsApi.readRoomYear.mockRejectedValue(network());
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(unknownOutcomeMessage()));
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('conflict：読み直した行がほかの人の値なら、帯でいまの設定を出し、入力を残して、次の保存は読み直した版で送る', async () => {
    data.fetchRoomYears.mockResolvedValueOnce([ry(true, null, T0)]).mockResolvedValue([ry(false, '他の人のメモ', T1)]);
    roomYearsApi.setRoomUsable.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue(ry(true, '私のメモ', T1));
    roomYearsApi.readRoomYear.mockResolvedValue(ry(false, '他の人のメモ', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const notice = await within(dialog).findByTestId('usable-changed-by-other');
    expect(notice.textContent).toContain('「使用不可」');
    expect(notice.textContent).toContain('他の人のメモ');
    expect(toasts.error).toHaveBeenCalledWith('他の人が先に変更しました。読み直しました');
    expect((within(dialog).getByLabelText('理由のメモ（任意）') as HTMLInputElement).value).toBe('私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(roomYearsApi.setRoomUsable.mock.calls.map((c) => c[2])).toEqual([T0, T1]);
  });

  it('conflict の後に読み直すと入力のとおり（前の送信が後から通っていた）なら「保存されていました」で閉じる', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(appError('conflict', 'lock_conflict'));
    roomYearsApi.readRoomYear.mockResolvedValue(ry(true, '私のメモ', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith('「1-1」の今年の使用は保存されていました');
  });

  it('止められて読み直せない（unread）：「読み直しました」と言わず、読み直すボタンを出す。読み直すと入力の元が新しい版になる', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue(ry(true, '私のメモ', T1));
    roomYearsApi.readRoomYear.mockRejectedValueOnce(network()).mockResolvedValue(ry(true, null, T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const unread = await within(dialog).findByTestId('locked-save-unread');
    expect(unread.textContent).toContain('ほかの人が変えた可能性がありますが、読み直せませんでした');
    expect(toasts.error).toHaveBeenCalledWith('ほかの人が変えた可能性がありますが、読み直せませんでした');
    expect(toasts.error.mock.calls.flat().some((m) => String(m).includes('読み直しました'))).toBe(false);
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(within(dialog).queryByTestId('locked-save-unread')).toBeNull());
    expect((within(dialog).getByLabelText('理由のメモ（任意）') as HTMLInputElement).value).toBe('私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(roomYearsApi.setRoomUsable.mock.calls.map((c) => c[2])).toEqual([T0, T1]);
  });

  it('unread の後の「読み直す」で読んだ行が入力と同じ（前の送信が後から通っていた）→「保存されていました」で閉じ、帯を出さない', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(appError('conflict', 'lock_conflict'));
    roomYearsApi.readRoomYear.mockRejectedValueOnce(network()).mockResolvedValue(ry(true, '私のメモ', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    const seen = watchChangedByOther();
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const unread = await within(dialog).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith('「1-1」の今年の使用は保存されていました');
    expect(roomYearsApi.setRoomUsable).toHaveBeenCalledTimes(1);
    expect(seen()).toBe(false);
  });

  it('unread の後の「読み直す」で読んだ行がほかの人の値（版が進んだ）→ 帯を出し、入力を残して、次の保存は読み直した版で送る', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue(ry(true, '私のメモ', T1));
    roomYearsApi.readRoomYear.mockRejectedValueOnce(network()).mockResolvedValue(ry(false, '他の人のメモ', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const unread = await within(dialog).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    const notice = await within(dialog).findByTestId('usable-changed-by-other');
    expect(notice.textContent).toContain('他の人のメモ');
    expect(within(dialog).queryByTestId('locked-save-unread')).toBeNull();
    expect((within(dialog).getByLabelText('理由のメモ（任意）') as HTMLInputElement).value).toBe('私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(roomYearsApi.setRoomUsable.mock.calls.map((c) => c[2])).toEqual([T0, T1]);
  });

  it('unread の後の「読み直す」で読んだ行の版が入力の元のまま（not-saved）→ 帯を出さず、入力の元を付け替えない', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue(ry(true, '私のメモ', T1));
    roomYearsApi.readRoomYear.mockRejectedValueOnce(network()).mockResolvedValue(ry(true, null, T0));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    const seen = watchChangedByOther();
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const unread = await within(dialog).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(within(dialog).queryByTestId('locked-save-unread')).toBeNull());
    expect(seen()).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(roomYearsApi.setRoomUsable.mock.calls.map((c) => c[2])).toEqual([T0, T0]);
  });

  it('unread の後に入力を変えてから「読み直す」：読んだ行が前に送った値でも、今の入力と違えばほかの人の変更として帯を出す（閉じない）', async () => {
    data.fetchRoomYears.mockResolvedValue([ry(true, null, T0)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(appError('conflict', 'lock_conflict'));
    roomYearsApi.readRoomYear.mockRejectedValueOnce(network()).mockResolvedValue(ry(true, '前のメモ', T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '前のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    const unread = await within(dialog).findByTestId('locked-save-unread');
    await user.clear(within(dialog).getByLabelText('理由のメモ（任意）'));
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '今のメモ');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    expect((await within(dialog).findByTestId('usable-changed-by-other')).textContent).toContain('前のメモ');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(toasts.success).not.toHaveBeenCalledWith('「1-1」の今年の使用は保存されていました');
  });

  it('裏の読み直しで受け取った行も同じ判定：応答が届かなかった後の読み直しでほかの人の値が見えたら帯、入力と同じなら出さない', async () => {
    data.fetchRoomYears.mockResolvedValueOnce([ry(true, null, T0)]).mockResolvedValue([ry(false, '他の人のメモ', T1)]);
    roomYearsApi.setRoomUsable.mockRejectedValue(network());
    roomYearsApi.readRoomYear.mockResolvedValue(ry(true, null, T0));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    const dialog = await openUsable(user);
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '私のメモ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect((await within(dialog).findByTestId('usable-changed-by-other')).textContent).toContain('他の人のメモ');
    // 入力をいまの設定と同じにすると帯は消える（判定が saved になる）
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    await user.clear(within(dialog).getByLabelText('理由のメモ（任意）'));
    await user.type(within(dialog).getByLabelText('理由のメモ（任意）'), '他の人のメモ');
    await waitFor(() => expect(within(dialog).queryByTestId('usable-changed-by-other')).toBeNull());
  });
});

describe('場所のタブの段（T15b。D-50）', () => {
  it('総務部門長・総務副部門長（開いている年度の管理者でない）：場所の一覧は読み取りで、今年の使用だけを変えられる', async () => {
    data.fetchRoomYears.mockResolvedValue([]);
    roomYearsApi.setRoomUsable.mockResolvedValue(ry(false, null, T1));
    const user = userEvent.setup();
    renderWith(<RoomsTab />, {
      membership: { role: 'head', years: [], adminOfOpenYear: false } as unknown as Membership,
      globalWritable: false,
    });
    expect(await screen.findByRole('button', { name: '1-1の今年の使用を変える' })).toBeTruthy();
    expect(screen.queryByTestId('room-add')).toBeNull();
    expect(screen.queryByRole('button', { name: '編集' })).toBeNull();
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
    // できること（今年の使用）だけを書き、建物の入れ方（直せる人向け）は出さない
    expect(screen.getByTestId('global-read-only').textContent).toBe(
      '場所の追加・編集・削除は管理者が行います（すべての年度で共有の表のため）。今年の使用（使用不可と理由のメモ）は年度ごとで、各行の「変える」から変えられます。',
    );
    expect(screen.queryByText(/建物の中の部屋は建物を入れてください/)).toBeNull();
    const dialog = await openUsable(user);
    await user.click(within(dialog).getByLabelText('今年は使用する'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(roomYearsApi.setRoomUsable).toHaveBeenCalledWith('y9', ROOM, null, false, null));
  });
});

describe('場所・団体・品目のフォーム（updateWithLock・一意のキーの insert。2.6 の (B1)）', () => {
  it('場所の更新：応答が届かなかったが通っていた → id で読み直して「保存されていました」で閉じる', async () => {
    data.fetchRoomYears.mockResolvedValue([]);
    data.updateRoom.mockRejectedValue(network());
    data.readRoom.mockImplementation(async () => ({ ...room, name: '1-1改', updated_at: T1 }));
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    await user.click(await screen.findByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('room-form');
    await user.clear(within(form).getByLabelText('名前'));
    await user.type(within(form).getByLabelText('名前'), ' 1-1改 ');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('room-form')).toBeNull());
    expect(data.readRoom).toHaveBeenCalledWith(ROOM);
    expect(toasts.success).toHaveBeenCalledWith('「1-1改」は保存されていました');
  });

  it('場所の更新：conflict でほかの人の値 → 入力を残し、次の保存は読み直した行（版）で送る', async () => {
    data.fetchRoomYears.mockResolvedValue([]);
    data.updateRoom.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue({});
    data.readRoom.mockResolvedValue({ ...room, extra_cost: 5, updated_at: T1 });
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    await user.click(await screen.findByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('room-form');
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '9');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('他の人が先に変更しました。読み直しました'));
    expect((within(form).getByLabelText('並び順') as HTMLInputElement).value).toBe('9');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('room-form')).toBeNull());
    expect(data.updateRoom.mock.calls.map((c) => (c[0] as RoomRow).updated_at)).toEqual([T0, T1]);
  });

  it('団体の insert：23505 で、一意のキーで読み直すと入力のとおり → 「保存されていました」。違えば「同じものがすでにあります」で入力を残す', async () => {
    const year9 = 'y9';
    data.fetchGroups.mockResolvedValue([]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    const mine = { id: 'g1', year_id: year9, name: '企業A', display_name: null, aliases: [], category: 'stall', is_food: false, location_room_id: null, sort_order: 0, updated_at: T1 };
    data.readGroupByName.mockResolvedValueOnce({ ...mine, is_food: true }).mockResolvedValue(mine);
    const user = userEvent.setup();
    renderWith(<GroupsTab />);
    await user.click(await screen.findByTestId('group-add'));
    const form = await screen.findByTestId('group-form');
    await user.type(within(form).getByLabelText('団体名'), '企業A');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('同じものがすでにあります（ほかの人が先に足した可能性があります）'));
    expect((within(form).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業A');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('group-form')).toBeNull());
    expect(data.readGroupByName).toHaveBeenLastCalledWith(year9, '企業A');
    expect(toasts.success).toHaveBeenCalledWith('「企業A」は保存されていました');
    // insert は insert のまま（2回とも insert）
    expect(data.insertGroup).toHaveBeenCalledTimes(2);
    expect(data.updateGroup).not.toHaveBeenCalled();
  });

  it('団体の insert：応答が届かず、読み直した一覧に足した団体が入っていても、次の保存は名前の重複で止めずに送り、「保存されていました」になる', async () => {
    const mine = { id: 'g1', year_id: 'y9', name: '企業A', display_name: null, aliases: [], category: 'stall', is_food: false, location_room_id: null, sort_order: 0, updated_at: T1 };
    data.fetchGroups.mockResolvedValueOnce([]).mockResolvedValue([mine]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValueOnce(network()).mockRejectedValue({ code: '23505', message: 'duplicate key' });
    data.readGroupByName.mockResolvedValueOnce(null).mockResolvedValue(mine);
    const user = userEvent.setup();
    renderWith(<GroupsTab />);
    await user.click(await screen.findByTestId('group-add'));
    const form = await screen.findByTestId('group-form');
    await user.type(within(form).getByLabelText('団体名'), '企業A');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(unknownOutcomeMessage()));
    // 裏の読み直しで、一覧に自分の足した団体が入る
    await waitFor(() => expect(data.fetchGroups).toHaveBeenCalledTimes(2));
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('group-form')).toBeNull());
    expect(data.insertGroup).toHaveBeenCalledTimes(2);
    expect(toasts.success).toHaveBeenCalledWith('「企業A」は保存されていました');
  });

  it('団体の insert：大文字・小文字だけが違う名前の団体があれば、今までどおり送らずに欄で止める', async () => {
    const other = { id: 'g2', year_id: 'y9', name: 'abc', display_name: null, aliases: [], category: 'stall', is_food: false, location_room_id: null, sort_order: 0, updated_at: T1 };
    data.fetchGroups.mockResolvedValue([other]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    const user = userEvent.setup();
    renderWith(<GroupsTab />);
    await user.click(await screen.findByTestId('group-add'));
    const form = await screen.findByTestId('group-form');
    await user.type(within(form).getByLabelText('団体名'), 'ABC');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(data.insertGroup).not.toHaveBeenCalled();
  });

  it('場所の更新：止められて読み直せず、「読み直す」で読んだ行が入力と同じ →「保存されていました」で閉じる', async () => {
    data.fetchRoomYears.mockResolvedValue([]);
    data.updateRoom.mockRejectedValue(appError('conflict', 'lock_conflict'));
    data.readRoom.mockRejectedValueOnce(network()).mockResolvedValue({ ...room, sort_order: 9, updated_at: T1 });
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    await user.click(await screen.findByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('room-form');
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '9');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.queryByTestId('room-form')).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith('「1-1」は保存されていました');
    expect(data.updateRoom).toHaveBeenCalledTimes(1);
  });

  it('品目の insert：応答が届かず、まだ行がない → unknownOutcomeMessage() で入力を残す（「通信できませんでした」と言わない）', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.insertItem.mockRejectedValue(network());
    data.readItemByCode.mockResolvedValue(null);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    await user.click(await screen.findByTestId('item-add'));
    const form = await screen.findByTestId('item-form');
    await user.type(within(form).getByLabelText('コード'), 'e2e_desk');
    await user.type(within(form).getByLabelText('表示名'), '机');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(unknownOutcomeMessage()));
    expect(data.readItemByCode).toHaveBeenCalledWith('e2e_desk');
    expect(toasts.error.mock.calls.flat()).not.toContain('通信できませんでした。電波の良い所でもう一度');
    expect((within(form).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // 止められて読み直せなかった後に、insert の一意のキーを変えてから「読み直す」：止められた結果（23505）は前のキーの行のもので、
  // いまの入力には当たらない。いまの入力が書く行（新しいキー）を読み直して、送った後と同じ判定にする（書き込みの後ではない読み直し）
  const DUP = '同じものがすでにあります（ほかの人が先に足した可能性があります）';
  const REREAD_NOT_SAVED = LOCKED_REREAD_NOT_SAVED_MESSAGE;
  const otherA = { id: 'g2', year_id: 'y9', name: '企業A', display_name: null, aliases: [], category: 'stall', is_food: false, location_room_id: null, sort_order: 0, updated_at: T1 };

  async function groupRejectedThenRename(user: ReturnType<typeof userEvent.setup>) {
    renderWith(<GroupsTab />);
    await user.click(await screen.findByTestId('group-add'));
    const form = await screen.findByTestId('group-form');
    await user.type(within(form).getByLabelText('団体名'), '企業A');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    expect(toasts.error.mock.calls).toEqual([[LOCKED_UNREAD_MESSAGE]]);
    await user.clear(within(form).getByLabelText('団体名'));
    await user.type(within(form).getByLabelText('団体名'), '企業B');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    return form;
  }

  it('団体の insert：23505 → 読み直せず → 名前を変えて「読み直す」、新しい名前の行がない → 重複と言わず「まだ保存されていません」。次の保存はふつうに送る', async () => {
    data.fetchGroups.mockResolvedValue([otherA]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' }).mockResolvedValue(undefined);
    data.readGroupByName.mockRejectedValueOnce(network()).mockResolvedValue(null);
    const user = userEvent.setup();
    const form = await groupRejectedThenRename(user);
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REREAD_NOT_SAVED));
    expect(data.readGroupByName).toHaveBeenLastCalledWith('y9', '企業B');
    expect(toasts.error.mock.calls).toEqual([[LOCKED_UNREAD_MESSAGE]]);
    expect(within(form).queryByTestId('locked-save-unread')).toBeNull();
    expect(within(form).queryByRole('alert')).toBeNull();
    expect((within(form).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業B');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('group-form')).toBeNull());
    expect(data.insertGroup.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual(['企業A', '企業B']);
    expect(toasts.success).toHaveBeenCalledWith('「企業B」を足しました');
  });

  it('団体の insert：名前を変えて「読み直す」と、新しい名前の行が別の値である → その行で決めて「同じものがすでにあります」（前の 23505 を使わない）', async () => {
    data.fetchGroups.mockResolvedValue([otherA]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    data.readGroupByName.mockRejectedValueOnce(network()).mockResolvedValue({ ...otherA, id: 'g3', name: '企業B', is_food: true });
    const user = userEvent.setup();
    const form = await groupRejectedThenRename(user);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DUP));
    expect(data.readGroupByName).toHaveBeenLastCalledWith('y9', '企業B');
    expect(toasts.info).not.toHaveBeenCalled();
    expect(within(form).queryByTestId('locked-save-unread')).toBeNull();
    expect((within(form).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業B');
  });

  // 「読み直す」の結果は、読み直しを始めたときのフォームにだけ当てる。読み直し中に保存を送った・シートを閉じた後に届いた結果は
  // 捨てる（前のフォームの onSaved が、後から開いた別のシートを閉じて入力を消さないように）
  async function groupRereadPendingThenNewSheet(user: ReturnType<typeof userEvent.setup>, leave: 'save' | 'close') {
    data.fetchGroups.mockResolvedValue([otherA]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' }).mockResolvedValue(undefined);
    let resolveReread: (row: unknown) => void = () => {};
    data.readGroupByName
      .mockRejectedValueOnce(network())
      .mockImplementationOnce(() => new Promise((r) => (resolveReread = r)))
      .mockResolvedValue(null);
    const form = await groupRejectedThenRename(user);
    expect(within(form).getByRole('button', { name: '読み直し中…' })).toBeTruthy();
    if (leave === 'save') {
      // 読み直し中も保存は押せる（2.6 の (B1)）。送った保存が通ってシートが閉じる
      await user.click(within(form).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(screen.queryByTestId('group-form')).toBeNull());
      expect(toasts.success.mock.calls).toEqual([['「企業B」を足しました']]);
    } else {
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('group-form')).toBeNull());
    }
    await user.click(await screen.findByTestId('group-add'));
    const next = await screen.findByTestId('group-form');
    await user.type(within(next).getByLabelText('団体名'), '企業C');
    // 遅れて届いた読み直し：前のフォームの入力（企業B）と同じ行
    resolveReread({ ...otherA, id: 'g3', name: '企業B' });
    await new Promise((r) => setTimeout(r, 50));
    return next;
  }

  it('「読み直す」の途中で保存して閉じ、次の団体を足し始めた後に読み直しが届いても、「保存されていました」と出さず、新しいシートを閉じない', async () => {
    const user = userEvent.setup();
    await groupRereadPendingThenNewSheet(user, 'save');
    expect(toasts.success.mock.calls).toEqual([['「企業B」を足しました']]);
    expect(toasts.info).not.toHaveBeenCalled();
    const next = screen.getByTestId('group-form');
    expect((within(next).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業C');
    expect(within(next).queryByTestId('locked-save-unread')).toBeNull();
  });

  it('「読み直す」の途中でシートを閉じ、別のシートを開いた後に読み直しが届いても、新しいシートを閉じない', async () => {
    const user = userEvent.setup();
    await groupRereadPendingThenNewSheet(user, 'close');
    expect(toasts.success).not.toHaveBeenCalled();
    expect(data.insertGroup).toHaveBeenCalledTimes(1);
    const next = screen.getByTestId('group-form');
    expect((within(next).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業C');
  });

  // 「読み直す」で読んだ行は、届いたときの入力と比べる（始めたときの入力ではない。2.6 の (B1)）。読み直し中に入力を変えたなら、
  // 前の入力と同じ行が届いても「保存されていました」で閉じない（変えた入力を何も言わずに捨てない）
  it('場所の更新：「読み直す」の途中で並び順を 9→10 に変え、届いた行が 9（前の送信が通っていた）→ 閉じず、10 を残し、次の保存は読み直した版で送る', async () => {
    data.fetchRoomYears.mockResolvedValue([]);
    data.updateRoom.mockRejectedValueOnce(appError('conflict', 'lock_conflict')).mockResolvedValue({});
    let resolveReread: (row: unknown) => void = () => {};
    data.readRoom
      .mockRejectedValueOnce(network())
      .mockImplementationOnce(() => new Promise((r) => (resolveReread = r)))
      .mockResolvedValue({ ...room, sort_order: 10, updated_at: '2026-10-29T01:00:02.000003+00:00' });
    const user = userEvent.setup();
    renderWith(<RoomsTab />);
    await user.click(await screen.findByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('room-form');
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '9');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    expect(within(form).getByRole('button', { name: '読み直し中…' })).toBeTruthy();
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '10');
    resolveReread({ ...room, sort_order: 9, updated_at: T1 });
    // いまの入力（10）と違い、版が進んでいる → ほかの人の変更と同じ扱い（入力を残し、入力の元を読み直した行にする）
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('他の人が先に変更しました。読み直しました'));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-form')).toBe(form);
    expect((within(form).getByLabelText('並び順') as HTMLInputElement).value).toBe('10');
    expect(within(form).queryByTestId('locked-save-unread')).toBeNull();
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByTestId('room-form')).toBeNull());
    expect(data.updateRoom.mock.calls.map((c) => (c[0] as RoomRow).updated_at)).toEqual([T0, T1]);
    expect(data.updateRoom.mock.calls.map((c) => (c[1] as { sort_order: number }).sort_order)).toEqual([9, 10]);
    expect(toasts.success.mock.calls).toEqual([['「1-1」を保存しました']]);
  });

  it('団体の insert：「読み直す」の途中で並び順を 0→5 に変え、届いた行が前の入力（企業A・0）と同じ → 閉じず、5 を残して「同じものがすでにあります」', async () => {
    data.fetchGroups.mockResolvedValue([]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' }).mockResolvedValue(undefined);
    let resolveReread: (row: unknown) => void = () => {};
    data.readGroupByName
      .mockRejectedValueOnce(network())
      .mockImplementationOnce(() => new Promise((r) => (resolveReread = r)))
      .mockResolvedValue(null);
    const user = userEvent.setup();
    renderWith(<GroupsTab />);
    await user.click(await screen.findByTestId('group-add'));
    const form = await screen.findByTestId('group-form');
    await user.type(within(form).getByLabelText('団体名'), '企業A');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    expect(within(form).getByRole('button', { name: '読み直し中…' })).toBeTruthy();
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '5');
    resolveReread({ ...otherA, id: 'g3' });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DUP));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-form')).toBe(form);
    expect((within(form).getByLabelText('並び順') as HTMLInputElement).value).toBe('5');
    expect(data.insertGroup).toHaveBeenCalledTimes(1);
  });

  // 読み直し中に insert の一意のキーを変えたなら、届いた行（前のキーの行）はいまの入力に当たらない。結果を当てず、
  // 読み直せていないときのまま（notice と「読み直す」を残す）にする。もう一度「読み直す」と、いまのキーで読む
  it.each([
    ['入力と同じ値', { is_food: false }],
    ['別の値', { is_food: true }],
  ])('団体の insert：「読み直す」の途中で名前を 企業B→企業D に変え、企業B の行（%s）が届く → 当てずに notice を残し、もう一度読み直すと 企業D で決める', async (_label, diff) => {
    data.fetchGroups.mockResolvedValue([otherA]);
    data.fetchMembers.mockResolvedValue({ members: [], invitations: [], repCount: new Map() });
    data.insertGroup.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' }).mockResolvedValue(undefined);
    let resolveReread: (row: unknown) => void = () => {};
    data.readGroupByName
      .mockRejectedValueOnce(network())
      .mockImplementationOnce(() => new Promise((r) => (resolveReread = r)))
      .mockResolvedValue(null);
    const user = userEvent.setup();
    const form = await groupRejectedThenRename(user);
    expect(within(form).getByRole('button', { name: '読み直し中…' })).toBeTruthy();
    await user.clear(within(form).getByLabelText('団体名'));
    await user.type(within(form).getByLabelText('団体名'), '企業D');
    resolveReread({ ...otherA, id: 'g3', name: '企業B', ...diff });
    const again = await within(form).findByRole('button', { name: '読み直す' });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.error.mock.calls).toEqual([[LOCKED_UNREAD_MESSAGE]]);
    expect(screen.getByTestId('group-form')).toBe(form);
    expect((within(form).getByLabelText('団体名') as HTMLInputElement).value).toBe('企業D');
    expect(within(form).getByTestId('locked-save-unread')).toBeTruthy();
    await user.click(again);
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REREAD_NOT_SAVED));
    expect(data.readGroupByName.mock.calls.map((c) => c[1])).toEqual(['企業A', '企業B', '企業D']);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(data.insertGroup).toHaveBeenCalledTimes(1);
  });

  it('品目の insert：23505 → 読み直せず → コードを変えて「読み直す」、新しいコードの行がない → 重複と言わない', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.insertItem.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    data.readItemByCode.mockRejectedValueOnce(network()).mockResolvedValue(null);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    await user.click(await screen.findByTestId('item-add'));
    const form = await screen.findByTestId('item-form');
    await user.type(within(form).getByLabelText('コード'), 'desk_a');
    await user.type(within(form).getByLabelText('表示名'), '机');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.clear(within(form).getByLabelText('コード'));
    await user.type(within(form).getByLabelText('コード'), 'desk_b');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REREAD_NOT_SAVED));
    expect(data.readItemByCode.mock.calls).toEqual([['desk_a'], ['desk_b']]);
    expect(toasts.error.mock.calls).toEqual([[LOCKED_UNREAD_MESSAGE]]);
    expect(within(form).queryByTestId('locked-save-unread')).toBeNull();
  });

  it('品目の insert：コードを変えずに「読み直す」と、行は止められたときのまま別の値 → 今までどおり「同じものがすでにあります」', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.insertItem.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    const theirs = { id: 'i2', code: 'desk_a', name: '長机', aliases: [], requestable_categories: [], sort_order: 0, updated_at: T1 };
    data.readItemByCode.mockRejectedValueOnce(network()).mockResolvedValue(theirs);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    await user.click(await screen.findByTestId('item-add'));
    const form = await screen.findByTestId('item-form');
    await user.type(within(form).getByLabelText('コード'), 'desk_a');
    await user.type(within(form).getByLabelText('表示名'), '机');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(DUP));
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it('距離の insert：23505 → 読み直せず → 建物の組を変えて「読み直す」、新しい組の行がない → 建物Bの欄に「その組はすでにあります」を出さない', async () => {
    data.fetchDistanceOverrides.mockResolvedValue([]);
    data.insertDistance.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    data.readDistance.mockRejectedValueOnce(network()).mockResolvedValue(null);
    const user = userEvent.setup();
    renderWith(<DistanceTab />);
    await user.click(await screen.findByTestId('distance-add'));
    const form = await screen.findByTestId('distance-form');
    await user.type(within(form).getByLabelText('建物A'), 'X');
    await user.type(within(form).getByLabelText('建物B'), 'Y');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    const unread = await within(form).findByTestId('locked-save-unread');
    await user.clear(within(form).getByLabelText('建物B'));
    await user.type(within(form).getByLabelText('建物B'), 'Z');
    await user.click(within(unread).getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith(REREAD_NOT_SAVED));
    expect(data.readDistance.mock.calls).toEqual([['X', 'Y'], ['X', 'Z']]);
    expect(within(form).queryByText('その組はすでにあります')).toBeNull();
    expect(toasts.error.mock.calls).toEqual([[LOCKED_UNREAD_MESSAGE]]);
  });
});

describe('GlobalReadOnlyNote（終了した年度の、場所・品目・距離の読み取り専用の理由）', () => {
  it('自分の年度のロールを読めなければ「確かめられませんでした」と「もう一度」。行き先なしの文は、読めたうえで行き先がないときだけ', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchMyYearRoles.mockRejectedValueOnce(network()).mockResolvedValue([{ year_id: 'y9', role: 'staff' }]);
    const user = userEvent.setup();
    renderWith(<ItemsTab />, { status: 'closed', globalWritable: false, yearWritable: false });
    const failed = await screen.findByTestId('global-read-only-roles-error');
    expect(failed.textContent).toContain('直せる年度を確かめられませんでした');
    expect(screen.queryByTestId('global-read-only-no-target')).toBeNull();
    await user.click(within(failed).getByRole('button', { name: 'もう一度' }));
    expect((await screen.findByTestId('global-read-only-no-target')).textContent).toBe('この表は、開いている年度の管理者が直します。');
    expect(screen.queryByTestId('global-read-only-roles-error')).toBeNull();
    expect(data.fetchMyYearRoles).toHaveBeenCalledTimes(2);
  });

  it('読んでいる間は、行き先なしの文も失敗の文も出さない', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchMyYearRoles.mockReturnValue(new Promise(() => {}));
    renderWith(<ItemsTab />, { status: 'closed', globalWritable: false, yearWritable: false });
    expect((await screen.findByTestId('global-read-only')).textContent).toContain('終了した年度のため、品目は直せません');
    expect(screen.queryByTestId('global-read-only-no-target')).toBeNull();
    expect(screen.queryByTestId('global-read-only-roles-error')).toBeNull();
  });
});

describe('品目のタブの「備品（数えるだけ）」の欄（T22・D-60。管理者）', () => {
  const TRASH = { id: 'c1', name: 'ゴミ箱', always_shown: true, sort_order: 1, updated_at: T0 };
  const WHITE = { id: 'c5', name: '白椅子', always_shown: false, sort_order: 5, updated_at: T0 };

  it('一覧（名前・最初から出す・並び）を出し、足すと insert（前後の空白を除いた名前）して読み直す', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchCountItems.mockResolvedValue([TRASH, WHITE]);
    data.insertCountItem.mockResolvedValue({ ...WHITE, id: 'c9', name: '台形机', updated_at: T1 });
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const section = await screen.findByTestId('count-items-settings');
    await within(section).findByText('ゴミ箱');
    expect(within(section).getByRole('table', { name: '備品（数えるだけ）の一覧' }).textContent).toContain('出す');
    await user.click(within(section).getByTestId('count-item-settings-add'));
    const form = await screen.findByTestId('count-item-form');
    await user.type(within(form).getByLabelText('名前'), ' 台形机 ');
    await user.clear(within(form).getByLabelText('並び順'));
    await user.type(within(form).getByLabelText('並び順'), '9');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「台形机」を足しました'));
    expect(data.insertCountItem).toHaveBeenCalledWith({ name: '台形机', always_shown: false, sort_order: 9 });
    await waitFor(() => expect(data.fetchCountItems).toHaveBeenCalledTimes(2));
  });

  it('編集は updated_at を条件にした更新（最初から出すを変えられる）。同じ名前（23505）は「同じ名前の物があります」', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchCountItems.mockResolvedValue([WHITE]);
    data.updateCountItem.mockRejectedValueOnce({ code: '23505', message: 'duplicate key' });
    data.readCountItem.mockResolvedValue(WHITE);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const section = await screen.findByTestId('count-items-settings');
    await user.click(await within(section).findByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('count-item-form');
    await user.click(within(form).getByRole('checkbox'));
    await user.clear(within(form).getByLabelText('名前'));
    await user.type(within(form).getByLabelText('名前'), 'ゴミ箱');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('同じ名前の物があります'));
    expect(data.updateCountItem).toHaveBeenCalledWith(WHITE, { name: 'ゴミ箱', always_shown: true, sort_order: 5 });
  });

  it('削除は確かめてから送り、数が入力された物（23503）は「数が入力された物は削除できません」と出して閉じない', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchCountItems.mockResolvedValue([WHITE]);
    data.deleteCountItem.mockRejectedValueOnce({ code: '23503', message: 'fk' }).mockResolvedValue(WHITE);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const section = await screen.findByTestId('count-items-settings');
    await user.click(await within(section).findByRole('button', { name: '削除' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('「白椅子」を削除しますか');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('数が入力された物は削除できません'));
    dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「白椅子」を削除しました'));
    expect(data.deleteCountItem).toHaveBeenCalledTimes(2);
    expect(data.deleteCountItem).toHaveBeenCalledWith(WHITE);
  });

  it('書けない（終了した年度など）ときは、足す・編集・削除を出さない', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchCountItems.mockResolvedValue([WHITE]);
    data.fetchMyYearRoles.mockResolvedValue([]);
    renderWith(<ItemsTab />, { status: 'closed', globalWritable: false, yearWritable: false });
    const section = await screen.findByTestId('count-items-settings');
    await within(section).findByText('白椅子');
    expect(within(section).queryByTestId('count-item-settings-add')).toBeNull();
    expect(within(section).queryByRole('button', { name: '編集' })).toBeNull();
    expect(within(section).queryByRole('button', { name: '削除' })).toBeNull();
  });
});

describe('T23 品目のタブの画像（管理者）', () => {
  const DESK = { id: 'i1', code: 'desk', name: '机(木)', aliases: [], requestable_categories: [], sort_order: 1, updated_at: T0 };
  const FAN = { id: 'c3', name: '扇風機', always_shown: true, sort_order: 3, updated_at: T0 };
  const DESK_IMG = 'items/i1/a.webp';

  beforeEach(() => {
    imageApi.paths.item = new Map([[DESK.id, DESK_IMG]]);
    imageApi.paths.count_item = new Map();
    imageApi.sendItemImage.mockClear();
    imageApi.removeItemImage.mockClear();
  });

  it('9 品目の行に画像と「画像を替える」「画像を外す」、画像のない備品は「画像を足す」。足すは写真を送る', async () => {
    data.fetchItems.mockResolvedValue([DESK]);
    data.fetchCountItems.mockResolvedValue([FAN]);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const table = await screen.findByRole('table', { name: '品目の一覧' });
    await waitFor(() => expect(within(table).getByRole('img', { name: '机(木)' }).getAttribute('src')).toBe(`https://img.test/${DESK_IMG}`));
    expect(within(table).getByTestId('item-image-replace')).toBeTruthy();
    expect(within(table).getByTestId('item-image-remove')).toBeTruthy();
    const section = screen.getByTestId('count-items-settings');
    await user.click(await within(section).findByTestId('item-image-add'));
    const dialog = await screen.findByTestId('item-photo-dialog');
    expect(dialog.textContent).toContain('「扇風機」の画像を足す');
    expect(dialog.textContent).toContain('人の顔・名前・掲示物が写らないように撮ってください');
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    await user.upload(within(dialog).getByTestId('item-photo-input'), file);
    await user.click(within(dialog).getByTestId('item-photo-submit'));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「扇風機」の画像を足しました'));
    expect(imageApi.sendItemImage).toHaveBeenCalledWith(expect.anything(), 'count_item', FAN.id, file, { imageId: expect.any(String) });
  });

  it('レビューで直したこと：画像を足した直後の「編集」は、読み直した行の updated_at で送る（自分の操作で conflict にしない）', async () => {
    const FAN_AFTER = { ...FAN, updated_at: T1 };
    data.fetchItems.mockResolvedValue([DESK]);
    data.fetchCountItems.mockResolvedValueOnce([FAN]).mockResolvedValue([FAN_AFTER]);
    data.updateCountItem.mockResolvedValue({ ...FAN_AFTER, name: '扇風機2' });
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const section = await screen.findByTestId('count-items-settings');
    await user.click(await within(section).findByTestId('item-image-add'));
    const dialog = await screen.findByTestId('item-photo-dialog');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByTestId('item-photo-submit'));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「扇風機」の画像を足しました'));
    await waitFor(() => expect(data.fetchCountItems).toHaveBeenCalledTimes(2));
    await user.click(within(section).getByRole('button', { name: '編集' }));
    const form = await screen.findByTestId('count-item-form');
    await user.clear(within(form).getByLabelText('名前'));
    await user.type(within(form).getByLabelText('名前'), '扇風機2');
    await user.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(data.updateCountItem).toHaveBeenCalled());
    expect(data.updateCountItem.mock.calls[0]![0]).toMatchObject({ id: FAN.id, updated_at: T1 });
  });

  it('レビューで直したこと：画像を外した後も品目の表を読み直す（品目の「編集」の updated_at）', async () => {
    data.fetchItems.mockResolvedValue([DESK]);
    data.fetchCountItems.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const table = await screen.findByRole('table', { name: '品目の一覧' });
    await waitFor(() => expect(data.fetchItems).toHaveBeenCalledTimes(1));
    await user.click(await within(table).findByTestId('item-image-remove'));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「机(木)」の画像を外しました'));
    await waitFor(() => expect(data.fetchItems).toHaveBeenCalledTimes(2));
  });

  it('レビューで直したこと：備品を削除したら、そのフォルダの画像を Storage から片付ける（削除の失敗では片付けない）', async () => {
    data.fetchItems.mockResolvedValue([]);
    data.fetchCountItems.mockResolvedValue([FAN]);
    data.deleteCountItem.mockRejectedValueOnce({ code: '23503', message: 'fk' }).mockResolvedValue(FAN);
    imageApi.removeDeletedItemImages.mockClear();
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const section = await screen.findByTestId('count-items-settings');
    await user.click(await within(section).findByRole('button', { name: '削除' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('数が入力された物は削除できません'));
    expect(imageApi.removeDeletedItemImages).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「扇風機」を削除しました'));
    expect(imageApi.removeDeletedItemImages).toHaveBeenCalledWith('count_item', FAN.id);
  });

  it('替えるの失敗はダイアログに出して閉じない。外すは確かめてから送る', async () => {
    data.fetchItems.mockResolvedValue([DESK]);
    data.fetchCountItems.mockResolvedValue([]);
    imageApi.sendItemImage.mockResolvedValueOnce({ ok: false, message: '写真は1枚 1 MB までです' });
    const user = userEvent.setup();
    renderWith(<ItemsTab />);
    const table = await screen.findByRole('table', { name: '品目の一覧' });
    await user.click(await within(table).findByTestId('item-image-replace'));
    const dialog = await screen.findByTestId('item-photo-dialog');
    expect(dialog.textContent).toContain('前の画像は消えます');
    await user.upload(within(dialog).getByTestId('item-photo-input'), new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(within(dialog).getByTestId('item-photo-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('写真は1枚 1 MB までです');
    expect(screen.getByTestId('item-photo-dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('item-photo-dialog')).toBeNull());

    await user.click(within(table).getByTestId('item-image-remove'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('「机(木)」の画像を外しますか');
    expect(confirm.textContent).toContain('画像を外します。名前はそのまま残ります。');
    await user.click(within(confirm).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('「机(木)」の画像を外しました'));
    expect(imageApi.removeItemImage).toHaveBeenCalledWith(expect.anything(), 'item', DESK.id);
  });

  it('終了した年度（管理者でない）では画像のボタンを出さない', async () => {
    data.fetchItems.mockResolvedValue([DESK]);
    data.fetchCountItems.mockResolvedValue([]);
    data.fetchMyYearRoles.mockReturnValue(new Promise(() => {}));
    renderWith(<ItemsTab />, { status: 'closed', globalWritable: false, yearWritable: false });
    const table = await screen.findByRole('table', { name: '品目の一覧' });
    await waitFor(() => expect(within(table).getByRole('img', { name: '机(木)' })).toBeTruthy());
    expect(within(table).queryByTestId('item-image-replace')).toBeNull();
  });
});
