import { Badge } from '@/components/ui/badge';
import { YEAR_STATUS_LABELS, type YearStatus } from '@/lib/auth/membership';
import { cn } from '@/lib/utils';

const STYLES: Record<YearStatus, string> = {
  preparing: 'border-border bg-background text-foreground',
  requesting: 'border-transparent bg-sky-100 text-sky-900',
  allocating: 'border-transparent bg-amber-100 text-amber-900',
  confirmed: 'border-transparent bg-emerald-100 text-emerald-900',
  closed: 'border-transparent bg-muted text-muted-foreground',
};

/** 年度の状態（準備中〜終了）の印（画面の設計 1.4。T09a） */
export function YearStatusBadge({ status, className }: { status: YearStatus; className?: string }) {
  return (
    <Badge variant="outline" data-status={status} className={cn(STYLES[status], className)}>
      {YEAR_STATUS_LABELS[status]}
    </Badge>
  );
}
