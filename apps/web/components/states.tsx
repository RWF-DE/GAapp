import { AlertTriangle, Inbox, Loader2, Lock, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { YearStatus } from '@/lib/auth/membership';
import { classifyError, messageFor, type MessageContext } from '@/lib/errors';
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

/** クエリの状態（TanStack Query の useQuery の結果のうち、使うものだけ） */
export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/**
 * クエリの状態から、読み込み中・失敗・空・中身のどれを出すかを決める（画面の設計 1.3・3 章の前書き。T09a）。
 * 失敗は 2.5 の文言（messageFor）と「もう一度読み込む」。空は isEmpty が真のとき empty（既定は EmptyState）。
 *
 * @example
 * <QueryState query={q} isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="場所がありません" … />}>
 *   {(rows) => <DataTable … data={rows} />}
 * </QueryState>
 */
export function QueryState<T>({
  query,
  isEmpty,
  empty,
  loading,
  errorContext,
  children,
}: {
  query: QueryLike<T>;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loading?: React.ReactNode;
  errorContext?: MessageContext;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isError) {
    return <ErrorState message={messageFor(classifyError(query.error), errorContext)} onRetry={() => void query.refetch()} />;
  }
  if (query.isPending || query.data === undefined) return <>{loading ?? <LoadingState />}</>;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(query.data)}</>;
}

const READ_ONLY_MESSAGES: Partial<Record<YearStatus, string>> = {
  allocating: '年度が振り分け中のため編集できません',
  confirmed: '年度が確定中のため編集できません',
  closed: '終了した年度のため編集できません（読み取り専用）',
};

/**
 * 年度の状態や立場で書けないときの帯（「年度が確定中のため編集できません」など。3 章の前書き。T09a）。入力欄は呼ぶ側が無効にする。
 *
 * @example
 * {!writable ? <ReadOnlyNotice status={year.status} /> : null}
 * <ReadOnlyNotice>部員は振り分けを見るだけです</ReadOnlyNotice>
 */
export function ReadOnlyNotice({
  status,
  children,
  className,
}: {
  status?: YearStatus;
  children?: React.ReactNode;
  className?: string;
}) {
  const text = children ?? (status ? READ_ONLY_MESSAGES[status] : undefined) ?? '編集できません';
  return (
    <div
      role="status"
      data-testid="read-only-notice"
      className={cn('flex items-center gap-2 rounded-md border bg-muted/50 px-4 py-2 text-sm text-muted-foreground', className)}
    >
      <Lock aria-hidden className="size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
