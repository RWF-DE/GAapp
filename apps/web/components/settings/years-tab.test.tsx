// @vitest-environment jsdom
// 年度のタブ（T09）：新しい年度を作った後の知らせ。create_year_from が通った後のルールの読み込みが失敗しても
// （disabledRuleCodes が null）、年度を作れたものとして扱う（フォームを閉じる・新しい年度に切り替える）。
// T15b：総務部門長・総務副部門長は受付期間だけ（年度名・1日目は読み取り、送る patch も受付期間だけ、作成の欄はない。D-50）。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
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

const rpc = vi.hoisted(() => ({ callRpc: vi.fn() }));
vi.mock('@/lib/rpc', () => rpc);

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

function renderTab(role: AppRole = 'admin') {
  const value: SettingsContextValue = {
    year,
    membership: { years: [], adminOfOpenYear: role === 'admin', role, latestYear: { id: 'y9', label: 'R9' } } as unknown as Membership,
    yearWritable: true,
    globalWritable: role === 'admin',
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
  for (const f of [data.createYearFrom, setYear, rpc.callRpc, toasts.success, toasts.error, toasts.info]) f.mockReset();
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

describe('年度の変更の段（D-50）', () => {
  const field = (form: HTMLElement, name: string) => form.querySelector(`input[name="${name}"]`) as HTMLInputElement;

  it('管理者：年度名・1日目も書け、説明は年度名・1日目・受付期間。作成の欄がある（最新の年度）', async () => {
    renderTab('admin');
    const form = await screen.findByTestId('year-edit-form');
    for (const name of ['label', 'festival_start', 'request_open_at', 'request_close_at']) expect(field(form, name).readOnly).toBe(false);
    expect(screen.getByTestId('year-edit-description').textContent).toBe(
      '年度名・1日目・申請の受付期間を変えます。受付開始の前に締切を入れてください（受付中は締切を空にできません）。',
    );
    expect(screen.getByTestId('year-create-form')).toBeTruthy();
  });

  it('管理者で最新でない年度：作成の欄はなく、最新の年度を開いてその年度の管理者が作ると知らせる', async () => {
    const value: SettingsContextValue = {
      year,
      membership: { years: [], adminOfOpenYear: true, role: 'admin', latestYear: { id: 'y10', label: 'R10' } } as unknown as Membership,
      yearWritable: true,
      globalWritable: true,
    };
    render(
      <TestProviders>
        <SettingsContext.Provider value={value}>
          <YearsTab />
        </SettingsContext.Provider>
      </TestProviders>,
    );
    expect((await screen.findByTestId('year-create-unavailable')).textContent).toBe(
      '新しい年度は、最新の年度（R10）を開いて、その年度の管理者が作れます。',
    );
    expect(screen.queryByTestId('year-fixed-fields')).toBeNull();
  });

  for (const role of ['head', 'deputy_head'] as const) {
    it(`${role}：年度名・1日目は入力欄でなく文字で出し、作成の欄はなく、送る patch は受付期間だけ`, async () => {
      rpc.callRpc.mockResolvedValue({});
      const user = userEvent.setup();
      renderTab(role);
      const form = await screen.findByTestId('year-edit-form');
      // 書ける欄と見分けられるよう、変えられない項目は入力欄にしない（「管理者が変えます」を添える）
      expect(field(form, 'label')).toBeNull();
      expect(field(form, 'festival_start')).toBeNull();
      expect(screen.getByTestId('year-fixed-label').textContent).toBe('R9');
      expect(screen.getByTestId('year-fixed-festival-start').textContent).toBe('2027/10/16');
      expect(screen.getByTestId('year-fixed-fields').textContent).toBe('年度名R9（管理者が変えます）1日目2027/10/16（管理者が変えます）');
      expect(field(form, 'request_open_at').readOnly).toBe(false);
      expect(field(form, 'request_close_at').readOnly).toBe(false);
      expect(screen.getByTestId('year-edit-description').textContent).toBe(
        '申請の受付期間を変えます（年度名と1日目は管理者が変えます）。受付開始の前に締切を入れてください（受付中は締切を空にできません）。',
      );
      // 最新の年度でも、作成の欄は出さずに最新の年度の管理者が作ると知らせる（開いている年度を開き直させない）
      expect(screen.queryByTestId('year-create-form')).toBeNull();
      expect(screen.getByTestId('year-create-unavailable').textContent).toBe('新しい年度は、最新の年度（R9）の管理者が作ります。');
      fireEvent.change(field(form, 'request_close_at'), { target: { value: '2027-07-10T18:00' } });
      await user.click(screen.getByRole('button', { name: '年度を保存' }));
      await waitFor(() => expect(rpc.callRpc).toHaveBeenCalledTimes(1));
      expect(rpc.callRpc).toHaveBeenCalledWith('update_year', { p_year_id: 'y9', p_patch: { request_close_at: '2027-07-10T18:00:00+09:00' } });
      await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('年度を保存しました'));
    });
  }
});
