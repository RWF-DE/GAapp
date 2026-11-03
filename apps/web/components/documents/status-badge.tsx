// 提出の状態の印（04「提出物」の状態の印。2つの画面で同じ色。色だけで表さず、状態の文字を出す。T19・D-55）。
// 言い方は画面で変える（店長・副店長は REP_STATUS_LABELS の「提出済み（総務の確認待ち）」、総務は SOUMU_STATUS_LABELS の「承認待ち」）。
import { Badge } from '@/components/ui/badge';
import type { DocumentStatus } from '@/lib/modules/documents/labels';
import { cn } from '@/lib/utils';

/** 状態ごとの色（未提出は目立たせない・承認待ちは青・差し戻しは注意の色・承認は緑） */
export const DOCUMENT_STATUS_CLASS: Readonly<Record<DocumentStatus, string>> = {
  not_submitted: 'border-border bg-background text-foreground',
  submitted: 'border-sky-300 bg-sky-50 text-sky-900',
  returned: 'border-amber-400 bg-amber-50 text-amber-900',
  approved: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

/** 印のほか（締切の後・代理・紙・締切を過ぎた）の色 */
export const DOCUMENT_MARK_CLASS = 'border-amber-300 bg-amber-50 text-amber-900';

export function DocumentStatusBadge({
  status,
  labels,
  className,
  ...rest
}: {
  status: DocumentStatus;
  labels: Readonly<Record<DocumentStatus, string>>;
  className?: string;
} & Omit<React.ComponentProps<'span'>, 'children'>) {
  return (
    <Badge variant="outline" data-status={status} className={cn('whitespace-normal', DOCUMENT_STATUS_CLASS[status], className)} {...rest}>
      {labels[status]}
    </Badge>
  );
}
