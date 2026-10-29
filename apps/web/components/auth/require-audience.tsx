'use client';

import { ForbiddenState, LoadingState } from '@/components/states';
import { useAuth } from '@/lib/auth/auth-provider';
import { hasAudience, type Audience } from '@/lib/auth/membership';

/**
 * 画面ごとの権限の出し分け。立場を読み込み中なら「読み込み中」、立場が合わなければ「権限がありません」を出す。
 * 見せ方の切り替えであって守りではない（データは RLS と RPC が守る）。AppShell の中で使う。
 */
export function RequireAudience({ allow, children }: { allow: readonly Audience[]; children: React.ReactNode }) {
  const { membership } = useAuth();
  if (membership.status === 'idle' || membership.status === 'loading') {
    return <LoadingState />;
  }
  if (membership.status !== 'ready' || !hasAudience(membership.membership, allow)) {
    return <ForbiddenState />;
  }
  return <>{children}</>;
}
