// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
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
/** 今のパス（T16：ナビの aria-current を確かめる） */
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => router }));
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
  nav.pathname = '/';
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

  it('年度を切り替えると画面を作り直す（前の年度の入力を持ち越さない）。同じ年度の読み直しでは入力が残る（1.3.1）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = twoYears;
    const user = userEvent.setup();
    renderShell();
    const input = (await screen.findByLabelText('メモ')) as HTMLInputElement;
    await user.type(input, 'R9 の数');

    // 同じ年度の読み直し：同じ要素のまま入力が残る
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await vi.waitFor(() => expect(screen.getByTestId('refreshing').textContent).toBe('no'));
    expect(screen.getByLabelText('メモ')).toBe(input);
    expect(input.value).toBe('R9 の数');

    // 年度の切り替え（未保存の印はないので確かめない）：作り直されて空になる
    await user.selectOptions(screen.getByTestId('year-select'), 'y8');
    expect(screen.getByTestId('current-year').textContent).toBe('R8・終了');
    const after = screen.getByLabelText('メモ') as HTMLInputElement;
    expect(after).not.toBe(input);
    expect(after.value).toBe('');
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

describe('AppShell：ヘッダーの立場とナビ（T15b。04「共通レイアウト」）', () => {
  const navLabels = () => [...document.querySelectorAll('aside nav a')].map((a) => a.textContent);

  it('店長・副店長は「{団体名} の店長」「{団体名} の副店長」と出す（団体代表の立場）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({
      displayName: '代表',
      roles: [],
      groups: [
        { id: 'g2', name: '模擬店02', year_id: 'y8', role: 'deputy_manager' },
        { id: 'g1', name: '模擬店01', year_id: 'y8', role: 'manager' },
      ],
    });
    const user = userEvent.setup();
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByText('模擬店01 の店長・模擬店02 の副店長')).toBeTruthy();
    expect(navLabels()).toEqual(['ホーム', '申請', '自団体の振り分け', 'お知らせ一覧']);
    // スマホのメニュー（開いた形）にも同じ言い方
    await user.click(screen.getByRole('button', { name: 'メニューを開く' }));
    expect(document.getElementById('app-mobile-nav')?.textContent).toContain('代表（模擬店01 の店長・模擬店02 の副店長）');
  });

  it('管理者で店長も務める人は、ロールと団体の両方', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ groups: [{ id: 'g1', name: '模擬店01', year_id: 'y8', role: 'manager' }] });
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByText('管理者・模擬店01 の店長')).toBeTruthy();
    expect(navLabels()).toContain('自団体の振り分け');
    expect(navLabels()).toContain('マスタ設定');
  });

  it.each([
    ['head', '総務部門長'],
    ['deputy_head', '総務副部門長'],
  ] as const)('%s は表示名「%s」で、ナビは管理者と同じ（総務の画面すべて）', async (role, label) => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role }] });
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByText(label)).toBeTruthy();
    expect(navLabels()).toEqual([
      'ホーム',
      '机椅子の状況',
      '在庫入力',
      '在庫一覧',
      '申請一覧',
      'ルール',
      '振り分け',
      'キャスター机交換',
      'お知らせ一覧',
      'マスタ設定',
      '履歴',
    ]);
  });

  it('総務部門員は「総務部門員」で、在庫・申請一覧・振り分けだけ', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'staff' }] });
    renderShell();
    await screen.findByLabelText('メモ');
    expect(screen.getByText('総務部門員')).toBeTruthy();
    expect(navLabels()).toEqual(['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け', 'お知らせ一覧']);
  });
});

describe('T16 AppShell：見出しごとのナビ（04「共通レイアウト」、D-51・D-52）', () => {
  const aside = () => document.querySelector('aside') as HTMLElement;

  it('管理者：見出し「机椅子」「お知らせ」「共通」の group の中に項目が並ぶ。「ホーム」の見出しは見た目では出さない（sr-only）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({});
    renderShell();
    await screen.findByLabelText('メモ');
    const groups = within(aside()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      'ホーム',
      '机椅子',
      'お知らせ',
      '共通',
    ]);
    const furniture = within(aside()).getByRole('group', { name: '机椅子' });
    expect(within(furniture).getAllByRole('link').map((a) => a.textContent)).toEqual([
      '机椅子の状況',
      '在庫入力',
      '在庫一覧',
      '申請一覧',
      'ルール',
      '振り分け',
      'キャスター机交換',
    ]);
    const common = within(aside()).getByRole('group', { name: '共通' });
    expect(within(common).getAllByRole('link').map((a) => a.textContent)).toEqual(['マスタ設定', '履歴']);
    // T17：お知らせの見出し（見せる）に「お知らせ一覧」（見出しと同じ言葉を縦に並べない）
    const notices = within(aside()).getByRole('group', { name: 'お知らせ' });
    expect(within(notices).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['お知らせ一覧', '/notices']]);
    // 見出しは h2。「ホーム」だけ sr-only（項目が「ホーム」1つなので同じ言葉を2つ並べない）
    const heads = within(aside()).getAllByRole('heading', { level: 2 });
    expect(heads.map((h) => [h.textContent, h.classList.contains('sr-only')])).toEqual([
      ['ホーム', true],
      ['机椅子', false],
      ['お知らせ', false],
      ['共通', false],
    ]);
  });

  it('listitem はリンクだけ（見出しを listitem にしない。E2E の navLabels が平らな一覧を返す）', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'head' }] });
    renderShell();
    await screen.findByLabelText('メモ');
    const items = within(aside()).getAllByRole('listitem');
    for (const li of items) expect(within(li).getAllByRole('link')).toHaveLength(1);
    expect(items.map((li) => li.textContent)).toEqual([
      'ホーム',
      '机椅子の状況',
      '在庫入力',
      '在庫一覧',
      '申請一覧',
      'ルール',
      '振り分け',
      'キャスター机交換',
      'お知らせ一覧',
      'マスタ設定',
      '履歴',
    ]);
  });

  it('総務部門員は「共通」の見出しがない。店長は「机椅子」の見出しに申請・自団体の振り分け', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'staff' }] });
    renderShell();
    await screen.findByLabelText('メモ');
    expect(within(aside()).queryByRole('group', { name: '共通' })).toBeNull();
    expect(within(within(aside()).getByRole('group', { name: '机椅子' })).getAllByRole('link')[0]?.textContent).toBe('机椅子の状況');
    cleanup();

    fakeAuth.reset();
    fakeAuth.session = { user: { id: 'u2' } };
    fakeAuth.sources.u2 = sourceOf({ roles: [], groups: [{ id: 'g1', name: '模擬店01', year_id: 'y8', role: 'manager' }] });
    renderShell();
    await screen.findByLabelText('メモ');
    expect(within(aside()).getAllByRole('group').length).toBe(3);
    expect(within(within(aside()).getByRole('group', { name: '机椅子' })).getAllByRole('link').map((a) => a.textContent)).toEqual([
      '申請',
      '自団体の振り分け',
    ]);
    expect(within(within(aside()).getByRole('group', { name: 'お知らせ' })).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'お知らせ一覧',
    ]);
  });

  it('/furniture/ を開いていれば「机椅子の状況」に aria-current="page"（ホームにはつかない）。スマホのメニューも見出しごと', async () => {
    nav.pathname = '/furniture/';
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({ roles: [{ year_id: 'y8', role: 'staff' }] });
    const user = userEvent.setup();
    renderShell();
    await screen.findByLabelText('メモ');
    const current = within(aside()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['机椅子の状況']);

    await user.click(screen.getByRole('button', { name: 'メニューを開く' }));
    const mobile = document.getElementById('app-mobile-nav')!;
    const group = within(mobile).getByRole('group', { name: '机椅子' });
    expect(within(group).getByRole('link', { name: '机椅子の状況' }).getAttribute('aria-current')).toBe('page');
    // PC の左とスマホのメニューで見出しの id が重ならない
    const ids = [...document.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('T16 AppShell：アプリの名前（D-51）', () => {
  it('ヘッダーの名前は「電波祭 総務」（スマホの幅では「電波祭 」を隠して「総務」）。「机椅子管理」は出さない', async () => {
    fakeAuth.session = { user: { id: 'u1' } };
    fakeAuth.sources.u1 = sourceOf({});
    renderShell();
    await screen.findByLabelText('メモ');
    const name = screen.getByTestId('app-name');
    expect(name.textContent).toBe('電波祭 総務');
    const prefix = [...name.querySelectorAll('span')].find((x) => x.textContent === '電波祭 ');
    expect(prefix?.className).toContain('hidden');
    expect(prefix?.className).toContain('sm:inline');
    expect(document.body.textContent).not.toContain('机椅子管理');
  });
});
