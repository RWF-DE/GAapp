// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectedYearKey } from '@/lib/auth/selected-year';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { useNotLatestYearConfirm, type NotLatestYearConfirmOptions } from './latest-year';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const twoYears = sourceOf({
  years: [
    { id: 'y8', label: 'R8', status: 'closed', festival_start: '2026-10-17' },
    { id: 'y9', label: 'R9', status: 'requesting', festival_start: '2027-10-16' },
  ],
  roles: [
    { year_id: 'y8', role: 'admin' },
    { year_id: 'y9', role: 'admin' },
  ],
});

/** 書き込む画面の代わり：押すと確かめ、結果を出す */
function Writer({ options }: { options?: NotLatestYearConfirmOptions }) {
  const notLatest = useNotLatestYearConfirm(options);
  const [result, setResult] = useState('');
  return (
    <div>
      {notLatest.dialog}
      <p data-testid="is-latest">{notLatest.isLatest ? 'yes' : 'no'}</p>
      <button onClick={async () => setResult((await notLatest.confirmBeforeWrite()) ? 'ok' : 'cancel')}>書き込む</button>
      <p data-testid="result">{result}</p>
    </div>
  );
}

const renderWriter = (options?: NotLatestYearConfirmOptions) =>
  render(
    <TestProviders>
      <Writer options={options} />
    </TestProviders>,
  );

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fakeAuth.session = { user: { id: 'u1' } };
  fakeAuth.sources.u1 = twoYears;
});
afterEach(() => cleanup());

describe('useNotLatestYearConfirm（最新でない年度で書き込む前の確かめ。1.3.1）', () => {
  it('最新の年度なら確かめずに続ける', async () => {
    const user = userEvent.setup();
    renderWriter();
    expect((await screen.findByTestId('is-latest')).textContent).toBe('yes');
    await user.click(screen.getByRole('button', { name: '書き込む' }));
    expect(screen.getByTestId('result').textContent).toBe('ok');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('既定の文言は「保存」。続ければ true、やめれば false', async () => {
    window.sessionStorage.setItem(selectedYearKey('u1'), 'y8');
    const user = userEvent.setup();
    renderWriter();
    await vi.waitFor(() => expect(screen.getByTestId('is-latest').textContent).toBe('no'));

    await user.click(screen.getByRole('button', { name: '書き込む' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('最新でない年度（R8・終了）に保存します。よろしいですか');
    await user.click(screen.getByRole('button', { name: 'この年度に保存する' }));
    await vi.waitFor(() => expect(screen.getByTestId('result').textContent).toBe('ok'));

    await user.click(screen.getByRole('button', { name: '書き込む' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.getByTestId('result').textContent).toBe('cancel'));
  });

  it('verb で動詞を変えられる（題と確定のボタン）', async () => {
    window.sessionStorage.setItem(selectedYearKey('u1'), 'y8');
    const user = userEvent.setup();
    renderWriter({ verb: '回答' });
    await vi.waitFor(() => expect(screen.getByTestId('is-latest').textContent).toBe('no'));
    await user.click(screen.getByRole('button', { name: '書き込む' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('最新でない年度（R8・終了）に回答します。よろしいですか');
    expect(dialog.textContent).not.toContain('保存');
    await user.click(screen.getByRole('button', { name: 'この年度に回答する' }));
    await vi.waitFor(() => expect(screen.getByTestId('result').textContent).toBe('ok'));
  });

  it('verb が空白だけなら既定の「保存」', async () => {
    window.sessionStorage.setItem(selectedYearKey('u1'), 'y8');
    const user = userEvent.setup();
    renderWriter({ verb: '  ' });
    await vi.waitFor(() => expect(screen.getByTestId('is-latest').textContent).toBe('no'));
    await user.click(screen.getByRole('button', { name: '書き込む' }));
    expect((await screen.findByRole('alertdialog')).textContent).toContain('に保存します。よろしいですか');
    expect(screen.getByRole('button', { name: 'この年度に保存する' })).toBeTruthy();
  });
});
