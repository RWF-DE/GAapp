'use client';

// 団体別の表示（画面の設計 3.9 の「左：団体別」。T13）。需要・振り分け数・差（不足は E003、多いは W101）・内訳。
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { GroupView } from '@/lib/allocation/group-view';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function GroupViewList({ views, highlightGroupId }: { views: readonly GroupView[]; highlightGroupId?: string | null }) {
  if (views.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-muted-foreground">申請と振り分けのある団体はありません。</p>;
  }
  return (
    <div className="space-y-4">
      {views.map(({ group, lines }) => (
        <section
          key={group.id}
          data-group-block={group.id}
          data-highlighted={highlightGroupId === group.id ? 'true' : undefined}
          aria-label={`団体 ${group.name}`}
          className={cn('rounded-md border', highlightGroupId === group.id && 'ring-2 ring-amber-400')}
        >
          <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <h3 className="font-semibold">{group.name}</h3>
            <span className="text-sm text-muted-foreground">{CATEGORY_LABELS[group.category]}</span>
            {group.displayName ? <span className="text-sm text-muted-foreground">（{group.displayName}）</span> : null}
          </header>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>申請品目</TableHead>
                  <TableHead className="text-right">需要</TableHead>
                  <TableHead className="text-right">振り分け</TableHead>
                  <TableHead className="text-right">差</TableHead>
                  <TableHead>内訳</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.requestedItemId}>
                    <TableCell>{l.requestedName}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.demand}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.allocated}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        l.diff < 0 && 'font-bold text-destructive',
                        l.diff > 0 && 'font-bold text-amber-700',
                      )}
                    >
                      {l.diff > 0 ? `+${l.diff}` : l.diff}
                      {l.diff < 0 ? (
                        <Badge variant="destructive" className="ml-1">
                          E003
                        </Badge>
                      ) : l.diff > 0 ? (
                        <Badge variant="outline" className="ml-1 border-amber-400">
                          W101
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.breakdown.length === 0
                        ? '—'
                        : l.breakdown
                            .map((b) => `${b.itemName} ${b.count}（${b.sources.map((s) => `${s.roomName} ${s.count}`).join('・')}）`)
                            .join('、')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}
