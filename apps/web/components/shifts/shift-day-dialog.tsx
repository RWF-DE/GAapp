'use client';

// 「1日分をまとめて作る」のダイアログ（04「シフト表」の部門長以上の操作、notes/T20.md「画面の約束」4・8・13。T20・D-56）。部門長以上だけが
// 開く（動的 import の shift-lead-dialogs.tsx から）。
// - 欄：日付（既定は開いている日。なければ今日）・始まり・終わり（15 分ごと。終わりは 24:00 まで選べ、始まりより後）・区切り（15・30・60・
//   90・120 分。既定 60）と、持ち場ごとの「置く」（既定は全部）と必要人数（0〜100。既定 1）。
// - 始まりから区切りごとに時間枠を作り、最後の枠は終わりで切る（slotsOfDayPlan）。並ぶ時間枠（「09:00〜10:00」…と数。1〜96）を見てから
//   「作る」で add_shift_slots を呼ぶ。今ある時間枠と重なるときは、送る前に重なる時間枠を出して「作る」を押せなくする（DB も止める）。
// - 冪等の鍵がないので (B2)：応答が届かなければ、その日の時間枠を読み直し、送った時刻の時間枠が全部あれば「作られていました」。読み直せ
//   なければ「確かめる」を出し、確かめるまで送り直さない（shift-write.ts の runAddDay・verifyAddDay）。
// - 成功したら「{日付} の時間枠を {N} 作りました」と閉じ、その日を開く。
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CountStepper } from '@/components/common/count-stepper';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { addShiftSlots, invalidateShifts, readSlotsOfDay } from '@/lib/data/shifts';
import { tokyoToday } from '@/lib/datetime';
import { formatShortDateWeekday } from '@/lib/datetime-weekday';
import { classifyError, effectOf } from '@/lib/errors';
import { overlappingSlots, slotLabelLookup, slotsOfDayPlan, SLOT_STEPS, sortDuties, type ShiftBoard } from '@/lib/modules/shifts/board';
import { slotTimeLabel } from '@/lib/modules/shifts/time';
import {
  checkDayForm,
  DAY_END_TIMES,
  DAY_START_TIMES,
  emptyDayForm,
  NEED_MAX,
  SHIFT_DATE_MAX,
  SHIFT_DATE_MIN,
  SHIFT_FORM_MESSAGES,
  type DayFormErrors,
  type DayFormValues,
} from '@/lib/schemas/shifts';
import { runAddDay, verifyAddDay, type AddDayResult } from './shift-write';
import { CANNOT_SAVE_TEXT, selectClass, WriteNotice, type WriteNoticeState } from './write-notice';

/** (B2)：応答が届かず、読み直せなかった（「確かめる」まで送り直さない） */
export const ADD_DAY_UNVERIFIED = '作れたか分かりません。「確かめる」を押すと、その日の時間枠を読み直して確かめます（確かめるまで「作る」は押せません）';
/** (B2)：読み直すと作られていなかった */
export const ADD_DAY_NOT_CREATED = '時間枠は作られていませんでした。もう一度「作る」を押してください';
/** (B2)：読み直すと一部だけあった（ほかの人が同じ時刻を作った） */
export const ADD_DAY_PARTIAL = 'ほかの人が同じ日に時間枠を作りました。表を読み直しました。並ぶ時間枠を確かめてください';

export interface ShiftDayDialogProps {
  /** 日付の既定（開いている日。なければ今日） */
  date: string | null;
  board: ShiftBoard;
  yearId: string;
  writable: boolean;
  onClose: () => void;
  onReload: () => void;
  onReloadMembership: () => void;
  /** 作った日を開く */
  onDayCreated: (date: string) => void;
}

export function ShiftDayDialog({ date, board, yearId, writable, onClose, onReload, onReloadMembership, onDayCreated }: ShiftDayDialogProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const duties = useMemo(() => sortDuties(board.duties), [board.duties]);
  const initial = useMemo(() => emptyDayForm(date ?? tokyoToday(), duties), [date, duties]);
  const [values, setValues] = useState<DayFormValues>(initial);
  const [errors, setErrors] = useState<DayFormErrors>({});
  const [notice, setNotice] = useState<WriteNoticeState | null>(null);
  const [pending, setPending] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const baseId = useId();
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const blocked = !writable || forbidden;

  const plan = useMemo(() => slotsOfDayPlan({ date: values.date, start: values.start, end: values.end, stepMinutes: values.step }), [values]);
  const overlaps = useMemo(() => (plan.ok ? overlappingSlots(plan.slots, board.slots) : []), [plan, board.slots]);

  const update = (patch: Partial<DayFormValues>) => setValues((v) => ({ ...v, ...patch }));
  const setNeed = (dutyId: string, patch: Partial<{ on: boolean; count: number }>) =>
    setValues((v) => ({ ...v, needs: { ...v.needs, [dutyId]: { on: true, count: 1, ...v.needs[dutyId], ...patch } } }));

  const requestClose = () => {
    if (pending) return;
    if (dirty && !unverified) setDiscardOpen(true);
    else onClose();
  };

  const dayText = (d: string) => formatShortDateWeekday(d, Number(tokyoToday().slice(0, 4))) || d;

  const settle = (result: AddDayResult, sentDate: string) => {
    switch (result.type) {
      case 'created':
        setUnverified(false);
        invalidateShifts(queryClient, yearId);
        toast.success(result.before ? `${dayText(sentDate)} の時間枠は作られていました` : `${dayText(sentDate)} の時間枠を ${result.count} 作りました`);
        onDayCreated(sentDate);
        onClose();
        return;
      case 'not-created':
        setUnverified(false);
        setNotice({ type: 'message', kind: 'not-created', message: ADD_DAY_NOT_CREATED });
        return;
      case 'unverified':
        setUnverified(true);
        setNotice({ type: 'message', kind: 'unverified', message: ADD_DAY_UNVERIFIED });
        return;
      case 'partial':
        setUnverified(false);
        setNotice({ type: 'message', kind: 'partial', message: ADD_DAY_PARTIAL });
        onReload();
        return;
      case 'failed': {
        const c = classifyError(result.error);
        if (c.kind === 'forbidden' || c.kind === 'state') setForbidden(true);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          onReloadMembership();
          onReload();
        } else if (effect.reload === 'data' || c.kind === 'input' || c.kind === 'blocked') onReload();
        setNotice({ type: 'error', error: result.error, context: { rpc: 'add_shift_slots', names: { slot: slotLabelLookup(board) } } });
        return;
      }
    }
  };

  const submit = async () => {
    if (pending || blocked || unverified) return;
    const r = checkDayForm(values, duties);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok || overlaps.length > 0) return;
    const sentDate = values.date;
    setNotice(null);
    setPending(true);
    try {
      settle(
        await runAddDay(
          {
            planned: r.write.slots,
            send: () => addShiftSlots(yearId, r.write.slots, r.write.needs),
            rereadDay: () => readSlotsOfDay(yearId, sentDate),
          },
          onAuthError,
        ),
        sentDate,
      );
    } finally {
      setPending(false);
    }
  };

  /** 「確かめる」：その日の時間枠を読み直し、送った時刻の時間枠があるかで決める（(B2)） */
  const verify = async () => {
    if (pending) return;
    const r = checkDayForm(values, duties);
    if (!r.ok) return;
    const sentDate = values.date;
    setPending(true);
    try {
      settle(await verifyAddDay(r.write.slots, () => readSlotsOfDay(yearId, sentDate)), sentDate);
    } finally {
      setPending(false);
    }
  };

  const fieldError = (key: keyof DayFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;
  const locked = pending || unverified;

  return (
    <Dialog open onOpenChange={() => undefined}>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="shift-day-dialog"
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
          <DialogTitle>1日分をまとめて作る</DialogTitle>
          <DialogDescription>始まりから区切りごとに時間枠を作り、選んだ持ち場のますを同じ必要人数で置きます（日本時間）。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <WriteNotice state={notice} testIds={{ conflict: 'shift-day-error', missing: 'shift-day-error', error: 'shift-day-error' }} onReload={onReload} />
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-4">
              <Label htmlFor={`${baseId}-date`}>日付</Label>
              <Input
                id={`${baseId}-date`}
                data-testid="shift-day-date"
                type="date"
                className="w-48"
                min={SHIFT_DATE_MIN}
                max={SHIFT_DATE_MAX}
                value={values.date}
                onChange={(e) => update({ date: e.target.value })}
                disabled={locked}
                aria-invalid={errors.date ? true : undefined}
              />
              {fieldError('date')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-start`}>始まり</Label>
              <select
                id={`${baseId}-start`}
                data-testid="shift-day-start"
                className={selectClass}
                value={values.start}
                onChange={(e) => update({ start: e.target.value })}
                disabled={locked}
              >
                {DAY_START_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {fieldError('start')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-end`}>終わり</Label>
              <select
                id={`${baseId}-end`}
                data-testid="shift-day-end"
                className={selectClass}
                value={values.end}
                onChange={(e) => update({ end: e.target.value })}
                disabled={locked}
                aria-invalid={errors.end ? true : undefined}
              >
                {DAY_END_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {fieldError('end')}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${baseId}-step`}>区切り</Label>
              <select
                id={`${baseId}-step`}
                data-testid="shift-day-step"
                className={selectClass}
                value={String(values.step)}
                onChange={(e) => update({ step: Number(e.target.value) })}
                disabled={locked}
              >
                {SLOT_STEPS.map((m) => (
                  <option key={m} value={m}>
                    {m} 分
                  </option>
                ))}
              </select>
              {fieldError('step')}
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">持ち場と必要人数</legend>
            {duties.length === 0 ? (
              <p className="text-sm text-muted-foreground">持ち場がありません。時間枠だけを作ります（ますは「—」）。</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {duties.map((d) => {
                  const n = values.needs[d.id] ?? { on: true, count: 1 };
                  return (
                    <li key={d.id} data-testid="shift-day-need" data-duty-id={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <Checkbox
                          id={`${baseId}-need-${d.id}`}
                          checked={n.on}
                          onCheckedChange={(v) => setNeed(d.id, { on: v === true })}
                          disabled={locked}
                          aria-label={`${d.name}を置く`}
                        />
                        <Label htmlFor={`${baseId}-need-${d.id}`} className="font-normal [overflow-wrap:anywhere]">
                          {d.name}
                        </Label>
                      </div>
                      <CountStepper label={`${d.name}の必要人数`} value={n.count} min={0} max={NEED_MAX} disabled={locked || !n.on} onChange={(v) => setNeed(d.id, { count: v })} />
                    </li>
                  );
                })}
              </ul>
            )}
            {fieldError('needs')}
          </fieldset>
          <section data-testid="shift-day-preview" aria-label="並ぶ時間枠" className="space-y-2">
            <h3 className="text-sm font-medium">
              並ぶ時間枠{plan.ok ? `（${plan.slots.length} 枠）` : ''}
            </h3>
            {plan.ok ? (
              <ul className="flex flex-wrap gap-1.5">
                {plan.slots.map((p) => (
                  <li key={p.starts_at} data-testid="shift-day-preview-slot" className="rounded border px-2 py-0.5 text-xs tabular-nums">
                    {slotTimeLabel(p)}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="shift-day-plan-error" className="text-sm text-destructive">
                {plan.reason === 'order' ? SHIFT_FORM_MESSAGES.endBefore : plan.reason === 'too_many' ? SHIFT_FORM_MESSAGES.tooMany : SHIFT_FORM_MESSAGES.dateRequired}
              </p>
            )}
            {overlaps.length > 0 ? (
              <div role="alert" data-testid="shift-day-overlap" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                今ある時間枠と重なっています：{overlaps.map((s) => slotTimeLabel(s)).join('・')}
              </div>
            ) : null}
          </section>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={pending}>
            やめる
          </Button>
          {unverified ? (
            <Button data-testid="shift-day-verify" onClick={() => void verify()} disabled={pending} aria-busy={pending || undefined}>
              {pending ? '確かめています…' : '確かめる'}
            </Button>
          ) : (
            <Button
              data-testid="shift-day-submit"
              onClick={() => void submit()}
              disabled={pending || blocked || !plan.ok || overlaps.length > 0}
              aria-busy={pending || undefined}
            >
              {pending ? '作っています…' : '作る'}
            </Button>
          )}
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
