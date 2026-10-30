'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { classifyError, effectOf, issueMessages, messageFor, type MessageContext } from '@/lib/errors';
import { cn } from '@/lib/utils';

/**
 * 分類したエラー（画面の設計 2.5）の文言と、「読み直す」「もう一度」のボタン（T09a）。
 * kind が issue（E001・E002・E005・E006）なら details を名前にした一覧も出す。
 * 「読み直す」は effectOf の reload が none 以外で onReload があるとき、「もう一度」は onRetry があるとき。
 *
 * @example
 * {m.error ? <ErrorBanner error={m.error} context={{ rpc: 'save_allocation_rows', names }} onReload={reload} /> : null}
 */
export function ErrorBanner({
  error,
  context,
  onReload,
  onRetry,
  className,
}: {
  error: unknown;
  context?: MessageContext;
  onReload?: () => void;
  onRetry?: () => void;
  className?: string;
}) {
  const c = classifyError(error);
  const effect = effectOf(c);
  const items = c.kind === 'issue' ? issueMessages(c, context) : [];
  return (
    <div
      role="alert"
      data-testid="error-banner"
      data-kind={c.kind}
      className={cn('flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm', className)}
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium text-destructive">{messageFor(c, context)}</p>
        {items.length > 0 ? (
          <ul className="list-inside list-disc space-y-0.5 text-foreground">
            {items.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        ) : null}
        {(onReload && effect.reload !== 'none') || onRetry ? (
          <div className="flex flex-wrap gap-2">
            {onReload && effect.reload !== 'none' ? (
              <Button size="sm" variant="outline" onClick={onReload}>
                読み直す
              </Button>
            ) : null}
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                もう一度
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
