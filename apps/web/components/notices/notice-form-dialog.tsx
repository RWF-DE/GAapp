'use client';

// お知らせを書く・編集のダイアログ（04「お知らせ一覧」の書く・編集・保存していない入力・エラー、notes/T17.md「後半（画面）の約束」4・5。
// T17・D-53）。
// - 段で出し分ける（lib/modules/notices/permissions.ts）：部門長以上は宛先を3つから選び（指定の団体なら宛先の団体の一覧）、ピン留めを
//   付け外しできる。総務部門員は宛先を選べず（総務内だけ）、ピン留めの欄を出さない（ピン留めされたお知らせを直すときは今の値のまま送る）。
// - 送る前に zod（lib/schemas/notices.ts。DB と同じ trim と字数）で確かめ、欄の下にエラーを出す。DB の invalid_input（field）も同じ欄に出す。
// - 編集は全部の欄と、読んだときの updated_at の文字列（入力の元の版）を送る。何も変えていなければ送らずに「変更はありません」で閉じる。
// - 応答が届かなかったとき・止められたときは notice-write.ts（2.6 の (B1)・(B2)）。conflict は読み直した行を入力の元にして入力を残し
//   （次の保存はその版で送り、入力で上書きする）、消えていたら「保存」を押せなくする。出すの応答が届かず読み直せなければ、確かめるまで
//   「出す」の代わりに「確かめる」を出す（(B2) だけが持つ状態）。
// - 入力はブラウザに下書きとして置き（lib/drafts.ts。作るときとお知らせごと。直すときは読んだときの updated_at も）、開き直したときに
//   戻せる（DraftNotice）。戻した下書きの保存は下書きの updated_at で送るので、間にほかの人が変えていれば conflict になる。
// - 閉じる前（入力があれば「保存していない入力を捨てますか」）・アプリの中で移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { ErrorBanner } from '@/components/common/error-banner';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { AppRole } from '@/lib/auth/roles';
import {
  findCreatedNotice,
  groupOrderOf,
  invalidateNotices,
  NOTICE_AUDIENCES,
  orderGroupIds,
  putNoticeInCache,
  readNotice,
  sameNoticeWrite,
  saveNotice,
  type NoticeAudience,
  type NoticeGroupOption,
  type NoticeRow,
  type SavedNotice,
} from '@/lib/data/notices';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, messageFor, NOTICE_CONFLICT_MESSAGE, NOTICE_MISSING_MESSAGE, unknownOutcomeMessage, type MessageContext } from '@/lib/errors';
import { NOTICE_AUDIENCE_LABELS } from '@/lib/labels';
import { canPinNotices, noticeAudiencesFor } from '@/lib/modules/notices/permissions';
import {
  charCount,
  checkNoticeForm,
  emptyNoticeForm,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  type NoticeFieldErrors,
  type NoticeFormValues,
  type NoticeWrite,
} from '@/lib/schemas/notices';
import { cn } from '@/lib/utils';
import { NoticeGroupPicker } from './notice-group-picker';
import { confirmCreated, runNoticeSave, type NoticeSaveResult } from './notice-write';

/** 開いているダイアログ：出す（new）か、一覧のお知らせを直す（edit。notice は開いたときの行） */
export type NoticeFormTarget = { type: 'new' } | { type: 'edit'; notice: NoticeRow };

export interface NoticeFormDialogProps {
  target: NoticeFormTarget | null;
  onClose: () => void;
  yearId: string;
  /** 自分の user_id（下書きのキーと、(B2) で自分が出したお知らせを探すのに使う） */
  userId: string;
  role: AppRole | null;
  /** 書けるか（総務で、年度が終了していない）。偽になったら送るボタンを押せない */
  writable: boolean;
  /** その年度の団体（団体の並び） */
  groups: readonly NoticeGroupOption[];
  /** 一覧のお知らせ（開いたときの id を (B2) の knownIds にする） */
  notices: readonly NoticeRow[];
  /** 一覧（と団体）を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden・invalid_state の後） */
  onReloadMembership: () => void;
}

/** 宛先ごとの読める人の説明（04「お知らせ一覧」の書く） */
export const AUDIENCE_HELP: Readonly<Record<NoticeAudience, string>> = {
  soumu: '総務だけが読みます',
  all_groups: 'すべての団体の店長・副店長と、閲覧のみの人が読みます',
  groups: '選んだ団体の店長・副店長と、閲覧のみの人が読みます',
};

/** 総務部門員の宛先（選ぶ欄を出さない） */
export const STAFF_AUDIENCE_TEXT = '総務内（総務部門員が出せるのは総務内のお知らせだけです）';
/** 総務部門員がピン留めされたお知らせを直すとき */
export const PINNED_NOTE = 'ピン留めされています（付け外しは部門長以上）';
/** conflict：読み直した行を入力の元にして入力を残す（(B1)） */
export const CONFLICT_NOTICE = `${NOTICE_CONFLICT_MESSAGE}。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）`;
/** 止められた後に読み直せなかった（「読み直しました」とは言わない） */
export const REREAD_FAILED_NOTICE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';
/** 出すの応答が届かず、読み直せなかった（(B2)） */
export const UNCONFIRMED_NOTICE = '出せたか確かめられません。通信が戻ったら「確かめる」を押してください';

/** 送った後の知らせ（本文の先頭に出す） */
type SubmitState =
  | { type: 'conflict'; row: NoticeRow }
  | { type: 'missing' }
  | { type: 'unknown'; message: string; showReload?: boolean }
  | { type: 'unconfirmed'; write: NoticeWrite; error: unknown }
  | { type: 'error'; error: unknown };

/** 下書きの値（入力と、直すときは読んだときの updated_at） */
export interface NoticeDraft {
  values: NoticeFormValues;
  baseUpdatedAt: string | null;
}

const RPC_CONTEXT: MessageContext = { rpc: 'save_notice' };

/** DB の invalid_input の field → 欄 */
const FIELD_OF: Readonly<Record<string, keyof NoticeFieldErrors>> = { title: 'title', body: 'body', group_ids: 'groupIds' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 下書きの形を確かめる（形が違えば戻さない） */
export function normalizeNoticeDraft(v: unknown): NoticeDraft | null {
  if (!isRecord(v) || !isRecord(v.values)) return null;
  const { audience, title, body, pinned, groupIds } = v.values;
  if (typeof audience !== 'string' || !(NOTICE_AUDIENCES as readonly string[]).includes(audience)) return null;
  if (typeof title !== 'string' || typeof body !== 'string' || typeof pinned !== 'boolean') return null;
  if (!Array.isArray(groupIds) || !groupIds.every((g): g is string => typeof g === 'string')) return null;
  const base = v.baseUpdatedAt;
  if (base !== null && typeof base !== 'string') return null;
  return { values: { audience: audience as NoticeAudience, title, body, pinned, groupIds }, baseUpdatedAt: base };
}

/** そのお知らせの今の値（編集の入力の元） */
function formOf(n: NoticeRow): NoticeFormValues {
  return { audience: n.audience, title: n.title, body: n.body ?? '', pinned: n.pinned, groupIds: [...n.groupIds] };
}

export function NoticeFormDialog(props: NoticeFormDialogProps) {
  const { target } = props;
  // target が変わるたびに中身を作り直す（前のお知らせの入力を持ち込まない）
  const key = target ? (target.type === 'edit' ? `edit:${target.notice.id}` : 'new') : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <NoticeFormBody key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

function NoticeFormBody({
  target,
  onClose,
  yearId,
  userId,
  role,
  writable,
  groups,
  notices,
  onReload,
  onReloadMembership,
}: NoticeFormDialogProps & { target: NoticeFormTarget }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const isNew = target.type === 'new';
  const editing = target.type === 'edit' ? target.notice : null;
  const initial = useMemo(() => (editing ? formOf(editing) : emptyNoticeForm()), [editing]);
  const [values, setValues] = useState<NoticeFormValues>(initial);
  const [errors, setErrors] = useState<NoticeFieldErrors>({});
  const [submit, setSubmit] = useState<SubmitState | null>(null);
  const [pending, setPending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // 開いたときの一覧の id（(B2) の確かめで、前からあったお知らせを取り違えない）
  const [knownIds] = useState(() => new Set(notices.map((n) => n.id)));
  // 直すときの楽観ロックの版（入力の元。開いたときの行の updated_at）。進めるのは conflict で読み直した行を入力の元にしたときと、
  // 下書きを戻したとき（下書きの updated_at）だけ（一覧の読み直しでは進めない）
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(editing?.updated_at ?? null);
  // 保存してある行（「変更はありません」の比べる相手）。conflict の後は読み直した行
  const [savedRow, setSavedRow] = useState<NoticeRow | null>(editing);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const pinId = useId();
  const pinHelpId = useId();
  const audienceId = useId();
  const baseId = useId();
  const ids = { title: titleId, body: bodyId, pin: pinId, pinHelp: pinHelpId, audience: audienceId, base: baseId };

  // 下書き（作るときは 'new'、直すときはお知らせの id）
  const draftKeyValue: DraftKey = useMemo(
    () => ({ userId, yearId, screen: 'notices', target: editing ? editing.id : 'new' }),
    [userId, yearId, editing],
  );
  const writer = useMemo(() => createDraftWriter<NoticeDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeNoticeDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const audiences = noticeAudiencesFor(role);
  const canPin = canPinNotices(role);
  const order = useMemo(() => groupOrderOf(groups), [groups]);
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  // 応答が届かなかった後・止められた後に読み直せなかったときは、DB の行が入力の元と同じか分からないので、「変更はありません」で閉じずに送る
  const mustSend = submit?.type === 'unknown';
  const titleCount = charCount(values.title.trim());
  const bodyCount = values.body.trim() === '' ? 0 : charCount(values.body);

  // エラーが出たら最初のエラーの欄を見える所に出す
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    bodyRef.current?.querySelector('[data-field-error]')?.scrollIntoView?.({ block: 'center' });
  }, [errors]);
  useEffect(() => {
    if (!submit) return;
    bodyRef.current?.querySelector('[data-submit-error]')?.scrollIntoView?.({ block: 'nearest' });
  }, [submit]);

  const update = (patch: Partial<NoticeFormValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    // 下書き：戻すか捨てるかを決めるまでは上書きしない。開いたときの値に戻したら消す
    if (draft) return;
    if (JSON.stringify(next) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: next, baseUpdatedAt: lockUpdatedAt });
  };

  const requestClose = () => {
    if (pending) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  /** 保存できた（出した・直した・保存されていた）：一覧のキャッシュに入れて読み直し、下書きを消して閉じる */
  const finish = (row: SavedNotice | NoticeRow, w: NoticeWrite, before: boolean) => {
    const groupIds = 'groupIds' in row ? row.groupIds : w.audience === 'groups' ? w.groupIds : [];
    putNoticeInCache(queryClient, yearId, row, groupIds);
    invalidateNotices(queryClient, yearId);
    writer.clear();
    const title = row.title;
    toast.success(
      isNew
        ? before
          ? `お知らせ「${title}」は出されていました`
          : `お知らせ「${title}」を出しました`
        : before
          ? `「${title}」は保存されていました`
          : `「${title}」を保存しました`,
    );
    onClose();
  };

  /** 送った結果の出し方 */
  const settle = (result: NoticeSaveResult, w: NoticeWrite) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, w, result.before);
        return;
      case 'conflict':
        // 読み直した行を入力の元にする（次の保存はその版で送り、この入力で上書きする）。一覧も読み直す
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setSubmit({ type: 'conflict', row: result.row });
        onReload();
        return;
      case 'missing':
        setSubmit({ type: 'missing' });
        onReload();
        return;
      case 'unknown':
        setSubmit({ type: 'unknown', message: unknownOutcomeMessage() });
        return;
      case 'unread':
        setSubmit({ type: 'unknown', message: REREAD_FAILED_NOTICE, showReload: true });
        return;
      case 'unconfirmed':
        setSubmit({ type: 'unconfirmed', write: w, error: result.error });
        return;
      case 'not-created':
        // 出されていなかった：入力を残し、もう一度「出す」を押せる（通信の失敗の文言）
        setSubmit({ type: 'error', error: result.error });
        return;
      case 'failed': {
        const c = classifyError(result.error);
        const d = c.details;
        const field = c.kind === 'input' && isRecord(d) && typeof d.field === 'string' ? FIELD_OF[d.field] : undefined;
        if (field) {
          setErrors({ [field]: messageFor(c, RPC_CONTEXT) });
          // その年度にない団体（消された）：団体を読み直す。入力は残す
          if (isRecord(d) && d.reason === 'not_in_year') onReload();
          return;
        }
        const effect = effectOf(c);
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
    if (pending || !writable || submit?.type === 'missing' || submit?.type === 'unconfirmed') return;
    // 宛先の団体は、今の一覧にある団体だけを団体の並びで送る（消えた団体は選べない）
    const normalized: NoticeFormValues = { ...values, groupIds: orderGroupIds(values.groupIds, order).filter((id) => order.has(id)) };
    const r = checkNoticeForm(normalized);
    setErrors(r.errors);
    if (!r.write) return;
    const w = r.write;
    if (editing && (!lockUpdatedAt || !savedRow)) return;
    // 編集で何も変えていない（保存してある行と同じで、版も同じ）なら送らずに閉じる。応答が届かなかった後などは必ず送る
    if (editing && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameNoticeWrite(savedRow, w)) {
      writer.clear();
      toast.info('変更はありません');
      onClose();
      return;
    }
    const base = editing && lockUpdatedAt ? { id: editing.id, updatedAt: lockUpdatedAt } : null;
    setSubmit(null);
    setPending(true);
    try {
      const result = await runNoticeSave(
        {
          base,
          write: w,
          send: () => saveNotice(yearId, w, base),
          reread: () => readNotice(editing!.id),
          findCreated: () => findCreatedNotice(yearId, userId, w, knownIds),
        },
        onAuthError,
      );
      settle(result, w);
    } finally {
      setPending(false);
    }
  };

  /** (B2)：出したか確かめる（応答が届かず読み直せなかった後） */
  const check = async () => {
    if (pending || submit?.type !== 'unconfirmed') return;
    const { write: w, error } = submit;
    setPending(true);
    try {
      const result = await confirmCreated(() => findCreatedNotice(yearId, userId, w, knownIds), error);
      settle(result, w);
    } finally {
      setPending(false);
    }
  };

  const restoreDraft = () => {
    if (!draft) return;
    setValues(draft.value.values);
    // 直すときは、下書きを書いたときの版で送る（間にほかの人が変えていれば conflict になり、読み直して決める）
    if (editing) setLockUpdatedAt(draft.value.baseUpdatedAt ?? editing.updated_at);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const sendLabel = isNew ? (pending ? '出しています…' : '出す') : pending ? '保存中…' : '保存';

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
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
          <DialogTitle>{isNew ? 'お知らせを書く' : 'お知らせを編集'}</DialogTitle>
          <DialogDescription>
            {isNew ? '宛先の人は、お知らせ一覧とダッシュボードの欄で読めます。' : '保存すると、宛先の人にすぐ見えます。'}
          </DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} data-testid="notice-form" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <SubmitNotice submit={submit} onReload={onReload} />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}

          <div data-field="audience" className="space-y-2">
            <p id={ids.audience} className="text-sm font-medium">
              宛先
            </p>
            {audiences.length > 1 ? (
              <RadioGroup
                aria-labelledby={ids.audience}
                value={values.audience}
                onValueChange={(v) => update({ audience: v as NoticeAudience })}
                disabled={pending}
                className="gap-2"
              >
                {audiences.map((a) => (
                  <div key={a} className="flex items-start gap-2">
                    <RadioGroupItem id={`${ids.base}-aud-${a}`} value={a} aria-describedby={`${ids.base}-aud-${a}-help`} className="mt-0.5" />
                    <div className="space-y-0.5">
                      <Label htmlFor={`${ids.base}-aud-${a}`} className="font-normal">
                        {NOTICE_AUDIENCE_LABELS[a]}
                      </Label>
                      <p id={`${ids.base}-aud-${a}-help`} className="text-xs text-muted-foreground">
                        {AUDIENCE_HELP[a]}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            ) : (
              <p data-testid="notice-audience-fixed" aria-describedby={`${ids.base}-aud-fixed-help`} className="text-sm">
                {STAFF_AUDIENCE_TEXT}
                <span id={`${ids.base}-aud-fixed-help`} className="block text-xs text-muted-foreground">
                  {AUDIENCE_HELP.soumu}
                </span>
              </p>
            )}
          </div>

          {values.audience === 'groups' && audiences.includes('groups') ? (
            <NoticeGroupPicker groups={groups} value={values.groupIds} onChange={(groupIds) => update({ groupIds })} disabled={pending} error={errors.groupIds} />
          ) : null}

          <div data-field="title" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.title}>題名</Label>
              <span
                data-testid="notice-title-count"
                className={cn('text-xs tabular-nums text-muted-foreground', titleCount > NOTICE_TITLE_MAX && 'text-destructive')}
              >
                {titleCount}/{NOTICE_TITLE_MAX}
              </span>
            </div>
            <Input
              id={ids.title}
              value={values.title}
              onChange={(e) => update({ title: e.target.value })}
              disabled={pending}
              aria-invalid={errors.title ? true : undefined}
              autoComplete="off"
            />
            {errors.title ? (
              <p data-field-error="title" className="text-sm text-destructive">
                {errors.title}
              </p>
            ) : null}
          </div>

          <div data-field="body" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.body}>本文（任意）</Label>
              <span
                data-testid="notice-body-count"
                className={cn('text-xs tabular-nums text-muted-foreground', bodyCount > NOTICE_BODY_MAX && 'text-destructive')}
              >
                {bodyCount}/{NOTICE_BODY_MAX}
              </span>
            </div>
            <Textarea
              id={ids.body}
              value={values.body}
              rows={8}
              onChange={(e) => update({ body: e.target.value })}
              disabled={pending}
              aria-invalid={errors.body ? true : undefined}
            />
            {errors.body ? (
              <p data-field-error="body" className="text-sm text-destructive">
                {errors.body}
              </p>
            ) : null}
          </div>

          {canPin ? (
            <div data-field="pinned" className="flex items-start gap-3">
              <Switch
                id={ids.pin}
                checked={values.pinned}
                onCheckedChange={(v) => update({ pinned: v })}
                disabled={pending}
                aria-describedby={ids.pinHelp}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={ids.pin}>ピン留めする</Label>
                <p id={ids.pinHelp} className="text-xs text-muted-foreground">
                  一覧とダッシュボードの欄の先頭に出します
                </p>
              </div>
            </div>
          ) : values.pinned ? (
            <p data-testid="notice-pinned-note" className="text-sm text-muted-foreground">
              {PINNED_NOTE}
            </p>
          ) : null}
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {!writable ? <p className="mr-auto text-sm text-muted-foreground">今の立場・年度の状態では保存できません</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={pending}>
            やめる
          </Button>
          {submit?.type === 'unconfirmed' ? (
            <Button onClick={() => void check()} disabled={pending} aria-busy={pending || undefined}>
              {pending ? '確かめています…' : '確かめる'}
            </Button>
          ) : (
            <Button
              onClick={() => void save()}
              disabled={pending || !writable || submit?.type === 'missing'}
              aria-busy={pending || undefined}
            >
              {sendLabel}
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
        onConfirm={() => {
          writer.clear();
          onClose();
        }}
      />
    </>
  );
}

/** 送った後の知らせ（conflict・消えていた・保存できたか分からない・確かめられない・そのほかの失敗） */
function SubmitNotice({ submit, onReload }: { submit: SubmitState | null; onReload: () => void }) {
  if (!submit) return null;
  const box = 'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm';
  switch (submit.type) {
    case 'conflict':
      return (
        <div role="alert" data-testid="notice-conflict" data-submit-error className={box}>
          <p className="font-medium text-destructive">{CONFLICT_NOTICE}</p>
          <p className="[overflow-wrap:anywhere]">今の題名：{submit.row.title}</p>
          <p>
            更新：<time dateTime={submit.row.updated_at}>{formatDateTime(submit.row.updated_at)}</time>
          </p>
        </div>
      );
    case 'missing':
      return (
        <div role="alert" data-testid="notice-missing" data-submit-error className={box}>
          <p className="font-medium text-destructive">{NOTICE_MISSING_MESSAGE}</p>
          <p>入力は残してあります。必要なら写してから閉じてください。</p>
        </div>
      );
    case 'unknown':
      return (
        <div role="alert" data-testid="unknown-outcome" data-submit-error className={box}>
          <p className="font-medium text-destructive">{submit.message}</p>
          {submit.showReload ? (
            <Button size="sm" variant="outline" onClick={onReload}>
              読み直す
            </Button>
          ) : null}
        </div>
      );
    case 'unconfirmed':
      return (
        <div role="alert" data-testid="unknown-outcome" data-submit-error className={box}>
          <p className="font-medium text-destructive">{UNCONFIRMED_NOTICE}</p>
        </div>
      );
    case 'error':
      return (
        <div data-submit-error>
          <ErrorBanner error={submit.error} context={RPC_CONTEXT} onReload={onReload} />
        </div>
      );
  }
}
