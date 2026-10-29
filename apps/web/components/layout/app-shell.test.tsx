// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-provider';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { AppShell } from './app-shell';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => router }));
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
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

/** 画面の代わり：入力の状態を持ち、立場の読み直しを呼ぶ */
function Page() {
  const { reloadMembership, isRefreshing, membership } = useAuth();
  const [text, setText] = useState('');
  return (
    <div>
      <label>
        メモ
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button onClick={reloadMembership}>読み直す</button>
      <p data-testid="refreshing">{isRefreshing ? 'yes' : 'no'}</p>
      <p data-testid="role">{membership.status === 'ready' ? membership.membership.role : membership.status}</p>
    </div>
  );
}

const renderShell = () =>
  render(
    <TestProviders>
      <AppShell>
        <Page />
      </AppShell>
    </TestProviders>,
  );

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  toast.error.mockClear();
});
afterEach(() => cleanup());

describe('AuthProvider と AppShell：立場の読み直しを裏で行う（画面の設計 1.3）', () => {
  it('初回の読み込みの間はページを LoadingState に置き換え、読めたら中身を出す', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.autoResolve = false;
    renderShell();
    expect((await screen.findByRole('status')).textContent).toContain('読み込み中');
    await vi.waitFor(() => expect(fakeAuth.pending).toHaveLength(1));
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    expect(screen.queryByLabelText('メモ')).toBeNull();
    await act(async () => fakeAuth.resolveLoad(sourceOf({})));
    expect(await screen.findByLabelText('メモ')).toBeTruthy();
    expect(screen.getByTestId('current-year').textContent).toBe('R8・申請受付中');
  });

  it('reloadMembership の間も子が外れない（入力が残る）。読み終えたら新しい立場になる', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'staff' }] });
    const user = userEvent.setup();
    renderShell();
    const input = await screen.findByLabelText('メモ');
    await user.type(input, '数え直し中');
    fakeAuth.autoResolve = false;
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    // 読み直しの間：中身はそのまま（LoadingState に置き換えない）、isRefreshing が立つ
    expect(screen.getByLabelText('メモ')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('数え直し中');
    expect(screen.getByTestId('refreshing').textContent).toBe('yes');
    expect(screen.getByTestId('role').textContent).toBe('staff');
    await act(async () => fakeAuth.resolveLoad(sourceOf({ roles: [{ year_id: 'y8', role: 'admin' }] })));
    expect(screen.getByTestId('refreshing').textContent).toBe('no');
    expect(screen.getByTestId('role').textContent).toBe('admin');
    expect((screen.getByLabelText('メモ') as HTMLInputElement).value).toBe('数え直し中');
  });

  it('読み直しに失敗しても前の立場が残り、toast で知らせる（ErrorState に置き換えない）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'staff' }] });
    const user = userEvent.setup();
    renderShell();
    const input = await screen.findByLabelText('メモ');
    await user.type(input, 'abc');
    fakeAuth.autoResolve = false;
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await act(async () => fakeAuth.rejectLoad());
    expect(screen.getByLabelText('メモ')).toBe(input);
    expect(screen.getByTestId('role').textContent).toBe('staff');
    expect(screen.getByTestId('refreshing').textContent).toBe('no');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('初回の読み込みに失敗したら ErrorState と「もう一度読み込む」', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.autoResolve = false;
    const user = userEvent.setup();
    renderShell();
    await vi.waitFor(() => expect(fakeAuth.pending).toHaveLength(1));
    await act(async () => fakeAuth.rejectLoad());
    expect(await screen.findByText('利用者の情報を読み込めませんでした。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    await act(async () => fakeAuth.resolveLoad(sourceOf({})));
    expect(await screen.findByLabelText('メモ')).toBeTruthy();
  });

  it('利用者が変わったら読み込み中に戻す（前の人の画面を出さない）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({});
    renderShell();
    await screen.findByLabelText('メモ');
    fakeAuth.autoResolve = false;
    act(() => fakeAuth.setUser('u2'));
    expect(screen.queryByLabelText('メモ')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    await act(async () => fakeAuth.resolveLoad(sourceOf({ roles: [{ year_id: 'y8', role: 'viewer' }] })));
    expect(screen.getByTestId('role').textContent).toBe('viewer');
  });

  it('未ログインなら確かめずに /login へ移る', async () => {
    renderShell();
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.replace).toHaveBeenCalledWith('/login/');
  });
});

describe('AppShell：年度の選択と最新でない年度の帯（D-31）', () => {
  const twoYears = sourceOf({
    years: [
      { id: 'y8', label: 'R8', status: 'closed', festival_start: '2026-10-17' },
      { id: 'y9', label: 'R9', status: 'preparing', festival_start: '2027-10-16' },
    ],
    roles: [
      { year_id: 'y8', role: 'admin' },
      { year_id: 'y9', role: 'staff' },
    ],
  });

  it('年度が1つなら選択を出さない', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({});
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.queryByTestId('year-select')).toBeNull();
  });

  it('年度が2つ以上なら新しい順に選べ、切り替えると立場・帯・sessionStorage が変わる', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = twoYears;
    const user = userEvent.setup();
    renderShell();
    await screen.findByLabelText('メモ');
    const select = screen.getByTestId('year-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['R9（準備中）', 'R8（終了）']);
    expect(screen.getByTestId('current-year').textContent).toBe('R9・準備中');
    expect(screen.queryByTestId('not-latest-year-banner')).toBeNull();

    await user.selectOptions(select, 'y8');
    expect(screen.getByTestId('current-year').textContent).toBe('R8・終了');
    expect(screen.getByTestId('role').textContent).toBe('admin');
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBe('y8');
    expect(screen.getByTestId('not-latest-year-banner').textContent).toContain('最新でない年度（R8・終了）を表示しています');

    await user.click(screen.getByRole('button', { name: '最新の年度（R9）に切り替える' }));
    expect(screen.getByTestId('current-year').textContent).toBe('R9・準備中');
    expect(screen.queryByTestId('not-latest-year-banner')).toBeNull();
  });

  it('同じタブで開き直すと選んだ年度を使い、その年度のロールがなくなっていれば既定に戻す', async () => {
    window.sessionStorage.setItem('gaapp:year:u1', 'y8');
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = twoYears;
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByTestId('current-year').textContent).toBe('R8・終了');
    cleanup();

    fakeAuth.reset();
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = { ...twoYears, roles: [{ year_id: 'y9', role: 'staff' }] };
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByTestId('current-year').textContent).toBe('R9・準備中');
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
  });
});
