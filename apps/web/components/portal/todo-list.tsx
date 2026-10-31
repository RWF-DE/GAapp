'use client';

// 要対応の一覧（ダッシュボード〔/〕の欄「要対応」。04「ダッシュボード」、notes/T16.md「固めた約束」2。T16）。
// 総務と団体代表に出す（閲覧のみには出さない）。機能が立場（段）ごとに作った要対応（行き先を開けるものだけ）を、
// sortTodos（急ぎ → ふつう → 参考、期日、機能の登録の順、作った順）で並べる。1件は行全体を行き先へのリンクにする。
// いちばん低い度合い（info）の印は「参考」（機能の「お知らせ」〔T17〕と取り違えないため）。期日はダッシュボードを開いた時刻（now）で
// 過ぎていれば「締切 10/5 17:00 を過ぎました」と出す。
import { AlertTriangle, ChevronRight, CircleDot, Info } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { formatShortDateTime } from '@/lib/datetime';
import { moduleLabel, sortTodos, type PortalContext, type TodoItem } from '@/lib/modules/portal';
import { cn } from '@/lib/utils';
import { usePortalWidget } from './use-portal';
import { ModuleError, PortalLoading, YearGateView, type YearGate } from './widget';

/** 要対応の欄の中身（枠とエラーの境界は portal-screen.tsx）。now はダッシュボードを開いた時刻 */
export function TodoList({ ctxs, gate, now }: { ctxs: readonly PortalContext[]; gate: YearGate; now: number }) {
  const modules = usePortalWidget(ctxs, 'todos');
  if (gate.status !== 'ready') return <YearGateView gate={gate} />;
  const todos = sortTodos(modules.flatMap((m) => m.todos));
  const loading = modules.filter((m) => m.loading);
  const failed = modules.filter((m) => m.failure);
  return (
    <div className="space-y-3">
      {failed.map((m) => (
        <ModuleError key={m.moduleId} moduleId={m.moduleId} error={m.failure!.error} onRetry={m.failure!.retry} />
      ))}
      {todos.length > 0 ? (
        <ul className="divide-y">
          {todos.map((t) => (
            <TodoRow key={t.id} todo={t} now={now} />
          ))}
        </ul>
      ) : loading.length === 0 && failed.length === 0 ? (
        <p data-testid="portal-todos-empty" className="text-sm text-muted-foreground">
          今やることはありません
        </p>
      ) : null}
      {loading.map((m) => (
        <PortalLoading key={m.moduleId} moduleId={m.moduleId} />
      ))}
    </div>
  );
}

const SEVERITY_ICON = { urgent: AlertTriangle, normal: CircleDot, info: Info } as const;

function TodoRow({ todo: t, now }: { todo: TodoItem; now: number }) {
  const Icon = SEVERITY_ICON[t.severity];
  // 期日を過ぎたか（締切ちょうどは「過ぎた」側。要対応を作る側の「締切 ≤ now」と同じ）
  const due = t.due ? Date.parse(t.due) : Number.NaN;
  const passed = !Number.isNaN(due) && due <= now;
  return (
    <li data-testid="portal-todo" data-id={t.id} data-severity={t.severity} data-module={t.moduleId}>
      <AppLink href={t.href} className="-mx-2 flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-accent">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            t.severity === 'urgent' ? 'text-destructive' : t.severity === 'info' ? 'text-muted-foreground' : 'text-primary',
          )}
        />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-muted-foreground">
              {moduleLabel(t.moduleId)}
            </Badge>
            {t.severity === 'urgent' ? <Badge variant="destructive">急ぎ</Badge> : null}
            {t.severity === 'info' ? (
              <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
                参考
              </Badge>
            ) : null}
          </span>
          <span
            className={cn(
              'block text-sm',
              t.severity === 'urgent' && 'font-medium text-destructive',
              t.severity === 'info' && 'text-muted-foreground',
            )}
          >
            {t.title}
          </span>
          {t.due ? (
            <span data-testid="portal-todo-due" className="block text-xs text-muted-foreground">
              締切 <time dateTime={t.due}>{formatShortDateTime(t.due)}</time>
              {passed ? ' を過ぎました' : null}
            </span>
          ) : null}
        </span>
        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </AppLink>
    </li>
  );
}
