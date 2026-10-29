'use client';

// 品目別の表示（画面の設計 3.9 の「左：品目別」。T13）。運び元ごとのまとまりと余り。
// 段 1 は読み取りだけ（行の操作・部屋の見出しの「使用不可にする」は段 2）。
import type { StoredAllocationRow } from '@gaapp/shared';
import { Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { itemTabBlocks, type RoomBlock } from '@/lib/allocation/item-view';
import type { ItemTab } from '@/lib/allocation/tabs';
import type { ViewModel } from '@/lib/allocation/view-model';
import { ORIGIN_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function stockText(block: RoomBlock): string {
  return block.cells.map((c) => (block.cells.length > 1 ? `${c.name} ${c.stock ?? '—'}` : String(c.stock ?? '—'))).join('・');
}

function SurplusCell({ block }: { block: RoomBlock }) {
  if (!block.room.usable) {
    return <span className="text-muted-foreground">使用不可（在庫 {block.cells.map((c) => c.stock ?? 0).join('・')}）</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-x-3">
      {block.cells.map((c) => (
        <span key={c.itemId} className={cn(c.surplus !== null && c.surplus < 0 && 'font-bold text-destructive')}>
          {block.cells.length > 1 ? `${c.name} ` : ''}
          {c.surplus ?? '—'}
          {c.surplus !== null && c.surplus < 0 ? (
            <Badge variant="destructive" className="ml-1">
              E001
            </Badge>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function ItemTabView({
  vm,
  rows,
  tab,
  highlightRowId,
  highlightRoomId,
  readOnlyList = false,
}: {
  vm: ViewModel;
  rows: readonly StoredAllocationRow[];
  tab: ItemTab;
  highlightRowId?: string | null;
  highlightRoomId?: string | null;
  /** viewer（Q1）：行の一覧だけ（在庫・余り・備考・自動／手動・固定を出さない） */
  readOnlyList?: boolean;
}) {
  const blocks = itemTabBlocks(vm, rows, tab);
  const two = tab.items.length > 1;
  if (blocks.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-muted-foreground">この品目の在庫と振り分けはありません。</p>;
  }
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <section
          key={b.room.id}
          data-room-block={b.room.id}
          data-highlighted={highlightRoomId === b.room.id ? 'true' : undefined}
          aria-label={`運び元 ${b.room.name}`}
          className={cn('rounded-md border', highlightRoomId === b.room.id && 'ring-2 ring-amber-400')}
        >
          <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <h3 className="font-semibold">{b.room.name}</h3>
            {!b.room.usable ? <Badge variant="outline">使用不可</Badge> : null}
            {vm.hasStock ? <span className="text-sm text-muted-foreground">在庫 {stockText(b)}</span> : null}
          </header>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>運び先</TableHead>
                  <TableHead>団体</TableHead>
                  {two || readOnlyList ? <TableHead>品目</TableHead> : null}
                  <TableHead>申請品目</TableHead>
                  <TableHead className="text-right">数</TableHead>
                  {!readOnlyList ? (
                    <>
                      <TableHead>備考</TableHead>
                      <TableHead>自動／手動</TableHead>
                      <TableHead>固定</TableHead>
                    </>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.rows.map((v) => (
                  <TableRow
                    key={v.row.id}
                    data-row-id={v.row.id}
                    data-highlighted={highlightRowId === v.row.id ? 'true' : undefined}
                    className={cn(highlightRowId === v.row.id && 'bg-amber-100')}
                  >
                    <TableCell>{v.dest || '—'}</TableCell>
                    <TableCell>{v.group?.name ?? '（不明な団体）'}</TableCell>
                    {two || readOnlyList ? <TableCell>{v.itemName}</TableCell> : null}
                    <TableCell className="text-muted-foreground">{v.requestedName ? `${v.requestedName}の代わり` : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.row.count}</TableCell>
                    {!readOnlyList ? (
                      <>
                        <TableCell className="max-w-64 truncate" title={v.row.note ?? undefined}>
                          {v.row.note ?? ''}
                        </TableCell>
                        <TableCell>{ORIGIN_LABELS[v.row.origin]}</TableCell>
                        <TableCell>
                          {v.row.pinned ? (
                            <span className="inline-flex items-center gap-1">
                              <Pin aria-hidden className="size-3.5" />
                              固定
                            </span>
                          ) : (
                            ''
                          )}
                        </TableCell>
                      </>
                    ) : null}
                  </TableRow>
                ))}
                {vm.hasStock && !readOnlyList ? (
                  <TableRow className="bg-muted/20" data-surplus-row={b.room.id}>
                    <TableCell className="font-medium">余り</TableCell>
                    <TableCell colSpan={two ? 7 : 6}>
                      <SurplusCell block={b} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}
    </div>
  );
}
