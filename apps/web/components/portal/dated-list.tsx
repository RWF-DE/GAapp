'use client';

// 締切と予定（ダッシュボード〔/〕の欄「締切と予定」。04「ダッシュボード」、notes/T16.md「固めた約束」2。T16）。
// どの立場にも出す。機能が出す日時の決まった項目のうち、これからのもの（時刻のあるものは今より後、日付だけのものは今日〔Asia/Tokyo〕
// 以降）を早い順に 8 件まで（upcomingDated）。続きは「ほか N 件」。行き先を開けるものだけ行をリンクにする。
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { formatShortDate, formatShortDateTime } from '@/lib/datetime';
import { isDateOnly, upcomingDated, type DatedItem, type PortalContext } from '@/lib/modules/portal';
import { cn } from '@/lib/utils';
import { usePortalWidget } from './use-portal';
import { ModuleError, PortalLoading, YearGateView, type YearGate } from './widget';

/** 締切と予定の欄の中身（枠とエラーの境界は portal-screen.tsx）。now はダッシュボードを開いた時刻 */
export function DatedList({ ctxs, gate, now }: { ctxs: readonly PortalContext[]; gate: YearGate; now: number }) {
  const modules = usePortalWidget(ctxs, 'dated');
  if (gate.status !== 'ready') return <YearGateView gate={gate} />;
  const { items, more } = upcomingDated(modules.flatMap((m) => m.dated), now);
  const loading = modules.filter((m) => m.loading);
  const failed = modules.filter((m) => m.failure);
  return (
    <div className="space-y-3">
      {failed.map((m) => (
        <ModuleError key={m.moduleId} moduleId={m.moduleId} error={m.failure!.error} onRetry={m.failure!.retry} />
      ))}
      {items.length > 0 ? (
        <ul className="divide-y">
          {items.map((d) => (
            <DatedRow key={d.id} item={d} />
          ))}
        </ul>
      ) : loading.length === 0 && failed.length === 0 ? (
        <p data-testid="portal-dated-empty" className="text-sm text-muted-foreground">
          これからの締切と予定はありません
        </p>
      ) : null}
      {more > 0 ? (
        <p data-testid="portal-dated-more" className="text-sm text-muted-foreground">
          ほか {more} 件
        </p>
      ) : null}
      {loading.map((m) => (
        <PortalLoading key={m.moduleId} moduleId={m.moduleId} />
      ))}
    </div>
  );
}

const KIND_LABEL = { deadline: '締切', event: '予定' } as const;

function DatedRow({ item: d }: { item: DatedItem }) {
  const dateOnly = isDateOnly(d.at);
  const body = (
    <>
      <time dateTime={d.at} className="w-[5.5rem] shrink-0 text-sm tabular-nums">
        {dateOnly ? formatShortDate(d.at) : formatShortDateTime(d.at)}
      </time>
      <Badge
        variant="outline"
        className={cn(
          'shrink-0',
          d.kind === 'deadline' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-transparent bg-muted text-muted-foreground',
        )}
      >
        {KIND_LABEL[d.kind]}
      </Badge>
      <span className="min-w-[10rem] flex-1 text-sm">{d.title}</span>
    </>
  );
  // 狭い欄（文の幅が 10rem より狭くなるとき）では、日付と種類の印の下に文を送る（文を細い列で細かく折り返さない）
  const row = 'flex flex-wrap items-center gap-x-3 gap-y-1 py-2';
  return (
    <li data-testid="portal-dated-item" data-id={d.id} data-kind={d.kind}>
      {d.href ? (
        <AppLink href={d.href} className={cn(row, '-mx-2 rounded-md px-2 hover:bg-accent')}>
          {body}
        </AppLink>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}
