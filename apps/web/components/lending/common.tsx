'use client';

// テント等の貸し出しの画面（/lending・/lending/records）で使う小さな部品（T21・D-57）。申請のタブ（/request）の最初に読む JS には
// 入れない（request-tabs.tsx は読まない）。
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { LendingGroup } from '@/lib/modules/lending/queries';
import { NO_LOCATION_TEXT } from '@/lib/modules/lending/labels';
import { cn } from '@/lib/utils';

/** 団体の表示名（表示名がなければ名前） */
export function groupDisplayName(g: Pick<LendingGroup, 'name' | 'display_name'>): string {
  return g.display_name?.trim() || g.name;
}

/** 使用場所（なければ「校内に分散」）と、屋外の場所（場所の種類が outdoor）なら「屋外」の印 */
export function GroupPlace({ group, className }: { group: Pick<LendingGroup, 'location'>; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground', className)}>
      <span>{group.location?.name ?? NO_LOCATION_TEXT}</span>
      {group.location?.kind === 'outdoor' ? (
        <Badge variant="outline" data-testid="lending-outdoor" className="px-1 py-0 text-[10px]">
          屋外
        </Badge>
      ) : null}
    </span>
  );
}

/** 帯（読むだけ・確定中などの説明）。testid は帯ごと */
export function LendingNotice({ testId, children, tone = 'muted' }: { testId: string; children: React.ReactNode; tone?: 'muted' | 'info' | 'warn' }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-md border px-4 py-2 text-sm print:hidden',
        tone === 'muted' && 'bg-muted/50 text-muted-foreground',
        tone === 'info' && 'border-sky-300 bg-sky-50 text-sky-950',
        tone === 'warn' && 'border-amber-300 bg-amber-50 text-amber-950',
      )}
    >
      {tone === 'muted' ? <Lock aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <span>{children}</span>
    </div>
  );
}
