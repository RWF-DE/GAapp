'use client';

// 締切・予定の登録・編集のダイアログ（04「締切と予定」の登録・編集・保存していない入力・エラーと読み直し、notes/T18.md「後半（画面）の
// 約束」7。T18・D-54）。部門長以上だけが開く（終了した年度を除く。canWriteEvents）。
// - 欄：種類・対象（読む人の説明つき）・題名・終日・日付（終日なら日付と最後の日、でなければ開始と終わりの日時。Asia/Tokyo）・メモ。
//   送る前に lib/schemas/calendar.ts（DB の CHECK と同じ trim・字数・日付の範囲）で確かめ、欄の下に誤りを出す。
// - 登録はダイアログを開いたときに作った id で insert する（閉じるまで、もう一度の送信と下書きも同じ id。(B1)：送り直しは 23505 で止まる）。
//   保存は全部の欄を、読んだときの updated_at の文字列のまま条件に入れて update する。何も変えていなければ送らずに「変更はありません」。
// - 応答が届かなかったとき・止められたときは event-write.ts（2.6 の (B1)）。conflict は読み直した行を入力の元にして入力を残し（次の
//   保存はその版で送り、入力で上書きする。登録の 23505 で中身が違えば、その項目の編集に切り替える）、消えていたら「保存」を押せなくする。
//   権限か年度の状態が変わった（42501・lock_unchanged）は年度の行と立場を読み直し、送るボタンを押せなくする（入力は残す）。
// - 入力はブラウザに下書きとして置き（lib/drafts.ts。登録はダイアログの id、編集は項目ごとに読んだときの updated_at も）、開き直したときに
//   戻せる（DraftNotice）。閉じる前・アプリの中で移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { ErrorBanner } from '@/components/common/error-banner';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  EVENT_AUDIENCES,
  EVENT_KINDS,
  insertEvent,
  invalidateCalendar,
  newEventId,
  putEventInCache,
  readEvent,
  sameEventWrite,
  updateEvent,
  type CalendarEventRow,
  type EventAudience,
  type EventKind,
  type EventWrite,
} from '@/lib/data/calendar';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, unknownOutcomeMessage } from '@/lib/errors';
import { EVENT_AUDIENCE_LABELS, EVENT_KIND_LABELS } from '@/lib/modules/calendar/labels';
import { charCount } from '@/lib/schemas/notice-fields';
import {
  checkEventForm,
  EMPTY_EVENT_FORM,
  EVENT_DATE_MAX,
  EVENT_DATE_MIN,
  EVENT_NOTE_MAX,
  EVENT_TITLE_MAX,
  eventFormValuesOf,
  toggleAllDay,
  type EventFormErrors,
  type EventFormValues,
} from '@/lib/schemas/calendar';
import { cn } from '@/lib/utils';
import { runEventSave, type EventSaveResult } from './event-write';

/** 開いているダイアログ：登録（new）か、一覧の項目の編集（edit。event は開いたときの行） */
export type EventFormTarget = { type: 'new' } | { type: 'edit'; event: CalendarEventRow };

export interface EventFormDialogProps {
  target: EventFormTarget | null;
  onClose: () => void;
  yearId: string;
  /** 自分の user_id（下書きのキー） */
  userId: string;
  /** 書けるか（部門長以上で、年度が終了していない）。偽になったら送るボタンを押せない */
  writable: boolean;
  /** 一覧を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden の後） */
  onReloadMembership: () => void;
}

/** 対象ごとの読む人の説明（04「締切と予定」の欄） */
export const AUDIENCE_HELP: Readonly<Record<EventAudience, string>> = {
  soumu: '総務だけが見ます',
  groups: '団体の店長・副店長に向けた項目です。総務と閲覧のみの人も見ます',
  all: '全員に向けた項目です。総務・閲覧のみの人と、団体の店長・副店長が見ます',
};

/** 項目の「ほかの人が先に変えた」（04「締切と予定」のエラーと読み直し） */
export const EVENT_CONFLICT_MESSAGE = 'ほかの人がこの項目を先に変えました。読み直しました';
/** conflict：読み直した行を入力の元にして入力を残す（(B1)） */
export const CONFLICT_NOTICE = `${EVENT_CONFLICT_MESSAGE}。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）`;
/** 保存の間に項目が消えた（読み直してもない） */
export const EVENT_MISSING_MESSAGE = 'この項目は見つかりません（ほかの人が削除した可能性があります）';
/** 送るボタンを押せないとき（書けない・権限か年度の状態が変わった）の足もとの文 */
export const CANNOT_SAVE_TEXT = '今の立場・年度の状態では保存できません';
/** 止められた後に読み直せなかった（「読み直しました」とは言わない） */
export const REREAD_FAILED_NOTICE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';
/** 日時の読み方の説明 */
export const TIME_ZONE_HELP = '日時は日本時間（Asia/Tokyo）として読みます';

/** 送った後の知らせ（本文の先頭に出す） */
type SubmitState =
  | { type: 'conflict'; row: CalendarEventRow }
  | { type: 'missing' }
  | { type: 'unknown'; message: string; showReload?: boolean }
  | { type: 'error'; error: unknown };

/** 下書きの値（入力と、登録ならダイアログで作った id、編集なら読んだときの updated_at） */
export interface EventDraft {
  values: EventFormValues;
  /** 送る先の id（登録はダイアログで作った id） */
  id: string | null;
  /** 編集の版（読んだときの updated_at）。登録は null */
  baseUpdatedAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 下書きの形を確かめる（形が違えば戻さない） */
export function normalizeEventDraft(v: unknown): EventDraft | null {
  if (!isRecord(v) || !isRecord(v.values)) return null;
  const { kind, audience, title, allDay, startDate, endDate, start, end, note } = v.values;
  if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof audience !== 'string' || !(EVENT_AUDIENCES as readonly string[]).includes(audience)) return null;
  if (typeof allDay !== 'boolean') return null;
  for (const s of [title, startDate, endDate, start, end, note]) if (typeof s !== 'string') return null;
  const id = v.id;
  const base = v.baseUpdatedAt;
  if (id !== null && typeof id !== 'string') return null;
  if (base !== null && typeof base !== 'string') return null;
  return {
    values: {
      kind: kind as EventKind,
      audience: audience as EventAudience,
      title: title as string,
      allDay,
      startDate: startDate as string,
      endDate: endDate as string,
      start: start as string,
      end: end as string,
      note: note as string,
    },
    id,
    baseUpdatedAt: base,
  };
}

export function EventFormDialog(props: EventFormDialogProps) {
  const { target } = props;
  // target が変わるたびに中身を作り直す（前の項目の入力を持ち込まない）
  const key = target ? (target.type === 'edit' ? `edit:${target.event.id}` : 'new') : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <EventFormBody key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

/** 送る先：登録（ダイアログの id）か、項目の編集（その id） */
type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

function EventFormBody({ target, onClose, yearId, userId, writable, onReload, onReloadMembership }: EventFormDialogProps & { target: EventFormTarget }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const editing = target.type === 'edit' ? target.event : null;
  const [mode, setMode] = useState<Mode>(() => (editing ? { type: 'edit', id: editing.id } : { type: 'new', id: newEventId() }));
  const initial = useMemo<EventFormValues>(() => (editing ? eventFormValuesOf(editing) : { ...EMPTY_EVENT_FORM }), [editing]);
  const [values, setValues] = useState<EventFormValues>(initial);
  const [errors, setErrors] = useState<EventFormErrors>({});
  const [submit, setSubmit] = useState<SubmitState | null>(null);
  const [pending, setPending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // 権限か年度の状態が変わった（42501・lock_unchanged）：このダイアログでは送らない（入力は残す）
  const [forbidden, setForbidden] = useState(false);
  // 編集の楽観ロックの版（入力の元。開いたときの行の updated_at）。進めるのは conflict で読み直した行を入力の元にしたときと、
  // 下書きを戻したとき（下書きの updated_at）だけ（一覧の読み直しでは進めない）
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(editing?.updated_at ?? null);
  // 保存してある行（「変更はありません」の比べる相手）。conflict の後は読み直した行
  const [savedRow, setSavedRow] = useState<CalendarEventRow | null>(editing);
  const bodyRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const ids = {
    kind: `${baseId}-kind`,
    audience: `${baseId}-audience`,
    title: `${baseId}-title`,
    allDay: `${baseId}-all-day`,
    startDate: `${baseId}-start-date`,
    endDate: `${baseId}-end-date`,
    start: `${baseId}-start`,
    end: `${baseId}-end`,
    note: `${baseId}-note`,
    tzHelp: `${baseId}-tz-help`,
  };

  // 下書き（登録は 'new'、編集は項目の id。開いたときの target で決める）
  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'calendar', target: editing ? editing.id : 'new' }), [userId, yearId, editing]);
  const writer = useMemo(() => createDraftWriter<EventDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeEventDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const isNew = mode.type === 'new';
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  // 応答が届かなかった後・止められた後に読み直せなかったときは、DB の行が入力の元と同じか分からないので、「変更はありません」で閉じずに送る
  const mustSend = submit?.type === 'unknown';
  const titleCount = charCount(values.title.trim());
  const noteCount = charCount(values.note.trim());
  const blocked = !writable || forbidden;

  // 誤りが出たら最初の誤りの欄を見える所に出す
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    bodyRef.current?.querySelector('[data-field-error]')?.scrollIntoView?.({ block: 'center' });
  }, [errors]);
  useEffect(() => {
    if (!submit) return;
    bodyRef.current?.querySelector('[data-submit-error]')?.scrollIntoView?.({ block: 'nearest' });
  }, [submit]);

  const writeDraft = (next: EventFormValues, m: Mode = mode, base: string | null = lockUpdatedAt) => {
    // 下書き：戻すか捨てるかを決めるまでは上書きしない。開いたときの値に戻したら消す
    if (draft) return;
    if (JSON.stringify(next) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: next, id: m.id, baseUpdatedAt: m.type === 'edit' ? base : null });
  };

  const update = (patch: Partial<EventFormValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    writeDraft(next);
  };

  const setAllDay = (allDay: boolean) => {
    const next = toggleAllDay(values, allDay);
    setValues(next);
    writeDraft(next);
  };

  const requestClose = () => {
    if (pending) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  /** 保存できた（登録した・保存した・されていた）：一覧のキャッシュに入れて読み直し、下書きを消して閉じる */
  const finish = (row: CalendarEventRow, before: boolean) => {
    putEventInCache(queryClient, yearId, row);
    invalidateCalendar(queryClient, yearId);
    writer.clear();
    toast.success(isNew ? (before ? `「${row.title}」は登録されていました` : `「${row.title}」を登録しました`) : before ? '保存されていました' : `「${row.title}」を保存しました`);
    onClose();
  };

  /** 送った結果の出し方 */
  const settle = (result: EventSaveResult) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, result.before);
        return;
      case 'conflict': {
        // 読み直した行を入力の元にする（次の保存はその版で送り、この入力で上書きする。登録の 23505 なら、その項目の編集に切り替える）。
        // 一覧も読み直す
        const m: Mode = { type: 'edit', id: result.row.id };
        setMode(m);
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setSubmit({ type: 'conflict', row: result.row });
        if (!draft) writer.write({ values, id: m.id, baseUpdatedAt: result.row.updated_at });
        onReload();
        return;
      }
      case 'missing':
        setSubmit({ type: 'missing' });
        onReload();
        return;
      case 'unknown':
        setSubmit({ type: 'unknown', message: unknownOutcomeMessage(isNew ? '登録' : '保存') });
        return;
      case 'unread':
        setSubmit({ type: 'unknown', message: REREAD_FAILED_NOTICE, showReload: true });
        return;
      case 'failed': {
        const c = classifyError(result.error);
        const effect = effectOf(c);
        if (c.kind === 'forbidden') setForbidden(true);
        if (effect.reload === 'year') {
          onReloadMembership();
          onReload();
        } else if (effect.reload === 'data') onReload();
        setSubmit({ type: 'error', error: result.error });
        return;
      }
    }
  };

  const save = async () => {
    if (pending || blocked || submit?.type === 'missing') return;
    const r = checkEventForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w: EventWrite = r.write;
    // 編集で何も変えていない（保存してある行と同じで、版も同じ）なら送らずに閉じる。応答が届かなかった後などは必ず送る
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameEventWrite(savedRow, w)) {
      writer.clear();
      toast.info('変更はありません');
      onClose();
      return;
    }
    if (mode.type === 'edit' && !lockUpdatedAt) return;
    const id = mode.id;
    const base = mode.type === 'edit' ? lockUpdatedAt : null;
    setSubmit(null);
    setPending(true);
    try {
      const result = await runEventSave(
        {
          baseVersion: base,
          write: w,
          send: () => (base === null ? insertEvent(yearId, id, w) : updateEvent({ id, updated_at: base }, w)),
          reread: () => readEvent(id),
        },
        onAuthError,
      );
      settle(result);
    } finally {
      setPending(false);
    }
  };

  const restoreDraft = () => {
    if (!draft) return;
    const d = draft.value;
    setValues(d.values);
    // 登録は下書きの id で送る（前の送信が通っていれば 23505 で止まり、読み直して決める）。編集は下書きを書いたときの版で送る
    // （間にほかの人が変えていれば conflict になり、読み直して決める）
    if (mode.type === 'new' && d.id) setMode({ type: 'new', id: d.id });
    if (editing) setLockUpdatedAt(d.baseUpdatedAt ?? editing.updated_at);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const sendLabel = isNew ? (pending ? '登録しています…' : '登録') : pending ? '保存中…' : '保存';
  const fieldError = (key: keyof EventFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="event-dialog"
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
          <DialogTitle>{isNew ? '締切・予定を登録' : '締切・予定を編集'}</DialogTitle>
          <DialogDescription>
            {isNew ? '対象の人は、締切と予定の一覧とダッシュボードで見られます。' : '保存すると、対象の人にすぐ見えます。'}
          </DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} data-testid="event-form" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <SubmitNotice submit={submit} onReload={onReload} />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}

          <div data-field="kind" className="space-y-2">
            <p id={ids.kind} className="text-sm font-medium">
              種類
            </p>
            <RadioGroup
              data-testid="event-kind"
              aria-labelledby={ids.kind}
              value={values.kind}
              onValueChange={(v) => update({ kind: v as EventKind })}
              disabled={pending}
              className="flex flex-wrap gap-x-6 gap-y-2"
            >
              {EVENT_KINDS.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids.kind}-${k}`} value={k} />
                  <Label htmlFor={`${ids.kind}-${k}`} className="font-normal">
                    {EVENT_KIND_LABELS[k]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div data-field="audience" className="space-y-2">
            <p id={ids.audience} className="text-sm font-medium">
              対象
            </p>
            <RadioGroup
              data-testid="event-audience"
              aria-labelledby={ids.audience}
              value={values.audience}
              onValueChange={(v) => update({ audience: v as EventAudience })}
              disabled={pending}
              className="gap-2"
            >
              {EVENT_AUDIENCES.map((a) => (
                <div key={a} className="flex items-start gap-2">
                  <RadioGroupItem id={`${ids.audience}-${a}`} value={a} aria-describedby={`${ids.audience}-${a}-help`} className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor={`${ids.audience}-${a}`} className="font-normal">
                      {EVENT_AUDIENCE_LABELS[a]}
                    </Label>
                    <p id={`${ids.audience}-${a}-help`} className="text-xs text-muted-foreground">
                      {AUDIENCE_HELP[a]}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div data-field="title" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.title}>題名</Label>
              <span
                data-testid="event-title-count"
                className={cn('text-xs tabular-nums text-muted-foreground', titleCount > EVENT_TITLE_MAX && 'text-destructive')}
              >
                {titleCount}/{EVENT_TITLE_MAX}
              </span>
            </div>
            <Input
              id={ids.title}
              data-testid="event-title"
              value={values.title}
              onChange={(e) => update({ title: e.target.value })}
              disabled={pending}
              aria-invalid={errors.title ? true : undefined}
              autoComplete="off"
            />
            {fieldError('title')}
          </div>

          <div className="space-y-3">
            <div data-field="allDay" className="flex items-center gap-2">
              <Checkbox
                id={ids.allDay}
                data-testid="event-all-day"
                checked={values.allDay}
                onCheckedChange={(v) => setAllDay(v === true)}
                disabled={pending}
              />
              <Label htmlFor={ids.allDay} className="font-normal">
                終日
              </Label>
            </div>
            {values.allDay ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div data-field="startDate" className="space-y-1.5">
                  <Label htmlFor={ids.startDate}>日付</Label>
                  <Input
                    id={ids.startDate}
                    data-testid="event-start-date"
                    type="date"
                    min={EVENT_DATE_MIN}
                    max={EVENT_DATE_MAX}
                    value={values.startDate}
                    onChange={(e) => update({ startDate: e.target.value })}
                    disabled={pending}
                    aria-invalid={errors.startDate ? true : undefined}
                    aria-describedby={ids.tzHelp}
                  />
                  {fieldError('startDate')}
                </div>
                <div data-field="endDate" className="space-y-1.5">
                  <Label htmlFor={ids.endDate}>最後の日（任意。2日以上のとき）</Label>
                  <Input
                    id={ids.endDate}
                    data-testid="event-end-date"
                    type="date"
                    min={values.startDate || EVENT_DATE_MIN}
                    max={EVENT_DATE_MAX}
                    value={values.endDate}
                    onChange={(e) => update({ endDate: e.target.value })}
                    disabled={pending}
                    aria-invalid={errors.endDate ? true : undefined}
                    aria-describedby={ids.tzHelp}
                  />
                  {fieldError('endDate')}
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div data-field="start" className="space-y-1.5">
                  <Label htmlFor={ids.start}>開始</Label>
                  <Input
                    id={ids.start}
                    data-testid="event-start"
                    type="datetime-local"
                    min={`${EVENT_DATE_MIN}T00:00`}
                    max={`${EVENT_DATE_MAX}T23:59`}
                    value={values.start}
                    onChange={(e) => update({ start: e.target.value })}
                    disabled={pending}
                    aria-invalid={errors.start ? true : undefined}
                    aria-describedby={ids.tzHelp}
                  />
                  {fieldError('start')}
                </div>
                <div data-field="end" className="space-y-1.5">
                  <Label htmlFor={ids.end}>終わり（任意）</Label>
                  <Input
                    id={ids.end}
                    data-testid="event-end"
                    type="datetime-local"
                    min={values.start || `${EVENT_DATE_MIN}T00:00`}
                    max={`${EVENT_DATE_MAX}T23:59`}
                    value={values.end}
                    onChange={(e) => update({ end: e.target.value })}
                    disabled={pending}
                    aria-invalid={errors.end ? true : undefined}
                    aria-describedby={ids.tzHelp}
                  />
                  {fieldError('end')}
                </div>
              </div>
            )}
            <p id={ids.tzHelp} className="text-xs text-muted-foreground">
              {TIME_ZONE_HELP}
              {values.kind === 'deadline' ? '。締切に終わりを入れると、終わりが期限になります' : ''}
            </p>
          </div>

          <div data-field="note" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.note}>メモ（任意）</Label>
              <span
                data-testid="event-note-count"
                className={cn('text-xs tabular-nums text-muted-foreground', noteCount > EVENT_NOTE_MAX && 'text-destructive')}
              >
                {noteCount}/{EVENT_NOTE_MAX}
              </span>
            </div>
            <Textarea
              id={ids.note}
              data-testid="event-note"
              value={values.note}
              rows={4}
              onChange={(e) => update({ note: e.target.value })}
              disabled={pending}
              aria-invalid={errors.note ? true : undefined}
            />
            {fieldError('note')}
          </div>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={pending}>
            やめる
          </Button>
          <Button
            data-testid="event-submit"
            onClick={() => void save()}
            disabled={pending || blocked || submit?.type === 'missing'}
            aria-busy={pending || undefined}
          >
            {sendLabel}
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

/** 送った後の知らせ（conflict・消えていた・保存できたか分からない・そのほかの失敗） */
function SubmitNotice({ submit, onReload }: { submit: SubmitState | null; onReload: () => void }) {
  if (!submit) return null;
  const box = 'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm';
  switch (submit.type) {
    case 'conflict': {
      const { row } = submit;
      return (
        <div role="alert" data-testid="event-conflict" data-submit-error className={box}>
          <p className="font-medium text-destructive">{CONFLICT_NOTICE}</p>
          <p className="[overflow-wrap:anywhere]">今の題名：{row.title}</p>
          <p>
            更新：<time dateTime={row.updated_at}>{formatDateTime(row.updated_at)}</time>
          </p>
        </div>
      );
    }
    case 'missing':
      return (
        <div role="alert" data-testid="event-missing" data-submit-error className={box}>
          <p className="font-medium text-destructive">{EVENT_MISSING_MESSAGE}</p>
          <p>入力は残してあります。必要なら写してから閉じてください。</p>
        </div>
      );
    case 'unknown':
      return (
        <div role="alert" data-testid="event-error" data-kind="unknown" data-submit-error className={box}>
          <p className="font-medium text-destructive">{submit.message}</p>
          {submit.showReload ? (
            <Button size="sm" variant="outline" onClick={onReload}>
              読み直す
            </Button>
          ) : null}
        </div>
      );
    case 'error':
      return (
        <div data-testid="event-error" data-submit-error>
          <ErrorBanner error={submit.error} onReload={onReload} />
        </div>
      );
  }
}
