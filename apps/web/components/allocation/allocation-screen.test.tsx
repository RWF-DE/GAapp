// @vitest-environment jsdom
// 振り分け画面の段（T15b。D-50、04「振り分け」）：部門長以上（管理者・総務部門長・総務副部門長）には自動振り分けのボタンを出し、
// 総務部門員には出さない（Excel 出力だけ）。閲覧のみは確定前なら「権限がありません」と「振り分けは確定後に表示されます。」。
// 振り分け中は、部門長以上に行の操作・部屋の見出しのメニュー（今年は使用不可にする）・行の追加・確定を出し、総務部門員には出さない
// （スナップショット・版の見張り・計算エンジンは差し替える。画面の中の段の判定〔AllocationScreen の lead〕を通す）。
import type { AllocationDbRow } from '@/lib/db/types';
import { fixtureIndex, fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, YearStatus } from '@/lib/auth/membership';
import type { Snapshot } from '@/lib/data/snapshot';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { AllocationScreen } from './allocation-screen';

const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: auth.membership,
    session: { status: 'signedIn', session: { user: { id: '00000000-0000-4000-8000-0000000000aa' } } },
    reloadMembership: () => {},
    reauthenticate: async () => false,
  }),
}));
// 振り分け中の形：スナップショットは差し替えた値（読み込みは済み）、版の見張りは進んでいない、計算エンジンは読み込み済みの偽物
const snap = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/data/snapshot', async (orig) => ({
  ...(await orig<typeof import('@/lib/data/snapshot')>()),
  useSnapshot: () => ({ isPending: false, isError: false, isFetching: false, data: snap.current, error: null, refetch: async () => ({ data: snap.current }) }),
}));
vi.mock('@/lib/data/version-watch', () => ({ useVersionWatch: () => ({ stale: false, latestVersion: null }) }));
vi.mock('@/lib/allocation/engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/allocation/engine')>()),
  getAllocatorEngine: () => ({
    state: () => 'ready',
    subscribe: () => () => {},
    warmup: async () => ({ ok: true, loadMs: 0 }),
    run: async () => {
      throw new Error('このテストでは計算しない');
    },
    cancel: () => {},
    dispose: () => {},
  }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

const GROUP: GroupSummary = { id: 'g1', name: '模擬店01', year_id: 'y1', role: 'manager' };

function as(role: AppRole | null, status: YearStatus, groups: GroupSummary[] = []): MembershipState {
  const year = { id: 'y1', label: 'R8', status, festival_start: '2026-10-17' };
  return { status: 'ready', membership: { displayName: null, year, role, groups, years: [year], latestYear: year, adminOfOpenYear: false } };
}

// jsdom にないもの（Radix の DropdownMenu・Popover と、行へのスクロール）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(() => cleanup());

describe('AllocationScreen：段ごとの出し分け（T15b・D-50）', () => {
  it.each(['admin', 'head', 'deputy_head'] as const)('部門長以上（%s）には、締切の前でも自動振り分け・最小変更で再実行のボタンを出す（押せない）', (role) => {
    auth.membership = as(role, 'requesting');
    render(<AllocationScreen />);
    expect(screen.getByText('締切の後に振り分けます')).toBeTruthy();
    for (const name of ['自動振り分け', '最小変更で再実行', 'Excel出力']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('総務部門員には自動振り分け・最小変更で再実行のボタンを出さない（Excel 出力だけ）', () => {
    auth.membership = as('staff', 'preparing');
    render(<AllocationScreen />);
    expect(screen.getByText('締切の後に振り分けます')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '自動振り分け' })).toBeNull();
    expect(screen.queryByRole('button', { name: '最小変更で再実行' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Excel出力' })).toBeTruthy();
  });

  it('閲覧のみは、確定前なら「権限がありません」と「振り分けは確定後に表示されます。」（ページの守りと同じ文言。二重の守り）', () => {
    auth.membership = as('viewer', 'allocating');
    render(<AllocationScreen />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('権限がありません');
    expect(alert.textContent).toContain('振り分けは確定後に表示されます。');
  });

  it('店長・副店長だけの人は「権限がありません」で、確定後の説明は添えない', () => {
    auth.membership = as(null, 'confirmed', [GROUP]);
    render(<AllocationScreen />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('権限がありません');
    expect(alert.textContent).not.toContain('振り分けは確定後に表示されます。');
  });
});

// ---- 振り分け中（部門長以上は編集できる。D-50・04「振り分け」） ----

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const ix = fixtureIndex(fx);
const desk = ix.itemId('desk');
const BASE = fixtureSnapshot(fx, { status: 'allocating' });
/** 机(木)の在庫がある保管場所（品目のタブ〔最初は机〕に部屋のまとまりが出る） */
const deskRoom = BASE.stocks.find((st) => st.item_id === desk && st.count > 0)!.room_id;
const deskRoomName = BASE.rooms.find((r) => r.id === deskRoom)!.name;
const ROW_ID = '00000000-0000-4000-8000-00000000a001';

function allocatingSnapshot(): Snapshot {
  const base = BASE;
  const row: AllocationDbRow = {
    id: ROW_ID,
    year_id: base.year.id,
    source_room_id: deskRoom,
    group_id: ix.groupId('模擬店01'),
    item_id: desk,
    requested_item_id: desk,
    count: 2,
    is_keep: false,
    origin: 'auto',
    pinned: false,
    note: null,
    updated_at: FIXTURE_UPDATED_AT,
  };
  return { ...base, allocations: [row] };
}

function renderAllocating(role: AppRole) {
  snap.current = allocatingSnapshot();
  auth.membership = as(role, 'allocating');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AllocationScreen />
    </QueryClientProvider>,
  );
}

const rowEl = () => document.querySelector<HTMLElement>(`[data-row-id="${ROW_ID}"]`);

describe('AllocationScreen：振り分け中の段（T15b・D-50）', () => {
  it.each(['head', 'deputy_head'] as const)(
    '%s：行の操作・部屋の見出しのメニュー（今年は使用不可にする）・行の追加・確定が出る（管理者と同じ）',
    async (role) => {
      const user = userEvent.setup();
      renderAllocating(role);
      await waitFor(() => expect(rowEl()).not.toBeNull());
      const row = rowEl()!;
      expect(within(row).getByRole('button', { name: '固定する' })).toBeTruthy();
      expect(within(row).getByRole('button', { name: /の運び元を変える$/ })).toBeTruthy();
      expect(within(row).getByRole('button', { name: /を削除$/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: '行を追加' })).toBeTruthy();
      expect(within(screen.getByTestId('year-status-actions')).getByRole('button', { name: '確定' })).toBeTruthy();
      expect(screen.queryByTestId('read-only-notice')).toBeNull();

      await user.click(screen.getByRole('button', { name: `${deskRoomName}のメニュー` }));
      expect(await screen.findByRole('menuitem', { name: '今年は使用不可にする' })).toBeTruthy();
    },
  );

  it('総務部門員：行は読み取りで、行の操作・部屋の見出しのメニュー・行の追加・確定は出さない（帯で知らせる）', async () => {
    renderAllocating('staff');
    await waitFor(() => expect(rowEl()).not.toBeNull());
    const row = rowEl()!;
    expect(within(row).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: `${deskRoomName}のメニュー` })).toBeNull();
    expect(screen.queryByRole('button', { name: '行を追加' })).toBeNull();
    expect(screen.queryByTestId('year-status-actions')).toBeNull();
    expect(screen.getByTestId('read-only-notice').textContent).toBe(
      '総務部門員は振り分けを見るだけです（自動振り分け・編集・確定は管理者・総務部門長・総務副部門長が行います）。',
    );
  });
});
