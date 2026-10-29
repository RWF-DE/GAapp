'use client';

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/states';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface DataTableProps<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack Table の列の値の型は列ごとに違う
  columns: ColumnDef<T, any>[];
  data: readonly T[];
  /** 行の id（`data-row-id` に出す。検証の一覧から行へ飛ぶため） */
  getRowId: (row: T) => string;
  /** ハイライトする行（変わったら見える所までスクロールする） */
  highlightRowId?: string | null;
  initialSorting?: SortingState;
  /** 空のときに出すもの（既定は EmptyState） */
  empty?: React.ReactNode;
  /** 表の入れ物の class（高さの上限など。既定 max-h-[70vh]。見出しはこの中で固定する） */
  containerClassName?: string;
  className?: string;
  onRowClick?: (row: T) => void;
  /** 行ごとの class（未保存の変更の色など） */
  rowClassName?: (row: T) => string | undefined;
  caption?: string;
}

/**
 * TanStack Table v8 の薄い包み（画面の設計 1.4。T09a）。並べ替え（見出しを押す）、見出しの固定（sticky）、
 * 行の id を `data-row-id` に出す、行のハイライト、空のときの EmptyState。表の中だけを横にスクロールさせる。
 *
 * @example
 * const columns: ColumnDef<StockRow>[] = [
 *   { accessorKey: 'roomName', header: '場所' },
 *   { accessorKey: 'count', header: '数', meta: { align: 'right' } },
 * ];
 * <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState title="まだ数えていません" />} />
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  highlightRowId,
  initialSorting = [],
  empty,
  containerClassName,
  className,
  onRowClick,
  rowClassName,
  caption,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table は React Compiler の対象外（このまま使う）
  const table = useReactTable({
    data: data as T[],
    columns,
    getRowId: (row) => getRowId(row),
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlightRowId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(highlightRowId)}"]`);
    el?.scrollIntoView?.({ block: 'center' });
  }, [highlightRowId]);

  if (data.length === 0) return <>{empty ?? <EmptyState />}</>;

  return (
    <div ref={containerRef} className={cn('relative max-h-[70vh] w-full overflow-auto rounded-md border', containerClassName)}>
      <table className={cn('w-full caption-bottom text-sm', className)}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--border)]">
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                const align = (h.column.columnDef.meta as { align?: 'right' } | undefined)?.align;
                return (
                  <TableHead
                    key={h.id}
                    colSpan={h.colSpan}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={align === 'right' ? 'text-right' : undefined}
                  >
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:underline"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp aria-hidden className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown aria-hidden className="size-3" />
                        ) : (
                          <ArrowUpDown aria-hidden className="size-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            const highlighted = row.id === highlightRowId;
            return (
              <TableRow
                key={row.id}
                data-row-id={row.id}
                data-highlighted={highlighted || undefined}
                data-state={highlighted ? 'selected' : undefined}
                className={cn(onRowClick && 'cursor-pointer', highlighted && 'bg-amber-50', rowClassName?.(row.original))}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell) => {
                  const align = (cell.column.columnDef.meta as { align?: 'right' } | undefined)?.align;
                  return (
                    <TableCell key={cell.id} className={align === 'right' ? 'text-right tabular-nums' : undefined}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </table>
    </div>
  );
}
