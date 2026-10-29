'use client';

import { RequireAudience } from '@/components/auth/require-audience';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/states';
import { routeFor } from '@/lib/navigation';

/**
 * 雛形のページ（画面の設計 1.1。T09a）。立場は lib/navigation.ts の表で守り、「この画面は準備中です（T10）」と担当のチケットを出す。
 * 各チケットは page.tsx をこの部品から自分の画面の部品に置き換える。
 */
export function PlaceholderPage({ href }: { href: string }) {
  const route = routeFor(href);
  if (!route) throw new Error(`lib/navigation.ts の ROUTES にない: ${href}`);
  return (
    <RequireAudience href={href}>
      <PageHeader title={route.label} />
      <EmptyState
        title={`この画面は準備中です（${route.ticket}）`}
        description="できあがるまで、ほかの画面を使ってください。"
        className="rounded-lg border border-dashed"
      />
    </RequireAudience>
  );
}
