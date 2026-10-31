'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { cn } from '@/lib/utils';
import { TokyoTime } from './tokyo-time';
import { YearStatusBadge } from './year-status-badge';

/**
 * 画面の題名、開いている年度とその状態、最終読み込み日時と「読み直す」（画面の設計 1.4・2.6。T09a）。
 * データの多い画面（机椅子の状況・在庫一覧・申請一覧・振り分け・キャスター机交換・履歴）は loadedAt と onReload を渡す。
 * スマホ（md 未満）では題名の段が全幅になり、最終読み込み・読み直す・actions はその下の行に並ぶ（呼ぶ側で className を足さなくてよい）。
 *
 * @example
 * <PageHeader title="在庫一覧" loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
 *   onReload={() => q.refetch()} reloading={q.isFetching} actions={<Button>QR を印刷</Button>} />
 */
export function PageHeader({
  title,
  description,
  actions,
  loadedAt,
  onReload,
  reloading = false,
  showYear = true,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  loadedAt?: string | Date | null;
  onReload?: () => void;
  reloading?: boolean;
  /** 開いている年度と状態を出すか（既定 true） */
  showYear?: boolean;
  className?: string;
}) {
  const { membership } = useAuth();
  const year = membership.status === 'ready' ? membership.membership.year : null;
  return (
    <header className={cn('mb-4 flex flex-wrap items-start gap-x-4 gap-y-2', className)}>
      {/* md 未満は題名の段を全幅にし、最終読み込み・読み直す・操作を次の行に送る（390px で題名と年度名が数文字ずつで折れないように）。
          md 以上は今までどおり（flex-1 と同じ grow・basis-0）で横に並べる */}
      <div className="min-w-0 grow basis-full space-y-1 md:basis-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold md:text-2xl">{title}</h1>
          {showYear && year ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              {year.label}
              <YearStatusBadge status={year.status} />
            </span>
          ) : null}
        </div>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {onReload || loadedAt ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground print:hidden">
          {loadedAt ? (
            <span>
              最終読み込み <TokyoTime value={loadedAt} format="time" />
            </span>
          ) : null}
          {onReload ? (
            <Button size="sm" variant="outline" onClick={onReload} disabled={reloading}>
              <RefreshCw aria-hidden className={reloading ? 'animate-spin' : undefined} />
              {reloading ? '読み直し中…' : '読み直す'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
    </header>
  );
}
