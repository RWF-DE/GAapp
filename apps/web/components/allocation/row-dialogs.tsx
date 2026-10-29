'use client';

// 行の操作のダイアログ（画面の設計 3.9。T13 の段 2）：運び元の変更・行の追加・使用不可にする前の一覧・使用可に戻す。
import type { StoredAllocationRow, YearData } from '@gaapp/shared';
import { useId, useMemo, useState } from 'react';
import { CountStepper } from '@/components/common/count-stepper';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { parseNote, type RowFields } from '@/lib/allocation/pending';
import {
  defaultCount,
  itemOptions,
  OUT_OF_RULE,
  requestedOptions,
  sourceLabel,
  sourceOptions,
} from '@/lib/allocation/row-options';
import { FIXED_ROW_OP_LABELS, unusableBlocker, type UnusableCheckItem } from '@/lib/allocation/unusable';
import type { ViewModel } from '@/lib/allocation/view-model';
import type { FixedRowOp } from '@/lib/data/room-years';
import { CATEGORY_LABELS, ORIGIN_LABELS } from '@/lib/labels';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

const nameOf = (vm: ViewModel, kind: 'group' | 'item' | 'room', id: string) =>
  (kind === 'group' ? vm.groupById.get(id)?.name : kind === 'item' ? vm.itemById.get(id)?.name : vm.roomById.get(id)?.name) ?? '（不明）';

/** 行の短い説明（団体・品目・運び元・数） */
export function rowLabel(vm: ViewModel, r: Pick<StoredAllocationRow, 'groupId' | 'itemId' | 'sourceRoomId' | 'count'>): string {
  return `${nameOf(vm, 'group', r.groupId)}の${nameOf(vm, 'item', r.itemId)}（${nameOf(vm, 'room', r.sourceRoomId)}から ${r.count}）`;
}

// ---- 運び元の変更 ----

export function SourceDialog({
  row,
  vm,
  rows,
  onOpenChange,
  onPick,
}: {
  row: StoredAllocationRow | null;
  vm: ViewModel;
  rows: readonly StoredAllocationRow[];
  onOpenChange: (open: boolean) => void;
  onPick: (roomId: string) => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent>{row ? <SourceForm key={row.id} row={row} vm={vm} rows={rows} onCancel={() => onOpenChange(false)} onPick={onPick} /> : null}</DialogContent>
    </Dialog>
  );
}

function SourceForm({
  row,
  vm,
  rows,
  onCancel,
  onPick,
}: {
  row: StoredAllocationRow;
  vm: ViewModel;
  rows: readonly StoredAllocationRow[];
  onCancel: () => void;
  onPick: (roomId: string) => void;
}) {
  const id = useId();
  const options = useMemo(() => sourceOptions(vm, rows, row.itemId, row.sourceRoomId), [vm, rows, row]);
  const [value, setValue] = useState(options[0]?.roomId ?? '');
  return (
    <>
      <DialogHeader>
        <DialogTitle>運び元を変える</DialogTitle>
        <DialogDescription>
          {rowLabel(vm, row)}。その品目の在庫がある使用可の場所から選びます（余りは未保存の変更を含めて数えます）。
        </DialogDescription>
      </DialogHeader>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">ほかに{nameOf(vm, 'item', row.itemId)}の在庫がある使用可の場所はありません。</p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-source`}>新しい運び元</Label>
          <select id={`${id}-source`} className={selectClass} value={value} onChange={(e) => setValue(e.target.value)}>
            {options.map((o) => (
              <option key={o.roomId} value={o.roomId}>
                {sourceLabel(o)}
              </option>
            ))}
          </select>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          やめる
        </Button>
        <Button disabled={!value} onClick={() => onPick(value)}>
          変える
        </Button>
      </DialogFooter>
    </>
  );
}

// ---- 行の追加 ----

export function AddRowDialog({
  open,
  onOpenChange,
  vm,
  data,
  rows,
  initialItemId,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vm: ViewModel;
  data: YearData | null;
  rows: readonly StoredAllocationRow[];
  /** 今のタブの品目（申請品目の既定にする） */
  initialItemId?: string;
  onAdd: (fields: RowFields & { groupId: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? <AddRowForm vm={vm} data={data} rows={rows} initialItemId={initialItemId} onCancel={() => onOpenChange(false)} onAdd={onAdd} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddRowForm({
  vm,
  data,
  rows,
  initialItemId,
  onCancel,
  onAdd,
}: {
  vm: ViewModel;
  data: YearData | null;
  rows: readonly StoredAllocationRow[];
  initialItemId?: string | undefined;
  onCancel: () => void;
  onAdd: (fields: RowFields & { groupId: string }) => void;
}) {
  const id = useId();
  const [groupId, setGroupId] = useState(vm.groups[0]?.id ?? '');
  const reqOpts = useMemo(() => (data && groupId ? requestedOptions(vm, data, rows, groupId) : vm.items.map((item) => ({ item, demand: 0, allocated: 0 }))), [vm, data, rows, groupId]);
  const [requestedPick, setRequested] = useState<string | null>(null);
  const requestedItemId =
    requestedPick && reqOpts.some((o) => o.item.id === requestedPick)
      ? requestedPick
      : (reqOpts.find((o) => o.item.id === initialItemId && o.demand > 0)?.item.id ?? reqOpts[0]?.item.id ?? '');
  const itemOpts = useMemo(() => (groupId && requestedItemId ? itemOptions(vm, data, groupId, requestedItemId) : []), [vm, data, groupId, requestedItemId]);
  const [itemPick, setItem] = useState<string | null>(null);
  const itemId = itemPick && itemOpts.some((o) => o.item.id === itemPick) ? itemPick : (itemOpts[0]?.item.id ?? '');
  const srcOpts = useMemo(() => (itemId ? sourceOptions(vm, rows, itemId) : []), [vm, rows, itemId]);
  const [sourcePick, setSource] = useState<string | null>(null);
  const sourceRoomId = sourcePick && srcOpts.some((o) => o.roomId === sourcePick) ? sourcePick : (srcOpts[0]?.roomId ?? '');
  const req = reqOpts.find((o) => o.item.id === requestedItemId);
  const surplus = srcOpts.find((o) => o.roomId === sourceRoomId)?.surplus ?? null;
  const def = defaultCount({ shortage: (req?.demand ?? 0) - (req?.allocated ?? 0), surplus, requestedName: req?.item.name ?? '' });
  const [countPick, setCount] = useState<number | null>(null);
  const count = countPick ?? def.count;
  const [pinned, setPinned] = useState(false);
  const outOfRule = itemOpts.find((o) => o.item.id === itemId)?.allowed === false;

  const groupsByCat = useMemo(() => {
    const m = new Map<string, typeof vm.groups>();
    for (const g of vm.groups) {
      const k = CATEGORY_LABELS[g.category];
      m.set(k, [...(m.get(k) ?? []), g]);
    }
    return [...m.entries()];
  }, [vm]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>行を追加</DialogTitle>
        <DialogDescription>手動の行として未保存の変更に入れます（保存するまで DB は変わりません）。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-group`}>団体</Label>
          <select
            id={`${id}-group`}
            className={selectClass}
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
              setCount(null);
            }}
          >
            {groupsByCat.map(([cat, gs]) => (
              <optgroup key={cat} label={cat}>
                {gs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-req`}>申請品目</Label>
          <select
            id={`${id}-req`}
            className={selectClass}
            value={requestedItemId}
            onChange={(e) => {
              setRequested(e.target.value);
              setCount(null);
            }}
          >
            {reqOpts.map((o) => (
              <option key={o.item.id} value={o.item.id}>
                {o.item.name}
                {o.demand > 0 ? `（需要 ${o.demand}・振り分け ${o.allocated}）` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-item`}>品目</Label>
          <select
            id={`${id}-item`}
            className={selectClass}
            value={itemId}
            onChange={(e) => {
              setItem(e.target.value);
              setCount(null);
            }}
          >
            {itemOpts.map((o) => (
              <option key={o.item.id} value={o.item.id}>
                {o.item.name}
                {o.allowed ? (o.ruleCode ? `（代替 ${o.ruleCode}）` : '') : `（${OUT_OF_RULE}）`}
              </option>
            ))}
          </select>
          {outOfRule ? <p className="text-xs text-amber-800">{OUT_OF_RULE}</p> : null}
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-source`}>運び元</Label>
          {srcOpts.length === 0 ? (
            <p className="text-sm text-muted-foreground">この品目の在庫がある使用可の場所はありません。</p>
          ) : (
            <select
              id={`${id}-source`}
              className={selectClass}
              value={sourceRoomId}
              onChange={(e) => {
                setSource(e.target.value);
                setCount(null);
              }}
            >
              {srcOpts.map((o) => (
                <option key={o.roomId} value={o.roomId}>
                  {sourceLabel(o)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="grid gap-1">
          <Label>数</Label>
          <CountStepper label="追加する行の数" min={1} value={count} onChange={setCount} />
          {countPick === null && def.hints.length > 0 ? <p className="text-xs text-muted-foreground">{def.hints.join('。')}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={pinned} onCheckedChange={(v) => setPinned(v === true)} />
          固定する
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          やめる
        </Button>
        <Button
          disabled={!groupId || !requestedItemId || !itemId || !sourceRoomId}
          onClick={() => onAdd({ groupId, requestedItemId, itemId, sourceRoomId, count, pinned, note: null })}
        >
          追加する
        </Button>
      </DialogFooter>
    </>
  );
}

// ---- 使用不可にする前の一覧 ----

export function UnusableDialog({
  roomId,
  vm,
  checklist,
  pendingCount,
  busy,
  onOpenChange,
  onOp,
  onConfirm,
}: {
  roomId: string | null;
  vm: ViewModel;
  checklist: readonly UnusableCheckItem[];
  pendingCount: number;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onOp: (op: FixedRowOp, rowId: string) => void;
  onConfirm: (note: string | null) => Promise<void>;
}) {
  return (
    <Dialog open={roomId !== null} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent className="sm:max-w-3xl" showCloseButton={!busy}>
        {roomId ? (
          <UnusableForm
            key={roomId}
            roomName={nameOf(vm, 'room', roomId)}
            vm={vm}
            checklist={checklist}
            pendingCount={pendingCount}
            busy={busy}
            onCancel={() => onOpenChange(false)}
            onOp={onOp}
            onConfirm={onConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UnusableForm({
  roomName,
  vm,
  checklist,
  pendingCount,
  busy,
  onCancel,
  onOp,
  onConfirm,
}: {
  roomName: string;
  vm: ViewModel;
  checklist: readonly UnusableCheckItem[];
  pendingCount: number;
  busy: boolean;
  onCancel: () => void;
  onOp: (op: FixedRowOp, rowId: string) => void;
  onConfirm: (note: string | null) => Promise<void>;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const blocker = unusableBlocker({ checklist, pendingCount });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{roomName}を今年は使用不可にする</DialogTitle>
        <DialogDescription>
          使用不可の部屋の行は、固定を外す変更も保存できません（E002）。手動の行は固定を外しても再実行で動きません。
          先に、この部屋からの固定・手動の行（全品目）を直して保存してから、使用不可にします。
        </DialogDescription>
      </DialogHeader>
      {checklist.length > 0 ? (
        <div className="max-h-80 overflow-auto rounded-md border" data-testid="unusable-checklist">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>団体</TableHead>
                <TableHead>品目</TableHead>
                <TableHead className="text-right">数</TableHead>
                <TableHead>自動／手動</TableHead>
                <TableHead>固定</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {checklist.map(({ row, ops }) => (
                <TableRow key={row.id} data-row-id={row.id}>
                  <TableCell>{nameOf(vm, 'group', row.groupId)}</TableCell>
                  <TableCell>{nameOf(vm, 'item', row.itemId)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                  <TableCell>{ORIGIN_LABELS[row.origin]}</TableCell>
                  <TableCell>{row.pinned ? '固定' : ''}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {ops.map((op) => (
                        <Button key={op} size="xs" variant={op === 'delete' ? 'ghost' : 'outline'} className={op === 'delete' ? 'text-destructive' : undefined} onClick={() => onOp(op, row.id)}>
                          {FIXED_ROW_OP_LABELS[op]}
                        </Button>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="unusable-checklist-empty">
          この部屋からの固定・手動の行はありません。
        </p>
      )}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-note`}>理由のメモ（任意）</Label>
        <Textarea id={`${id}-note`} value={text} disabled={busy || blocker !== null} onChange={(e) => setText(e.target.value)} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {blocker ? (
        <p className="text-sm font-medium text-amber-800" data-testid="unusable-blocker">
          {blocker}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          閉じる
        </Button>
        <Button
          variant="destructive"
          disabled={busy || blocker !== null}
          onClick={async () => {
            const r = parseNote(text);
            if (!r.ok) {
              setError(r.error);
              return;
            }
            await onConfirm(r.note);
          }}
        >
          {busy ? '保存中…' : '使用不可にする'}
        </Button>
      </DialogFooter>
    </>
  );
}
