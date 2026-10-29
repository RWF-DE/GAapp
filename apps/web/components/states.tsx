import { AlertTriangle, Inbox, Loader2, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// すべての画面で使う3状態（読み込み中・データが空・権限なし）と、読み込みの失敗の表示（04「画面仕様」の前書き）。

function StateFrame({
  icon,
  title,
  children,
  className,
  role,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  return (
    <div
      role={role}
      className={cn('flex flex-col items-center justify-center gap-3 px-4 py-12 text-center', className)}
    >
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-base font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function LoadingState({ label = '読み込み中…', className }: { label?: string; className?: string }) {
  return (
    <StateFrame role="status" icon={<Loader2 className="size-6 animate-spin" aria-hidden />} title={label} className={className} />
  );
}

export function EmptyState({
  title = 'データがありません',
  description,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <StateFrame icon={<Inbox className="size-6" aria-hidden />} title={title} className={className}>
      {description}
      {action ? <div className="mt-3">{action}</div> : null}
    </StateFrame>
  );
}

export function ForbiddenState({
  description = 'この画面を開く権限がありません。必要なら総務の管理者に確認してください。',
  className,
}: {
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <StateFrame role="alert" icon={<ShieldX className="size-6" aria-hidden />} title="権限がありません" className={className}>
      {description}
    </StateFrame>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <StateFrame role="alert" icon={<AlertTriangle className="size-6" aria-hidden />} title={message} className={className}>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          もう一度読み込む
        </Button>
      ) : null}
    </StateFrame>
  );
}
