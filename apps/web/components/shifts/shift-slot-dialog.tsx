'use client';

// 時間枠を足す・直すのダイアログ（04「シフト表」の部門長以上の操作、notes/T20.md「画面の約束」4・8・13。T20・D-56）。部門長以上だけが開く
// （動的 import の shift-lead-dialogs.tsx から）。
// - 欄：日付・始まり・終わり（時刻。終わりが始まり以前なら翌日の時刻として扱い「翌日」と出す。24 時間まで）。送る値は `+09:00`。
// - 足すのはダイアログを開いたときに作った id の insert、直すのは読んだときの updated_at の文字列のまま条件に入れた update（(B1)）。
// - ほかの時間枠と重なれば DB が止め（invalid_input の overlap）、「ほかの時間枠と時間が重なっています（09:00〜10:00）」と出す
//   （detail の slot_id の時間枠の時刻。lib/errors.ts の NameLookup.slot）。
// - 入力は短い（日付と時刻）ので下書きは置かず、閉じる前・アプリの中で移る前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { insertSlot, invalidateShifts, newShiftId, readSlot, updateSlot, type SlotRow } from '@/lib/data/shifts';
import { formatDateTime, tokyoToday } from '@/lib/datetime';
import { classifyError, effectOf, unknownOutcomeMessage } from '@/lib/errors';
import { slotLabelLookup, type BoardSlot, type ShiftBoard } from '@/lib/modules/shifts/board';
import { slotTimeLabel } from '@/lib/modules/shifts/time';
import { checkSlotForm, isNextDayEnd, SHIFT_DATE_MAX, SHIFT_DATE_MIN, slotFormValuesOf, type SlotFormErrors, type SlotFormValues } from '@/lib/schemas/shifts';
import { runRowSave, type RowSaveResult } from './shift-write';
import { CANNOT_SAVE_TEXT, REREAD_AGAIN_FAILED_MESSAGE, WriteNotice, type WriteNoticeState } from './write-notice';

/** 時間枠の「ほかの人が先に変えた」 */
export const SLOT_CONFLICT_NOTICE =
  'ほかの人がこの時間枠を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）';
/** 直す間に時間枠が消えた */
export const SLOT_MISSING_MESSAGE = 'この時間枠は見つかりません（ほかの人が削除した可能性があります）';

const sameInstant = (a: string, b: string) => {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && ta === tb;
};

export interface ShiftSlotDialogProps {
  /** 直す時間枠（足すときは null） */
  slot: BoardSlot | null;
  /** 足すときの日付の既定（開いている日。なければ今日） */
  date: string | null;
  board: ShiftBoard;
  yearId: string;
  writable: boolean;
  onClose: () => void;
  onReload: () => void;
  onReloadMembership: () => void;
  /** 足した・直した時間枠の日を開く */
  onDay: (date: string) => void;
}

type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

export function ShiftSlotDialog({ slot, date, board, yearId, writable, onClose, onReload, onReloadMembership, onDay }: ShiftSlotDialogProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const [mode, setMode] = useState<Mode>(() => (slot ? { type: 'edit', id: slot.id } : { type: 'new', id: newShiftId() }));
  const initial = useMemo<SlotFormValues>(
    () => (slot ? slotFormValuesOf(slot) : { date: date ?? tokyoToday(), start: '09:00', end: '10:00' }),
    [slot, date],
  );
  const [values, setValues] = useState<SlotFormValues>(initial);
  const [errors, setErrors] = useState<SlotFormErrors>({});
  const [notice, setNotice] = useState<WriteNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(slot?.updated_at ?? null);
  const [savedRow, setSavedRow] = useState<SlotRow | null>(slot);
  const baseId = useId();
  const isNew = mode.type === 'new';
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const blocked = !writable || forbidden;
  const nextDay = isNextDayEnd(values);
  const slotName = slotLabelLookup(board);

  const update = (patch: Partial<SlotFormValues>) => setValues((v) => ({ ...v, ...patch }));
  const requestClose = () => {
    if (pending) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const settle = (result: RowSaveResult<SlotRow>, sentDate: string) => {
    switch (result.type) {
      case 'saved':
        invalidateShifts(queryClient, yearId);
        toast.success(isNew ? (result.before ? '時間枠は足されていました' : '時間枠を足しました') : result.before ? '保存されていました' : '保存しました');
        onDay(sentDate);
        onClose();
        return;
      case 'conflict':
        setMode({ type: 'edit', id: result.row.id });
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setNotice({
          type: 'conflict',
          message: SLOT_CONFLICT_NOTICE,
          lines: [`今の時刻：${slotTimeLabel(result.row)}`, `更新：${formatDateTime(result.row.updated_at)}`],
        });
        onReload();
        return;
      case 'missing':
        setMissing(true);
        setNotice({ type: 'missing', message: SLOT_MISSING_MESSAGE });
        onReload();
        return;
      case 'duplicate':
      case 'unknown':
        setNotice({ type: 'message', kind: 'unknown', message: unknownOutcomeMessage(isNew ? '足す' : '保存') });
        return;
      case 'unread':
        setNotice({ type: 'unread' });
        return;
      case 'failed': {
        const c = classifyError(result.error);
        if (c.kind === 'forbidden' || c.kind === 'state') setForbidden(true);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          onReloadMembership();
          onReload();
        } else if (effect.reload === 'data') onReload();
        setNotice({ type: 'error', error: result.error, context: { names: { slot: slotName } } });
        return;
      }
    }
  };

  const save = async () => {
    if (pending || blocked || missing) return;
    const r = checkSlotForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w = r.write;
    const mustSend = notice?.type === 'message';
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameInstant(savedRow.starts_at, w.starts_at) && sameInstant(savedRow.ends_at, w.ends_at)) {
      toast.info('変更はありません');
      onClose();
      return;
    }
    if (mode.type === 'edit' && !lockUpdatedAt) return;
    const id = mode.id;
    const base = mode.type === 'edit' ? lockUpdatedAt : null;
    setNotice(null);
    setPending(true);
    try {
      settle(
        await runRowSave<SlotRow>(
          {
            baseVersion: base,
            matches: (row) => sameInstant(row.starts_at, w.starts_at) && sameInstant(row.ends_at, w.ends_at),
            send: () => (base === null ? insertSlot(yearId, id, w) : updateSlot({ id, updated_at: base }, w)),
            reread: () => readSlot(id),
          },
          onAuthError,
        ),
        values.date,
      );
    } finally {
      setPending(false);
    }
  };

  /** 止められた後に読み直せなかったときの「読み直す」：その時間枠を読み直し、止められたときの道と同じに決める */
  const reread = async () => {
    if (pending || mode.type !== 'edit') return;
    const r = checkSlotForm(values);
    setPending(true);
    try {
      let row: SlotRow | null;
      try {
        row = await readSlot(mode.id);
      } catch {
        toast.error(REREAD_AGAIN_FAILED_MESSAGE);
        return;
      }
      const same = !!row && r.ok && sameInstant(row.starts_at, r.write.starts_at) && sameInstant(row.ends_at, r.write.ends_at);
      settle(!row ? { type: 'missing' } : same ? { type: 'saved', row, before: true } : { type: 'conflict', row }, values.date);
    } finally {
      setPending(false);
    }
  };

  const fieldError = (key: keyof SlotFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;

  return (
    <Dialog open onOpenChange={() => undefined}>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="shift-slot-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-md"
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
          <DialogTitle>{isNew ? '時間枠を足す' : '時間枠を直す'}</DialogTitle>
          <DialogDescription>時刻は日本時間（Asia/Tokyo）です。同じ年度の時間枠と重ならないようにします。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <WriteNotice
            state={notice}
            testIds={{ conflict: 'shift-slot-error', missing: 'shift-slot-error', error: 'shift-slot-error' }}
            onReload={onReload}
            onReread={() => void reread()}
            rereading={pending}
          />
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-date`}>日付</Label>
            <Input
              id={`${baseId}-date`}
              data-testid="shift-slot-date"
              type="date"
              min={SHIFT_DATE_MIN}
              max={SHIFT_DATE_MAX}
              value={values.date}
              onChange={(e) => update({ date: e.target.value })}
              disabled={pending}
              aria-invalid={errors.date ? true : undefined}
            />
            {fieldError('date')}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-start`}>始まり</Label>
              <Input
                id={`${baseId}-start`}
                data-testid="shift-slot-start"
                type="time"
                value={values.start}
                onChange={(e) => update({ start: e.target.value })}
                disabled={pending}
                aria-invalid={errors.start ? true : undefined}
              />
              {fieldError('start')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-end`}>終わり</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${baseId}-end`}
                  data-testid="shift-slot-end"
                  type="time"
                  value={values.end}
                  onChange={(e) => update({ end: e.target.value })}
                  disabled={pending}
                  aria-invalid={errors.end ? true : undefined}
                  aria-describedby={nextDay ? `${baseId}-next-day` : undefined}
                />
                {nextDay ? (
                  <span id={`${baseId}-next-day`} data-testid="shift-slot-next-day" className="shrink-0 rounded bg-muted px-1.5 text-xs">
                    翌日
                  </span>
                ) : null}
              </div>
              {fieldError('end')}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">終わりが始まり以前なら、次の日の時刻として扱います（24 時間まで）。</p>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={pending}>
            やめる
          </Button>
          <Button data-testid="shift-slot-submit" onClick={() => void save()} disabled={pending || blocked || missing} aria-busy={pending || undefined}>
            {pending ? '保存中…' : isNew ? '足す' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない入力を捨てますか"
        description="閉じると、このフォームに入れた内容は消えます。"
        confirmLabel="捨てて閉じる"
        cancelLabel="入力に戻る"
        destructive
        onConfirm={onClose}
      />
    </Dialog>
  );
}
