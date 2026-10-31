// @vitest-environment jsdom
// 振り分け画面の段（T15b。D-50、04「振り分け」）：部門長以上（管理者・総務部門長・総務副部門長）には自動振り分けのボタンを出し、
// 総務部門員には出さない（Excel 出力だけ）。閲覧のみは確定前なら「権限がありません」と「振り分けは確定後に表示されます。」。
// スナップショットを読む前の形（準備中・受付中）と立場の確かめだけを描く（振り分け中の編集は部品のテストと E2E）。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { AppRole, GroupSummary, YearStatus } from '@/lib/auth/membership';
import { AllocationScreen } from './allocation-screen';

const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ membership: auth.membership, reloadMembership: () => {} }) }));
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
