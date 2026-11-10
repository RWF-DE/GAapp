'use client';

// 提出状況のセルのシート（04「提出状況 /documents（PC）」のセルのシート、「提出物」のファイルの扱い・書き込みの決まり・エラーの文言、
// notes/T19.md「パート B・C の約束」6。T19・D-55）。横から開く。見出しは「{団体}・{提出物}」。開いたまま、裏の読み直しで中身を変える。
// - 状態の印と経過（提出・承認・差し戻しの日時と、した人の表示名〔読めない・記録がないときは「名前を表示できません」〕）、理由・メモ（書いた
//   とおり。改行を残す）。
// - ファイル（部門長以上だけ。Q4）：1件ずつ「ファイル 1（PDF・1.2 MB・10/5 17:00）」と、届いたものに「開く」「保存」、承認でなければ「外す」。
//   総務部門員には、ファイルの欄の代わりに「ファイルを開けるのは部門長以上です」とだけ出す（ファイルは RLS も返さない）。
// - 操作（部門長以上。終了した年度を除く。今の状態で押せるものだけ。leadDocumentActions）：承認する・差し戻す（承認を取り消して差し戻す・
//   理由を書き直す）・紙などで受け取ったとして承認する（review-dialogs.tsx）、代理のファイルを足す・外す（use-document-uploader.ts。画面に
//   1つある送り手を使う。セルごとに状態が分かれる）・代わりに提出する・提出を取り消す（確かめのダイアログ）。base_updated_at はシートの提出の
//   updated_at（行がなければ null）。成功したらシートを開いたまま読み直す。止められたら読み直して今の状態とエラーの文言を出し、読み直せなければ
//   「読み直す」を出す（submission-write.ts の (B1)）。forbidden・invalid_state は年度の行と立場も読み直す。
// - 送っている・上げている間はシートを閉じない（送っている1つは止められないので、終わるまで待つ）。
// - 操作が成功すると押したボタンが消えるので、ダイアログが閉じた後にフォーカスをシートの見出しへ移す（focus-after-dialog.ts。レビューの F4）。
// 署名つき URL は押したときに作る（file-open.ts。60 秒。残さない）。その画面で上げている間は「保存」を押せない（F2）。開く・保存の 403 は開く・
// 保存の文言（UX-4）。変数名は doc（ブラウザの document を隠さない）。
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { TokyoTime } from '@/components/common/tokyo-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { YearStatus } from '@/lib/auth/membership';
import {
  approveDocument,
  returnDocument,
  submitDocument,
  withdrawDocument,
  type BoardGroupRow,
  type BoardStatusRow,
  type DocumentFileRow,
  type DocumentRow,
  type DocumentsBoardData,
} from '@/lib/data/documents';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import type { BoardCell } from '@/lib/modules/documents/board';
import { downloadNameFor, numberFiles, submitBlocker } from '@/lib/modules/documents/files';
import { submitUrlHref } from '@/lib/modules/documents/submit-url';
import { DOCUMENT_MARK_LABELS, SOUMU_STATUS_LABELS } from '@/lib/modules/documents/labels';
import { leadDocumentActions, RETURN_KIND_LABELS, type LeadDocumentActions } from '@/lib/modules/documents/permissions';
import { cn } from '@/lib/utils';
import { DocumentFileList, fileEntriesOf, REMOVE_CONFIRM_TEXT, SHEET_FILE_TESTIDS, type FileEntry } from './document-file-list';
import { SubmitLink } from './submit-link';
import { cellMarkLabels, columnDeadlineText, COLUMN_OVERDUE_TEXT } from './documents-board';
import { openDocumentFile, POPUP_BLOCKED_MESSAGE, saveDocumentFile, type FileOpenResult } from './file-open';
import { focusAfterDialogs } from './focus-after-dialog';
import { ReviewNoteDialog, type ReviewKind, type ReviewNoteDialogProps, type ReviewOutcome, type ReviewTarget } from './review-dialogs';
import { DOCUMENT_MARK_CLASS, DocumentStatusBadge } from './status-badge';
import {
  REREAD_AGAIN_FAILED_MESSAGE,
  REREAD_FAILED_NOTICE,
  runSubmissionWrite,
  SUBMISSION_DONE_BEFORE,
  SUBMISSION_RPCS,
  SUBMISSION_UNKNOWN,
  type AuthErrorHandler,
  type SubmissionAction,
} from './submission-write';
import { DISCARD_UNKNOWN_MESSAGE, uploadSlot, type DocumentFileTarget, type DocumentUploader } from './use-document-uploader';

/** 総務部門員のシートのファイルの欄の代わり（Q4） */
export const STAFF_FILES_NOTE = 'ファイルを開けるのは部門長以上です';
/** 提出先の URL がないときの文（T24。D-62） */
export const NO_SUBMIT_URL_SHEET_TEXT = '提出先の URL はまだありません';
/** 部門長以上に添える文（「提出物の設定」で入れられる） */
export const NO_SUBMIT_URL_LEAD_HINT = '（「提出物の設定」で入れられます）';
/** した人を読めない・記録がない */
export const UNKNOWN_ACTOR = '名前を表示できません';
/** 提出がまだない（未提出で、経過がない） */
export const NO_HISTORY_TEXT = '提出はまだありません';
/** 紙などで受け取ったとして承認する（ボタンとダイアログの見出し） */
export const PAPER_LABEL = '紙などで受け取ったとして承認する';
/** 代わりに提出するの確かめの説明（その団体の店長・副店長も務める人には出さない。代理にならない） */
export const PROXY_CONFIRM_TEXT = '団体の画面に「総務が代わりに提出しました」と出ます。';
/** 提出を取り消すの確かめの説明 */
export const WITHDRAW_SHEET_CONFIRM_TEXT = '未提出に戻ります。団体がもう一度「提出した」を押せるようになります。';
/** 代わりに提出したが、届いたか分からない（押すボタンの名前で言う。04 の書き込みの決まり） */
export const PROXY_SUBMIT_UNKNOWN = '提出できたか分かりません。もう一度「代わりに提出する」を押すと、確かめてから送ります';

/** 成功の知らせ（04「提出状況」のセルのシートの操作） */
export function reviewDoneMessage(action: SubmissionAction, groupName: string): string {
  switch (action) {
    case 'approve':
    case 'paper':
      return '承認しました';
    case 'return':
      return '差し戻しました';
    case 'submit':
      return `「${groupName}」の代わりに提出しました`;
    case 'withdraw':
      return '提出を取り消しました';
  }
}

/** 開いているセル（表の今の行。裏の読み直しで変わる） */
export interface OpenCell {
  cell: BoardCell;
  doc: DocumentRow;
  group: BoardGroupRow;
}

export interface DocumentsSheetProps {
  /** 開いているセル（null なら閉じている） */
  open: OpenCell | null;
  /** そのセルのファイル（部門長以上。総務部門員は null） */
  files: readonly DocumentFileRow[] | null;
  /** 表示名（user_id → 表示名） */
  names: ReadonlyMap<string, string>;
  /** 書けるか（部門長以上で、年度が終了でない。canManageDocuments） */
  writable: boolean;
  yearStatus: YearStatus | null;
  yearId: string;
  /** 自分（下書きのキー。なければ書けない） */
  userId: string | null;
  /** 開いた時刻・「読み直す」を押した時刻 */
  now: number;
  /** 自分が店長・副店長を務める団体（その団体の代わりに提出しても代理にならない） */
  repGroupIds: ReadonlySet<string>;
  /** 画面に1つある送り手（セルごとに状態が分かれる） */
  uploader: DocumentUploader;
  onClose: () => void;
  /** 提出状況を読み直す（届くまで待つ。読めなければ null） */
  rereadBoard: () => Promise<DocumentsBoardData | null>;
  /** 止められた後の画面の動き（forbidden・invalid_state は年度の行と立場を読み直す） */
  onYearEffect: (error: unknown) => void;
  onAuthError: AuthErrorHandler;
}

/**
 * セルのシート。セルが変わるたびに中身を作り直す（前のセルの知らせ・ダイアログを持ち込まない）。
 *
 * @example
 * <DocumentsSheet open={openCell} files={cellFiles} … onClose={() => router.forceReplace(documentsHref({ tab: 'status', filter }))} />
 */
export function DocumentsSheet(props: DocumentsSheetProps) {
  const { open } = props;
  if (!open) return null;
  return <SheetBody key={`${open.cell.documentId}:${open.cell.groupId}`} {...props} open={open} />;
}

/** シートの知らせ（代わりに提出する・取り消す・外すの失敗。unread は「読み直す」も出す。unknownAction は「分からない」で終わった操作） */
interface SheetNote {
  kind: 'error' | 'unread';
  message: string;
  unknownAction?: 'submit' | 'withdraw';
}

const NO_ACTIONS: LeadDocumentActions = {
  addFile: false,
  removeFile: false,
  removePending: false,
  approve: false,
  returnKind: null,
  paper: false,
  submit: false,
  withdraw: false,
};

function SheetBody({
  open,
  files,
  names,
  writable,
  yearStatus,
  yearId,
  userId,
  now,
  repGroupIds,
  uploader,
  onClose,
  rereadBoard,
  onYearEffect,
  onAuthError,
}: DocumentsSheetProps & { open: OpenCell }) {
  const { cell, doc, group } = open;
  const row = cell.row;
  const status = cell.marks.status;
  const showFiles = files !== null;
  const target: DocumentFileTarget = { documentId: cell.documentId, groupId: cell.groupId };
  const slot = uploadSlot(target);
  const actions = writable && userId ? leadDocumentActions(status, yearStatus) : NO_ACTIONS;

  const [note, setNote] = useState<SheetNote | null>(null);
  const [pending, setPending] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [review, setReview] = useState<ReviewTarget | null>(null);
  // 確かめのダイアログ（開いたときの版の写し）
  const [proxyBase, setProxyBase] = useState<{ base: string | null } | null>(null);
  const [withdrawBase, setWithdrawBase] = useState<{ base: string | null } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FileEntry | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // 見出し（操作が成功して押したボタンが消えた後のフォーカスの行き先。レビューの F4）
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitleAfterDialogs = () =>
    focusAfterDialogs(
      () => titleRef.current,
      () => titleRef.current?.closest('[role="dialog"]') ?? null,
    );

  const numbered = numberFiles(files ?? []);
  const rowIds = new Set(numbered.map((f) => f.file.id));
  const localOnly = showFiles ? uploader.localOnly(slot, rowIds) : [];
  const entries = fileEntriesOf(numbered, localOnly, uploader.uploading, uploader.failed, uploader.sent);
  const uploadBusy = uploader.busy(slot);
  const busy = pending || uploadBusy || rereading;
  const blocker = submitBlocker([...numbered.map((f) => f.file), ...localOnly.map(() => ({ uploaded: false }))], uploadBusy);

  /** 読み直して、このセルの提出の行を返す（読めなければ投げる。対象でない・消えたなら null） */
  const rereadRow = async (): Promise<BoardStatusRow | null> => {
    const fresh = await rereadBoard();
    if (!fresh) throw new Error('reread');
    return fresh.statuses.find((s) => s.document_id === cell.documentId && s.group_id === cell.groupId) ?? null;
  };

  // ---------------------------------------------------------------- 承認・差し戻し・紙での承認（ダイアログ）

  const openReview = (kind: ReviewKind) => {
    const heading = kind === 'approve' ? '承認する' : kind === 'paper' ? PAPER_LABEL : RETURN_KIND_LABELS[actions.returnKind ?? 'return'];
    setReview({
      kind,
      documentId: cell.documentId,
      groupId: cell.groupId,
      heading,
      subject: `${group.name}・${doc.title}`,
      base: row.updated_at ?? null,
      // 理由の書き直し（差し戻しのまま）は今の理由を入れて開く
      initial: kind === 'return' && status === 'returned' ? (row.review_note ?? '') : '',
    });
  };

  const sendReview: ReviewNoteDialogProps['onSubmit'] = async ({ target: t, note: text, base, afterUnknown }): Promise<ReviewOutcome> => {
    const action: SubmissionAction = t.kind === 'return' ? 'return' : t.kind === 'paper' ? 'paper' : 'approve';
    // 読み直した行（止められて読み直したら、次の送信はその版で送る）。undefined は読み直していない
    let latest: BoardStatusRow | null | undefined;
    setPending(true);
    try {
      const r = await runSubmissionWrite(
        {
          action,
          base,
          note: text,
          afterUnknown,
          send: () =>
            action === 'return'
              ? returnDocument(t.documentId, t.groupId, text ?? '', base ?? '')
              : approveDocument(t.documentId, t.groupId, text, base),
          reread: async () => {
            latest = await rereadRow();
            return latest ? { status: latest.status, updated_at: latest.updated_at, review_note: latest.review_note } : null;
          },
        },
        onAuthError,
      );
      const ctx = { rpc: SUBMISSION_RPCS[action] };
      switch (r.type) {
        case 'done':
          // 届くまで待ってから知らせる（シートを新しい状態にしてから。止められた後の読み直しはもう済んでいる）
          if (!r.before) await rereadBoard();
          toast.success(r.before ? SUBMISSION_DONE_BEFORE[action] : reviewDoneMessage(action, group.name));
          focusTitleAfterDialogs();
          return { type: 'done' };
        case 'unknown':
          return { type: 'keep', kind: 'unknown', message: SUBMISSION_UNKNOWN[action] };
        case 'rejected':
          onYearEffect(r.error);
          return {
            type: 'keep',
            kind: 'error',
            message: messageFor(classifyError(r.error), ctx),
            ...(latest !== undefined ? { base: latest?.updated_at ?? null } : {}),
          };
        case 'unread':
          onYearEffect(r.error);
          return { type: 'keep', kind: 'unread', message: REREAD_FAILED_NOTICE };
        case 'failed': {
          const c = classifyError(r.error);
          onYearEffect(r.error);
          if (effectOf(c).reload === 'data') void rereadBoard();
          return { type: 'keep', kind: 'error', message: messageFor(c, ctx) };
        }
      }
    } finally {
      setPending(false);
    }
  };

  const rereadReview: ReviewNoteDialogProps['onReread'] = async () => {
    try {
      const fresh = await rereadRow();
      return { ok: true, base: fresh?.updated_at ?? null };
    } catch {
      return { ok: false };
    }
  };

  // ---------------------------------------------------------------- 代わりに提出する・取り消す（確かめのダイアログ）

  const runConfirmWrite = async (action: 'submit' | 'withdraw', base: string | null) => {
    const afterUnknown = note?.unknownAction === action;
    setNote(null);
    setPending(true);
    try {
      const r = await runSubmissionWrite(
        {
          action,
          base,
          afterUnknown,
          send: () =>
            action === 'submit' ? submitDocument(cell.documentId, cell.groupId, base) : withdrawDocument(cell.documentId, cell.groupId, base ?? ''),
          reread: async () => {
            const fresh = await rereadRow();
            return fresh ? { status: fresh.status, updated_at: fresh.updated_at, review_note: fresh.review_note } : null;
          },
        },
        onAuthError,
      );
      const ctx = { rpc: SUBMISSION_RPCS[action] };
      switch (r.type) {
        case 'done':
          if (!r.before) await rereadBoard();
          toast.success(r.before ? SUBMISSION_DONE_BEFORE[action] : reviewDoneMessage(action, group.name));
          focusTitleAfterDialogs();
          return;
        case 'unknown':
          setNote({ kind: 'error', message: action === 'submit' ? PROXY_SUBMIT_UNKNOWN : SUBMISSION_UNKNOWN[action], unknownAction: action });
          return;
        case 'rejected':
          setNote({ kind: 'error', message: messageFor(classifyError(r.error), ctx) });
          onYearEffect(r.error);
          return;
        case 'unread':
          setNote({ kind: 'unread', message: REREAD_FAILED_NOTICE });
          onYearEffect(r.error);
          return;
        case 'failed': {
          const c = classifyError(r.error);
          setNote({ kind: 'error', message: messageFor(c, ctx) });
          onYearEffect(r.error);
          if (effectOf(c).reload === 'data') void rereadBoard();
          return;
        }
      }
    } finally {
      setPending(false);
    }
  };

  /** 止められた後に読み直せなかったときの「読み直す」：提出状況を読み直し、また読めなければ知らせを変える */
  const rereadUnread = async () => {
    setRereading(true);
    try {
      const fresh = await rereadBoard();
      setNote(fresh ? null : { kind: 'unread', message: REREAD_AGAIN_FAILED_MESSAGE });
    } finally {
      setRereading(false);
    }
  };

  // ---------------------------------------------------------------- ファイル（開く・保存・外す・足す・もう一度）

  const showOpenResult = (r: FileOpenResult) => {
    if (r.type === 'opened') return;
    if (r.type === 'blocked') {
      uploader.setError(slot, POPUP_BLOCKED_MESSAGE);
      return;
    }
    const c = classifyError(r.error);
    // 開く・保存（署名つき URL）の 403 はアップロードの文言にしない（レビューの UX-4）
    uploader.setError(slot, messageFor(c, { storage: 'sign' }));
    onYearEffect(r.error);
    if (c.kind === 'not_found') void rereadBoard();
  };

  const onOpenFile = async (entry: FileEntry) => {
    if (!entry.row) return;
    uploader.setError(slot, null);
    showOpenResult(await openDocumentFile(entry.row.object_path));
  };

  const onSaveFile = async (entry: FileEntry) => {
    // 上げている間は押せない（このページを移すと、ページを離れる確かめが出る。レビューの F2）
    if (!entry.row || uploader.active) return;
    uploader.setError(slot, null);
    showOpenResult(await saveDocumentFile(entry.row.object_path, downloadNameFor(doc.title, group.name, entry.n, entry.row.content_type)));
  };

  const onRemoveFile = async (entry: FileEntry) => {
    // DB の行のない失敗（そのタブだけ）は書き込みでないので、確かめずに消す
    if (!entry.row) {
      await uploader.remove(target, entry.id, null);
      return;
    }
    if (entry.state === 'uploaded') {
      setRemoveError(null);
      setRemoveTarget(entry);
      return;
    }
    // 届いていないファイルは確かめずに外す（提出の状態によらない）
    const r = await uploader.remove(target, entry.id, entry.row);
    if (r.type === 'unknown') uploader.setError(slot, DISCARD_UNKNOWN_MESSAGE);
  };

  const confirmRemove = async () => {
    const entry = removeTarget;
    if (!entry) return;
    setRemoveError(null);
    const r = await uploader.remove(target, entry.id, entry.row);
    if (r.type === 'unknown') {
      // 外せたか分からない：確かめのダイアログを開いたまま知らせる（もう一度押すと、読み直してから決める）
      setRemoveError(DISCARD_UNKNOWN_MESSAGE);
      throw new Error('keep-open');
    }
    if (r.type === 'removed') toast.success(`ファイル ${entry.n} を外しました`);
  };

  // ---------------------------------------------------------------- 描く

  const nameOf = (userIdOf: string | null) => (userIdOf ? names.get(userIdOf) : undefined) || UNKNOWN_ACTOR;
  const reviewNote = row.review_note && row.review_note.trim() !== '' ? row.review_note : null;
  const noteLabel =
    status === 'returned' ? '差し戻しの理由' : status === 'submitted' && reviewNote ? '前回の差し戻しの理由' : status === 'approved' && reviewNote ? '承認のメモ' : null;
  const marks = cellMarkLabels(cell);
  const isRep = repGroupIds.has(cell.groupId);
  const titleText = `${group.name}・${doc.title}`;

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        // 送っている・上げている間は閉じない
        if (!o && !busy) onClose();
      }}
    >
      <SheetContent
        side="right"
        data-testid="documents-sheet"
        className="w-full gap-0 overflow-y-auto sm:max-w-lg"
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <SheetHeader className="border-b pr-10">
          <SheetTitle ref={titleRef} tabIndex={-1} data-testid="documents-sheet-title" className="outline-none [overflow-wrap:anywhere]">
            {titleText}
          </SheetTitle>
          <SheetDescription>
            締切 {columnDeadlineText(doc.deadline, now)}
            {cell.marks.overdue ? <span className="ml-2 font-medium text-amber-800">{COLUMN_OVERDUE_TEXT}</span> : null}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 p-4">
          <div data-testid="documents-sheet-status" data-status={status} className="flex flex-wrap items-center gap-1.5">
            <DocumentStatusBadge status={status} labels={SOUMU_STATUS_LABELS} />
            {marks.map((m) => (
              <Badge key={m} variant="outline" className={DOCUMENT_MARK_CLASS}>
                {m}
              </Badge>
            ))}
          </div>

          <ul data-testid="documents-sheet-history" className="space-y-1 text-sm">
            {row.submitted_at ? (
              <li>
                提出 <TokyoTime value={row.submitted_at} />（{nameOf(row.submitted_by)}）
                {row.proxy ? (
                  <Badge variant="outline" className={cn('ml-1.5', DOCUMENT_MARK_CLASS)}>
                    {DOCUMENT_MARK_LABELS.proxy}
                  </Badge>
                ) : null}
              </li>
            ) : null}
            {status === 'approved' ? (
              <li>
                承認 <TokyoTime value={row.reviewed_at} />（{nameOf(row.reviewed_by)}）
              </li>
            ) : null}
            {status === 'returned' ? (
              <li>
                差し戻し <TokyoTime value={row.reviewed_at} />（{nameOf(row.reviewed_by)}）
              </li>
            ) : null}
            {!row.submitted_at && status !== 'approved' && status !== 'returned' ? <li className="text-muted-foreground">{NO_HISTORY_TEXT}</li> : null}
          </ul>

          {noteLabel && reviewNote ? (
            <div
              data-testid="documents-sheet-note"
              className={cn('space-y-1 rounded-md border px-3 py-2 text-sm', status === 'returned' && 'border-amber-400 bg-amber-50 text-amber-950')}
            >
              <p className="font-medium">{noteLabel}</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{reviewNote}</p>
            </div>
          ) : null}

          {/* 提出先（T24。D-62）：ドライブ・フォームを新しいタブで開く。中を見られるかはドライブの共有の設定で決まる */}
          <div className="text-sm">
            {submitUrlHref(doc.submit_url) ? (
              <SubmitLink url={doc.submit_url} testId="documents-sheet-submit-url" />
            ) : (
              <p data-testid="documents-sheet-no-submit-url" className="text-muted-foreground">
                {NO_SUBMIT_URL_SHEET_TEXT}
                {writable && userId ? NO_SUBMIT_URL_LEAD_HINT : ''}
              </p>
            )}
          </div>

          {showFiles ? (
            entries.length > 0 || uploader.error(slot) ? (
              <section data-testid="documents-sheet-files" aria-label="ファイル" className="space-y-2">
                <h3 className="text-sm font-medium">ファイル</h3>
                <DocumentFileList
                  entries={entries}
                  testIds={SHEET_FILE_TESTIDS}
                  canRemoveUploaded={actions.removeFile}
                  canRemovePending={actions.removePending}
                  canRetry={false}
                  disabled={busy}
                  saveBlocked={uploader.active}
                  onOpen={(e) => void onOpenFile(e)}
                  onSave={(e) => void onSaveFile(e)}
                  onRemove={(e) => void onRemoveFile(e)}
                  onRetry={() => undefined}
                />
                {uploader.error(slot) ? (
                  <p role="alert" data-testid="documents-sheet-file-error" className="text-sm text-destructive">
                    {uploader.error(slot)}
                  </p>
                ) : null}
              </section>
            ) : null
          ) : (
            <p data-testid="documents-sheet-staff-note" className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {STAFF_FILES_NOTE}
            </p>
          )}

          {note ? (
            <div
              role="alert"
              data-testid="documents-sheet-error"
              data-kind={note.kind}
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
            >
              <p className="font-medium text-destructive">{note.message}</p>
              {note.kind === 'unread' ? (
                <Button
                  data-testid="documents-sheet-reread"
                  size="sm"
                  variant="outline"
                  onClick={() => void rereadUnread()}
                  disabled={rereading}
                  aria-busy={rereading || undefined}
                >
                  {rereading ? '読み直しています…' : '読み直す'}
                </Button>
              ) : null}
            </div>
          ) : null}

          {actions.approve || actions.returnKind || actions.paper || actions.submit || actions.withdraw ? (
            <div className="space-y-3 border-t pt-4">
              <div className="flex flex-wrap gap-2">
                {actions.approve ? (
                  <Button data-testid="documents-sheet-approve" disabled={busy} onClick={() => openReview('approve')}>
                    承認する
                  </Button>
                ) : null}
                {actions.returnKind ? (
                  <Button data-testid="documents-sheet-return" variant="outline" disabled={busy} onClick={() => openReview('return')}>
                    {RETURN_KIND_LABELS[actions.returnKind]}
                  </Button>
                ) : null}
                {actions.paper ? (
                  <Button data-testid="documents-sheet-paper" variant="outline" disabled={busy} onClick={() => openReview('paper')}>
                    {PAPER_LABEL}
                  </Button>
                ) : null}
                {actions.submit ? (
                  <Button
                    data-testid="documents-sheet-submit"
                    variant="outline"
                    disabled={busy || blocker !== null}
                    aria-describedby={blocker ? 'documents-sheet-submit-hint' : undefined}
                    onClick={() => setProxyBase({ base: row.updated_at ?? null })}
                  >
                    代わりに提出する
                  </Button>
                ) : null}
                {actions.withdraw ? (
                  <Button data-testid="documents-sheet-withdraw" variant="outline" disabled={busy} onClick={() => setWithdrawBase({ base: row.updated_at ?? null })}>
                    提出を取り消す
                  </Button>
                ) : null}
              </div>
              {actions.submit && blocker ? (
                <p id="documents-sheet-submit-hint" className="text-sm text-muted-foreground">
                  {blocker}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {userId ? (
          <ReviewNoteDialog target={review} onClose={() => setReview(null)} userId={userId} yearId={yearId} onSubmit={sendReview} onReread={rereadReview} />
        ) : null}
        <ConfirmDialog
          open={proxyBase !== null}
          onOpenChange={(o) => {
            if (!o) setProxyBase(null);
          }}
          title={`「${group.name}」の代わりに「${doc.title}」を提出しますか`}
          confirmLabel="提出する"
          pendingLabel="送信中…"
          onConfirm={async () => {
            if (proxyBase) await runConfirmWrite('submit', proxyBase.base);
          }}
        >
          <div data-testid="documents-proxy-confirm" className="text-sm text-muted-foreground">
            {isRep ? null : <p>{PROXY_CONFIRM_TEXT}</p>}
          </div>
        </ConfirmDialog>
        <ConfirmDialog
          open={withdrawBase !== null}
          onOpenChange={(o) => {
            if (!o) setWithdrawBase(null);
          }}
          title={`「${group.name}」の「${doc.title}」の提出を取り消しますか`}
          description={WITHDRAW_SHEET_CONFIRM_TEXT}
          confirmLabel="取り消す"
          pendingLabel="送信中…"
          onConfirm={async () => {
            if (withdrawBase) await runConfirmWrite('withdraw', withdrawBase.base);
          }}
        >
          <div data-testid="documents-withdraw-confirm" />
        </ConfirmDialog>
        <ConfirmDialog
          open={removeTarget !== null}
          onOpenChange={(o) => {
            if (!o) {
              setRemoveTarget(null);
              setRemoveError(null);
            }
          }}
          title={removeTarget ? `ファイル ${removeTarget.n} を外しますか` : ''}
          description={REMOVE_CONFIRM_TEXT}
          confirmLabel="外す"
          pendingLabel="外しています…"
          destructive
          onConfirm={confirmRemove}
        >
          <div data-testid="documents-remove-confirm">
            {removeError ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {removeError}
              </p>
            ) : null}
          </div>
        </ConfirmDialog>
      </SheetContent>
    </Sheet>
  );
}
