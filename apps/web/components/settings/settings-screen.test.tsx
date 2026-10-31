// @vitest-environment jsdom
// マスタ設定の画面（T15b。D-50）：タブを段で出し分ける（管理者は7つ、総務部門長・総務副部門長は年度・場所・ユーザー）。
// 開けないタブ・知らない値の `?tab=` は開けるタブの最初（年度）。終了した年度の帯は段で文が違う。
// 各タブの中身は差し替え（どのタブを描いたかだけを見る）。
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';

const state = vi.hoisted(() => ({
  role: 'admin' as AppRole,
  status: 'preparing' as 'preparing' | 'requesting' | 'allocating' | 'confirmed' | 'closed',
  query: '',
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/',
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ push: vi.fn(), replace: state.replace, refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/auth-provider', () => {
  const year = { id: 'y9', label: 'R9', status: 'preparing', festival_start: '2027-10-16' };
  return {
    useAuth: () => ({
      session: { status: 'signedIn', session: { user: { id: 'u1' } } },
      membership: {
        status: 'ready',
        membership: { displayName: 'テスト', year, role: state.role, groups: [], years: [year], latestYear: year, adminOfOpenYear: state.role === 'admin' },
      },
      isRefreshing: false,
      reloadMembership: vi.fn(),
      setYear: vi.fn(),
      signOut: vi.fn(),
    }),
  };
});

vi.mock('@/lib/data/year', () => ({
  useYearRow: () => ({
    data: { id: 'y9', label: 'R9', status: state.status, festival_start: '2027-10-16', updated_at: 'T0' } as unknown as YearRow,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// 各タブの中身（どのタブを描いたかだけを見る）
vi.mock('./years-tab', () => ({ YearsTab: () => <p data-testid="tab-body">years</p> }));
vi.mock('./rooms-tab', () => ({ RoomsTab: () => <p data-testid="tab-body">rooms</p> }));
vi.mock('./items-tab', () => ({ ItemsTab: () => <p data-testid="tab-body">items</p> }));
vi.mock('./groups-tab', () => ({ GroupsTab: () => <p data-testid="tab-body">groups</p> }));
vi.mock('./distance-tab', () => ({ DistanceTab: () => <p data-testid="tab-body">distance</p> }));
vi.mock('./users-tab', () => ({ UsersTab: () => <p data-testid="tab-body">users</p> }));
vi.mock('./export-tab', () => ({ ExportTab: () => <p data-testid="tab-body">export</p> }));

const { SettingsScreen } = await import('./settings-screen');

const tabIds = () => screen.queryAllByRole('tab').map((t) => t.getAttribute('data-testid'));

beforeEach(() => {
  state.role = 'admin';
  state.status = 'preparing';
  state.query = '';
  state.replace.mockReset();
});
afterEach(() => cleanup());

describe('マスタ設定のタブ（段ごと。D-50）', () => {
  it('管理者は7つのタブ。`?tab=groups` は団体のタブ', () => {
    state.query = 'tab=groups';
    render(<SettingsScreen />);
    expect(tabIds()).toEqual([
      'settings-tab-years',
      'settings-tab-rooms',
      'settings-tab-items',
      'settings-tab-groups',
      'settings-tab-distance',
      'settings-tab-users',
      'settings-tab-export',
    ]);
    expect(screen.getByTestId('tab-body').textContent).toBe('groups');
  });

  for (const role of ['head', 'deputy_head'] as const) {
    it(`${role}：年度・場所・ユーザーだけ。開けないタブ（groups・items・distance・export）と知らない値は年度`, () => {
      state.role = role;
      for (const [query, body] of [
        ['', 'years'],
        ['tab=rooms', 'rooms'],
        ['tab=users', 'users'],
        ['tab=groups', 'years'],
        ['tab=items', 'years'],
        ['tab=distance', 'years'],
        ['tab=export', 'years'],
        ['tab=foo', 'years'],
      ] as const) {
        state.query = query;
        render(<SettingsScreen />);
        expect(tabIds()).toEqual(['settings-tab-years', 'settings-tab-rooms', 'settings-tab-users']);
        expect(screen.getByTestId('tab-body').textContent).toBe(body);
        // 開けないタブの URL は書き換えない（年度のタブを選んだ形で出すだけ）
        expect(screen.getByTestId('settings-tab-years').getAttribute('aria-selected')).toBe(body === 'years' ? 'true' : 'false');
        cleanup();
      }
      expect(state.replace).not.toHaveBeenCalled();
    });
  }

  it('タブを押すと `?tab=` を書き換える（部門長はユーザーのタブへ）', async () => {
    state.role = 'head';
    const user = userEvent.setup();
    render(<SettingsScreen />);
    await user.click(screen.getByTestId('settings-tab-users'));
    expect(state.replace).toHaveBeenCalledWith('/settings?tab=users', { scroll: false });
  });

  it('部門長以上でない（ページの守りの外）ときは権限なし（タブを出さない）', () => {
    state.role = 'staff';
    render(<SettingsScreen />);
    expect(screen.getByText('権限がありません')).toBeTruthy();
    expect(tabIds()).toEqual([]);
    expect(screen.queryByTestId('tab-body')).toBeNull();
  });
});

describe('終了した年度の帯（段で文が違う。04「マスタ設定」）', () => {
  it('管理者：ロールを外す・店長・副店長を外す・招待の取り消し・新しい年度の作成はできる', () => {
    state.status = 'closed';
    render(<SettingsScreen />);
    expect(screen.getByTestId('read-only-notice').textContent).toBe(
      '終了した年度のため、読み取り専用です（ロールを外す、店長・副店長を外す、招待の取り消し、新しい年度の作成はできます）',
    );
  });

  it('総務部門長・総務副部門長：総務部門員のロールを外す・店長・副店長を外す・招待の取り消しだけ', () => {
    state.status = 'closed';
    for (const role of ['head', 'deputy_head'] as const) {
      state.role = role;
      render(<SettingsScreen />);
      expect(screen.getByTestId('read-only-notice').textContent).toBe(
        '終了した年度のため、読み取り専用です（総務部門員のロールを外す、店長・副店長を外す、招待の取り消しはできます）',
      );
      cleanup();
    }
  });

  it('終了していない年度では帯を出さない', () => {
    state.role = 'head';
    render(<SettingsScreen />);
    expect(screen.queryByTestId('read-only-notice')).toBeNull();
  });
});
