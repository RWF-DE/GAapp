import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '@/components/states';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { Membership } from '@/lib/auth/membership';
import { RequireAudience } from './require-audience';

// useAuth だけを差し替える（AuthProvider は Supabase に接続するため）
const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({ session: { status: 'loading' }, membership: auth.membership, reloadMembership: () => {}, signOut: async () => {} }),
}));

const year = { id: 'y1', label: 'R8', status: 'requesting', festival_start: '2026-10-17' } as const;
const member = (m: Partial<Membership>): MembershipState => ({
  status: 'ready',
  membership: { displayName: 'テスト', year, role: null, groups: [], ...m },
});
const render = (allow: Parameters<typeof RequireAudience>[0]['allow']) =>
  renderToStaticMarkup(
    <RequireAudience allow={allow}>
      <p>中身</p>
    </RequireAudience>,
  );

describe('RequireAudience', () => {
  beforeEach(() => {
    auth.membership = { status: 'idle' };
  });

  it('立場が合えば中身を出す', () => {
    auth.membership = member({ role: 'admin' });
    expect(render(['admin'])).toBe('<p>中身</p>');
  });
  it('立場が合わなければ「権限がありません」を出し、中身は出さない', () => {
    auth.membership = member({ role: 'staff' });
    const html = render(['admin']);
    expect(html).toContain('権限がありません');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('中身');
  });
  it('団体代表は rep で判定する（ロールがなくても団体があれば通る）', () => {
    auth.membership = member({ groups: [{ id: 'g1', name: 'テスト団体', year_id: 'y1' }] });
    expect(render(['rep'])).toBe('<p>中身</p>');
    expect(render(['admin', 'staff'])).toContain('権限がありません');
  });
  it('招待されていない（年度がない）なら「権限がありません」', () => {
    auth.membership = member({ year: null });
    expect(render(['admin', 'staff', 'viewer', 'rep'])).toContain('権限がありません');
  });
  it.each(['idle', 'loading'] as const)('立場を読み込み中（%s）なら「読み込み中」を出し、「権限がありません」は出さない', (status) => {
    auth.membership = { status };
    const html = render(['admin']);
    expect(html).toContain('読み込み中');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('権限がありません');
    expect(html).not.toContain('中身');
  });
  it('立場を読めなかったら中身を出さない', () => {
    auth.membership = { status: 'error', message: '利用者の情報を読み込めませんでした。' };
    expect(render(['admin'])).not.toContain('中身');
  });
});

describe('3状態の部品', () => {
  it('LoadingState は role="status" で文言を出す（文言は変えられる）', () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain('読み込み中…');
    expect(renderToStaticMarkup(<LoadingState label="在庫を読み込み中…" />)).toContain('在庫を読み込み中…');
    expect(renderToStaticMarkup(<LoadingState />)).toContain('role="status"');
  });
  it('EmptyState は既定の文言と、説明・操作を出す', () => {
    expect(renderToStaticMarkup(<EmptyState />)).toContain('データがありません');
    const html = renderToStaticMarkup(
      <EmptyState title="申請はまだありません" description="受付が始まると表示されます" action={<button>追加</button>} />,
    );
    expect(html).toContain('申請はまだありません');
    expect(html).toContain('受付が始まると表示されます');
    expect(html).toContain('<button>追加</button>');
    expect(html).not.toContain('role=');
  });
  it('ForbiddenState は role="alert" で「権限がありません」と説明を出す', () => {
    const html = renderToStaticMarkup(<ForbiddenState />);
    expect(html).toContain('権限がありません');
    expect(html).toContain('総務の管理者に確認してください');
    expect(html).toContain('role="alert"');
  });
  it('ErrorState は再試行があるときだけボタンを出す', () => {
    expect(renderToStaticMarkup(<ErrorState message="読み込めませんでした" />)).not.toContain('もう一度読み込む');
    expect(renderToStaticMarkup(<ErrorState message="読み込めませんでした" onRetry={() => {}} />)).toContain('もう一度読み込む');
  });
});
