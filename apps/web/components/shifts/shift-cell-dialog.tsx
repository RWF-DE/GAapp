'use client';

// ますのダイアログ（04「シフト表」のますを押したとき、notes/T20.md「画面の約束」4・13。T20・D-56）。部門長以上だけが開く（動的 import の
// shift-lead-dialogs.tsx から）。見出しは「{時刻} {持ち場}」。
// - 必要人数（0〜100）と「保存」。ますのない所（「—」）は「このますを作る」。「このますを外す」（割り当てがあれば人数を出して確かめる）。
//   必要人数は数の絶対値の upsert で、保存のたびに送る前にそのますを読み直し、同じ数なら送らずに「保存されていました」（(A)）。
// - 人を選ぶ一覧：その年度の総務を、表示名・ロール・その日の割り当ての数（「この日 2 枠」）つきで表示名の順に並べる。このますに入っている人
//   には「外す」と「ほかの持ち場へ移す」（同じ時間枠のほかのます。duty_id の update 1回）、その時間枠のほかのますに入っている人には
//   「{持ち場}に入っています」と出して選べなくする（二重の割り当ては DB も止める）、ほかの人には「入れる」。「総務でない人」（閲覧のみに
//   変わった人）の割り当ては「外す」だけ。割り当てる・外す・移すは (B1)（shift-write.ts）。書いた結果は表のキャッシュにすぐ入れてから読み直す。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CountStepper } from '@/components/common/count-stepper';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { ROLE_LABELS } from '@/lib/auth/membership';
import {
  assign,
  deleteNeed,
  invalidateShifts,
  moveAssignment,
  readAssignment,
  readNeed,
  unassign,
  updateBoardCache,
  upsertNeed,
  type MemberRow,
} from '@/lib/data/shifts';
import { classifyError, effectOf, SHIFT_GONE_MESSAGE, unknownOutcomeMessage } from '@/lib/errors';
import {
  boardWithAssignment,
  boardWithNeed,
  boardWithoutAssignment,
  boardWithoutNeed,
  memberChoices,
  otherCellsOfSlot,
  type MemberChoice,
  type ShiftBoard,
} from '@/lib/modules/shifts/board';
import { NAME_UNKNOWN } from '@/lib/modules/shifts/names';
import { slotTimeLabel } from '@/lib/modules/shifts/time';
import { NEED_MAX } from '@/lib/schemas/shifts';
import { cn } from '@/lib/utils';
import { NOT_SOUMU_LABEL } from './shift-table';
import { runAssign, runMove, runNeedSave, runRowDelete } from './shift-write';
import { selectClass, WriteNotice, type WriteNoticeState } from './write-notice';

/** 割り当ての 23505 で読み直すと、ほかのますにいた */
export const ASSIGN_BUSY_MESSAGE = 'この人は同じ時間枠に、ほかの持ち場で入っています';
/** 割り当て・ますが先に変えられた（外す・移すの conflict） */
export const CELL_CHANGED_MESSAGE = 'ほかの人がこのますを先に変えました。読み直しました';

export interface ShiftCellDialogProps {
  slotId: string;
  dutyId: string;
  board: ShiftBoard;
  names: ReadonlyMap<string, string>;
  members: readonly MemberRow[];
  yearId: string;
  writable: boolean;
  onClose: () => void;
  onReload: () => void;
  onReloadMembership: () => void;
}

export function ShiftCellDialog({ slotId, dutyId, board, names, members, yearId, writable, onClose, onReload, onReloadMembership }: ShiftCellDialogProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const slot = board.slots.find((s) => s.id === slotId) ?? null;
  const duty = board.duties.find((d) => d.id === dutyId) ?? null;
  const need = slot?.shift_needs.find((n) => n.duty_id === dutyId) ?? null;
  const [count, setCount] = useState<number>(need?.required_count ?? 1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<WriteNoticeState | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const dirty = !!need && count !== need.required_count;
  const blocked = !writable || forbidden;
  const time = slot ? slotTimeLabel(slot) : '';
  const nameOf = (userId: string) => names.get(userId) ?? NAME_UNKNOWN;

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  /** そのほかの失敗：権限・年度の状態は立場を読み直し、ます・時間枠・持ち場が消えていれば（23503）その文言にして表を読み直す */
  const fail = (error: unknown) => {
    const c = classifyError(error);
    if (c.kind === 'forbidden' || c.kind === 'state') setForbidden(true);
    const effect = effectOf(c);
    if (effect.reload === 'year') onReloadMembership();
    onReload();
    // 23503（ます・時間枠・持ち場が先に消された）。not_soumu などの invalid_input は lib/errors.ts の文言（ErrorBanner）
    if (c.kind === 'blocked') setNotice({ type: 'message', kind: 'gone', message: SHIFT_GONE_MESSAGE });
    else setNotice({ type: 'error', error });
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy || blocked) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const saveNeed = () =>
    run(async () => {
      const creating = !need;
      const r = await runNeedSave({ count, reread: () => readNeed(slotId, dutyId), send: () => upsertNeed(yearId, slotId, dutyId, count) }, onAuthError);
      if (r.type === 'saved') {
        updateBoardCache(queryClient, yearId, (b) => boardWithNeed(b, r.row));
        invalidateShifts(queryClient, yearId);
        setCount(r.row.required_count);
        toast.success(r.before ? '保存されていました' : creating ? 'ますを作りました' : '保存しました');
      } else if (r.type === 'unknown') setNotice({ type: 'message', kind: 'unknown', message: unknownOutcomeMessage('保存') });
      else fail(r.error);
    });

  const removeNeed = async () => {
    if (!need) return;
    setRemoveError(null);
    const r = await runRowDelete(
      {
        send: () => deleteNeed({ slot_id: slotId, duty_id: dutyId, updated_at: need.updated_at }),
        reread: () => readNeed(slotId, dutyId),
        baseVersion: need.updated_at,
      },
      onAuthError,
    );
    switch (r.type) {
      case 'deleted':
        updateBoardCache(queryClient, yearId, (b) => boardWithoutNeed(b, slotId, dutyId));
        invalidateShifts(queryClient, yearId);
        toast.success(r.before ? 'このますはすでに外れていました' : 'ますを外しました');
        onClose();
        return;
      case 'changed':
        onReload();
        setNotice({ type: 'message', kind: 'changed', message: `${CELL_CHANGED_MESSAGE}。内容を確かめてから、もう一度外してください` });
        return;
      case 'unknown':
        setRemoveError(unknownOutcomeMessage('外す'));
        throw new Error('keep-open');
      case 'failed':
        fail(r.error);
        return;
    }
  };

  const assignOne = (c: MemberChoice) =>
    run(async () => {
      const r = await runAssign({ dutyId, send: () => assign(yearId, slotId, dutyId, c.userId), reread: () => readAssignment(slotId, c.userId) }, onAuthError);
      if (r.type === 'saved' || r.type === 'busy') {
        updateBoardCache(queryClient, yearId, (b) => boardWithAssignment(b, r.row));
        invalidateShifts(queryClient, yearId);
      }
      if (r.type === 'saved') toast.success(r.before ? '割り当てられていました' : `${nameOf(c.userId)}を${duty?.name ?? ''}に入れました`);
      else if (r.type === 'busy') setNotice({ type: 'message', kind: 'busy', message: ASSIGN_BUSY_MESSAGE });
      else if (r.type === 'unknown') setNotice({ type: 'message', kind: 'unknown', message: unknownOutcomeMessage('入れる') });
      else if (r.type === 'failed') fail(r.error);
    });

  const unassignOne = (c: MemberChoice) =>
    run(async () => {
      if (!c.updatedAt) return;
      const base = c.updatedAt;
      const r = await runRowDelete(
        { send: () => unassign({ slot_id: slotId, user_id: c.userId, updated_at: base }), reread: () => readAssignment(slotId, c.userId), baseVersion: base },
        onAuthError,
      );
      if (r.type === 'deleted') {
        updateBoardCache(queryClient, yearId, (b) => boardWithoutAssignment(b, slotId, c.userId));
        invalidateShifts(queryClient, yearId);
        toast.success(r.before ? `${nameOf(c.userId)}はすでに外れていました` : `${nameOf(c.userId)}を外しました`);
      } else if (r.type === 'changed') {
        onReload();
        setNotice({ type: 'message', kind: 'changed', message: CELL_CHANGED_MESSAGE });
      } else if (r.type === 'unknown') setNotice({ type: 'message', kind: 'unknown', message: unknownOutcomeMessage('外す') });
      else fail(r.error);
    });

  const moveOne = (c: MemberChoice, targetDutyId: string) =>
    run(async () => {
      if (!c.updatedAt) return;
      const base = c.updatedAt;
      const target = board.duties.find((d) => d.id === targetDutyId);
      const r = await runMove(
        {
          dutyId: targetDutyId,
          baseVersion: base,
          send: () => moveAssignment({ slot_id: slotId, user_id: c.userId, updated_at: base }, targetDutyId),
          reread: () => readAssignment(slotId, c.userId),
        },
        onAuthError,
      );
      if (r.type === 'saved') {
        updateBoardCache(queryClient, yearId, (b) => boardWithAssignment(b, r.row));
        invalidateShifts(queryClient, yearId);
        toast.success(r.before ? '移されていました' : `${nameOf(c.userId)}を${target?.name ?? ''}に移しました`);
      } else if (r.type === 'changed') {
        const row = r.row;
        updateBoardCache(queryClient, yearId, (b) => (row ? boardWithAssignment(b, row) : boardWithoutAssignment(b, slotId, c.userId)));
        onReload();
        setNotice({ type: 'message', kind: 'changed', message: CELL_CHANGED_MESSAGE });
      } else if (r.type === 'unknown') setNotice({ type: 'message', kind: 'unknown', message: unknownOutcomeMessage('移す') });
      else if (r.type === 'failed') fail(r.error);
    });

  const gone = !slot || !duty;
  const choices = gone || !need ? [] : memberChoices(board, members, names, slotId, dutyId);
  const others = gone ? [] : otherCellsOfSlot(board, slotId, dutyId);
  const inCount = need ? need.shift_assignments.length : 0;

  return (
    <Dialog open onOpenChange={() => undefined}>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="shift-cell-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-xl"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onPointerDownOutside={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>{gone ? 'ます' : `${time} ${duty.name}`}</DialogTitle>
          <DialogDescription>{need ? '必要人数と、入る人を決めます。' : 'このますはまだありません（表では「—」）。'}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <WriteNotice state={notice} testIds={{ conflict: 'shift-cell-error', missing: 'shift-cell-error', error: 'shift-cell-error' }} onReload={onReload} />
          {gone ? (
            <p data-testid="shift-cell-error" data-kind="gone" className="text-sm text-destructive">
              {SHIFT_GONE_MESSAGE}
            </p>
          ) : (
            <>
              <section aria-label="必要人数" className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">必要人数</p>
                  <div data-testid="shift-need-count">
                    <CountStepper label="必要人数" value={count} min={0} max={NEED_MAX} disabled={busy || blocked} onChange={setCount} />
                  </div>
                </div>
                <Button data-testid="shift-need-save" onClick={() => void saveNeed()} disabled={busy || blocked} aria-busy={busy || undefined}>
                  {need ? '保存' : 'このますを作る'}
                </Button>
                {need ? (
                  <Button
                    variant="outline"
                    className="text-destructive"
                    data-testid="shift-need-remove"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoveOpen(true);
                    }}
                    disabled={busy || blocked}
                  >
                    このますを外す
                  </Button>
                ) : null}
                <p className="w-full text-xs text-muted-foreground">0 は「人数を決めない」（ますには人数だけを出します）。</p>
              </section>
              {need ? (
                <section aria-label="入る人" className="space-y-2">
                  <h3 className="text-sm font-medium">入る人（総務）</h3>
                  {choices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">選べる人がいません（総務のロールの一覧を読み込み中か、読めませんでした）。</p>
                  ) : (
                    <ul data-testid="shift-member-picker" className="divide-y rounded-md border">
                      {choices.map((c) => (
                        <MemberOption
                          key={c.userId}
                          choice={c}
                          others={others}
                          disabled={busy || blocked}
                          onAssign={() => void assignOne(c)}
                          onUnassign={() => void unassignOne(c)}
                          onMove={(d) => void moveOne(c, d)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : (
                <p className="text-sm text-muted-foreground">先に「このますを作る」で必要人数を決めると、人を入れられます。</p>
              )}
            </>
          )}
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveOpen(false);
            setRemoveError(null);
          }
        }}
        title="このますを外しますか"
        description={inCount > 0 ? `${inCount} 人の割り当ても消えます。` : 'このますは「—」になります。'}
        confirmLabel="外す"
        pendingLabel="外しています…"
        destructive
        onConfirm={removeNeed}
      >
        <div data-testid="shifts-delete-confirm">
          {removeError ? (
            <p role="alert" data-testid="shifts-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {removeError}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない入力を捨てますか"
        description="閉じると、変えた必要人数は消えます。"
        confirmLabel="捨てて閉じる"
        cancelLabel="入力に戻る"
        destructive
        onConfirm={onClose}
      />
    </Dialog>
  );
}

function MemberOption({
  choice: c,
  others,
  disabled,
  onAssign,
  onUnassign,
  onMove,
}: {
  choice: MemberChoice;
  others: readonly { id: string; name: string }[];
  disabled: boolean;
  onAssign: () => void;
  onUnassign: () => void;
  onMove: (dutyId: string) => void;
}) {
  const name = c.name ?? NAME_UNKNOWN;
  return (
    <li data-testid="shift-member-option" data-user-id={c.userId} data-state={c.state} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', c.state === 'busy' && 'bg-muted/40')}>
      <div className="min-w-0 flex-1">
        <p className="font-medium [overflow-wrap:anywhere]">
          {name}
          {c.role ? <span className="ml-2 text-xs font-normal text-muted-foreground">{ROLE_LABELS[c.role]}</span> : null}
          {!c.soumu ? (
            <Badge variant="outline" className="ml-2 border-amber-400 text-amber-900">
              {NOT_SOUMU_LABEL}
            </Badge>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">この日 {c.dayCount} 枠</p>
        {c.state === 'busy' ? (
          <p data-testid="shift-member-busy" className="text-xs text-amber-900">
            {c.dutyName ?? 'ほかの持ち場'}に入っています
          </p>
        ) : null}
      </div>
      {c.state === 'free' ? (
        <Button size="sm" data-testid="shift-member-assign" onClick={onAssign} disabled={disabled || !c.soumu} aria-label={`${name}を入れる`}>
          入れる
        </Button>
      ) : null}
      {c.state === 'in' ? (
        <div className="flex flex-wrap items-center gap-2">
          {c.soumu && others.length > 0 ? (
            <select
              data-testid="shift-member-move"
              className={cn(selectClass, 'h-8 w-auto')}
              aria-label={`${name}をほかの持ち場へ移す`}
              value=""
              disabled={disabled}
              onChange={(e) => {
                if (e.target.value) onMove(e.target.value);
              }}
            >
              <option value="">ほかの持ち場へ移す</option>
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" variant="outline" data-testid="shift-member-unassign" onClick={onUnassign} disabled={disabled} aria-label={`${name}を外す`}>
            外す
          </Button>
        </div>
      ) : null}
    </li>
  );
}
