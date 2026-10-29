// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/layout/app-shell';
import { useAuth } from '@/lib/auth/auth-provider';
import { draftKey, saveDraft } from '@/lib/drafts';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { UnsavedChangesGuard } from './unsaved-changes-guard';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/stock/', useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const draft = { userId: 'u1', yearId: 'y9', screen: 'stock', target: 'r1' };

const holder: { signOut: ((kind?: 'manual' | 'forced') => Promise<void>) | null } = { signOut: null };
function Page({ dirty }: { dirty: boolean }) {
  const { signOut } = useAuth();
  useEffect(() => {
    holder.signOut = signOut;
  });
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <p>画面の中身</p>
    </>
  );
}

const renderShell = async (dirty: boolean) => {
  fakeAuth.session = { user: { id: 'u1' } };
  fakeAuth.sources.u1 = sourceOf({
    years: [
      { id: 'y8', label: 'R8', status: 'closed', festival_start: '2026-10-17' },
      { id: 'y9', label: 'R9', status: 'requesting', festival_start: '2027-10-16' },
    ],
    roles: [
      { year_id: 'y8', role: 'staff' },
      { year_id: 'y9', role: 'staff' },
    ],
  });
  render(
    <TestProviders>
      <AppShell>
        <Page dirty={dirty} />
      </AppShell>
    </TestProviders>,
  );
  await screen.findByText('画面の中身');
  saveDraft(draft, { counts: { i1: 3 } });
};

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  router.replace.mockClear();
});
afterEach(() => cleanup());

describe('UnsavedChangesGuard：手動のログアウト（D-33）', () => {
  it('未保存の入力があれば確かめ、やめればログアウトせず下書きも残る', async () => {
    const user = userEvent.setup();
    await renderShell(true);
    await user.click(screen.getByRole('button', { name: /^ログアウト\s*ログアウト$/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('ログアウトすると下書きも消えます');
    await user.click(screen.getByRole('button', { name: 'やめる（入力を続ける）' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fakeAuth.signOut).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(draftKey(draft))).not.toBeNull();
    expect(screen.getByText('画面の中身')).toBeTruthy();
  });

  it('続ければ下書きを消してログアウトし、/login へ移る', async () => {
    const user = userEvent.setup();
    await renderShell(true);
    await user.click(screen.getByRole('button', { name: /^ログアウト\s*ログアウト$/ }));
    await user.click(await screen.findByRole('button', { name: 'ログアウトする' }));
    await vi.waitFor(() => expect(fakeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(window.localStorage.getItem(draftKey(draft))).toBeNull();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login/'));
  });

  it('未保存の入力がなければ確かめずにログアウトする', async () => {
    const user = userEvent.setup();
    await renderShell(false);
    await user.click(screen.getByRole('button', { name: /^ログアウト\s*ログアウト$/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await vi.waitFor(() => expect(fakeAuth.signOut).toHaveBeenCalled());
  });

  it('強制の signOut（401 など）は確かめず、下書きを残して /login?next= へ移る', async () => {
    await renderShell(true);
    await act(() => holder.signOut!('forced'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.localStorage.getItem(draftKey(draft))).not.toBeNull();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login/?next=%2Fstock%2F'));
  });
});

describe('UnsavedChangesGuard：年度の切り替え（D-31）', () => {
  it('未保存の入力があれば確かめ、やめれば選択が元に戻る', async () => {
    const user = userEvent.setup();
    await renderShell(true);
    const select = screen.getByTestId('year-select') as HTMLSelectElement;
    await user.selectOptions(select, 'y8');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('年度を切り替えますか');
    await user.click(screen.getByRole('button', { name: 'やめる（入力を続ける）' }));
    expect(select.value).toBe('y9');
    expect(screen.getByTestId('current-year').textContent).toBe('R9・申請受付中');
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
  });

  it('続ければ切り替わる（入力は年度ごとの下書きに残る）', async () => {
    const user = userEvent.setup();
    await renderShell(true);
    await user.selectOptions(screen.getByTestId('year-select'), 'y8');
    await user.click(await screen.findByRole('button', { name: '切り替える' }));
    await vi.waitFor(() => expect(screen.getByTestId('current-year').textContent).toBe('R8・終了'));
    expect(window.localStorage.getItem(draftKey(draft))).not.toBeNull();
  });
});
