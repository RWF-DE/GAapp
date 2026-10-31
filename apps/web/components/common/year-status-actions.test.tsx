// @vitest-environment jsdom
// 年度の状態のボタン（YearStatusActions）の段（D-48・D-50。T15b）：部門長以上に出し、「終了」とその確認の書き出しは管理者だけ
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-provider';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { YearStatusActions } from './year-status-actions';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('@/lib/rpc', () => ({ callRpc: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
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

/** 立場を読み終えたかを見る（読み終える前の「ボタンがない」と取り違えない） */
function RoleProbe() {
  const { membership } = useAuth();
  return <p data-testid="role">{membership.status === 'ready' ? (membership.membership.role ?? 'none') : membership.status}</p>;
}

const year = (status: YearRow['status']): Pick<YearRow, 'id' | 'label' | 'status' | 'request_close_at'> => ({
  id: 'y8',
  label: 'R8',
  status,
  request_close_at: null,
});

async function renderAs(role: AppRole, status: YearRow['status']) {
  fakeAuth.session = { user: { id: 'u1' } };
  fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role }], years: [{ id: 'y8', label: 'R8', status, festival_start: '2026-10-17' }] });
  render(
    <TestProviders>
      <RoleProbe />
      <YearStatusActions year={year(status)} closeExtras={<button type="button">年度データを書き出す</button>} />
    </TestProviders>,
  );
  await waitFor(() => expect(screen.getByTestId('role').textContent).toBe(role));
}

const buttons = () =>
  screen.queryByTestId('year-status-actions')
    ? [...screen.getByTestId('year-status-actions').querySelectorAll('button')].map((b) => b.textContent)
    : [];

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('YearStatusActions の段', () => {
  it('管理者：確定中は「確定を解除」と「終了」。終了の確認に書き出しのボタンが並ぶ', async () => {
    const user = userEvent.setup();
    await renderAs('admin', 'confirmed');
    expect(buttons()).toEqual(['確定を解除', '終了']);
    await user.click(screen.getByRole('button', { name: '終了' }));
    expect(await screen.findByRole('button', { name: '年度データを書き出す' })).toBeTruthy();
  });

  it.each(['head', 'deputy_head'] as const)('%s：確定中は「確定を解除」だけ（終了と書き出しはない。終了は管理者が行うと添える）', async (role) => {
    await renderAs(role, 'confirmed');
    expect(buttons()).toEqual(['確定を解除']);
    expect(screen.queryByRole('button', { name: '年度データを書き出す' })).toBeNull();
    expect(screen.getByTestId('close-admin-only').textContent).toBe('年度の終了は管理者が行います。');
  });

  it('管理者には終了の注を出さない（「終了」がある）', async () => {
    await renderAs('admin', 'confirmed');
    expect(screen.queryByTestId('close-admin-only')).toBeNull();
  });

  it('総務部門長：準備中は「受付開始」（締切がなければ押せず、マスタ設定の年度のタブへ案内する）', async () => {
    await renderAs('head', 'preparing');
    expect(buttons()).toEqual(['受付開始']);
    expect((screen.getByRole('button', { name: '受付開始' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'マスタ設定の年度へ' }).getAttribute('href')).toBe('/settings?tab=years');
  });

  it.each(['staff', 'viewer'] as const)('%s には出さない', async (role) => {
    await renderAs(role, 'confirmed');
    expect(screen.queryByTestId('year-status-actions')).toBeNull();
  });
});
