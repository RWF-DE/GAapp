'use client';

// 作業を足す・編集のダイアログ（04「作業一覧」の部門長以上の操作・保存していない入力・エラーと読み直し、notes/T20.md「画面の約束」7・8・13。
// T20・D-56）。部門長以上だけが開く（終了した年度を除く。canEditTasks）。tasks-screen.tsx が動的 import で読む（総務部門員の JS に入れない）。
// - 欄：題名（必須。前後の空白を除いて 1〜100 字。「{n}/100」）・説明（任意。2000 字。「{n}/2000」）・担当者（その年度の総務から選ぶ。最初の
//   選択肢は「担当者なし」）・締切の日付と時刻（日付を入れると時刻の既定は 17:00。日付が空なら締切なし。時刻だけは誤り）。送る前に
//   lib/schemas/tasks.ts で確かめる。状態はダイアログで送らない（状態のボタンだけ）。
// - 足すのはダイアログを開いたときに作った id の insert（閉じるまで、もう一度の送信と下書きも同じ id）、編集は全部の欄を、読んだときの
//   updated_at の文字列のまま条件に入れた update。何も変えていなければ送らずに「変更はありません」。応答が届かなかったとき・止められた
//   ときは task-write.ts（(B1)。締切と予定と同じ決め方）。担当者が総務でない（not_soumu）は文言を出してロールの一覧を読み直す。
// - 入力はブラウザに下書きとして置き（足すはダイアログの id、編集は作業ごとに読んだときの updated_at も）、開き直したときに戻せる。閉じる前・
//   アプリの中で移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { CANNOT_SAVE_TEXT, REREAD_AGAIN_FAILED_MESSAGE, selectClass, WriteNotice, type WriteNoticeState } from '@/components/shifts/write-notice';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { ROLE_LABELS } from '@/lib/auth/membership';
import { isSoumu, type AppRole } from '@/lib/auth/roles';
import { newShiftId } from '@/lib/data/shifts';
import { insertTask, invalidateTasks, putTaskInCache, readTask, updateTask, type TaskRow } from '@/lib/data/tasks';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, TASK_CONFLICT_MESSAGE, TASK_MISSING_MESSAGE, unknownOutcomeMessage } from '@/lib/errors';
import { compareByName, NAME_UNKNOWN } from '@/lib/modules/shifts/names';
import { charCount } from '@/lib/schemas/notice-fields';
import {
  checkTaskForm,
  EMPTY_TASK_FORM,
  sameTaskWrite,
  TASK_DATE_MAX,
  TASK_DATE_MIN,
  TASK_DEFAULT_TIME,
  TASK_NOTE_MAX,
  TASK_TITLE_MAX,
  taskFormValuesOf,
  type TaskFormErrors,
  type TaskFormValues,
} from '@/lib/schemas/tasks';
import { cn } from '@/lib/utils';
import { rereadRejectedTaskSave, runTaskSave, type TaskSaveResult } from './task-write';

/** 開いているダイアログ：足す（new）か、一覧の作業の編集（edit。task は開いたときの行） */
export type TaskFormTarget = { type: 'new' } | { type: 'edit'; task: TaskRow };

/** conflict：読み直した行を入力の元にして入力を残す（(B1)） */
export const TASK_CONFLICT_NOTICE = `${TASK_CONFLICT_MESSAGE}。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）`;

/** 下書きの値 */
export interface TaskDraft {
  values: TaskFormValues;
  id: string;
  baseUpdatedAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 下書きの形を確かめる（形が違えば戻さない） */
export function normalizeTaskDraft(v: unknown): TaskDraft | null {
  if (!isRecord(v) || !isRecord(v.values)) return null;
  const { title, note, assigneeId, dueDate, dueTime } = v.values;
  for (const s of [title, note, assigneeId, dueDate, dueTime]) if (typeof s !== 'string') return null;
  if (typeof v.id !== 'string') return null;
  if (v.baseUpdatedAt !== null && typeof v.baseUpdatedAt !== 'string') return null;
  return {
    values: { title: title as string, note: note as string, assigneeId: assigneeId as string, dueDate: dueDate as string, dueTime: dueTime as string },
    id: v.id,
    baseUpdatedAt: v.baseUpdatedAt as string | null,
  };
}

export interface TaskFormDialogProps {
  target: TaskFormTarget | null;
  onClose: () => void;
  yearId: string;
  userId: string;
  writable: boolean;
  /** 担当者の選択肢（その年度のロールの一覧） */
  members: readonly { user_id: string; role: AppRole }[];
  names: ReadonlyMap<string, string>;
  /** 一覧を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden の後） */
  onReloadMembership: () => void;
  /** ロールの一覧を読み直す（not_soumu の後） */
  onReloadMembers: () => void;
}

export function TaskFormDialog(props: TaskFormDialogProps) {
  const { target } = props;
  const key = target ? (target.type === 'edit' ? `edit:${target.task.id}` : 'new') : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <TaskFormBody key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

function TaskFormBody({ target, onClose, yearId, userId, writable, members, names, onReload, onReloadMembership, onReloadMembers }: TaskFormDialogProps & { target: TaskFormTarget }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const editing = target.type === 'edit' ? target.task : null;
  const [mode, setMode] = useState<Mode>(() => (editing ? { type: 'edit', id: editing.id } : { type: 'new', id: newShiftId() }));
  const initial = useMemo<TaskFormValues>(() => (editing ? taskFormValuesOf(editing) : { ...EMPTY_TASK_FORM }), [editing]);
  const [values, setValues] = useState<TaskFormValues>(initial);
  const [errors, setErrors] = useState<TaskFormErrors>({});
  const [notice, setNotice] = useState<WriteNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(editing?.updated_at ?? null);
  const [savedRow, setSavedRow] = useState<TaskRow | null>(editing);
  const baseId = useId();

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'tasks', target: editing ? editing.id : 'new' }), [userId, yearId, editing]);
  const writer = useMemo(() => createDraftWriter<TaskDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeTaskDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const isNew = mode.type === 'new';
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const mustSend = (notice?.type === 'message' && notice.kind === 'unknown') || notice?.type === 'unread';
  const blocked = !writable || forbidden;
  const busy = pending || rereading;
  const titleCount = charCount(values.title.trim());
  const noteCount = charCount(values.note.trim());

  // 担当者の選択肢：その年度の総務（表示名の順）。今の担当者が総務でなくなっていれば、その人も残す（外すか選び直す）
  const options = useMemo(() => {
    const list: { userId: string; name: string | null; role: AppRole | null }[] = members
      .filter((m) => isSoumu(m.role) || m.user_id === values.assigneeId)
      .map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? null, role: m.role }));
    if (values.assigneeId && !list.some((o) => o.userId === values.assigneeId)) {
      list.push({ userId: values.assigneeId, name: names.get(values.assigneeId) ?? null, role: null });
    }
    return list.sort(compareByName);
  }, [members, names, values.assigneeId]);

  const writeDraft = (next: TaskFormValues) => {
    if (draft) return;
    if (JSON.stringify(next) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: next, id: mode.id, baseUpdatedAt: mode.type === 'edit' ? lockUpdatedAt : null });
  };
  const update = (patch: Partial<TaskFormValues>) => {
    const next = { ...values, ...patch };
    // 締切の日付を入れたとき、時刻が空なら既定の 17:00 を入れる
    if (patch.dueDate !== undefined && patch.dueDate !== '' && values.dueTime === '') next.dueTime = TASK_DEFAULT_TIME;
    setValues(next);
    writeDraft(next);
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  const finish = (row: TaskRow, before: boolean) => {
    putTaskInCache(queryClient, yearId, row);
    invalidateTasks(queryClient, yearId);
    writer.clear();
    toast.success(isNew ? (before ? `「${row.title}」は作られていました` : `「${row.title}」を足しました`) : before ? '保存されていました' : `「${row.title}」を保存しました`);
    onClose();
  };

  const settle = (result: TaskSaveResult) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, result.before);
        return;
      case 'conflict': {
        const m: Mode = { type: 'edit', id: result.row.id };
        setMode(m);
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setNotice({
          type: 'conflict',
          message: TASK_CONFLICT_NOTICE,
          lines: [`今の題名：${result.row.title}`, `更新：${formatDateTime(result.row.updated_at)}`],
        });
        if (!draft) writer.write({ values, id: m.id, baseUpdatedAt: result.row.updated_at });
        onReload();
        return;
      }
      case 'missing':
        setMissing(true);
        setNotice({ type: 'missing', message: TASK_MISSING_MESSAGE });
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
        // 担当者が総務でない（not_soumu）：ロールの一覧を読み直す（選択肢から外れる）
        if (c.kind === 'input') onReloadMembers();
        setNotice({ type: 'error', error: result.error });
        return;
      }
    }
  };

  const save = async () => {
    if (busy || blocked || missing) return;
    const r = checkTaskForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w = r.write;
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameTaskWrite(savedRow, w)) {
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
        await runTaskSave(
          {
            baseVersion: base,
            matches: (row) => sameTaskWrite(row, w),
            send: () => (base === null ? insertTask(yearId, id, w) : updateTask({ id, updated_at: base }, w)),
            reread: () => readTask(id),
          },
          onAuthError,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const rereadUnread = async () => {
    if (busy || mode.type !== 'edit' || !lockUpdatedAt) return;
    const r = checkTaskForm(values);
    const id = mode.id;
    setRereading(true);
    try {
      const matches = r.ok ? (row: TaskRow) => sameTaskWrite(row, r.write) : null;
      const result = await rereadRejectedTaskSave({ baseVersion: lockUpdatedAt, matches, reread: () => readTask(id) });
      if (result.type === 'unread') toast.error(REREAD_AGAIN_FAILED_MESSAGE);
      else settle(result);
    } finally {
      setRereading(false);
    }
  };

  const restoreDraft = () => {
    if (!draft || busy) return;
    const d = draft.value;
    setValues(d.values);
    if (mode.type === 'new') setMode({ type: 'new', id: d.id });
    if (editing) setLockUpdatedAt(d.baseUpdatedAt ?? editing.updated_at);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const fieldError = (key: keyof TaskFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;
  const ids = { title: `${baseId}-title`, note: `${baseId}-note`, assignee: `${baseId}-assignee`, date: `${baseId}-date`, time: `${baseId}-time` };

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="task-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl"
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
          <DialogTitle>{isNew ? '作業を足す' : '作業を編集'}</DialogTitle>
          <DialogDescription>総務の全員が作業一覧で見られます。状態は一覧の状態のボタンで変えます。</DialogDescription>
        </DialogHeader>
        <div data-testid="task-form" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <WriteNotice
            state={notice}
            testIds={{ conflict: 'task-conflict', missing: 'task-missing', error: 'task-error' }}
            onReload={onReload}
            onReread={() => void rereadUnread()}
            rereading={rereading}
          />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.title}>題名</Label>
              <span data-testid="task-title-count" className={cn('text-xs tabular-nums text-muted-foreground', titleCount > TASK_TITLE_MAX && 'text-destructive')}>
                {titleCount}/{TASK_TITLE_MAX}
              </span>
            </div>
            <Input
              id={ids.title}
              data-testid="task-title"
              value={values.title}
              onChange={(e) => update({ title: e.target.value })}
              disabled={busy}
              aria-invalid={errors.title ? true : undefined}
              autoComplete="off"
            />
            {fieldError('title')}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.note}>説明（任意）</Label>
              <span data-testid="task-note-count" className={cn('text-xs tabular-nums text-muted-foreground', noteCount > TASK_NOTE_MAX && 'text-destructive')}>
                {noteCount}/{TASK_NOTE_MAX}
              </span>
            </div>
            <Textarea
              id={ids.note}
              data-testid="task-note"
              value={values.note}
              rows={4}
              onChange={(e) => update({ note: e.target.value })}
              disabled={busy}
              aria-invalid={errors.note ? true : undefined}
            />
            {fieldError('note')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.assignee}>担当者</Label>
            <select
              id={ids.assignee}
              data-testid="task-assignee"
              className={selectClass}
              value={values.assigneeId}
              onChange={(e) => update({ assigneeId: e.target.value })}
              disabled={busy}
              aria-invalid={errors.assigneeId ? true : undefined}
            >
              <option value="">担当者なし</option>
              {options.map((o) => (
                <option key={o.userId} value={o.userId}>
                  {o.name ?? NAME_UNKNOWN}
                  {o.role ? `（${ROLE_LABELS[o.role]}${isSoumu(o.role) ? '' : '・総務でない'}）` : '（総務でない）'}
                </option>
              ))}
            </select>
            {fieldError('assigneeId')}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.date}>締切の日付（任意）</Label>
              <Input
                id={ids.date}
                data-testid="task-due-date"
                type="date"
                min={TASK_DATE_MIN}
                max={TASK_DATE_MAX}
                value={values.dueDate}
                onChange={(e) => update({ dueDate: e.target.value })}
                disabled={busy}
                aria-invalid={errors.dueDate ? true : undefined}
              />
              {fieldError('dueDate')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.time}>締切の時刻</Label>
              <Input
                id={ids.time}
                data-testid="task-due-time"
                type="time"
                value={values.dueTime}
                onChange={(e) => update({ dueTime: e.target.value })}
                disabled={busy}
                aria-invalid={errors.dueTime ? true : undefined}
              />
              {fieldError('dueTime')}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">日時は日本時間（Asia/Tokyo）です。日付を入れると、時刻の既定は {TASK_DEFAULT_TIME} です。日付が空なら締切なし。</p>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            やめる
          </Button>
          <Button data-testid="task-submit" onClick={() => void save()} disabled={busy || blocked || missing} aria-busy={pending || undefined}>
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
    </>
  );
}
