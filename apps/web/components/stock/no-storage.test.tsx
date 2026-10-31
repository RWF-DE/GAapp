// @vitest-environment jsdom
// 保管場所が1つもないときの案内（T15b。D-50、04「在庫一覧」）：保管場所の登録はマスタなので、管理者にだけマスタ設定の場所への
// リンクを出し、総務部門長・総務副部門長・総務部門員には管理者に頼む文を出す。在庫一覧（StocksScreen）と在庫入力の場所の選び方
// （RoomPicker）の両方を描いて確かめる（データの読み込みは差し替える）。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import type { OpenYear } from './common';
import { RoomPicker } from './room-picker';
import { StocksScreen } from './stocks-screen';

const auth = vi.hoisted(() => ({ role: 'admin' as AppRole }));
vi.mock('@/lib/auth/auth-provider', () => {
  const year = { id: 'y1', label: 'R9', status: 'preparing', festival_start: '2027-10-16' };
  return {
    useAuth: () => ({
      session: { status: 'signedIn', session: { user: { id: 'u1' } } },
      membership: {
        status: 'ready',
        membership: { displayName: null, year, role: auth.role, groups: [], years: [year], latestYear: year, adminOfOpenYear: auth.role === 'admin' },
      },
    }),
  };
});
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

/** 読み終えたクエリの形（中身だけを差し替える） */
const done = <T,>(data: T) => ({ data, isError: false, isFetching: false, error: null, dataUpdatedAt: 1, refetch: vi.fn() });
const YEAR = {
  id: 'y1',
  label: 'R9',
  status: 'preparing',
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2027-10-16',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: null,
  updated_at: 't',
} as YearRow;
vi.mock('@/lib/data/year', async (orig) => ({ ...(await orig<typeof import('@/lib/data/year')>()), useYearRow: () => done(YEAR) }));
vi.mock('@/lib/data/stocks', async (orig) => ({
  ...(await orig<typeof import('@/lib/data/stocks')>()),
  useStockMaster: () => done({ rooms: [], items: [], roomYears: [] }),
  useYearStocks: () => done([]),
  usePreviousYearStocks: () => done(undefined),
  useProfileNames: () => done(new Map()),
}));

afterEach(() => cleanup());

function openYear(role: AppRole): OpenYear {
  const year = { id: 'y1', label: 'R9', status: 'preparing' as const, festival_start: '2027-10-16' };
  const membership = { displayName: null, year, role, groups: [], years: [year], latestYear: year, adminOfOpenYear: role === 'admin' } as Membership;
  return { membership, year, role, userId: 'u1' };
}

const SCREENS = {
  在庫一覧: () => <StocksScreen />,
  在庫入力の場所の選び方: (role: AppRole) => <RoomPicker open={openYear(role)} year={YEAR} storage={[]} />,
};

describe('保管場所がないときの案内（D-50）', () => {
  for (const [name, view] of Object.entries(SCREENS)) {
    it(`${name}：管理者にはマスタ設定の場所へのリンク`, () => {
      auth.role = 'admin';
      render(view('admin'));
      expect(screen.getByText('保管場所がありません')).toBeTruthy();
      expect(screen.getByText('マスタ設定の場所で「保管場所」にしてください。')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'マスタ設定（場所）へ' }).getAttribute('href')).toBe('/settings?tab=rooms');
    });

    it.each(['head', 'deputy_head', 'staff'] as const)(`${name}：%s には管理者に頼む文（リンクはない）`, (role) => {
      auth.role = role;
      render(view(role));
      expect(screen.getByText('保管場所がありません')).toBeTruthy();
      expect(screen.getByText('管理者に、保管場所の登録を頼んでください。')).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'マスタ設定（場所）へ' })).toBeNull();
      expect(screen.queryByText(/マスタ設定の場所で/)).toBeNull();
    });
  }
});
