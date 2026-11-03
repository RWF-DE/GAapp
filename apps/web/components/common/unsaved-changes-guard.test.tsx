// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/layout/app-shell';
import { useAuth } from '@/lib/auth/auth-provider';
import { draftKey, saveDraft } from '@/lib/drafts';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { LEAVE_MESSAGES, useUnsavedChangesApi, type LeaveKind } from '@/lib/unsaved-changes';
import { UnsavedChangesGuard, UnsavedChangesProvider, useUnsavedChanges } from './unsaved-changes-guard';

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

// 画面が渡す確かめの文（2026-11-03。D-52 の T19 の直し・2。04「共通レイアウト」の確かめの文）。渡さない画面は今の文のまま（後方互換）
describe('UnsavedChangesProvider：画面が渡した確かめの文（D-52 の T19 の直し・2）', () => {
  const UPLOADING = {
    navigate: { title: 'アップロード中です', description: '離れると、残りのファイルは送られません。', confirm: '移る', cancel: 'やめる（アップロードを続ける）' },
    signOut: { title: 'アップロード中です', description: 'ログアウトすると、残りのファイルは送られません。', confirm: 'ログアウトする', cancel: 'やめる（アップロードを続ける）' },
  } as const;
  const answers: boolean[] = [];

  function Source({ dirty, messages }: { dirty: boolean; messages?: Parameters<typeof useUnsavedChanges>[1] }) {
    useUnsavedChanges(dirty, messages);
    return null;
  }
  function Ask({ kind }: { kind: LeaveKind }) {
    const { confirmLeave } = useUnsavedChangesApi();
    return (
      <button type="button" onClick={() => void confirmLeave(kind).then((ok) => answers.push(ok))}>
        {`確かめる：${kind}`}
      </button>
    );
  }
  function Harness({ plain, custom }: { plain: boolean; custom: boolean }) {
    return (
      <UnsavedChangesProvider>
        <Source dirty={plain} />
        <Source dirty={custom} messages={UPLOADING} />
        <Ask kind="navigate" />
        <Ask kind="year" />
        <Ask kind="signOut" />
      </UnsavedChangesProvider>
    );
  }
  const ask = async (user: ReturnType<typeof userEvent.setup>, kind: LeaveKind) => {
    await user.click(screen.getByRole('button', { name: `確かめる：${kind}` }));
    return screen.findByRole('alertdialog');
  };

  beforeEach(() => {
    answers.length = 0;
  });

  it('渡した種類はその見出し・文・2つのボタンで確かめ、下書きの文を出さない。続ければ true', async () => {
    const user = userEvent.setup();
    render(<Harness plain={false} custom />);
    const dialog = await ask(user, 'navigate');
    expect(within(dialog).getByRole('heading').textContent).toBe('アップロード中です');
    expect(dialog.textContent).toContain('離れると、残りのファイルは送られません。');
    expect(dialog.textContent).not.toContain('下書き');
    expect(within(dialog).getByRole('button', { name: 'やめる（アップロードを続ける）' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '移る' }));
    await vi.waitFor(() => expect(answers).toEqual([true]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('やめれば false。渡していない種類（年度の切り替え）は今の文とボタン', async () => {
    const user = userEvent.setup();
    render(<Harness plain={false} custom />);
    const signOut = await ask(user, 'signOut');
    expect(signOut.textContent).toContain('ログアウトすると、残りのファイルは送られません。');
    await user.click(within(signOut).getByRole('button', { name: 'やめる（アップロードを続ける）' }));
    await vi.waitFor(() => expect(answers).toEqual([false]));
    const year = await ask(user, 'year');
    expect(within(year).getByRole('heading').textContent).toBe(LEAVE_MESSAGES.year.title);
    expect(year.textContent).toContain(LEAVE_MESSAGES.year.description);
    expect(within(year).getByRole('button', { name: 'やめる（入力を続ける）' })).toBeTruthy();
    expect(within(year).getByRole('button', { name: LEAVE_MESSAGES.year.confirm })).toBeTruthy();
  });

  it('文を渡さない部品と一緒に知らせているときも、渡した文を出す。渡した部品が知らせをやめると今の文に戻る', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness plain custom />);
    const both = await ask(user, 'navigate');
    expect(within(both).getByRole('heading').textContent).toBe('アップロード中です');
    await user.click(within(both).getByRole('button', { name: 'やめる（アップロードを続ける）' }));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    rerender(<Harness plain custom={false} />);
    const plainOnly = await ask(user, 'navigate');
    expect(within(plainOnly).getByRole('heading').textContent).toBe(LEAVE_MESSAGES.navigate.title);
    expect(plainOnly.textContent).toContain(LEAVE_MESSAGES.navigate.description);
    expect(within(plainOnly).getByRole('button', { name: 'やめる（入力を続ける）' })).toBeTruthy();
    expect(within(plainOnly).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm })).toBeTruthy();
  });

  it('文を渡さない画面は今までどおり（今の文・「やめる（入力を続ける）」）。知らせがなければ確かめずに true', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness plain custom={false} />);
    const dialog = await ask(user, 'navigate');
    expect(dialog.textContent).toContain(LEAVE_MESSAGES.navigate.description);
    await user.click(within(dialog).getByRole('button', { name: LEAVE_MESSAGES.navigate.confirm }));
    await vi.waitFor(() => expect(answers).toEqual([true]));
    rerender(<Harness plain={false} custom={false} />);
    await user.click(screen.getByRole('button', { name: '確かめる：navigate' }));
    await vi.waitFor(() => expect(answers).toEqual([true, true]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
