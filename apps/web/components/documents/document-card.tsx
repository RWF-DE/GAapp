'use client';

// 自団体の提出物（/document）のカード1枚（04「自団体の提出物」のカードに出すもの、notes/T19.md「パート B・C の約束」6。T19・D-55）。
// 上から：題名と状態の印（締切の後）、締切（「締切 10/5（月）17:00」と相対の言い方。未提出・差し戻しで過ぎていれば注意の色）、説明
// （書いたとおりの文字）、提出先（T24。「提出先を開く」のリンク〔新しいタブ〕か、まだないときの文）、差し戻し（目立つ枠に日時・理由・
// 「直してから…」）、提出済み（日時と前回の差し戻しの理由）、承認（日時とメモ・紙などで受け取った）、代理の提出、ファイル（T24 の前に上がった
// ものがあるときだけ一覧。「ファイルを追加」は T24 でやめた）、知らせ、「提出した」（押せない理由）・
// 「提出を取り消す」。出す操作は店長・副店長の決まり（repDocumentActions。管理者が兼ねていても同じ）。色だけで表さず、文字を出す。
import { useEffect, useRef } from 'react';
import { TokyoTime } from '@/components/common/tokyo-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DOCUMENT_MARK_LABELS, REP_MARK_TEXTS, REP_STATUS_LABELS } from '@/lib/modules/documents/labels';
import type { RepDocumentActions } from '@/lib/modules/documents/permissions';
import { deadlineRelative, deadlineText, type RepDocumentCard } from '@/lib/modules/documents/rep';
import { cn } from '@/lib/utils';
import { submitUrlHref } from '@/lib/modules/documents/submit-url';
import { DocumentFileList, REP_FILE_TESTIDS, type FileEntry } from './document-file-list';
import { DOCUMENT_MARK_CLASS, DocumentStatusBadge } from './status-badge';
import { SubmitLink } from './submit-link';

/** 提出先の URL があるときの文（T24。D-62） */
export const SUBMIT_URL_HINT = 'ドライブやフォームで出してから、「提出した」を押してください（出せる人・見られる人は、提出先の共有の設定で決まります）';
/** 提出先の URL がないときの文（T24） */
export const NO_SUBMIT_URL_TEXT = '提出先は総務から知らされます（決まると、ここに「提出先を開く」が出ます）';
/** 差し戻しの枠の最後の文 */
export const RETURNED_HINT = '直してから、もう一度「提出した」を押してください';

/** カードの題名の id（aria-labelledby と、提出・取り消しの後のフォーカスの行き先） */
export function cardTitleId(documentId: string): string {
  return `document-card-title-${documentId}`;
}

/** カードの知らせ（提出・取り消しの失敗。unread は「読み直す」も出す） */
export interface CardNote {
  kind: 'error' | 'unread';
  message: string;
}

export interface DocumentCardProps {
  card: RepDocumentCard;
  /** 画面を開いた時刻・「読み直す」を押した時刻（締切を過ぎたか） */
  now: number;
  actions: RepDocumentActions;
  highlighted: boolean;
  /** T24 の前に上がったファイル（なければ空。ファイルの欄を出さない） */
  entries: readonly FileEntry[];
  /** 外している・送っている（外す・提出・取り消しを押せない） */
  busy: boolean;
  /** その画面のどこかで外している（「保存」を押せない。レビューの F2） */
  saveBlocked: boolean;
  fileError: string | null;
  note: CardNote | null;
  /** 「提出した」を押せない理由（押せるなら null） */
  submitBlocker: string | null;
  rereading: boolean;
  onOpen: (e: FileEntry) => void;
  onSave: (e: FileEntry) => void;
  onRemove: (e: FileEntry) => void;
  onSubmit: () => void;
  onWithdraw: () => void;
  onReread: () => void;
}

export function DocumentCard(props: DocumentCardProps) {
  const { card, now, actions, highlighted, busy, note } = props;
  const { doc, status, marks } = card;
  const ref = useRef<HTMLElement>(null);
  // ダッシュボードから来たカード（?document=）は、見える所に送る（目立たせるのは data-highlighted と色）
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [highlighted]);
  const relative = deadlineRelative(doc.deadline, now);
  const titleId = cardTitleId(doc.document_id);
  // ファイルの欄は、T24 の前に上がったファイルがあるか、開く・外すの知らせがあるときだけ（ファイルを上げる欄は T24 でやめた）
  const showFiles = props.entries.length > 0 || props.fileError !== null;
  const hasSubmitUrl = submitUrlHref(doc.submit_url) !== null;
  return (
    <article
      ref={ref}
      aria-labelledby={titleId}
      data-testid="document-card"
      data-document-id={doc.document_id}
      data-status={status}
      data-late={marks.late ? 'true' : 'false'}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('scroll-mt-20 space-y-3 rounded-lg border bg-card p-4', highlighted && 'ring-2 ring-amber-300')}
    >
      <header className="space-y-1.5">
        {/* 「提出した」「提出を取り消す」の後は押したボタンが消えるので、ここへフォーカスを移す（tabIndex -1。レビューの F4） */}
        <h2 id={titleId} tabIndex={-1} data-testid="document-card-title" className="text-base font-semibold outline-none [overflow-wrap:anywhere]">
          {doc.title}
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <DocumentStatusBadge data-testid="document-card-status" status={status} labels={REP_STATUS_LABELS} />
          {marks.late ? (
            <Badge data-testid="document-card-late" variant="outline" className={DOCUMENT_MARK_CLASS}>
              {DOCUMENT_MARK_LABELS.late}
            </Badge>
          ) : null}
        </div>
        <p data-testid="document-card-deadline" data-overdue={marks.overdue ? 'true' : 'false'} className="text-sm">
          <span className={cn(marks.overdue && 'font-medium text-amber-800')}>{deadlineText(doc.deadline, now)}</span>
          {relative ? <span className={cn('ml-2 text-xs', marks.overdue ? 'font-medium text-amber-800' : 'text-muted-foreground')}>{relative}</span> : null}
        </p>
      </header>

      {doc.description ? (
        <p data-testid="document-card-description" className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {doc.description}
        </p>
      ) : null}
      {hasSubmitUrl ? (
        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <SubmitLink url={doc.submit_url} testId="document-card-submit-url" className="text-base" />
          {actions.submit ? <p className="text-muted-foreground">{SUBMIT_URL_HINT}</p> : null}
        </div>
      ) : actions.submit ? (
        <p data-testid="document-card-no-submit-url" className="text-sm text-muted-foreground">
          {NO_SUBMIT_URL_TEXT}
        </p>
      ) : null}

      {status === 'returned' ? (
        <div data-testid="document-returned" className="space-y-1 rounded-md border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-semibold">
            差し戻されました（<TokyoTime value={doc.reviewed_at} format="short" />）
          </p>
          {card.returnNote ? (
            <p data-testid="document-returned-reason" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              理由：{card.returnNote}
            </p>
          ) : null}
          <p>{RETURNED_HINT}</p>
        </div>
      ) : null}
      {status === 'submitted' ? (
        <div className="space-y-1 text-sm">
          <p data-testid="document-submitted-at">
            提出しました（<TokyoTime value={doc.submitted_at} format="short" />）
          </p>
          {card.previousReturnNote ? (
            <p data-testid="document-previous-reason" className="text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
              前回の差し戻しの理由：{card.previousReturnNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {status === 'approved' ? (
        <div data-testid="document-approved" className="space-y-1 text-sm">
          <p className="font-medium text-emerald-900">
            承認されました（<TokyoTime value={doc.reviewed_at} format="short" />）
          </p>
          {card.approvalNote ? (
            <p data-testid="document-approved-note" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              メモ：{card.approvalNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {marks.paper ? (
        <p data-testid="document-card-paper" className="text-sm">
          {REP_MARK_TEXTS.paper}
        </p>
      ) : null}
      {marks.proxy ? (
        <p data-testid="document-card-proxy" className="text-sm">
          {REP_MARK_TEXTS.proxy}
        </p>
      ) : null}

      {showFiles ? (
        <section aria-label="ファイル" className="space-y-2">
          <DocumentFileList
            entries={props.entries}
            testIds={REP_FILE_TESTIDS}
            canRemoveUploaded={actions.removeFile}
            canRemovePending={actions.removePending}
            canRetry={false}
            disabled={busy}
            saveBlocked={props.saveBlocked}
            onOpen={props.onOpen}
            onSave={props.onSave}
            onRemove={props.onRemove}
            onRetry={() => undefined}
          />
          {props.fileError ? (
            <p role="alert" data-testid="document-file-error" className="text-sm text-destructive">
              {props.fileError}
            </p>
          ) : null}
        </section>
      ) : null}

      {note ? (
        <div role="alert" data-testid="document-error" data-kind={note.kind} className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <p className="font-medium text-destructive">{note.message}</p>
          {note.kind === 'unread' ? (
            <Button
              data-testid="document-reread"
              size="sm"
              variant="outline"
              onClick={props.onReread}
              disabled={props.rereading}
              aria-busy={props.rereading || undefined}
            >
              {props.rereading ? '読み直しています…' : '読み直す'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {actions.submit ? (
        <div className="space-y-1">
          <Button
            data-testid="document-submit"
            className="w-full"
            size="lg"
            disabled={busy || props.submitBlocker !== null}
            aria-describedby={props.submitBlocker ? `${titleId}-submit-hint` : undefined}
            onClick={props.onSubmit}
          >
            提出した
          </Button>
          {props.submitBlocker ? (
            <p id={`${titleId}-submit-hint`} data-testid="document-submit-hint" className="text-sm text-muted-foreground">
              {props.submitBlocker}
            </p>
          ) : null}
        </div>
      ) : null}
      {actions.withdraw ? (
        <Button data-testid="document-withdraw" variant="outline" className="w-full" disabled={busy} onClick={props.onWithdraw}>
          提出を取り消す
        </Button>
      ) : null}
    </article>
  );
}
