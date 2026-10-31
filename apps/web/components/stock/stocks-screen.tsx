'use client';

// 在庫一覧 /stocks（画面の設計 3.4、04「在庫一覧」。T10）。PC。
// 保管場所 × 品目の表（各セルに今年の数と前年との差「12（+2）」、行と列の合計）。使用不可の部屋は灰色にして印をつけ、
// 合計は「使用不可を除く」と「全部」の2つ。部屋の名前から在庫入力へ。まだ数えていない場所（W104 と同じ）を表の上に出す。
import { Printer } from 'lucide-react';
import { useMemo } from 'react';
import { AppLink } from '@/components/common/app-link';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import {
  buildStockMatrix,
  formatCell,
  formatDiff,
  stockPath,
  storageRooms,
  uncountedRooms,
  usePreviousYearStocks,
  useStockMaster,
  useYearStocks,
  type MatrixCell,
  type MatrixTotals,
} from '@/lib/data/stocks';
import { isAdmin } from '@/lib/auth/roles';
import { useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { UnusableBadge, useOpenYear } from './common';

function TotalCell({ c }: { c: MatrixCell }) {
  return (
    <>
      {c.count ?? 0}
      {c.diff !== null ? <span className="ml-0.5 text-xs text-muted-foreground">（{formatDiff(c.diff)}）</span> : null}
    </>
  );
}

function TotalsRow({ label, totals, itemIds, testId }: { label: string; totals: MatrixTotals; itemIds: string[]; testId: string }) {
  return (
    <tr data-testid={testId} className="border-t bg-muted/40 font-semibold">
      <th scope="row" className="sticky left-0 z-10 bg-muted px-3 py-2 text-left whitespace-nowrap">
        {label}
      </th>
      {itemIds.map((id) => (
        <td key={id} data-item-id={id} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
          <TotalCell c={totals.cells[id]!} />
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        <TotalCell c={totals.total} />
      </td>
    </tr>
  );
}

export function StocksScreen() {
  const open = useOpenYear();
  const yearId = open?.year.id ?? null;
  const yearQ = useYearRow(yearId);
  const masterQ = useStockMaster(yearId);
  const stocksQ = useYearStocks(yearId);
  const prevYearId = yearQ.data?.prev_year_id ?? null;
  const prevQ = usePreviousYearStocks(yearId, prevYearId);

  const matrix = useMemo(() => {
    if (!masterQ.data || !stocksQ.data) return null;
    if (prevYearId && !prevQ.data) return null;
    return buildStockMatrix({
      storage: storageRooms(masterQ.data.rooms, masterQ.data.roomYears),
      items: masterQ.data.items,
      stocks: stocksQ.data,
      prev: prevYearId ? (prevQ.data ?? []) : null,
    });
  }, [masterQ.data, stocksQ.data, prevQ.data, prevYearId]);

  const queries = [yearQ, masterQ, stocksQ, ...(prevYearId ? [prevQ] : [])];
  const failed = queries.find((q) => q.isError);
  const fetching = queries.some((q) => q.isFetching);
  const loadedAt = stocksQ.dataUpdatedAt ? new Date(stocksQ.dataUpdatedAt) : null;
  const reload = () => {
    for (const q of queries) void q.refetch();
  };

  const header = (
    <PageHeader
      title="在庫一覧"
      loadedAt={loadedAt}
      onReload={reload}
      reloading={fetching}
      actions={
        <Button asChild variant="outline">
          <AppLink href="/stocks/qr">
            <Printer aria-hidden />
            QR を印刷
          </AppLink>
        </Button>
      }
    />
  );

  if (!open) return <LoadingState />;
  if (failed) {
    return (
      <>
        {header}
        <ErrorState message={messageFor(classifyError(failed.error))} onRetry={reload} />
      </>
    );
  }
  if (!matrix || !yearQ.data) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }

  if (matrix.rows.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="保管場所がありません"
          description={isAdmin(open.role) ? 'マスタ設定の場所で「保管場所」にしてください。' : '総務の管理者に、保管場所の登録を頼んでください。'}
          action={
            isAdmin(open.role) ? (
              <AppLink href="/settings?tab=rooms" className="text-sm underline underline-offset-4">
                マスタ設定（場所）へ
              </AppLink>
            ) : undefined
          }
        />
      </>
    );
  }

  const counted = new Set(matrix.rows.filter((r) => r.counted).map((r) => r.storage.room.id));
  const uncounted = uncountedRooms(
    matrix.rows.map((r) => r.storage),
    counted,
  );
  const itemIds = matrix.items.map((i) => i.id);

  return (
    <>
      {header}
      <section aria-label="まだ数えていない場所" data-testid="uncounted-rooms" className="mb-4 rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold">
          まだ数えていない場所（{uncounted.length}／{matrix.rows.filter((r) => r.storage.usable).length}。使用不可を除く）
        </h2>
        {uncounted.length === 0 ? (
          <p className="text-sm text-muted-foreground">使用できる保管場所はすべて数えました。</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {uncounted.map((s) => (
              <li key={s.room.id}>
                <AppLink href={stockPath(s.room.id)} className="inline-block rounded-full border px-3 py-1 text-sm hover:bg-accent">
                  {s.room.name}
                </AppLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mb-2 text-xs text-muted-foreground">
        {matrix.hasPrev ? 'セルは「今年の数（前年との差）」。' : '前年度がないので、前年との差は出しません。'}
        「まだ」はその場所をまだ数えていないことを表します。
      </p>
      {matrix.hasPrev ? (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="stock-total-note">
          合計の前年との差は、今年数えた場所だけで比べます（まだ数えていない場所は、今年と前年の両方から除きます）。
        </p>
      ) : null}
      <div className="max-h-[70vh] overflow-auto rounded-lg border">
        <table className="w-full border-collapse text-sm" data-testid="stock-matrix">
          <thead className="sticky top-0 z-20 bg-background">
            <tr className="border-b">
              <th scope="col" className="sticky left-0 z-30 bg-background px-3 py-2 text-left whitespace-nowrap">
                保管場所
              </th>
              {matrix.items.map((i) => (
                <th key={i.id} scope="col" className="px-3 py-2 text-right whitespace-nowrap">
                  {i.name}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right whitespace-nowrap">
                合計
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr
                key={r.storage.room.id}
                data-testid="stock-matrix-row"
                data-room-id={r.storage.room.id}
                data-usable={r.storage.usable ? 'true' : 'false'}
                className={cn('border-b', !r.storage.usable && 'bg-zinc-100 text-zinc-500')}
              >
                <th scope="row" className={cn('sticky left-0 z-10 px-3 py-2 text-left font-normal whitespace-nowrap', r.storage.usable ? 'bg-background' : 'bg-zinc-100')}>
                  <span className="flex items-center gap-2">
                    <AppLink href={stockPath(r.storage.room.id)} className="font-medium underline-offset-4 hover:underline">
                      {r.storage.room.name}
                    </AppLink>
                    {!r.storage.usable ? <UnusableBadge /> : null}
                  </span>
                </th>
                {matrix.items.map((i) => (
                  <td
                    key={i.id}
                    data-item-id={i.id}
                    className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', !r.counted && 'text-amber-700')}
                  >
                    {formatCell(r.cells[i.id]!, r.counted)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-medium tabular-nums whitespace-nowrap">{formatCell(r.total, r.counted)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <TotalsRow label="合計（使用不可を除く）" totals={matrix.usableTotals} itemIds={itemIds} testId="stock-total-usable" />
            <TotalsRow label="合計（全部）" totals={matrix.allTotals} itemIds={itemIds} testId="stock-total-all" />
          </tfoot>
        </table>
      </div>
    </>
  );
}
