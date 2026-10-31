// @vitest-environment jsdom
// ユーザーのタブ（T15b。04「マスタ設定」のユーザーの表・D-50）：招待の立場は段ごと（管理者は7つ、総務部門長・総務副部門長は
// 総務部門員・店長・副店長）、店長・副店長の招待は団体と立場を送る、兼任の禁止・別のロール・別の立場は立場の欄の下に出す、
// ロールの変更は管理者だけ（兼任の禁止はダイアログの中）、ロールを外すのは manageableRoles、店長⇄副店長と代表を外すのは部門長以上、
// 招待の取り消しは canRevokeInvitation、終了した年度の出し分け。
// RPC は本物の callRpc（引数の zod と、エラーの分類・文言）を通し、Supabase の rpc だけを差し替える。
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { InvitationRow, MemberRow } from '@/lib/data/settings';
import type { GroupRow, YearRow } from '@/lib/db/types';
import { fakeAuth, sourceOf } from '@/lib/testing/fake-auth';
import { TestProviders } from '@/lib/testing/providers';
import { SettingsContext, type SettingsContextValue } from './shared';
import { UsersTab } from './users-tab';

type RpcResult = { data?: unknown; error?: unknown; status?: number };
const rpcState = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  handler: null as null | ((name: string, args: unknown) => RpcResult),
}));

vi.mock('@/lib/supabase/client', async () => {
  const m = (await import('@/lib/testing/fake-auth')).supabaseClientModule;
  return {
    ...m,
    getSupabase: () => ({
      ...m.getSupabase(),
      rpc: async (name: string, args: unknown) => {
        rpcState.calls.push({ name, args });
        const r = rpcState.handler ? rpcState.handler(name, args) : { data: null };
        return { data: r.data ?? null, error: r.error ?? null, status: r.status ?? (r.error ? 400 : 200) };
      },
    }),
  };
});
vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/',
  useSearchParams: () => new URLSearchParams('tab=users'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

const data = vi.hoisted(() => ({ fetchMembers: vi.fn(), fetchGroups: vi.fn() }));
vi.mock('@/lib/data/settings', async (orig) => ({ ...(await orig<typeof import('@/lib/data/settings')>()), ...data }));

const YEAR = '00000000-0000-4000-8000-0000000000f9';
const G1 = '00000000-0000-4000-8000-0000000000c1';
const G2 = '00000000-0000-4000-8000-0000000000c2';
const U = {
  admin: '00000000-0000-4000-8000-0000000000d1',
  head: '00000000-0000-4000-8000-0000000000d2',
  staff: '00000000-0000-4000-8000-0000000000d3',
  viewer: '00000000-0000-4000-8000-0000000000d4',
  rep: '00000000-0000-4000-8000-0000000000d5',
};
const INV = {
  staff: '00000000-0000-4000-8000-0000000000e1',
  group: '00000000-0000-4000-8000-0000000000e2',
  admin: '00000000-0000-4000-8000-0000000000e3',
  used: '00000000-0000-4000-8000-0000000000e4',
};
const T0 = '2026-10-29T01:00:00.000001+00:00';

const year = { id: YEAR, label: 'R9', status: 'preparing', festival_start: '2027-10-16', updated_at: T0 } as unknown as YearRow;
const group = (id: string, name: string, category: GroupRow['category']) => ({ id, year_id: YEAR, name, category }) as unknown as GroupRow;

const MEMBERS: MemberRow[] = [
  { userId: U.admin, displayName: 'テスト管理者', role: 'admin', roleUpdatedAt: T0, groups: [] },
  { userId: U.head, displayName: 'テスト部門長', role: 'head', roleUpdatedAt: T0, groups: [] },
  { userId: U.staff, displayName: 'テスト部門員', role: 'staff', roleUpdatedAt: T0, groups: [] },
  { userId: U.viewer, displayName: 'テスト閲覧', role: 'viewer', roleUpdatedAt: T0, groups: [{ id: G1, name: '模擬店A', role: 'manager' }] },
  { userId: U.rep, displayName: 'テスト副店長', role: null, roleUpdatedAt: null, groups: [{ id: G1, name: '模擬店A', role: 'deputy_manager' }] },
];
const invitation = (id: string, over: Partial<InvitationRow>): InvitationRow => ({
  id,
  email: 'x@example.test',
  role: null,
  groupId: null,
  groupRole: null,
  usedAt: null,
  createdAt: T0,
  ...over,
});
const INVITATIONS: InvitationRow[] = [
  invitation(INV.staff, { email: 'new-staff@example.test', role: 'staff' }),
  invitation(INV.group, { email: 'new-rep@example.test', groupId: G2, groupRole: 'deputy_manager' }),
  // 部門長・副部門長には RLS が返さない招待（画面の守りの確かめに混ぜる）
  invitation(INV.admin, { email: 'new-admin@example.test', role: 'admin' }),
  invitation(INV.used, { email: 'used-staff@example.test', role: 'staff', usedAt: T0 }),
];

const OVERLAP = '総務の部門員・部門長・副部門長は、同じ年度の団体の店長・副店長を兼ねられません（管理者と閲覧のみは兼ねられます）';
const p0001 = (message: string, details: unknown) => ({ error: { code: 'P0001', message, details: JSON.stringify(details), hint: null } });

function renderTab(role: AppRole, opts: { closed?: boolean } = {}) {
  const value: SettingsContextValue = {
    year: (opts.closed ? { ...year, status: 'closed' } : year) as YearRow,
    membership: { role, years: [], groups: [], adminOfOpenYear: role === 'admin', latestYear: null } as unknown as Membership,
    yearWritable: !opts.closed,
    globalWritable: !opts.closed && role === 'admin',
  };
  return render(
    <TestProviders>
      <SettingsContext.Provider value={value}>
        <UsersTab />
      </SettingsContext.Provider>
    </TestProviders>,
  );
}

/** メンバーの表の行（data-row-id は userId） */
async function memberRow(userId: string): Promise<HTMLElement> {
  await screen.findByRole('table', { name: 'メンバー' });
  const row = document.querySelector(`[data-row-id="${userId}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`行がない：${userId}`);
  return row;
}
async function invitationRow(id: string): Promise<HTMLElement> {
  await screen.findByRole('table', { name: '招待' });
  const row = document.querySelector(`[data-row-id="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`行がない：${id}`);
  return row;
}

const kindSelect = () => within(screen.getByTestId('invite-form')).getByLabelText('立場') as HTMLSelectElement;
const optionLabels = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);

/** 招待のフォームに入れて送る（団体は店長・副店長のときだけ選ぶ） */
async function invite(user: ReturnType<typeof userEvent.setup>, email: string, kind: string, groupName?: string) {
  const form = screen.getByTestId('invite-form');
  await user.selectOptions(kindSelect(), kind);
  if (groupName) {
    await user.click(within(form).getByRole('combobox', { name: '団体' }));
    await user.click(await screen.findByRole('option', { name: groupName }));
  }
  const email$ = within(form).getByLabelText('メールアドレス');
  await user.clear(email$);
  await user.type(email$, email);
  await user.click(within(form).getByRole('button', { name: '招待する' }));
}

// jsdom にないもの（Radix の Popover・cmdk が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

beforeEach(() => {
  fakeAuth.reset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fakeAuth.session = { user: { id: U.head } };
  fakeAuth.sources[U.head] = sourceOf({
    years: [{ id: YEAR, label: 'R9', status: 'preparing', festival_start: '2027-10-16' }],
    roles: [{ year_id: YEAR, role: 'head' }],
  });
  for (const f of [data.fetchMembers, data.fetchGroups, toasts.success, toasts.error, toasts.info]) f.mockReset();
  rpcState.calls = [];
  rpcState.handler = null;
  data.fetchMembers.mockResolvedValue({ members: MEMBERS, invitations: INVITATIONS, repCount: new Map() });
  data.fetchGroups.mockResolvedValue([group(G1, '模擬店A', 'stall'), group(G2, '部門B', 'department')]);
});
afterEach(() => cleanup());

describe('招待の立場（段ごと。D-50）', () => {
  it('管理者は7つ（管理者・総務部門長・総務副部門長・総務部門員・閲覧のみ・店長・副店長）。既定は総務部門員', async () => {
    renderTab('admin');
    await screen.findByTestId('invite-form');
    expect(optionLabels(kindSelect())).toEqual(['管理者', '総務部門長', '総務副部門長', '総務部門員', '閲覧のみ', '店長', '副店長']);
    expect([...kindSelect().options].map((o) => o.value)).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer', 'manager', 'deputy_manager']);
    expect(kindSelect().value).toBe('staff');
  });

  for (const role of ['head', 'deputy_head'] as const) {
    it(`${role} は総務部門員・店長・副店長の3つ（ほかの立場とロールの変更は管理者が行うと添える）`, async () => {
      renderTab(role);
      await screen.findByTestId('invite-form');
      expect(optionLabels(kindSelect())).toEqual(['総務部門員', '店長', '副店長']);
      expect(kindSelect().value).toBe('staff');
      const hint = document.getElementById(kindSelect().getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent).toBe('管理者・総務部門長・総務副部門長・閲覧のみの招待と、ロールの変更は管理者が行います');
    });
  }

  it('管理者には立場の欄の注を出さない', async () => {
    renderTab('admin');
    await screen.findByTestId('invite-form');
    expect(kindSelect().getAttribute('aria-describedby')).toBeNull();
  });

  it('店長・副店長の招待がその場で付いたら、付いた立場（「{団体} の副店長」）で知らせる', async () => {
    rpcState.handler = () => ({ data: { invitation_ids: [INV.group], applied: true } });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'rep-now@example.test', 'deputy_manager', '模擬店A');
    expect((await screen.findByTestId('invite-result')).textContent).toBe('この人はすでにアカウントがあるので、その場で「模擬店A の副店長」にしました');
  });

  it('店長・副店長を選ぶと団体の欄が出て、送るのは団体と立場（ロールは送らない）。送った後も同じ立場と団体を残す', async () => {
    rpcState.handler = () => ({ data: { invitation_ids: [INV.group], applied: false } });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    expect(within(screen.getByTestId('invite-form')).queryByRole('combobox', { name: '団体' })).toBeNull();
    await invite(user, ' New-Rep@Example.Test ', 'deputy_manager', '模擬店A');
    await waitFor(() => expect(rpcState.calls).toHaveLength(1));
    expect(rpcState.calls[0]).toEqual({
      name: 'invite',
      args: { p_year_id: YEAR, p_email: 'new-rep@example.test', p_group_id: G1, p_group_role: 'deputy_manager' },
    });
    expect(await screen.findByTestId('invite-result')).toHaveProperty(
      'textContent',
      '招待しました。この人が学校の Google アカウントでログインしたときに付きます',
    );
    expect(kindSelect().value).toBe('deputy_manager');
    expect(within(screen.getByTestId('invite-form')).getByRole('combobox', { name: '団体' }).textContent).toBe('模擬店A');
    expect((within(screen.getByTestId('invite-form')).getByLabelText('メールアドレス') as HTMLInputElement).value).toBe('');
    // 一覧を読み直す
    await waitFor(() => expect(data.fetchMembers).toHaveBeenCalledTimes(2));
  });

  it('ロールの招待は p_role だけを送る（前に選んだ団体は送らない）', async () => {
    rpcState.handler = () => ({ data: { invitation_ids: [INV.staff], applied: true } });
    const user = userEvent.setup();
    renderTab('admin');
    await screen.findByTestId('invite-form');
    await user.selectOptions(kindSelect(), 'manager');
    await user.click(within(screen.getByTestId('invite-form')).getByRole('combobox', { name: '団体' }));
    await user.click(await screen.findByRole('option', { name: '部門B' }));
    await invite(user, 'new-head@example.test', 'head');
    await waitFor(() => expect(rpcState.calls).toHaveLength(1));
    expect(rpcState.calls[0]!.args).toEqual({ p_year_id: YEAR, p_email: 'new-head@example.test', p_role: 'head' });
    expect((await screen.findByTestId('invite-result')).textContent).toBe('この人はすでにアカウントがあるので、その場でロールを付けました');
  });

  it('店長・副店長で団体を選んでいなければ送らずに「団体を選んでください」', async () => {
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'new-rep@example.test', 'manager');
    expect(await screen.findByText('団体を選んでください')).toBeTruthy();
    expect(rpcState.calls).toEqual([]);
  });
});

describe('招待のエラーは立場の欄の下（入力は残す。04）', () => {
  it('兼任の禁止（role_overlap）：文言を立場の欄の下に出し、メールと立場を残して、一覧を読み直す（toast は出さない）', async () => {
    rpcState.handler = () => p0001('role_overlap', { year_id: YEAR, user_id: U.rep, reason: 'current_membership' });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'rep-member@example.test', 'staff');
    expect((await screen.findByTestId('invite-kind-error')).textContent).toBe(OVERLAP);
    expect((within(screen.getByTestId('invite-form')).getByLabelText('メールアドレス') as HTMLInputElement).value).toBe('rep-member@example.test');
    expect(kindSelect().value).toBe('staff');
    expect(kindSelect().getAttribute('aria-invalid')).toBe('true');
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId('invite-result')).toBeNull();
    await waitFor(() => expect(data.fetchMembers).toHaveBeenCalledTimes(2));

    // 別のメールを入れ始めたら、前のメールの誤りは消す（立場はそのまま）
    await user.type(within(screen.getByTestId('invite-form')).getByLabelText('メールアドレス'), 'x');
    expect(screen.queryByTestId('invite-kind-error')).toBeNull();
    expect(kindSelect().value).toBe('staff');
  });

  it('兼任の禁止（団体の招待。未使用の総務部門員の招待がある）も同じ', async () => {
    rpcState.handler = () => p0001('role_overlap', { year_id: YEAR, reason: 'pending_invitation' });
    const user = userEvent.setup();
    renderTab('admin');
    await screen.findByTestId('invite-form');
    await invite(user, 'new-staff@example.test', 'manager', '模擬店A');
    expect((await screen.findByTestId('invite-kind-error')).textContent).toBe(OVERLAP);
    expect(kindSelect().value).toBe('manager');
  });

  it('別のロールを持つ（conflict の field: role）：部門長・副部門長は「管理者に頼んでください」、管理者は「メンバーの一覧から」', async () => {
    rpcState.handler = () => p0001('conflict', { field: 'role', current: 'viewer' });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'viewer@example.test', 'staff');
    expect((await screen.findByTestId('invite-kind-error')).textContent).toBe(
      'この人はすでに「閲覧のみ」です。ロールの変更は管理者に頼んでください',
    );
    cleanup();

    renderTab('admin');
    await screen.findByTestId('invite-form');
    await invite(user, 'viewer@example.test', 'staff');
    expect((await screen.findByTestId('invite-kind-error')).textContent).toBe('この人はすでに「閲覧のみ」です。ロールの変更はメンバーの一覧から');
  });

  it('同じ団体に別の立場でいる（conflict の field: group_role）：今の立場と、切り替えはメンバーの一覧から', async () => {
    rpcState.handler = () => p0001('conflict', { field: 'group_role', current: 'deputy_manager' });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'rep@example.test', 'manager', '模擬店A');
    expect((await screen.findByTestId('invite-kind-error')).textContent).toBe(
      'この人はすでにこの団体の副店長です。店長・副店長の切り替えはメンバーの一覧から',
    );
    expect(kindSelect().value).toBe('manager');
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('権限なし（forbidden）は今までどおり toast。部門長・副部門長には、管理者の未使用の招待があるメールかもしれないと添える', async () => {
    rpcState.handler = () => ({ error: { code: 'P0001', message: 'forbidden', details: '', hint: null } });
    const user = userEvent.setup();
    renderTab('head');
    await screen.findByTestId('invite-form');
    await invite(user, 'pending-admin@example.test', 'staff');
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        '権限がありません。このメールアドレスに管理者が出した招待があるか、立場が変わった可能性があります（管理者に頼んでください）',
      ),
    );
    expect(screen.queryByTestId('invite-kind-error')).toBeNull();
    cleanup();
    toasts.error.mockClear();

    renderTab('admin');
    await screen.findByTestId('invite-form');
    await invite(user, 'pending-admin@example.test', 'staff');
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('権限がありません。立場が変わった可能性があります'));
  });
});

describe('メンバーの一覧（段ごとの操作）', () => {
  it('ロールの表示名と「{団体} の店長」「{団体} の副店長」を出す', async () => {
    renderTab('admin');
    expect(within(await memberRow(U.head)).getByText('総務部門長')).toBeTruthy();
    expect(within(await memberRow(U.staff)).getByText('総務部門員')).toBeTruthy();
    expect(within(await memberRow(U.viewer)).getByTestId('member-position').textContent).toContain('模擬店A の店長');
    expect(within(await memberRow(U.rep)).getByTestId('member-position').textContent).toContain('模擬店A の副店長');
    expect(screen.getByRole('columnheader', { name: '店長・副店長' })).toBeTruthy();
  });

  it('管理者：ロールを変える・外すは、ロールのある人すべて。店長⇄副店長と代表を外すも出る', async () => {
    renderTab('admin');
    for (const id of [U.admin, U.head, U.staff, U.viewer]) {
      const row = await memberRow(id);
      expect(within(row).getByRole('button', { name: 'ロールを変える' })).toBeTruthy();
      expect(within(row).getByRole('button', { name: 'ロールを外す' })).toBeTruthy();
    }
    const rep = await memberRow(U.rep);
    expect(within(rep).queryByRole('button', { name: 'ロールを変える' })).toBeNull();
    expect(within(rep).getByRole('button', { name: '店長にする' })).toBeTruthy();
    expect(within(await memberRow(U.viewer)).getByRole('button', { name: '副店長にする' })).toBeTruthy();
  });

  for (const role of ['head', 'deputy_head'] as const) {
    it(`${role}：「ロールを変える」はなく、「ロールを外す」は総務部門員の行だけ。店長⇄副店長と代表を外すは出る`, async () => {
      renderTab(role);
      await memberRow(U.staff);
      expect(screen.queryAllByRole('button', { name: 'ロールを変える' })).toEqual([]);
      expect(screen.getAllByRole('button', { name: 'ロールを外す' })).toHaveLength(1);
      expect(within(await memberRow(U.staff)).getByRole('button', { name: 'ロールを外す' })).toBeTruthy();
      expect(within(await memberRow(U.viewer)).getByRole('button', { name: '副店長にする' })).toBeTruthy();
      expect(within(await memberRow(U.viewer)).getByRole('button', { name: '代表を外す' })).toBeTruthy();
      expect(within(await memberRow(U.rep)).getByRole('button', { name: '店長にする' })).toBeTruthy();
    });
  }

  it('「副店長にする」：確かめのダイアログ（できることは同じ）から set_group_member_role を送り、一覧と立場を読み直す', async () => {
    rpcState.handler = () => ({ data: null });
    const user = userEvent.setup();
    renderTab('head');
    await user.click(within(await memberRow(U.viewer)).getByRole('button', { name: '副店長にする' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('テスト閲覧を「模擬店A」の副店長にしますか');
    expect(dialog.textContent).toContain('店長と副店長は、できることが同じです（表示だけが変わります）。');
    await user.type(within(dialog).getByLabelText('理由（任意）'), '本人の希望');
    await user.click(within(dialog).getByRole('button', { name: '副店長にする' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcState.calls).toEqual([
      { name: 'set_group_member_role', args: { p_group_id: G1, p_user_id: U.viewer, p_group_role: 'deputy_manager', p_reason: '本人の希望' } },
    ]);
    expect(toasts.success).toHaveBeenCalledWith('テスト閲覧を「模擬店A」の副店長にしました');
    await waitFor(() => expect(data.fetchMembers).toHaveBeenCalledTimes(2));
  });

  it('「店長にする」：副店長を店長にする（理由なし）', async () => {
    rpcState.handler = () => ({ data: null });
    const user = userEvent.setup();
    renderTab('deputy_head');
    await user.click(within(await memberRow(U.rep)).getByRole('button', { name: '店長にする' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('テスト副店長を「模擬店A」の店長にしますか');
    await user.click(within(dialog).getByRole('button', { name: '店長にする' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcState.calls[0]!.args).toEqual({ p_group_id: G1, p_user_id: U.rep, p_group_role: 'manager' });
    expect(toasts.success).toHaveBeenCalledWith('テスト副店長を「模擬店A」の店長にしました');
  });

  it('「代表を外す」：題と知らせは立場の名前（副店長）', async () => {
    rpcState.handler = () => ({ data: null });
    const user = userEvent.setup();
    renderTab('head');
    await user.click(within(await memberRow(U.rep)).getByRole('button', { name: '代表を外す' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('テスト副店長を「模擬店A」の副店長から外しますか');
    await user.click(within(dialog).getByRole('button', { name: '外す' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcState.calls).toEqual([{ name: 'remove_group_member', args: { p_group_id: G1, p_user_id: U.rep } }]);
    expect(toasts.success).toHaveBeenCalledWith('「模擬店A」の副店長から外しました');
  });

  it('「ロールを外す」の説明は段で違う（部門長・副部門長は総務部門員の招待だけを取り消す）', async () => {
    const user = userEvent.setup();
    renderTab('head');
    await user.click(within(await memberRow(U.staff)).getByRole('button', { name: 'ロールを外す' }));
    expect((await screen.findByRole('dialog')).textContent).toContain(
      'この年度の画面を開けなくなります。この人あての未使用の総務部門員の招待も取り消します。',
    );
    cleanup();

    renderTab('admin');
    await user.click(within(await memberRow(U.viewer)).getByRole('button', { name: 'ロールを外す' }));
    expect((await screen.findByRole('dialog')).textContent).toContain(
      'この年度の画面を開けなくなります（店長・副店長は残ります）。この人あての未使用のロールの招待も取り消します。',
    );
  });

  it('ロールの変更（管理者）：5つのロールから選び、兼任の禁止はダイアログの中に出して閉じない（選び直すと消える）', async () => {
    rpcState.handler = (name) =>
      name === 'set_role' ? p0001('role_overlap', { year_id: YEAR, user_id: U.viewer }) : { data: null };
    const user = userEvent.setup();
    renderTab('admin');
    await user.click(within(await memberRow(U.viewer)).getByRole('button', { name: 'ロールを変える' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('新しいロール') as HTMLSelectElement;
    expect(optionLabels(select)).toEqual(['管理者', '総務部門長', '総務副部門長', '総務部門員', '閲覧のみ']);
    await user.selectOptions(select, 'staff');
    await user.click(within(dialog).getByRole('button', { name: '変える' }));
    expect((await within(dialog).findByTestId('role-dialog-error')).textContent).toBe(OVERLAP);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(select.value).toBe('staff');
    expect(rpcState.calls).toEqual([{ name: 'set_role', args: { p_year_id: YEAR, p_user_id: U.viewer, p_role: 'staff' } }]);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    await user.selectOptions(select, 'admin');
    expect(within(dialog).queryByTestId('role-dialog-error')).toBeNull();
  });
});

describe('招待の一覧', () => {
  it('「立場」はロールの表示名か「{団体} の副店長」。管理者はすべての未使用の招待を取り消せる', async () => {
    renderTab('admin');
    expect(within(await screen.findByRole('table', { name: '招待' })).getByRole('columnheader', { name: '立場' })).toBeTruthy();
    expect(within(await invitationRow(INV.staff)).getByText('総務部門員')).toBeTruthy();
    expect(within(await invitationRow(INV.group)).getByText('部門B の副店長')).toBeTruthy();
    for (const id of [INV.staff, INV.group, INV.admin]) {
      expect(within(await invitationRow(id)).getByRole('button', { name: '取り消す' })).toBeTruthy();
    }
    expect(within(await invitationRow(INV.used)).queryByRole('button', { name: '取り消す' })).toBeNull();
  });

  it('部門長・副部門長は総務部門員と団体の招待だけを取り消せる（RLS が返さない招待が来ても出さない）', async () => {
    renderTab('head');
    expect(within(await invitationRow(INV.staff)).getByRole('button', { name: '取り消す' })).toBeTruthy();
    expect(within(await invitationRow(INV.group)).getByRole('button', { name: '取り消す' })).toBeTruthy();
    expect(within(await invitationRow(INV.admin)).queryByRole('button', { name: '取り消す' })).toBeNull();
    // メールはこの画面（招待の一覧）に出す
    expect(within(await invitationRow(INV.group)).getByText('new-rep@example.test')).toBeTruthy();
  });
});

describe('終了した年度', () => {
  it('招待・ロールの変更・店長⇄副店長は出さず、ロールを外す・代表を外す・招待の取り消しは出す', async () => {
    renderTab('head', { closed: true });
    expect((await screen.findByTestId('users-closed-note')).textContent).toBe(
      '終了した年度では、招待、ロールの変更、店長・副店長の切り替えはできません（外す・取り消しはできます）。',
    );
    expect(screen.queryByTestId('invite-form')).toBeNull();
    await memberRow(U.viewer);
    expect(screen.queryAllByRole('button', { name: '副店長にする' })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: '店長にする' })).toEqual([]);
    expect(within(await memberRow(U.viewer)).getByRole('button', { name: '代表を外す' })).toBeTruthy();
    expect(within(await memberRow(U.staff)).getByRole('button', { name: 'ロールを外す' })).toBeTruthy();
    expect(within(await invitationRow(INV.staff)).getByRole('button', { name: '取り消す' })).toBeTruthy();
    cleanup();

    renderTab('admin', { closed: true });
    await memberRow(U.viewer);
    expect(screen.queryAllByRole('button', { name: 'ロールを変える' })).toEqual([]);
    expect(screen.getAllByRole('button', { name: 'ロールを外す' })).toHaveLength(4);
  });
});
