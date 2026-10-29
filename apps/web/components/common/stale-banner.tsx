'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 版の見張り（useVersionWatch）で、ほかの人の変更に気づいたときの帯（画面の設計 2.6。T09a）。自動では読み直さない。
 *
 * @example
 * const { stale } = useVersionWatch(yearId, snap.data?.version ?? null, { paused: saving });
 * {stale ? <StaleBanner onReload={() => snap.refetch()} reloading={snap.isFetching} /> : null}
 */
export function StaleBanner({
  onReload,
  reloading = false,
  message = 'ほかの人が振り分けの入力を変えました。',
  className,
}: {
  onReload: () => void;
  reloading?: boolean;
  message?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-testid="stale-banner"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 print:hidden',
        className,
      )}
    >
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onReload} disabled={reloading}>
        <RefreshCw aria-hidden className={reloading ? 'animate-spin' : undefined} />
        {reloading ? '読み直し中…' : '読み直す'}
      </Button>
    </div>
  );
}
