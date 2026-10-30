// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { usePendingRows } from './use-pending';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  readVersion: vi.fn(),
  loadSnapshot: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ session: { status: 'signedOut' }, reloadMembership: vi.fn() }) }));
vi.mock('@/lib/data/allocation', () => ({ saveAllocationRows: mocks.save }));
vi.mock('@/lib/data/year', () => ({ fetchYearVersion: mocks.readVersion }));
vi.mock('@/lib/data/snapshot', () => ({ loadSnapshot: mocks.loadSnapshot }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snapshot = fixtureSnapshot(fx, { version: 5 });
const desk = snapshot.items.find((i) => i.code === 'desk')!;
const room = snapshot.rooms.find((r) => r.is_storage)!;
const group = snapshot.groups[0]!;
/** 行を1つ足す（未保存の変更） */
const addRow = { op: 'insert' as const, groupId: group.id, sourceRoomId: room.id, itemId: desk.id, requestedItemId: desk.id, count: 1, note: null, pinned: false };

function setup(refetch: () => Promise<{ isError?: boolean }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => usePendingRows({ snapshot, refetch, editable: true }), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockRejectedValue(appError('conflict', 'conflict'));
});
afterEach(() => cleanup());

describe('usePendingRows：保存が conflict で拒まれた後（afterReject）', () => {
  it('読み直せたら「他の人が変更しました。読み直して、ぶつからない変更を当て直しました」', async () => {
    const refetch = vi.fn(async () => ({ isError: false }));
    const { result } = setup(refetch);
    act(() => result.current.edit(addRow));
    await act(() => result.current.save('E2E：理由'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.toast.warning).toHaveBeenCalledWith('他の人が変更しました。読み直して、ぶつからない変更を当て直しました');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('読み直し（refetch）が失敗したら、当て直したとは言わず「読み直せませんでした。「読み直す」を押してください」', async () => {
    const refetch = vi.fn(async () => ({ isError: true }));
    const { result } = setup(refetch);
    act(() => result.current.edit(addRow));
    await act(() => result.current.save('E2E：理由'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('他の人が変更しました。読み直せませんでした。「読み直す」を押してください');
    // 入力（未保存の変更）は残る
    expect(result.current.pending).toHaveLength(1);
  });

  it('refetch が投げても同じ（読み直せなかった）', async () => {
    const refetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { result } = setup(refetch);
    act(() => result.current.edit(addRow));
    await act(() => result.current.save('E2E：理由'));
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('他の人が変更しました。読み直せませんでした。「読み直す」を押してください');
  });
});

describe('usePendingRows：保存されたか確かめられない（unverified）間は、未保存の変更を変えられない（2.6 の (B2)・3.9）', () => {
  /** 応答が届かず、版も読めない → unverified */
  async function unverified() {
    mocks.save.mockRejectedValue(new TypeError('Failed to fetch'));
    mocks.readVersion.mockRejectedValue(new TypeError('Failed to fetch'));
    const refetch = vi.fn(async () => ({ isError: false }));
    const r = setup(refetch);
    act(() => r.result.current.edit(addRow));
    await act(() => r.result.current.save('E2E：理由'));
    expect(r.result.current.notice?.kind).toBe('unverified');
    return r;
  }

  it('編集・元に戻す・取り消すを受け付けず、理由（editBlock）を返す', async () => {
    const { result } = await unverified();
    expect(result.current.editBlock).toBe('保存されたかを確かめるまで、編集できません。「確かめる」を押してください');
    const before = result.current.pending;
    act(() => result.current.edit({ ...addRow, count: 2 }));
    expect(result.current.pending).toBe(before);
    act(() => result.current.revert(changeIdOf(before[0]!)));
    expect(result.current.pending).toBe(before);
    act(() => result.current.discardAll());
    expect(result.current.pending).toBe(before);
    expect(result.current.notice?.kind).toBe('unverified');
  });

  it('「確かめる」で保存されていない（not-saved）と分かったら、また編集できる', async () => {
    const { result } = await unverified();
    mocks.readVersion.mockResolvedValue(snapshot.version);
    await act(() => result.current.recheck());
    expect(result.current.notice?.kind).toBe('not-saved');
    expect(result.current.editBlock).toBeNull();
    expect(result.current.pending).toHaveLength(1);
    act(() => result.current.edit({ ...addRow, count: 2 }));
    expect(result.current.pending).toHaveLength(2);
    act(() => result.current.discardAll());
    expect(result.current.pending).toHaveLength(0);
  });

  it('「確かめる」でもまだ版を読めなければ、編集できないまま', async () => {
    const { result } = await unverified();
    await act(() => result.current.recheck());
    expect(result.current.notice?.kind).toBe('unverified');
    expect(result.current.editBlock).not.toBeNull();
  });
});

function changeIdOf(c: { op: string; tempId?: string; id?: string }): string {
  return (c.op === 'insert' ? c.tempId : c.id)!;
}

describe('usePendingRows：一部だけが反映済みに見えたとき（partial）の「残りも取り消す」', () => {
  /** A（数 1）と B（数 2）を足して保存 → 応答が届かず、版が進んでいて、A だけが DB にある → partial（残りは B） */
  async function partial() {
    mocks.save.mockRejectedValue(new TypeError('Failed to fetch'));
    mocks.readVersion.mockResolvedValue(snapshot.version + 1);
    const savedA = {
      id: '00000000-0000-4000-8000-00000000a001',
      year_id: snapshot.year.id,
      source_room_id: room.id,
      group_id: group.id,
      item_id: desk.id,
      requested_item_id: desk.id,
      count: 1,
      is_keep: false,
      origin: 'manual' as const,
      pinned: false,
      note: null,
      updated_at: '2026-10-30T00:00:00.000000+00:00',
    };
    mocks.loadSnapshot.mockResolvedValue({ ...snapshot, version: snapshot.version + 1, loadedAt: 'later', allocations: [...snapshot.allocations, savedA] });
    const r = setup(vi.fn(async () => ({ isError: false })));
    act(() => r.result.current.edit(addRow));
    act(() => r.result.current.edit({ ...addRow, count: 2 }));
    await act(() => r.result.current.save('E2E：理由'));
    const notice = r.result.current.notice;
    expect(notice?.kind).toBe('partial');
    expect(notice?.kind === 'partial' ? notice.remaining.map((c) => (c.op === 'insert' ? c.count : null)) : null).toEqual([2]);
    return r;
  }

  it('知らせの残りだけを外し、知らせの後に足した変更は残す', async () => {
    const { result } = await partial();
    act(() => result.current.edit({ ...addRow, count: 3 }));
    expect(result.current.pending).toHaveLength(2);
    act(() => result.current.resolvePartial(false));
    expect(result.current.notice).toBeNull();
    expect(result.current.pending.map((c) => (c.op === 'insert' ? c.count : null))).toEqual([3]);
  });

  it('知らせの後に残りの行を直していれば、直した変更は残す（知らせの後の編集）', async () => {
    const { result } = await partial();
    const b = result.current.pending[0]!;
    act(() => result.current.edit({ op: 'update', id: changeIdOf(b), patch: { count: 4 } }));
    act(() => result.current.resolvePartial(false));
    expect(result.current.pending.map((c) => (c.op === 'insert' ? c.count : null))).toEqual([4]);
  });

  it('知らせの後に何もしていなければ、未保存の変更はなくなる', async () => {
    const { result } = await partial();
    act(() => result.current.resolvePartial(false));
    expect(result.current.pending).toEqual([]);
  });

  it('「残りを残す」なら、残りも知らせの後の変更も残す', async () => {
    const { result } = await partial();
    act(() => result.current.edit({ ...addRow, count: 3 }));
    act(() => result.current.resolvePartial(true));
    expect(result.current.notice).toBeNull();
    expect(result.current.pending.map((c) => (c.op === 'insert' ? c.count : null))).toEqual([2, 3]);
  });
});
