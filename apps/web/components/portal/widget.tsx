'use client';

// ダッシュボード（/）の欄の枠と、欄の中の読み込み中・失敗の表示（04「ダッシュボード」、notes/T16.md「固めた約束」2・5。T16）。
import { AlertTriangle } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { classifyError, messageFor } from '@/lib/errors';
import { moduleLabel } from '@/lib/modules/portal';
import type { ModuleId } from '@/lib/modules/registry';
import { cn } from '@/lib/utils';

/** 年度の行（useYearRow）の状態。欄は年度の行がないと何も決められないので、読み込み中・失敗をそのまま出す */
export type YearGate = { status: 'ready' } | { status: 'loading' } | { status: 'error'; error: unknown; retry: () => void };

/**
 * 欄の枠（見出し〔h2〕つきの section。testid は欄の id：portal-todos・portal-dated・portal-cards）。
 * framed が偽なら枠を描かない（中身がカードの並び〔機能ごとの状況・代表する団体〕のとき。カードの中にカードを重ねない）。
 */
export function PortalWidget({
  title,
  testId,
  framed = true,
  className,
  children,
}: {
  title: string;
  testId?: string;
  framed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn('min-w-0', framed && 'rounded-xl border bg-card p-4 text-card-foreground shadow-sm md:p-5', className)}
    >
      <h2 id={headingId} className="mb-3 text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 欄の中の読み込み中（年度の行の読み込み中は欄全体、機能の読み込み中はその機能の分。portal-loading） */
export function PortalLoading({ moduleId, rows = 2, className }: { moduleId?: ModuleId; rows?: number; className?: string }) {
  return (
    <div
      data-testid="portal-loading"
      data-module={moduleId}
      role="status"
      aria-label={moduleId ? `${moduleLabel(moduleId)}を読み込み中` : '読み込み中'}
      className={cn('space-y-2', className)}
    >
      {Array.from({ length: rows }, (_, k) => (
        <Skeleton key={k} className="h-5 w-full" />
      ))}
    </div>
  );
}

/**
 * 1つの機能の読み込みの失敗（portal-module-error。「{機能の名前}：{文言}」と「もう一度」＝その機能の query の読み直し）。
 * ほかの機能・ほかの欄・年度の行だけで決まる項目は出したまま。children（機能の入口へのリンクなど）を並べられる。
 */
export function ModuleError({
  moduleId,
  error,
  onRetry,
  className,
  children,
}: {
  moduleId: ModuleId;
  error: unknown;
  onRetry: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-testid="portal-module-error"
      data-module={moduleId}
      role="alert"
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm', className)}
    >
      <AlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-destructive">
        {moduleLabel(moduleId)}：{messageFor(classifyError(error))}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        もう一度
      </Button>
      {children}
    </div>
  );
}

/** 年度の行がまだない間の欄の中身（読み込み中、または失敗ともう一度＝年度の行の読み直し。portal-year-error） */
export function YearGateView({ gate }: { gate: Exclude<YearGate, { status: 'ready' }> }) {
  if (gate.status === 'loading') return <PortalLoading />;
  return (
    <div
      data-testid="portal-year-error"
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
    >
      <AlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-destructive">年度の情報：{messageFor(classifyError(gate.error))}</p>
      <Button type="button" size="sm" variant="outline" onClick={gate.retry}>
        もう一度
      </Button>
    </div>
  );
}
