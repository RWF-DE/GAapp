'use client';

import { ForbiddenState, LoadingState } from '@/components/states';
import { useAuth } from '@/lib/auth/auth-provider';
import { hasAudience, type Audience } from '@/lib/auth/membership';
import { audiencesFor } from '@/lib/navigation';

/**
 * 画面ごとの権限の出し分け。立場を読み込み中なら「読み込み中」、立場が合わなければ「権限がありません」を出す。
 * 見せ方の切り替えであって守りではない（データは RLS と RPC が守る）。AppShell の中で使う。
 *
 * 立場は `href`（lib/navigation.ts の表から、開いている年度の状態も見て引く。T09a）か `allow` で渡す。
 * 立場の読み直しの間（isRefreshing）は前の立場のまま中身を出し続ける（画面を外さない）。
 *
 * @example
 * <RequireAudience href="/allocation">…</RequireAudience>   // viewer は確定後だけ（Q1）
 * <RequireAudience allow={['admin']}>…</RequireAudience>
 */
export function RequireAudience({
  allow,
  href,
  children,
}: {
  allow?: readonly Audience[];
  href?: string;
  children: React.ReactNode;
}) {
  const { membership } = useAuth();
  if (membership.status === 'idle' || membership.status === 'loading') {
    return <LoadingState />;
  }
  if (membership.status !== 'ready') return <ForbiddenState />;
  const m = membership.membership;
  const allowed = href ? audiencesFor(href, m.year?.status) : (allow ?? []);
  if (!hasAudience(m, allowed)) return <ForbiddenState />;
  return <>{children}</>;
}
