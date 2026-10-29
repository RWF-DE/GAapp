'use client';

// 行の操作（画面の設計 3.9 の「行の操作」。T13 の段 2）。管理者が振り分け中（確定前）のときだけ出す。
// 数（CountStepper。min 1）・運び元の変更・備考（ポップオーバー。自動の行には「手動の行になります」）・固定（ピン）・削除（確認）・
// 未保存の行の「元に戻す」。使用不可の部屋の行は運び元の変更と削除だけ（allowedRowOps。「固定を外す」は出さない）。
import type { StoredAllocationRow } from '@gaapp/shared';
import { Pin, PinOff, Trash2, Undo2 } from 'lucide-react';
import { createContext, useContext, useId, useState } from 'react';
import { CountStepper } from '@/components/common/count-stepper';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { allowedRowOps, parseNote, type PendingEdit, type RowOp } from '@/lib/allocation/pending';
import type { ViewModel } from '@/lib/allocation/view-model';

export interface RowEditApi {
  vm: ViewModel;
  /** 未保存の変更を当てた行 */
  rows: readonly StoredAllocationRow[];
  /** 未保存の変更がある行の id（DB の id と tempId） */
  pendingIds: ReadonlySet<string>;
  isUsable: (roomId: string) => boolean;
  edit: (e: PendingEdit) => void;
  revert: (rowId: string) => void;
  openSource: (rowId: string) => void;
  requestDelete: (rowId: string) => void;
  openUnusable: (roomId: string) => void;
  openUsable: (roomId: string) => void;
}

const RowEditContext = createContext<RowEditApi | null>(null);
export const RowEditProvider = RowEditContext.Provider;
/** 編集できるときだけ値がある（読み取りの表は null） */
export const useRowEdit = () => useContext(RowEditContext);

export const opsOf = (api: RowEditApi, row: StoredAllocationRow): RowOp[] => allowedRowOps(row, api.isUsable);

export const AUTO_NOTE_WARNING = '備考を書くと、この行は手動の行になり、次の自動振り分け・最小変更で変わらなくなります';

/** 数のセル（使えないときは数だけ） */
export function CountCell({ api, row, groupName, itemName }: { api: RowEditApi; row: StoredAllocationRow; groupName: string; itemName: string }) {
  if (!opsOf(api, row).includes('count')) return <span className="tabular-nums">{row.count}</span>;
  return (
    <CountStepper
      label={`${groupName}の${itemName}の数`}
      min={1}
      value={row.count}
      onChange={(count) => api.edit({ op: 'update', id: row.id, patch: { count } })}
      className="justify-end"
    />
  );
}

/** 固定（ピン）のボタン */
export function PinCell({ api, row }: { api: RowEditApi; row: StoredAllocationRow }) {
  const ops = opsOf(api, row);
  if (!ops.includes('pin') && !ops.includes('unpin')) {
    return row.pinned ? (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Pin aria-hidden className="size-3.5" />
        固定
      </span>
    ) : null;
  }
  return (
    <Button
      size="xs"
      variant={row.pinned ? 'secondary' : 'ghost'}
      aria-pressed={row.pinned}
      title={row.pinned ? '固定を外す' : '固定する'}
      onClick={() => api.edit({ op: 'update', id: row.id, patch: { pinned: !row.pinned } })}
    >
      {row.pinned ? <Pin aria-hidden /> : <PinOff aria-hidden />}
      {row.pinned ? '固定を外す' : '固定する'}
    </Button>
  );
}

/** 備考のポップオーバー（2000 字まで。自動の行には手動の行になることを知らせる） */
export function NoteCell({ api, row }: { api: RowEditApi; row: StoredAllocationRow }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(row.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const can = opsOf(api, row).includes('note');
  const shown = (
    <span className="block max-w-48 truncate" title={row.note ?? undefined}>
      {row.note ?? ''}
    </span>
  );
  if (!can) return shown;
  return (
    <div className="flex items-center gap-1">
      {shown}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) {
            setText(row.note ?? '');
            setError(null);
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button size="xs" variant="ghost">
            備考
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-2">
          <Label htmlFor={`${id}-note`}>備考（2000 字まで）</Label>
          {row.origin === 'auto' ? <p className="text-xs text-amber-800">{AUTO_NOTE_WARNING}</p> : null}
          <Textarea id={`${id}-note`} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
              やめる
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const r = parseNote(text);
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                api.edit({ op: 'update', id: row.id, patch: { note: r.note } });
                setOpen(false);
              }}
            >
              決める
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** 操作の列：運び元を変える・削除・元に戻す */
export function ActionsCell({ api, row, label }: { api: RowEditApi; row: StoredAllocationRow; label: string }) {
  const ops = opsOf(api, row);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ops.includes('change_source') ? (
        <Button size="xs" variant="outline" aria-label={`${label}の運び元を変える`} onClick={() => api.openSource(row.id)}>
          運び元を変える
        </Button>
      ) : null}
      {ops.includes('delete') ? (
        <Button size="xs" variant="ghost" className="text-destructive" aria-label={`${label}を削除`} onClick={() => api.requestDelete(row.id)}>
          <Trash2 aria-hidden />
          削除
        </Button>
      ) : null}
      {api.pendingIds.has(row.id) ? (
        <Button size="xs" variant="ghost" aria-label={`${label}の変更を元に戻す`} onClick={() => api.revert(row.id)}>
          <Undo2 aria-hidden />
          元に戻す
        </Button>
      ) : null}
    </div>
  );
}
