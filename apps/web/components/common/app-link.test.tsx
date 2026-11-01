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

  it('開ける立場なら、className（リンクの見た目）を付けたリンク', () => {
    auth.membership = as('admin');
    render(
      <AppLink href="/swaps" className="underline underline-offset-2 hover:text-primary">
        キャスター机交換へ
      </AppLink>,
    );
    expect(screen.getByRole('link', { name: 'キャスター机交換へ' }).getAttribute('class')).toBe('underline underline-offset-2 hover:text-primary');
  });

  it('開けない立場では、リンクの見た目（下線・色。className）を付けずに文字だけを出す（リンクに見えない）', () => {
    auth.membership = as('staff');
    const { container } = render(
      <p>
        ルール{' '}
        <AppLink href="/rules?code=S05" className="underline underline-offset-2 hover:text-primary">
          S05
        </AppLink>
      </p>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    const text = screen.getByText('S05');
    expect(text.tagName).toBe('SPAN');
    expect(text.hasAttribute('class')).toBe(false);
    expect(container.querySelector('.underline, [class*="text-primary"]')).toBeNull();
    expect(container.textContent).toBe('ルール S05');
  });

  it('開けない立場で fallback を渡せば、既定の文字の代わりにそれを出す（null なら何も出さない）', () => {
    auth.membership = as('staff');
    const { container } = render(
      <div>
        <AppLink href="/swaps" className="underline" fallback={<span data-testid="own">交換の画面は部門長以上</span>}>
          交換へ
        </AppLink>
        <AppLink href="/history" className="underline" fallback={null}>
          履歴へ
        </AppLink>
      </div>,
    );
    expect(screen.getByTestId('own').textContent).toBe('交換の画面は部門長以上');
    expect(screen.queryByText('交換へ')).toBeNull();
    expect(screen.queryByText('履歴へ')).toBeNull();
    expect(container.querySelector('.underline')).toBeNull();
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
