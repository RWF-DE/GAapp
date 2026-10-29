// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_TTL_MS, draftKey, saveDraft } from '@/lib/drafts';
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

/** 最新の y9（R9）と古い Y（R8）の両方で管理者 */
const twoYears = () =>
  sourceOf({
    years: [
      { id: 'y9', label: 'R9', status: 'requesting', festival_start: '2027-10-16' },
      { id: Y, label: 'R8', status: 'closed', festival_start: '2026-10-17' },
    ],
    roles: [
      { year_id: 'y9', role: 'admin' },
      { year_id: Y, role: 'admin' },
    ],
  });

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

  it('(a)(b) ログアウトの後に同じ人がまたログインすると、前に選んだ年度ではなく最新の年度で開く（メモリの選択も消す）', async () => {
    for (const kind of ['manual', 'forced'] as const) {
      cleanup();
      fakeAuth.reset();
      window.sessionStorage.clear();
      fakeAuth.session = { user: { id: 'u1' } };
      fakeAuth.sources.u1 = twoYears();
      render(
        <TestProviders>
          <Probe />
        </TestProviders>,
      );
      await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
      act(() => ctx().setYear(Y));
      await vi.waitFor(() => expect(ctx().membership).toMatchObject({ membership: { year: { id: Y } } }));
      await act(() => ctx().signOut(kind));
      expect(screen.getByTestId('status').textContent).toBe('idle');
      act(() => fakeAuth.setUser('u1'));
      await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
      expect(ctx().membership).toMatchObject({ membership: { year: { id: 'y9' } } });
    }
  });

  it('ログアウトの通信の間は、開いている年度のまま（最新の年度で画面を作り直さない）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = twoYears();
    const mounts: string[] = [];
    function YearChild({ yearId }: { yearId: string }) {
      useEffect(() => {
        mounts.push(yearId);
      }, [yearId]);
      return null;
    }
    function Shell() {
      const auth = useAuth();
      const yearId = auth.membership.status === 'ready' ? auth.membership.membership.year?.id : undefined;
      return yearId ? <YearChild key={yearId} yearId={yearId} /> : null;
    }
    render(
      <TestProviders>
        <Probe />
        <Shell />
      </TestProviders>,
    );
    await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    act(() => ctx().setYear(Y));
    await vi.waitFor(() => expect(mounts).toEqual(['y9', Y]));
    // auth の signOut の応答をまだ返さない
    let finish: () => void = () => {};
    fakeAuth.signOut.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            fakeAuth.setUser(null);
            resolve({ error: null });
          };
        }),
    );
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = ctx().signOut('forced');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(ctx().membership).toMatchObject({ status: 'ready', membership: { year: { id: Y } } });
    expect(mounts).toEqual(['y9', Y]);
    await act(async () => {
      finish();
      await done;
    });
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(mounts).toEqual(['y9', Y]);
  });

  it('(b) ほかのタブのログアウト（SIGNED_OUT）の後に同じ人がまたログインすると、最新の年度で開く（メモリの選択も消す）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = twoYears();
    render(
      <TestProviders>
        <Probe />
      </TestProviders>,
    );
    await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    act(() => ctx().setYear(Y));
    await vi.waitFor(() => expect(ctx().membership).toMatchObject({ membership: { year: { id: Y } } }));
    act(() => fakeAuth.setUser(null));
    expect(screen.getByTestId('status').textContent).toBe('idle');
    act(() => fakeAuth.setUser('u1'));
    await vi.waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(ctx().membership).toMatchObject({ membership: { year: { id: 'y9' } } });
  });

  it('もう一方のタブが localStorage のセッションを消したら（storage イベント）、このタブもログアウトの状態にし、キャッシュと選んだ年度を消す', async () => {
    const qc = await setup('u1');
    saveDraft(draftOf('u1'), { a: 1 });
    act(() => ctx().setYear(Y));
    const storageEvent = (key: string | null, newValue: string | null) =>
      new StorageEvent('storage', { key, newValue, oldValue: '{"access_token":"x"}', storageArea: window.localStorage });
    // 関係のないキーの削除・トークンの更新（newValue がある）では何もしない
    act(() => {
      window.dispatchEvent(storageEvent('other-key', null));
      window.dispatchEvent(storageEvent('sb-test-auth-token', '{"access_token":"y"}'));
    });
    expect(ctx().session.status).toBe('signedIn');
    expect(qc.getQueryData(['year', Y, 'row'])).toEqual({ id: Y });
    // もう一方のタブの代わりの処理（removeStoredSession）でセッションのキーが消えた
    act(() => window.dispatchEvent(storageEvent('sb-test-auth-token', null)));
    expect(ctx().session.status).toBe('signedOut');
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(qc.getQueryData(['year', Y, 'row'])).toBeUndefined();
    expect(window.sessionStorage.getItem('gaapp:year:u1')).toBeNull();
    // 強制と同じく、下書きは残す
    expect(window.localStorage.getItem(draftKey(draftOf('u1')))).not.toBeNull();
  });

  it('signOut が error を返しセッションを消さなかったら（トークンの更新の通信の失敗）、もう一度試し、だめならその端末のセッションを消してログアウトの状態にする', async () => {
    await setup('u1');
    window.localStorage.setItem('sb-test-auth-token', '{"access_token":"x"}');
    window.localStorage.setItem('sb-test-auth-token-code-verifier', 'v');
    window.localStorage.setItem('sb-test-auth-token-user', '{"id":"u1"}');
    window.localStorage.setItem('other-key', 'keep');
    // auth-js は、セッションの読み込み（期限切れのトークンの更新）が通信の失敗になると、セッションを消さずに error を返す
    const failed = async () => ({ error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch' } as unknown as null });
    fakeAuth.signOut.mockImplementationOnce(failed).mockImplementationOnce(failed);
    await act(() => ctx().signOut('manual'));
    expect(fakeAuth.signOut).toHaveBeenCalledTimes(2);
    expect(fakeAuth.signOut).toHaveBeenNthCalledWith(2, { scope: 'local' });
    expect(window.localStorage.getItem('sb-test-auth-token')).toBeNull();
    expect(window.localStorage.getItem('sb-test-auth-token-code-verifier')).toBeNull();
    expect(window.localStorage.getItem('sb-test-auth-token-user')).toBeNull();
    expect(window.localStorage.getItem('other-key')).toBe('keep');
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(ctx().session.status).toBe('signedOut');
  });

  it('signOut が例外を投げても、その端末のセッションを消してログアウトの状態にする', async () => {
    await setup('u1');
    window.localStorage.setItem('sb-test-auth-token', '{"access_token":"x"}');
    fakeAuth.signOut
      .mockImplementationOnce(async () => {
        throw new Error('network');
      })
      .mockImplementationOnce(async () => {
        throw new Error('network');
      });
    await act(() => ctx().signOut('forced'));
    expect(window.localStorage.getItem('sb-test-auth-token')).toBeNull();
    expect(ctx().session.status).toBe('signedOut');
  });

  it('2回目の signOut が通れば、それに任せる（自分でストレージを消さない）', async () => {
    await setup('u1');
    window.localStorage.setItem('sb-test-auth-token', '{"access_token":"x"}');
    fakeAuth.signOut.mockImplementationOnce(async () => ({ error: { message: 'Failed to fetch' } as unknown as null }));
    await act(() => ctx().signOut('manual'));
    expect(fakeAuth.signOut).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem('sb-test-auth-token')).toBe('{"access_token":"x"}');
    expect(screen.getByTestId('status').textContent).toBe('idle');
  });
});

describe('AuthProvider：アプリを開いたとき', () => {
  it('ログインしている人が決まったら、期限の切れた下書きを捨てる（期限内は残す）', async () => {
    const old = { ...draftOf('u1'), target: 'old' };
    const fresh = { ...draftOf('u1'), target: 'fresh' };
    saveDraft(old, { a: 1 }, { now: Date.now() - DRAFT_TTL_MS - 60_000 });
    saveDraft(fresh, { a: 2 });
    await setup('u1');
    expect(window.localStorage.getItem(draftKey(old))).toBeNull();
    expect(window.localStorage.getItem(draftKey(fresh))).not.toBeNull();
  });
});
