'use client';

// 品目別の表示（画面の設計 3.9 の「左：品目別」。T13）。運び元ごとのまとまりと余り。
// 部門長以上が振り分け中のときは、行の操作（row-edit.tsx）と部屋の見出しのメニュー（今年は使用不可にする・使用可に戻す。room_years は
// 部門長以上が書ける。D-48）を出す（段 2）。
import type { StoredAllocationRow } from '@gaapp/shared';
import { MoreHorizontal, Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { itemTabBlocks, type RoomBlock } from '@/lib/allocation/item-view';
import type { ItemTab } from '@/lib/allocation/tabs';
import type { ViewModel } from '@/lib/allocation/view-model';
import { UNUSABLE_ROW_NOTE } from '@/lib/allocation/pending';
import { ORIGIN_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { ActionsCell, CountCell, NoteCell, PinCell, useRowEdit, type RowEditApi } from './row-edit';

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
  const edit = useRowEdit();
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
            {edit ? <RoomMenu api={edit} roomId={b.room.id} roomName={b.room.name} usable={b.room.usable} /> : null}
            {edit && !b.room.usable && b.rows.length > 0 ? (
              <p className="basis-full text-xs text-amber-800" data-testid="unusable-row-note">
                {UNUSABLE_ROW_NOTE}
              </p>
            ) : null}
          </header>
          <div className="overflow-x-auto">
            {/* セルの左右の余白を詰める（PC の 1280px で「固定・操作」の列まで収めるため。B6） */}
            <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead>運び先</TableHead>
                  <TableHead>団体</TableHead>
                  {/* 申請品目（品目と違うときだけ「…の代わり」）は列にせず、品目のセル（品目の列がなければ団体のセル）の2行目に
                      たたむ（PC の 1280px で「固定・操作」の列まで部屋のまとまりに収めるため。B6） */}
                  {two || readOnlyList ? <TableHead>品目</TableHead> : null}
                  <TableHead className="text-right">数</TableHead>
                  {!readOnlyList ? (
                    <>
                      <TableHead>備考</TableHead>
                      <TableHead>自動／手動</TableHead>
                      <TableHead>{edit ? '固定・操作' : '固定'}</TableHead>
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
                    data-pending={edit?.pendingIds.has(v.row.id) ? 'true' : undefined}
                    className={cn(edit?.pendingIds.has(v.row.id) && 'bg-sky-50', highlightRowId === v.row.id && 'bg-amber-100')}
                  >
                    <TableCell>{v.dest || '—'}</TableCell>
                    <TableCell>
                      {v.group?.name ?? '（不明な団体）'}
                      {!(two || readOnlyList) ? <RequestedLine name={v.requestedName} /> : null}
                    </TableCell>
                    {two || readOnlyList ? (
                      <TableCell>
                        {v.itemName}
                        <RequestedLine name={v.requestedName} />
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">
                      {edit ? <CountCell api={edit} row={v.row} groupName={v.group?.name ?? ''} itemName={v.itemName} /> : v.row.count}
                    </TableCell>
                    {!readOnlyList && edit ? (
                      <EditCells api={edit} row={v.row} label={`${v.group?.name ?? ''}の${v.itemName}（${b.room.name}から）`} />
                    ) : !readOnlyList ? (
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
                    <TableCell colSpan={two ? 6 : 5}>
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

/** 申請品目が品目と違うときの2行目（「机(木)の代わり」） */
function RequestedLine({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="block text-xs text-muted-foreground" data-testid="requested-item">
      {name}の代わり
    </span>
  );
}

function EditCells({ api, row, label }: { api: RowEditApi; row: StoredAllocationRow; label: string }) {
  return (
    <>
      <TableCell>
        <NoteCell api={api} row={row} />
      </TableCell>
      <TableCell>
        {ORIGIN_LABELS[row.origin]}
        {api.pendingIds.has(row.id) ? (
          <Badge variant="outline" className="mt-0.5 block w-fit border-sky-400 text-sky-900">
            未保存
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <PinCell api={api} row={row} />
          <ActionsCell api={api} row={row} label={label} />
        </div>
      </TableCell>
    </>
  );
}

/** 部屋の見出しのメニュー（今年は使用不可にする・使用可に戻す。部門長以上・振り分け中） */
function RoomMenu({ api, roomId, roomName, usable }: { api: RowEditApi; roomId: string; roomName: string; usable: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={`${roomName}のメニュー`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {usable ? (
          <DropdownMenuItem onSelect={() => api.openUnusable(roomId)}>今年は使用不可にする</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => api.openUsable(roomId)}>使用可に戻す</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
