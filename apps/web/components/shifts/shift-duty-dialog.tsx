'use client';

// 持ち場を足す・直すのダイアログ（04「シフト表」の部門長以上の操作、notes/T20.md「画面の約束」4・8・13。T20・D-56）。部門長以上だけが開く
// （動的 import の shift-lead-dialogs.tsx から）。
// - 欄：名前（必須。前後の空白を除いて 1〜50 字。「{n}/50」）・場所（任意。100 字）・説明（任意。1000 字）・並び順（整数。既定は今の
//   持ち場の最大＋1）。送る前に lib/schemas/shifts.ts（DB の CHECK と同じ trim・字数）で確かめ、欄の下に誤りを出す。
// - 足すのはダイアログを開いたときに作った id の insert、直すのは読んだときの updated_at の文字列のまま条件に入れた update（(B1)。
//   shift-write.ts の runRowSave）。23505 は、同じ id の持ち場がなければ「同じ名前の持ち場があります」。
// - 入力はブラウザに下書きとして置き（足すはダイアログの id、直すは読んだときの updated_at も）、開き直したときに戻せる。閉じる前・アプリの
//   中で移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { insertDuty, invalidateShifts, newShiftId, readDuty, updateBoardCache, updateDuty } from '@/lib/data/shifts';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, unknownOutcomeMessage } from '@/lib/errors';
import { sortDuties, type BoardDuty } from '@/lib/modules/shifts/board';
import { charCount } from '@/lib/schemas/notice-fields';
import {
  checkDutyForm,
  DUTY_NAME_MAX,
  DUTY_NOTE_MAX,
  DUTY_PLACE_MAX,
  dutyFormValuesOf,
  emptyDutyForm,
  sameDutyWrite,
  type DutyFormErrors,
  type DutyFormValues,
} from '@/lib/schemas/shifts';
import { cn } from '@/lib/utils';
import { runRowSave, type RowSaveResult } from './shift-write';
import { CANNOT_SAVE_TEXT, REREAD_AGAIN_FAILED_MESSAGE, WriteNotice, type WriteNoticeState } from './write-notice';

/** 持ち場の「ほかの人が先に変えた」 */
export const DUTY_CONFLICT_NOTICE =
  'ほかの人がこの持ち場を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）';
/** 直す間に持ち場が消えた */
export const DUTY_MISSING_MESSAGE = 'この持ち場は見つかりません（ほかの人が削除した可能性があります）';
/** 同じ名前の持ち場がある（23505） */
export const DUTY_DUPLICATE_MESSAGE = '同じ名前の持ち場があります';

/** 下書きの値 */
interface DutyDraft {
  values: DutyFormValues;
  id: string;
  baseUpdatedAt: string | null;
}

function normalizeDutyDraft(v: unknown): DutyDraft | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const vals = d.values as Record<string, unknown> | undefined;
  if (!vals || typeof vals !== 'object') return null;
  for (const k of ['name', 'place', 'note', 'sortOrder']) if (typeof vals[k] !== 'string') return null;
  if (typeof d.id !== 'string') return null;
  if (d.baseUpdatedAt !== null && typeof d.baseUpdatedAt !== 'string') return null;
  return {
    values: { name: vals.name as string, place: vals.place as string, note: vals.note as string, sortOrder: vals.sortOrder as string },
    id: d.id,
    baseUpdatedAt: d.baseUpdatedAt as string | null,
  };
}

export interface ShiftDutyDialogProps {
  /** 直す持ち場（足すときは null） */
  duty: BoardDuty | null;
  /** 今の持ち場（並び順の既定） */
  duties: readonly BoardDuty[];
  yearId: string;
  userId: string;
  writable: boolean;
  onClose: () => void;
  onReload: () => void;
  onReloadMembership: () => void;
}

type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

export function ShiftDutyDialog({ duty, duties, yearId, userId, writable, onClose, onReload, onReloadMembership }: ShiftDutyDialogProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const [mode, setMode] = useState<Mode>(() => (duty ? { type: 'edit', id: duty.id } : { type: 'new', id: newShiftId() }));
  const initial = useMemo<DutyFormValues>(() => (duty ? dutyFormValuesOf(duty) : emptyDutyForm(duties)), [duty, duties]);
  const [values, setValues] = useState<DutyFormValues>(initial);
  const [errors, setErrors] = useState<DutyFormErrors>({});
  const [notice, setNotice] = useState<WriteNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(duty?.updated_at ?? null);
  const [savedRow, setSavedRow] = useState<BoardDuty | null>(duty);
  const baseId = useId();

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'shift-duty', target: duty ? duty.id : 'new' }), [userId, yearId, duty]);
  const writer = useMemo(() => createDraftWriter<DutyDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeDutyDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const isNew = mode.type === 'new';
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const mustSend = notice?.type === 'message' && notice.kind === 'unknown';
  const blocked = !writable || forbidden;
  const busy = pending || rereading;
  const nameCount = charCount(values.name.trim());

  const update = (patch: Partial<DutyFormValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (draft) return;
    if (JSON.stringify(next) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: next, id: mode.id, baseUpdatedAt: mode.type === 'edit' ? lockUpdatedAt : null });
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  const finish = (row: BoardDuty, before: boolean) => {
    updateBoardCache(queryClient, yearId, (b) => ({ ...b, duties: sortDuties([...b.duties.filter((d) => d.id !== row.id), row]) }));
    invalidateShifts(queryClient, yearId);
    writer.clear();
    toast.success(isNew ? (before ? `「${row.name}」は足されていました` : `「${row.name}」を足しました`) : before ? '保存されていました' : '保存しました');
    onClose();
  };

  const settle = (result: RowSaveResult<BoardDuty>) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, result.before);
        return;
      case 'conflict': {
        setMode({ type: 'edit', id: result.row.id });
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setNotice({
          type: 'conflict',
          message: DUTY_CONFLICT_NOTICE,
          lines: [`今の名前：${result.row.name}`, `更新：${formatDateTime(result.row.updated_at)}`],
        });
        if (!draft) writer.write({ values, id: result.row.id, baseUpdatedAt: result.row.updated_at });
        onReload();
        return;
      }
      case 'missing':
        setMissing(true);
        setNotice({ type: 'missing', message: DUTY_MISSING_MESSAGE });
        onReload();
        return;
      case 'duplicate':
        setErrors({ name: DUTY_DUPLICATE_MESSAGE });
        setNotice(null);
        onReload();
        return;
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
        setNotice({ type: 'error', error: result.error });
        return;
      }
    }
  };

  const save = async () => {
    if (busy || blocked || missing) return;
    const r = checkDutyForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w = r.write;
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameDutyWrite(savedRow, w)) {
      writer.clear();
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
        await runRowSave<BoardDuty>(
          {
            baseVersion: base,
            matches: (row) => sameDutyWrite(row, w),
            send: () => (base === null ? insertDuty(yearId, id, w) : updateDuty({ id, updated_at: base }, w)),
            reread: () => readDuty(id),
            uniqueName: true,
          },
          onAuthError,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const reread = async () => {
    if (busy || mode.type !== 'edit' || !lockUpdatedAt) return;
    const r = checkDutyForm(values);
    const id = mode.id;
    setRereading(true);
    try {
      let row: BoardDuty | null;
      try {
        row = await readDuty(id);
      } catch {
        toast.error(REREAD_AGAIN_FAILED_MESSAGE);
        return;
      }
      if (!row) settle({ type: 'missing' });
      else if (r.ok && sameDutyWrite(row, r.write)) settle({ type: 'saved', row, before: true });
      else settle({ type: 'conflict', row });
    } finally {
      setRereading(false);
    }
  };

  const restoreDraft = () => {
    if (!draft || busy) return;
    const d = draft.value;
    setValues(d.values);
    if (mode.type === 'new') setMode({ type: 'new', id: d.id });
    if (duty) setLockUpdatedAt(d.baseUpdatedAt ?? duty.updated_at);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const fieldError = (key: keyof DutyFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;

  return (
    <Dialog open onOpenChange={() => undefined}>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="shift-duty-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg"
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
          <DialogTitle>{isNew ? '持ち場を足す' : '持ち場を直す'}</DialogTitle>
          <DialogDescription>持ち場はシフト表の列です（受付・運搬など）。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <WriteNotice
            state={notice}
            testIds={{ conflict: 'shift-duty-error', missing: 'shift-duty-error', error: 'shift-duty-error' }}
            onReload={onReload}
            onReread={() => void reread()}
            rereading={rereading}
          />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={`${baseId}-name`}>名前</Label>
              <span data-testid="shift-duty-name-count" className={cn('text-xs tabular-nums text-muted-foreground', nameCount > DUTY_NAME_MAX && 'text-destructive')}>
                {nameCount}/{DUTY_NAME_MAX}
              </span>
            </div>
            <Input
              id={`${baseId}-name`}
              data-testid="shift-duty-name"
              value={values.name}
              onChange={(e) => update({ name: e.target.value })}
              disabled={busy}
              aria-invalid={errors.name ? true : undefined}
              autoComplete="off"
            />
            {fieldError('name')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-place`}>場所（任意。集合場所など。{DUTY_PLACE_MAX} 字まで）</Label>
            <Input
              id={`${baseId}-place`}
              data-testid="shift-duty-place"
              value={values.place}
              onChange={(e) => update({ place: e.target.value })}
              disabled={busy}
              aria-invalid={errors.place ? true : undefined}
              autoComplete="off"
            />
            {fieldError('place')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-note`}>説明（任意。仕事の説明）</Label>
            <Textarea
              id={`${baseId}-note`}
              data-testid="shift-duty-note"
              value={values.note}
              rows={4}
              onChange={(e) => update({ note: e.target.value })}
              disabled={busy}
              aria-invalid={errors.note ? true : undefined}
            />
            <p className="text-xs text-muted-foreground">{DUTY_NOTE_MAX} 字まで</p>
            {fieldError('note')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-order`}>並び順（小さい順に左から）</Label>
            <Input
              id={`${baseId}-order`}
              data-testid="shift-duty-order"
              inputMode="numeric"
              className="w-32"
              value={values.sortOrder}
              onChange={(e) => update({ sortOrder: e.target.value })}
              disabled={busy}
              aria-invalid={errors.sortOrder ? true : undefined}
              autoComplete="off"
            />
            {fieldError('sortOrder')}
          </div>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            やめる
          </Button>
          <Button data-testid="shift-duty-submit" onClick={() => void save()} disabled={busy || blocked || missing} aria-busy={pending || undefined}>
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
        onConfirm={() => {
          writer.clear();
          onClose();
        }}
      />
    </Dialog>
  );
}
