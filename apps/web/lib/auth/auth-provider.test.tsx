// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftKey, saveDraft } from '@/lib/drafts';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { useAuth, type AuthContextValue } from './auth-provider';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const Y = 'y8';
const draftOf = (userId: string) => ({ userId, yearId: Y, screen: 'stock', target: 'r1' });

const holder: { ctx: AuthContextValue | null } = { ctx: null };
function Probe() {
  const auth = useAuth();
  useEffect(() => {
    holder.ctx = auth;
  });
  return <p data-testid="status">{auth.membership.status}</p>;
}
const ctx = () => holder.ctx!;

const setup = async (userId = 'u1') => {
  fakeAuth.session = { user: { id: userId } };
  fakeAuth.sources[userId] = sourceOf({});
  const queryClient = new QueryClient();
  queryClient.setQueryData(['year', Y, 'row'], { id: Y });
  render(
    <TestProviders queryClient={queryClient}>
      <Probe />
    </TestProviders>,
  );
  await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
  return queryClient;
};

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('AuthProvider：ログアウトと利用者の切り替えで消すもの（画面の設計 1.3 の (a)〜(c)、D-33）', () => {
  it('(a) 手動のログアウト：scope local で signOut し、キャッシュ・その人の下書き・選んだ年度を消す', async () => {
    const qc = await setup('u1');
    saveDraft(draftOf('u1'), { a: 1 });
    act(() => ctx().setYear(Y));
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBe(Y);
    await act(() => ctx().signOut('manual'));
    expect(fakeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).toBeNull();
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
    expect(qc.getQueryData(['year', Y, 'row'])).toBeUndefined();
    expect(screen.getByTestId('status').textContent).toBe('idle');
  });

  it('(b) 強制の signOut（401 など）：下書きは残し、キャッシュと選んだ年度は消す', async () => {
    const qc = await setup('u1');
    saveDraft(draftOf('u1'), { a: 1 });
    act(() => ctx().setYear(Y));
    await act(() => ctx().signOut('forced'));
    expect(fakeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).not.toBeNull();
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
    expect(qc.getQueryData(['year', Y, 'row'])).toBeUndefined();
  });

  it('(b) ほかのタブのログアウト（SIGNED_OUT が届く）：下書きは残し、キャッシュと選んだ年度は消す', async () => {
    const qc = await setup('u1');
    saveDraft(draftOf('u1'), { a: 1 });
    act(() => ctx().setYear(Y));
    act(() => fakeAuth.setUser(null));
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).not.toBeNull();
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
    expect(qc.getQueryData(['year', Y, 'row'])).toBeUndefined();
  });

  it('(c) 別の利用者がログインしたら、自分以外の下書きを消す', async () => {
    saveDraft(draftOf('u0'), { a: 1 });
    saveDraft(draftOf('u1'), { a: 2 });
    await setup('u1');
    expect(window.localStorage.getItem(draftKey(draftOf('u0')))).toBeNull();
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).not.toBeNull();
  });

  it('401 の後：セッションを更新できれば true、できなければ強制の signOut（下書きを残す）', async () => {
    await setup('u1');
    saveDraft(draftOf('u1'), { a: 1 });
    fakeAuth.refreshSession.mockResolvedValueOnce({ data: { session: { user: { id: 'u1' } } as never }, error: null });
    await expect(act(() => ctx().reauthenticate())).resolves.toBe(true);
    expect(fakeAuth.signOut).not.toHaveBeenCalled();
    await expect(act(() => ctx().reauthenticate())).resolves.toBe(false);
    expect(fakeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).not.toBeNull();
  });
});
