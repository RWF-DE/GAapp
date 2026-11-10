'use client';

// 提出物の登録・編集のダイアログ（04「提出状況 /documents（PC）」の提出物の設定、「提出物」の提出物の登録・変更・削除・書き込みの決まり・
// エラーの文言、notes/T19.md「パート B・C の約束」6。T19・D-55）。部門長以上だけが開く（終了した年度を除く。canManageDocuments）。
// 締切と予定の event-form-dialog.tsx と同じ形：
// - 欄：題名・説明（様式の置き場所も書ける。Q12）・締切の日付と時刻（Asia/Tokyo。時刻の既定は 17:00）・出す団体の区分・飲食の団体だけ（Q8）・
//   ファイルが要る（Q7）。下に「対象の団体：{N} 団体」（今の団体から数える）。編集で対象を狭めると、外れる団体のうち未提出でない提出のある
//   団体の数を出す（保存はできる）。送る前に lib/schemas/documents.ts（DB の CHECK と同じ trim・字数・日付の範囲）で確かめ、欄の下に誤りを出す。
// - 登録はダイアログを開いたときに作った id で insert する（閉じるまで、もう一度の送信と下書きも同じ id。(B1)：送り直しは 23505 で止まる）。
//   保存は全部の欄を、読んだときの updated_at の文字列のまま条件に入れて update する。何も変えていなければ送らずに「変更はありません」。
// - 応答が届かなかったとき・止められたときは doc-write.ts（2.6 の (B1)）。conflict は読み直した行を入力の元にして入力を残し（次の保存はその版で
//   送り、入力で上書きする。登録の 23505 で同じ id の提出物が入力と違えば、その提出物の編集に切り替える）、消えていたら「保存」を押せなくする。
//   同じ題名は題名の欄の下に出す（入力を残す）。保存が止められた後に読み直せなかったときの「読み直す」は、その提出物を読み直して止められた後と
//   同じに決める（rereadRejectedDocSave）。権限か年度の状態が変わった（42501・lock_unchanged）は年度の行と立場を読み直し、送るボタンを押せなく
//   する（入力は残す）。
// - 入力はブラウザに下書きとして置き（lib/drafts.ts。登録はダイアログの id、編集は提出物ごとに読んだときの updated_at も）、開き直したときに戻せる
//   （DraftNotice）。閉じる前・アプリの中で移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { GROUP_CATEGORIES, type GroupCategory } from '@gaapp/shared';
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
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  insertDocument,
  invalidateDocuments,
  newDocumentUuid,
  readDocument,
  sameDocumentWrite,
  updateDocument,
  type BoardGroupRow,
  type BoardStatusRow,
  type DocumentRow,
  type DocumentWrite,
} from '@/lib/data/documents';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, unknownOutcomeMessage } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { narrowingCount, targetsOf } from '@/lib/modules/documents/board';
import {
  checkDocumentForm,
  DOCUMENT_DATE_MAX,
  DOCUMENT_DATE_MIN,
  DOCUMENT_DESCRIPTION_MAX,
  DOCUMENT_SUBMIT_URL_MAX,
  DOCUMENT_TITLE_MAX,
  documentFormValuesOf,
  EMPTY_DOCUMENT_FORM,
  type DocumentFormErrors,
  type DocumentFormValues,
} from '@/lib/schemas/documents';
import { charCount } from '@/lib/schemas/notice-fields';
import { cn } from '@/lib/utils';
import { DOCUMENT_TITLE_TAKEN_MESSAGE, rereadRejectedDocSave, runDocSave, type DocSaveResult } from './doc-write';

/** 開いているダイアログ：登録（new）か、一覧の提出物の編集（edit。doc は開いたときの行） */
export type DocFormTarget = { type: 'new' } | { type: 'edit'; doc: DocumentRow };

export interface DocFormDialogProps {
  target: DocFormTarget | null;
  onClose: () => void;
  yearId: string;
  /** 自分の user_id（下書きのキー） */
  userId: string;
  /** 書けるか（部門長以上で、年度が終了していない）。偽になったら送るボタンを押せない */
  writable: boolean;
  /** その年度の団体（「対象の団体：{N} 団体」と、対象を狭めたときに外れる団体の数） */
  groups: readonly BoardGroupRow[];
  /** 提出の状況（対象を狭めたときに外れる、提出の記録のある団体の数） */
  statuses: readonly BoardStatusRow[];
  /** 一覧を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden・invalid_state の後） */
  onReloadMembership: () => void;
}

/** 提出物の「ほかの人が先に変えた」（04「提出物」のエラーの文言の、変更の conflict） */
export const DOC_CONFLICT_NOTICE =
  'ほかの人がこの提出物を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）';
/** 保存の間に提出物が消えた（読み直してもない） */
export const DOC_MISSING_MESSAGE = 'この提出物は見つかりません（ほかの人が削除した可能性があります）';
/** 送るボタンを押せないとき（書けない・権限か年度の状態が変わった）の足もとの文 */
export const DOC_CANNOT_SAVE_TEXT = '今の立場・年度の状態では保存できません';
/** 保存が止められた後に読み直せなかった（「読み直しました」とは言わない） */
export const DOC_REREAD_FAILED_NOTICE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';
/** 「読み直す」でもまた読み直せなかった */
export const DOC_REREAD_AGAIN_FAILED_MESSAGE = 'まだ読み直せませんでした。通信を確かめてから、もう一度「読み直す」を押してください（入力は残してあります）';
/** 説明の欄の添え書き（Q12。様式は v1 では置かない） */
export const DESCRIPTION_HELP = '様式（ひな形）の置き場所もここに書けます';
/** 日時の読み方の説明 */
export const DEADLINE_TIME_ZONE_HELP = '日時は日本時間（Asia/Tokyo）として読みます';
/** 「提出先の URL」の添え書き（T24。D-62。出せる人・見られる人はドライブの共有の設定で決まる） */
export const SUBMIT_URL_HELP =
  '共有ドライブのフォルダや Google フォームの URL（https:// で始まるもの）。出せる人・見られる人は、ドライブやフォームの共有の設定で決めてください';
/** 「飲食の団体だけ」の添え書き（Q8） */
export const FOOD_ONLY_HELP = '選んだ区分のうち、飲食の団体だけが出します';

/** 対象の団体の数の文（04「提出物の設定」の「対象の団体：{N} 団体」） */
export function targetCountText(n: number): string {
  return `対象の団体：${n} 団体`;
}

/** 対象を狭めたときの文（04「提出物の設定」） */
export function narrowingText(n: number): string {
  return `対象から外れる ${n} 団体に提出の記録があります。記録は残りますが、提出状況と団体の画面に出なくなります（対象に戻すとまた出ます）`;
}

/** 送った後の知らせ（本文の先頭に出す） */
type SubmitState =
  | { type: 'conflict'; row: DocumentRow }
  | { type: 'missing' }
  | { type: 'unknown'; message: string }
  /** 保存が止められた後に読み直せなかった（「読み直す」つき） */
  | { type: 'unread' }
  | { type: 'error'; error: unknown };

/** 下書きの値（入力と、登録ならダイアログで作った id、編集なら読んだときの updated_at） */
export interface DocDraft {
  values: DocumentFormValues;
  /** 送る先の id（登録はダイアログで作った id） */
  id: string | null;
  /** 編集の版（読んだときの updated_at）。登録は null */
  baseUpdatedAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 下書きの形を確かめる（形が違えば戻さない。知らない区分は除く） */
export function normalizeDocDraft(v: unknown): DocDraft | null {
  if (!isRecord(v) || !isRecord(v.values)) return null;
  const { title, description, deadlineDate, deadlineTime, categories, foodOnly, submitUrl } = v.values;
  for (const s of [title, description, deadlineDate, deadlineTime]) if (typeof s !== 'string') return null;
  if (!Array.isArray(categories) || typeof foodOnly !== 'boolean') return null;
  // 提出先の URL は T24 で足した（T24 の前の下書き〔requiresFile を持ち submitUrl がない〕は空として戻す）
  if (submitUrl !== undefined && typeof submitUrl !== 'string') return null;
  const id = v.id;
  const base = v.baseUpdatedAt;
  if (id !== null && typeof id !== 'string') return null;
  if (base !== null && typeof base !== 'string') return null;
  return {
    values: {
      title: title as string,
      description: description as string,
      deadlineDate: deadlineDate as string,
      deadlineTime: deadlineTime as string,
      categories: GROUP_CATEGORIES.filter((c) => categories.includes(c)),
      foodOnly,
      submitUrl: typeof submitUrl === 'string' ? submitUrl : '',
    },
    id,
    baseUpdatedAt: base,
  };
}

export function DocFormDialog(props: DocFormDialogProps) {
  const { target } = props;
  // target が変わるたびに中身を作り直す（前の提出物の入力を持ち込まない）
  const key = target ? (target.type === 'edit' ? `edit:${target.doc.id}` : 'new') : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <DocFormBody key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

/** 送る先：登録（ダイアログの id）か、提出物の編集（その id） */
type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

function DocFormBody({
  target,
  onClose,
  yearId,
  userId,
  writable,
  groups,
  statuses,
  onReload,
  onReloadMembership,
}: DocFormDialogProps & { target: DocFormTarget }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const editing = target.type === 'edit' ? target.doc : null;
  const [mode, setMode] = useState<Mode>(() => (editing ? { type: 'edit', id: editing.id } : { type: 'new', id: newDocumentUuid() }));
  const initial = useMemo<DocumentFormValues>(() => (editing ? documentFormValuesOf(editing) : { ...EMPTY_DOCUMENT_FORM, categories: [] }), [editing]);
  const [values, setValues] = useState<DocumentFormValues>(initial);
  const [errors, setErrors] = useState<DocumentFormErrors>({});
  const [submit, setSubmit] = useState<SubmitState | null>(null);
  const [pending, setPending] = useState(false);
  // 止められた後に読み直せなかったときの「読み直す」の最中（その間は送る・閉じる・入力を止める）
  const [rereading, setRereading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // 権限か年度の状態が変わった（42501・lock_unchanged）：このダイアログでは送らない（入力は残す）
  const [forbidden, setForbidden] = useState(false);
  // 編集の楽観ロックの版（入力の元）。進めるのは conflict で読み直した行を入力の元にしたときと、下書きを戻したときだけ
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(editing?.updated_at ?? null);
  // 保存してある行（「変更はありません」の比べる相手・対象を狭めたときの元）。conflict の後は読み直した行
  const [savedRow, setSavedRow] = useState<DocumentRow | null>(editing);
  const bodyRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const ids = {
    title: `${baseId}-title`,
    description: `${baseId}-description`,
    descriptionHelp: `${baseId}-description-help`,
    date: `${baseId}-date`,
    time: `${baseId}-time`,
    tzHelp: `${baseId}-tz-help`,
    categories: `${baseId}-categories`,
    foodOnly: `${baseId}-food-only`,
    submitUrl: `${baseId}-submit-url`,
    submitUrlHelp: `${baseId}-submit-url-help`,
  };

  // 下書き（登録は 'doc:new'、編集は提出物ごと。開いたときの target で決める）
  const draftKeyValue: DraftKey = useMemo(
    () => ({ userId, yearId, screen: 'documents', target: editing ? `doc:${editing.id}` : 'doc:new' }),
    [userId, yearId, editing],
  );
  const writer = useMemo(() => createDraftWriter<DocDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeDocDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const isNew = mode.type === 'new';
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  // 応答が届かなかった後・止められた後に読み直せなかったときは、DB の行が入力の元と同じか分からないので、「変更はありません」で閉じずに送る
  const mustSend = submit?.type === 'unknown' || submit?.type === 'unread';
  const titleCount = charCount(values.title.trim());
  const descriptionCount = charCount(values.description.trim());
  const submitUrlCount = charCount(values.submitUrl.trim());
  const blocked = !writable || forbidden;
  const busy = pending || rereading;
  const next = { target_categories: values.categories, food_only: values.foodOnly };
  const targetCount = targetsOf(next, groups).length;
  const narrowed = savedRow && mode.type === 'edit' ? narrowingCount(savedRow, next, { groups, statuses }) : 0;

  // 誤りが出たら最初の誤りの欄を見える所に出す
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    bodyRef.current?.querySelector('[data-field-error]')?.scrollIntoView?.({ block: 'center' });
  }, [errors]);
  useEffect(() => {
    if (!submit) return;
    bodyRef.current?.querySelector('[data-submit-error]')?.scrollIntoView?.({ block: 'nearest' });
  }, [submit]);

  const writeDraft = (nextValues: DocumentFormValues, m: Mode = mode, base: string | null = lockUpdatedAt) => {
    // 下書き：戻すか捨てるかを決めるまでは上書きしない。開いたときの値に戻したら消す
    if (draft) return;
    if (JSON.stringify(nextValues) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: nextValues, id: m.id, baseUpdatedAt: m.type === 'edit' ? base : null });
  };

  const update = (patch: Partial<DocumentFormValues>) => {
    const nextValues = { ...values, ...patch };
    setValues(nextValues);
    writeDraft(nextValues);
  };

  const toggleCategory = (c: GroupCategory, on: boolean) => {
    const set = new Set(values.categories);
    if (on) set.add(c);
    else set.delete(c);
    update({ categories: GROUP_CATEGORIES.filter((x) => set.has(x)) });
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  /** 保存できた（登録した・保存した・されていた）：読み直し、下書きを消して閉じる */
  const finish = (row: DocumentRow, before: boolean) => {
    invalidateDocuments(queryClient, yearId);
    writer.clear();
    toast.success(isNew ? (before ? `「${row.title}」は登録されていました` : `「${row.title}」を登録しました`) : before ? '保存されていました' : `「${row.title}」を保存しました`);
    onClose();
  };

  /** 送った結果の出し方 */
  const settle = (result: DocSaveResult) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, result.before);
        return;
      case 'conflict': {
        // 読み直した行を入力の元にする（次の保存はその版で送り、この入力で上書きする。登録の 23505 なら、その提出物の編集に切り替える）
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
      case 'title_taken':
        // 同じ題名：題名の欄の下に出す（入力を残す。一覧も読み直して、ほかの人が足した提出物を出す）
        setErrors({ title: DOCUMENT_TITLE_TAKEN_MESSAGE });
        onReload();
        return;
      case 'unknown':
        setSubmit({ type: 'unknown', message: unknownOutcomeMessage(isNew ? '登録' : '保存') });
        return;
      case 'unread':
        setSubmit({ type: 'unread' });
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
    if (busy || blocked || submit?.type === 'missing') return;
    const r = checkDocumentForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w: DocumentWrite = r.write;
    // 編集で何も変えていない（保存してある行と同じで、版も同じ）なら送らずに閉じる。応答が届かなかった後などは必ず送る
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameDocumentWrite(savedRow, w)) {
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
      const result = await runDocSave(
        {
          baseVersion: base,
          write: w,
          send: () => (base === null ? insertDocument(yearId, id, w) : updateDocument({ id, updated_at: base }, w)),
          reread: () => readDocument(id),
        },
        onAuthError,
      );
      settle(result);
    } finally {
      setPending(false);
    }
  };

  /**
   * 保存が止められた後に読み直せなかった（unread）ときの「読み直す」：その提出物を読み直し、止められた後の読み直しと同じに決める（入力と
   * 同じなら「保存されていました」、変わっていれば conflict の知らせにして入力の元を進める、なければ「見つかりません」）。また読み直せなければ
   * 知らせと「読み直す」を残す（版は進めない）。読み直す間は送る・閉じる・入力を止める。
   */
  const rereadUnread = async () => {
    if (busy || mode.type !== 'edit' || !lockUpdatedAt) return;
    const r = checkDocumentForm(values);
    const id = mode.id;
    setRereading(true);
    try {
      const result = await rereadRejectedDocSave({ baseVersion: lockUpdatedAt, write: r.ok ? r.write : null, reread: () => readDocument(id) });
      if (result.type === 'unread') toast.error(DOC_REREAD_AGAIN_FAILED_MESSAGE);
      else settle(result);
    } finally {
      setRereading(false);
    }
  };

  const restoreDraft = () => {
    // 送っている間・読み直している間は入力と版を変えない（届いた結果は、送った・押したときの入力と版で決めるため）
    if (!draft || busy) return;
    const d = draft.value;
    setValues(d.values);
    // 登録は下書きの id で送る（前の送信が通っていれば 23505 で止まり、読み直して決める）。編集は下書きを書いたときの版で送る
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
  const fieldError = (key: keyof DocumentFormErrors) =>
    errors[key] ? (
      <p data-field-error={key} className="text-sm text-destructive">
        {errors[key]}
      </p>
    ) : null;

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="doc-dialog"
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
          <DialogTitle>{isNew ? '提出物を登録' : '提出物を編集'}</DialogTitle>
          <DialogDescription>
            {isNew ? '対象の団体の店長・副店長が「自団体の提出物」から出します。' : '保存すると、対象の団体にすぐ見えます。'}
          </DialogDescription>
        </DialogHeader>
        <div ref={bodyRef} data-testid="doc-form" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          <SubmitNotice submit={submit} onReload={onReload} onReread={() => void rereadUnread()} rereading={rereading} />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}

          <div data-field="title" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.title}>題名</Label>
              <span
                data-testid="doc-title-count"
                className={cn('text-xs tabular-nums text-muted-foreground', titleCount > DOCUMENT_TITLE_MAX && 'text-destructive')}
              >
                {titleCount}/{DOCUMENT_TITLE_MAX}
              </span>
            </div>
            <Input
              id={ids.title}
              data-testid="doc-title"
              value={values.title}
              onChange={(e) => update({ title: e.target.value })}
              disabled={busy}
              aria-invalid={errors.title ? true : undefined}
              autoComplete="off"
            />
            {fieldError('title')}
          </div>

          <div data-field="description" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.description}>説明（任意）</Label>
              <span
                data-testid="doc-description-count"
                className={cn('text-xs tabular-nums text-muted-foreground', descriptionCount > DOCUMENT_DESCRIPTION_MAX && 'text-destructive')}
              >
                {descriptionCount}/{DOCUMENT_DESCRIPTION_MAX}
              </span>
            </div>
            <Textarea
              id={ids.description}
              data-testid="doc-description"
              value={values.description}
              rows={4}
              onChange={(e) => update({ description: e.target.value })}
              disabled={busy}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={ids.descriptionHelp}
            />
            <p id={ids.descriptionHelp} className="text-xs text-muted-foreground">
              {DESCRIPTION_HELP}
            </p>
            {fieldError('description')}
          </div>

          <div className="space-y-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div data-field="deadlineDate" className="space-y-1.5">
                <Label htmlFor={ids.date}>締切の日付</Label>
                <Input
                  id={ids.date}
                  data-testid="doc-deadline-date"
                  type="date"
                  min={DOCUMENT_DATE_MIN}
                  max={DOCUMENT_DATE_MAX}
                  value={values.deadlineDate}
                  onChange={(e) => update({ deadlineDate: e.target.value })}
                  disabled={busy}
                  aria-invalid={errors.deadlineDate ? true : undefined}
                  aria-describedby={ids.tzHelp}
                />
                {fieldError('deadlineDate')}
              </div>
              <div data-field="deadlineTime" className="space-y-1.5">
                <Label htmlFor={ids.time}>締切の時刻</Label>
                <Input
                  id={ids.time}
                  data-testid="doc-deadline-time"
                  type="time"
                  value={values.deadlineTime}
                  onChange={(e) => update({ deadlineTime: e.target.value })}
                  disabled={busy}
                  aria-invalid={errors.deadlineTime ? true : undefined}
                  aria-describedby={ids.tzHelp}
                />
                {fieldError('deadlineTime')}
              </div>
            </div>
            <p id={ids.tzHelp} className="text-xs text-muted-foreground">
              {DEADLINE_TIME_ZONE_HELP}
            </p>
          </div>

          <fieldset data-field="categories" className="space-y-2" aria-describedby={errors.categories ? `${ids.categories}-error` : undefined}>
            <legend id={ids.categories} className="text-sm font-medium">
              出す団体の区分
            </legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {GROUP_CATEGORIES.map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <Checkbox
                    id={`${ids.categories}-${c}`}
                    data-testid="doc-category"
                    data-category={c}
                    checked={values.categories.includes(c)}
                    onCheckedChange={(v) => toggleCategory(c, v === true)}
                    disabled={busy}
                    aria-invalid={errors.categories ? true : undefined}
                  />
                  <Label htmlFor={`${ids.categories}-${c}`} className="font-normal">
                    {CATEGORY_LABELS[c]}
                  </Label>
                </div>
              ))}
            </div>
            {errors.categories ? (
              <p id={`${ids.categories}-error`} data-field-error="categories" className="text-sm text-destructive">
                {errors.categories}
              </p>
            ) : null}
          </fieldset>

          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id={ids.foodOnly}
                data-testid="doc-food-only"
                checked={values.foodOnly}
                onCheckedChange={(v) => update({ foodOnly: v === true })}
                disabled={busy}
                aria-describedby={`${ids.foodOnly}-help`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={ids.foodOnly} className="font-normal">
                  飲食の団体だけ
                </Label>
                <p id={`${ids.foodOnly}-help`} className="text-xs text-muted-foreground">
                  {FOOD_ONLY_HELP}
                </p>
              </div>
            </div>
          </div>

          <div data-field="submitUrl" className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={ids.submitUrl}>提出先の URL（任意）</Label>
              <span
                data-testid="doc-submit-url-count"
                className={cn('text-xs tabular-nums text-muted-foreground', submitUrlCount > DOCUMENT_SUBMIT_URL_MAX && 'text-destructive')}
              >
                {submitUrlCount}/{DOCUMENT_SUBMIT_URL_MAX}
              </span>
            </div>
            <Input
              id={ids.submitUrl}
              data-testid="doc-submit-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://drive.google.com/…"
              value={values.submitUrl}
              onChange={(e) => update({ submitUrl: e.target.value })}
              disabled={busy}
              aria-invalid={errors.submitUrl ? true : undefined}
              aria-describedby={ids.submitUrlHelp}
            />
            <p id={ids.submitUrlHelp} className="text-xs text-muted-foreground">
              {SUBMIT_URL_HELP}
            </p>
            {fieldError('submitUrl')}
          </div>

          <div className="space-y-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <p data-testid="doc-target-count" className="font-medium">
              {targetCountText(targetCount)}
            </p>
            {narrowed > 0 ? (
              <p data-testid="doc-narrowing" role="status" className="text-amber-900">
                {narrowingText(narrowed)}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{DOC_CANNOT_SAVE_TEXT}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            やめる
          </Button>
          <Button
            data-testid="doc-submit"
            onClick={() => void save()}
            disabled={busy || blocked || submit?.type === 'missing'}
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

/** 送った後の知らせ（conflict・消えていた・保存できたか分からない・止められた後に読み直せなかった・そのほかの失敗） */
function SubmitNotice({
  submit,
  onReload,
  onReread,
  rereading,
}: {
  submit: SubmitState | null;
  onReload: () => void;
  onReread: () => void;
  rereading: boolean;
}) {
  if (!submit) return null;
  const box = 'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm';
  switch (submit.type) {
    case 'conflict': {
      const { row } = submit;
      return (
        <div role="alert" data-testid="doc-conflict" data-submit-error className={box}>
          <p className="font-medium text-destructive">{DOC_CONFLICT_NOTICE}</p>
          <p className="[overflow-wrap:anywhere]">今の題名：{row.title}</p>
          <p>
            更新：<time dateTime={row.updated_at}>{formatDateTime(row.updated_at)}</time>
          </p>
        </div>
      );
    }
    case 'missing':
      return (
        <div role="alert" data-testid="doc-missing" data-submit-error className={box}>
          <p className="font-medium text-destructive">{DOC_MISSING_MESSAGE}</p>
          <p>入力は残してあります。必要なら写してから閉じてください。</p>
        </div>
      );
    case 'unknown':
      return (
        <div role="alert" data-testid="doc-error" data-kind="unknown" data-submit-error className={box}>
          <p className="font-medium text-destructive">{submit.message}</p>
        </div>
      );
    case 'unread':
      return (
        <div role="alert" data-testid="doc-error" data-kind="unread" data-submit-error className={box}>
          <p className="font-medium text-destructive">{DOC_REREAD_FAILED_NOTICE}</p>
          <Button size="sm" variant="outline" onClick={onReread} disabled={rereading} aria-busy={rereading || undefined}>
            {rereading ? '読み直しています…' : '読み直す'}
          </Button>
        </div>
      );
    case 'error':
      return (
        <div data-testid="doc-error" data-submit-error>
          <ErrorBanner error={submit.error} onReload={onReload} />
        </div>
      );
  }
}
