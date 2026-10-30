// @vitest-environment jsdom
// 年度のタブ（T09）：新しい年度を作った後の知らせ。create_year_from が通った後のルールの読み込みが失敗しても
// （disabledRuleCodes が null）、年度を作れたものとして扱う（フォームを閉じる・新しい年度に切り替える）。
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { SettingsContext, type SettingsContextValue } from './shared';
import { YearsTab } from './years-tab';

vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

const data = vi.hoisted(() => ({ createYearFrom: vi.fn() }));
vi.mock('@/lib/data/settings', async (orig) => ({ ...(await orig<typeof import('@/lib/data/settings')>()), ...data }));

const setYear = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/guarded', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/guarded')>()), useGuardedSetYear: () => setYear }));

const T0 = '2026-10-29T01:00:00.000001+00:00';
const year = {
  id: 'y9',
  label: 'R9',
  status: 'preparing',
  festival_start: '2027-10-16',
  request_open_at: null,
  request_close_at: null,
  updated_at: T0,
} as unknown as YearRow;
const NEW = { ...year, id: 'y10', label: 'R10', festival_start: '2028-10-14' } as unknown as YearRow;

function renderTab() {
  const value: SettingsContextValue = {
    year,
    membership: { years: [], adminOfOpenYear: true, role: 'admin', latestYear: { id: 'y9', label: 'R9' } } as unknown as Membership,
    yearWritable: true,
    globalWritable: true,
  };
  return render(
    <TestProviders>
      <SettingsContext.Provider value={value}>
        <YearsTab />
      </SettingsContext.Provider>
    </TestProviders>,
  );
}

async function create(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByTestId('year-create-form');
  const label = form.querySelector('input[name="label"]') as HTMLInputElement;
  const start = form.querySelector('input[name="festival_start"]') as HTMLInputElement;
  await user.type(label, 'R10');
  await user.type(start, '2028-10-14');
  await user.click(screen.getByRole('button', { name: '新しい年度を作る' }));
  return { label, start };
}

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fakeAuth.session = { user: { id: 'u1' } };
  fakeAuth.sources.u1 = sourceOf({
    years: [{ id: 'y9', label: 'R9', status: 'preparing', festival_start: '2027-10-16' }],
    roles: [{ year_id: 'y9', role: 'admin' }],
  });
  for (const f of [data.createYearFrom, setYear, toasts.success, toasts.error, toasts.info]) f.mockReset();
  setYear.mockResolvedValue(true);
});
afterEach(() => cleanup());

describe('新しい年度を作った後の知らせ', () => {
  it('無効になったルールを数えられた：件数とコードを出し、新しい年度に切り替える', async () => {
    data.createYearFrom.mockResolvedValue({ year: NEW, disabledRuleCodes: ['S05'] });
    const user = userEvent.setup();
    renderTab();
    await create(user);
    await waitFor(() => expect(setYear).toHaveBeenCalledWith('y10'));
    expect(toasts.success).toHaveBeenCalledWith('R10 を作りました', expect.objectContaining({
      description: '対象の団体が見つからず無効になったルールが 1 件あります（S05）。ルール画面で確かめてください',
    }));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('数えられなかった（null）：「通信できませんでした」と言わず、作れたものとして知らせ、フォームを空にして新しい年度に切り替える', async () => {
    data.createYearFrom.mockResolvedValue({ year: NEW, disabledRuleCodes: null });
    const user = userEvent.setup();
    renderTab();
    const { label, start } = await create(user);
    await waitFor(() => expect(setYear).toHaveBeenCalledWith('y10'));
    expect(toasts.success).toHaveBeenCalledWith('R10 を作りました', expect.objectContaining({
      description: '無効になったルールの数を確かめられませんでした。ルール画面で確かめてください',
    }));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(label.value).toBe('');
    expect(start.value).toBe('');
    // 切り替えが止められたとき（setYear のモック）は、この画面にタブの先頭の知らせが残る
    const notice = await screen.findByTestId('year-created');
    expect(notice.textContent).toContain('R10 を作りました。無効になったルールの数を確かめられませんでした。ルール画面で確かめてください。');
    expect(notice.textContent).not.toContain('無効になったルール 0 件');
  });
});
