'use client';

// シフト表の部門長以上の部品（04「シフト表」の部門長以上の操作、notes/T20.md「画面の約束」4。T20・D-56）。shifts-screen.tsx が動的 import
// （next/dynamic）で読み、部門長以上で書けるときだけ描く（総務部門員の /shifts の JS に、ダイアログ・送信と読み直しの決め方を入れない）。
// - 開くもの（target）：1日分をまとめて作る・時間枠を足す・直す・持ち場を足す・直す・ますのダイアログと、時間枠・持ち場の削除の確かめ。
// - 削除の確かめ：時間枠「この時間枠を削除しますか」（割り当てがあれば「この時間枠の {N} 人の割り当ても消えます。」）、持ち場「「{名前}」を
//   削除しますか」（ますと割り当てがあれば「この持ち場の {N} のますと {M} 人の割り当ても消えます。」）。読んだときの updated_at を条件に
//   入れた delete（(B1)。shift-write.ts の runRowDelete）。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { deleteDuty, deleteSlot, invalidateShifts, readDuty, readSlot, updateBoardCache, type MemberRow } from '@/lib/data/shifts';
import { classifyError, effectOf, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { dutyUsage, slotAssignmentCount, type BoardDuty, type BoardSlot, type ShiftBoard } from '@/lib/modules/shifts/board';
import { slotTimeLabel } from '@/lib/modules/shifts/time';
import { ShiftCellDialog } from './shift-cell-dialog';
import { ShiftDayDialog } from './shift-day-dialog';
import { ShiftDutyDialog } from './shift-duty-dialog';
import { ShiftSlotDialog } from './shift-slot-dialog';
import { runRowDelete } from './shift-write';

/** 開くダイアログ */
export type ShiftDialogTarget =
  | { type: 'day'; date: string | null }
  | { type: 'slot-new'; date: string | null }
  | { type: 'slot-edit'; slot: BoardSlot }
  | { type: 'slot-delete'; slot: BoardSlot }
  | { type: 'duty-new' }
  | { type: 'duty-edit'; duty: BoardDuty }
  | { type: 'duty-delete'; duty: BoardDuty }
  | { type: 'cell'; slotId: string; dutyId: string };

/** 削除で、版が違った */
export const SHIFT_DELETE_CHANGED_MESSAGE = 'ほかの人が先に変えました。読み直しました。内容を確かめてから、もう一度削除してください';

export interface ShiftLeadDialogsProps {
  target: ShiftDialogTarget | null;
  onClose: () => void;
  yearId: string;
  userId: string;
  board: ShiftBoard;
  names: ReadonlyMap<string, string>;
  members: readonly MemberRow[];
  writable: boolean;
  onReload: () => void;
  onReloadMembership: () => void;
  /** 作った・直した時間枠の日を開く */
  onDayCreated: (date: string) => void;
}

export function ShiftLeadDialogs(props: ShiftLeadDialogsProps) {
  const { target, onClose, yearId, userId, board, names, members, writable, onReload, onReloadMembership, onDayCreated } = props;
  if (!target) return null;
  switch (target.type) {
    case 'day':
      return (
        <ShiftDayDialog
          date={target.date}
          board={board}
          yearId={yearId}
          writable={writable}
          onClose={onClose}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
          onDayCreated={onDayCreated}
        />
      );
    case 'slot-new':
    case 'slot-edit':
      return (
        <ShiftSlotDialog
          key={target.type === 'slot-edit' ? target.slot.id : 'new'}
          slot={target.type === 'slot-edit' ? target.slot : null}
          date={target.type === 'slot-new' ? target.date : null}
          board={board}
          yearId={yearId}
          writable={writable}
          onClose={onClose}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
          onDay={onDayCreated}
        />
      );
    case 'duty-new':
    case 'duty-edit':
      return (
        <ShiftDutyDialog
          key={target.type === 'duty-edit' ? target.duty.id : 'new'}
          duty={target.type === 'duty-edit' ? target.duty : null}
          duties={board.duties}
          yearId={yearId}
          userId={userId}
          writable={writable}
          onClose={onClose}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
        />
      );
    case 'cell':
      return (
        <ShiftCellDialog
          key={`${target.slotId}:${target.dutyId}`}
          slotId={target.slotId}
          dutyId={target.dutyId}
          board={board}
          names={names}
          members={members}
          yearId={yearId}
          writable={writable}
          onClose={onClose}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
        />
      );
    case 'slot-delete':
    case 'duty-delete':
      return <ShiftDeleteConfirm key={target.type === 'slot-delete' ? target.slot.id : target.duty.id} {...props} target={target} />;
  }
}

function ShiftDeleteConfirm({
  target,
  onClose,
  yearId,
  board,
  onReload,
  onReloadMembership,
}: ShiftLeadDialogsProps & { target: Extract<ShiftDialogTarget, { type: 'slot-delete' | 'duty-delete' }> }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const [error, setError] = useState<string | null>(null);
  const isSlot = target.type === 'slot-delete';
  const title = isSlot ? 'この時間枠を削除しますか' : `「${target.duty.name}」を削除しますか`;
  const description = (() => {
    if (isSlot) {
      const live = board.slots.find((s) => s.id === target.slot.id) ?? target.slot;
      const n = slotAssignmentCount(live);
      return `${slotTimeLabel(live)}。${n > 0 ? `この時間枠の ${n} 人の割り当ても消えます。` : ''}元に戻せません。`;
    }
    const u = dutyUsage(board, target.duty.id);
    return `${u.needs > 0 ? `この持ち場の ${u.needs} のますと ${u.assignments} 人の割り当ても消えます。` : ''}元に戻せません。`;
  })();

  const confirm = async () => {
    // 同じ確かめのダイアログで、前の削除が消せたか分からずに終わった
    const afterUnknown = error !== null;
    setError(null);
    const r = isSlot
      ? await runRowDelete({ send: () => deleteSlot(target.slot), reread: () => readSlot(target.slot.id), baseVersion: target.slot.updated_at }, onAuthError)
      : await runRowDelete({ send: () => deleteDuty(target.duty), reread: () => readDuty(target.duty.id), baseVersion: target.duty.updated_at }, onAuthError);
    const label = isSlot ? 'この時間枠' : `「${target.duty.name}」`;
    switch (r.type) {
      case 'deleted':
        updateBoardCache(queryClient, yearId, (b) =>
          isSlot ? { ...b, slots: b.slots.filter((s) => s.id !== target.slot.id) } : {
            slots: b.slots.map((s) => ({ ...s, shift_needs: s.shift_needs.filter((n) => n.duty_id !== target.duty.id) })),
            duties: b.duties.filter((d) => d.id !== target.duty.id),
          },
        );
        invalidateShifts(queryClient, yearId);
        if (r.before && afterUnknown) toast.success(`${label}は削除されていました`);
        else if (r.before) toast.info('すでに削除されていました（ほかの人が削除した可能性があります）');
        else toast.success(`${label}を削除しました`);
        return;
      case 'changed':
        onReload();
        toast.error(SHIFT_DELETE_CHANGED_MESSAGE);
        return;
      case 'unknown':
        setError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed': {
        const c = classifyError(r.error);
        const effect = effectOf(c);
        if (effect.reload === 'year') onReloadMembership();
        onReload();
        toast.error(messageFor(c));
        return;
      }
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={description}
      confirmLabel="削除する"
      pendingLabel="削除しています…"
      destructive
      onConfirm={confirm}
    >
      <div data-testid="shifts-delete-confirm">
        {error ? (
          <p role="alert" data-testid="shifts-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
