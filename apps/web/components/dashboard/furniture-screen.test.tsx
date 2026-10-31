// @vitest-environment jsdom
// 机椅子の状況（/furniture。04「机椅子の状況」。T16）：T16 より前の / のダッシュボード（components/dashboard/dashboard.tsx）を
// h1「机椅子の状況」で出す。立場の一覧と代表する団体はダッシュボード（/）に出すので、ここには出さない。
// スナップショットは版から読む（読み終えるまでは dashboard-loading。中身と testid は T09 の E2E が確かめる）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { GroupSummary } from '@/lib/auth/membership';
import { createFakeSupabase } from '@/lib/testing/fake-supabase';
import { FurnitureScreen } from './furniture-screen';

const h = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState, client: null as unknown }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({ membership: h.membership, reloadMembership: () => {}, isRefreshing: false }),
}));
vi.mock('@/lib/supabase/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/client')>()),
  getSupabase: () => h.client,
}));

afterEach(() => cleanup());

const Y = 'y1';
const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };

describe('T16 机椅子の状況（FurnitureScreen）', () => {
  it('h1「机椅子の状況」で机椅子のダッシュボードを出し、版（years の allocation_version）から読む。立場の一覧・代表する団体は出さない', async () => {
    // 読み込みは返さない（スナップショットの読み込み中の形）
    const fake = createFakeSupabase(() => new Promise(() => {}));
    h.client = fake.client;
    const year = { id: Y, label: 'R8', status: 'requesting' as const, festival_start: '2026-10-17' };
    h.membership = {
      status: 'ready',
      membership: { displayName: null, year, role: 'admin', groups: [G1], years: [year], latestYear: year, adminOfOpenYear: true },
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FurnitureScreen />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('机椅子の状況');
    expect(screen.getByTestId('dashboard-loading')).toBeTruthy();
    expect(screen.queryByTestId('home-year')).toBeNull();
    expect(screen.queryByTestId('home-roles')).toBeNull();
    expect(screen.queryByTestId('rep-home')).toBeNull();
    expect(screen.queryByTestId('rep-card')).toBeNull();
    await waitFor(() => expect(fake.issued.length).toBeGreaterThan(0));
    expect(fake.issued[0]?.table).toBe('years');
  });
});
