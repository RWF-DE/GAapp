// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { AppLink } from './app-link';

const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ membership: auth.membership }) }));
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

const year = { id: 'y1', label: 'R8', status: 'allocating', festival_start: '2026-10-17' } as const;
const as = (role: 'admin' | 'staff' | 'viewer', status: typeof year.status | 'confirmed' = 'allocating'): MembershipState => ({
  status: 'ready',
  membership: {
    displayName: null,
    year: { ...year, status },
    role,
    groups: [],
    years: [],
    latestYear: null,
    adminOfOpenYear: false,
  },
});

afterEach(() => cleanup());

describe('AppLink（canOpen で出し分け）', () => {
  it('開ける立場ならリンク、開けなければ文字だけ', () => {
    auth.membership = as('admin');
    render(<AppLink href="/swaps">3 件</AppLink>);
    expect(screen.getByRole('link', { name: '3 件' }).getAttribute('href')).toBe('/swaps');
    cleanup();
    auth.membership = as('staff');
    render(<AppLink href="/swaps">3 件</AppLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('3 件')).toBeTruthy();
  });

  it('viewer の振り分けは確定後だけリンクになる。fallback を渡せる', () => {
    auth.membership = as('viewer');
    render(
      <AppLink href="/allocation" fallback={<span>確定後に見られます</span>}>
        振り分け表
      </AppLink>,
    );
    expect(screen.getByText('確定後に見られます')).toBeTruthy();
    cleanup();
    auth.membership = as('viewer', 'confirmed');
    render(<AppLink href="/allocation">振り分け表</AppLink>);
    expect(screen.getByRole('link', { name: '振り分け表' })).toBeTruthy();
  });
});
