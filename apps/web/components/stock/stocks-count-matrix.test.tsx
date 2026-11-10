// @vitest-environment jsdom
// 在庫一覧の「備品（数えるだけ）」の表（04「在庫一覧」。T22・D-60）：机椅子の表の下に、保管場所 × 物の表。列は最初から出す物と、
// 今年か前年に数がある物。数の行がなければ 0。「まだ数えていない場所」は机椅子の在庫だけで決める（データの読み込みは差し替える）。
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRole } from '@/lib/auth/roles';
import type { CountItemRow, ItemRow, RoomRow, YearRow } from '@/lib/db/types';
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
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const room = (n: number): RoomRow => ({
  id: id(n),
  name: `倉庫${n}`,
  aliases: [],
  kind: 'room',
  building: 'E2E棟',
  floor: 1,
  extra_cost: 0,
  is_storage: true,
  sort_order: n,
  updated_at: 't',
});
const DESK: ItemRow = { id: id(101), code: 'i1', name: '机(木)', aliases: [], requestable_categories: ['stall'], sort_order: 1, updated_at: 't' };
const ci = (n: number, name: string, always: boolean): CountItemRow => ({ id: id(200 + n), name, always_shown: always, sort_order: n, updated_at: 't' });
const TRASH = ci(1, 'ゴミ箱', true);
const WHITE = ci(5, '白椅子', false);
const VACUUM = ci(6, '掃除機', false);
const YEAR = {
  id: 'y1',
  label: 'R9',
  status: 'requesting',
  allocation_version: 1,
  auto_allocated_at: null,
  festival_start: '2027-10-16',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: id(500),
  updated_at: 't',
} as YearRow;
vi.mock('@/lib/data/year', async (orig) => ({ ...(await orig<typeof import('@/lib/data/year')>()), useYearRow: () => done(YEAR) }));
vi.mock('@/lib/data/stocks', async (orig) => ({
  ...(await orig<typeof import('@/lib/data/stocks')>()),
  useStockMaster: () => done({ rooms: [room(1), room(2)], items: [DESK], roomYears: [], countItems: [TRASH, WHITE, VACUUM] }),
  useYearStocks: () =>
    done([{ year_id: 'y1', room_id: id(1), item_id: DESK.id, count: 4, counted_at: 'a', counted_by: null, updated_at: 'u' }]),
  usePreviousYearStocks: () => done([]),
  useYearCountStocks: () =>
    done([{ year_id: 'y1', room_id: id(2), count_item_id: WHITE.id, count: 2, counted_at: 'a', counted_by: null, updated_at: 'u' }]),
  usePreviousYearCountStocks: () => done([{ room_id: id(1), count_item_id: TRASH.id, count: 3 }]),
  useProfileNames: () => done(new Map()),
}));

afterEach(() => cleanup());

describe('在庫一覧の「備品（数えるだけ）」の表（T22）', () => {
  it('列は最初から出す物と今年か前年に数がある物、セルは数の行がなければ 0。「まだ数えていない場所」は机椅子だけで決める', () => {
    auth.role = 'staff';
    render(<StocksScreen />);
    const table = screen.getByTestId('count-matrix');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['保管場所', 'ゴミ箱', '白椅子', '合計']);
    const rows = within(table).getAllByTestId('count-matrix-row');
    expect(within(rows[0]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0（−3）', '0（±0）', '0（−3）']);
    expect(within(rows[1]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0（±0）', '2（+2）', '2（+2）']);
    expect(within(screen.getByTestId('count-total-all')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0（−3）', '2（+2）', '2（−1）']);
    // 机椅子の表と「まだ数えていない場所」（倉庫2 は机椅子の在庫がない）
    expect(screen.getByTestId('stock-matrix')).toBeTruthy();
    expect(within(screen.getByTestId('uncounted-rooms')).getAllByRole('link').map((a) => a.textContent)).toEqual(['倉庫2']);
  });
});
