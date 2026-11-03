'use client';

// セルのシートの承認・差し戻し・紙などで受け取った承認のダイアログ（04「提出状況 /documents（PC）」のセルのシートの操作、「提出物」の書き込みの
// 決まり、notes/T19.md「パート B・C の約束」6。T19・D-55）。部門長以上だけが開く（終了した年度を除く）。
// - 承認する（提出済み）：メモは任意（1000 字まで）。差し戻す（提出済み。承認なら「承認を取り消して差し戻す」、差し戻しなら「理由を書き直す」で
//   今の理由を入れて開く）：理由は必須（前後の空白を除いて 1〜1000 字）。紙などで受け取ったとして承認する（未提出・差し戻し）：メモは必須。
//   「{n}/1000」は今の字数（前後の空白を除かない。コードポイント）。団体にも見える・履歴に残るので、個人の名前を書かないよう添える。
// - 送る版（base_updated_at）は開いたときのシートの提出の版。止められて読み直した（conflict・not_editable）ら、読み直した版に進める（もう一度
//   押すと、読み直した版で送る）。応答が届かなかった（分からない）後のもう一度は同じ版で送り、前の送信が通っていたかを読み直して決める（(B1)。
//   submission-write.ts）。結果の出し方はシート（documents-sheet.tsx）が決めて返す（閉じるか、入力を残して知らせを出すか）。
// - 入力はブラウザに下書きとして置き（lib/drafts.ts。セルとダイアログごと）、開き直したときに戻せる（DraftNotice）。閉じる前・アプリの中で
//   移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。成功したら消す。
import { useEffect, useId, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { approveNoteSchema, checkReturnNote, noteLength, paperNoteSchema, REVIEW_NOTE_MAX } from '@/lib/schemas/documents';
import { cn } from '@/lib/utils';
import { REREAD_AGAIN_FAILED_MESSAGE } from './submission-write';

/** ダイアログの種類 */
export type ReviewKind = 'approve' | 'return' | 'paper';

/** 開いているダイアログ（開いたときのシートの写し） */
export interface ReviewTarget {
  kind: ReviewKind;
  documentId: string;
  groupId: string;
  /** 見出し（押したボタンと同じ。差し戻しは「差し戻す」「承認を取り消して差し戻す」「理由を書き直す」） */
  heading: string;
  /** どの提出か（「{団体}・{提出物}」。見出しの下に出す） */
  subject: string;
  /** 開いたときの提出の版（v_document_status の updated_at。行がなければ null） */
  base: string | null;
  /** 開いたときの入力（理由の書き直しは今の理由。ほかは空） */
  initial: string;
}

/** 送った結果（シートが決める）：閉じる（成功）か、入力を残して知らせを出す */
export type ReviewOutcome =
  | { type: 'done' }
  | {
      type: 'keep';
      /** unknown：できたか分からない（もう一度押すと確かめてから送る）、unread：読み直せなかった（「読み直す」）、error：ほか */
      kind: 'unknown' | 'unread' | 'error';
      message: string;
      /** 読み直した版（止められて読み直したとき。次の送信はこの版で送る） */
      base?: string | null;
    };

/** シートの「読み直す」（止められた後に読み直せなかったとき）の結果 */
export type ReviewReread = { ok: true; base: string | null } | { ok: false };

/** 承認・紙での承認のメモの注意（04「提出状況」のセルのシート） */
export const NOTE_VISIBLE_HELP = 'メモは団体にも見えます。個人の名前は書かないでください。';
/** 差し戻しの理由の注意 */
export const RETURN_REASON_HELP = '理由は団体のホームと履歴に残ります。個人の名前は書かないでください。';
/** 紙での承認のメモの例 */
export const PAPER_NOTE_PLACEHOLDER = '例：10/3 に紙で受け取りました';

/** ダイアログごとの文言と testid（04 の testid の表） */
const KIND_TEXT: Readonly<
  Record<ReviewKind, { label: string; help: string; submit: string; pending: string; testids: { dialog: string; note: string; count: string; submit: string } }>
> = {
  approve: {
    label: 'メモ（任意）',
    help: NOTE_VISIBLE_HELP,
    submit: '承認する',
    pending: '送信中…',
    testids: { dialog: 'documents-approve-dialog', note: 'documents-approve-note', count: 'documents-approve-note-count', submit: 'documents-approve-submit' },
  },
  return: {
    label: '差し戻しの理由',
    help: RETURN_REASON_HELP,
    submit: '差し戻す',
    pending: '送信中…',
    testids: { dialog: 'documents-return-dialog', note: 'documents-return-reason', count: 'documents-return-reason-count', submit: 'documents-return-submit' },
  },
  paper: {
    label: 'メモ',
    help: NOTE_VISIBLE_HELP,
    submit: '承認する',
    pending: '送信中…',
    testids: { dialog: 'documents-paper-dialog', note: 'documents-paper-note', count: 'documents-paper-note-count', submit: 'documents-paper-submit' },
  },
};

/** 入力の確かめ（送る前。通れば送る値〔承認のメモの空は null〕、通らなければ文言） */
export function checkReviewNote(kind: ReviewKind, value: string): { ok: true; note: string | null } | { ok: false; message: string } {
  if (kind === 'return') return checkReturnNote(value);
  const r = (kind === 'approve' ? approveNoteSchema : paperNoteSchema).safeParse(value);
  return r.success ? { ok: true, note: r.data } : { ok: false, message: r.error.issues[0]?.message ?? '' };
}

/** 下書きの値 */
interface ReviewDraft {
  note: string;
}

export interface ReviewNoteDialogProps {
  target: ReviewTarget | null;
  onClose: () => void;
  /** 下書きのキー（自分・年度） */
  userId: string;
  yearId: string;
  /** 送る（シートが runSubmissionWrite で送り、結果の出し方を返す） */
  onSubmit: (req: { target: ReviewTarget; note: string | null; base: string | null; afterUnknown: boolean }) => Promise<ReviewOutcome>;
  /** 止められた後に読み直せなかったときの「読み直す」（シートの読み取りを読み直し、その提出の版を返す） */
  onReread: (target: ReviewTarget) => Promise<ReviewReread>;
}

/**
 * 承認・差し戻し・紙での承認のダイアログ。target が変わるたびに中身を作り直す（前のセルの入力を持ち込まない）。
 *
 * @example
 * <ReviewNoteDialog target={review} onClose={() => setReview(null)} userId={userId} yearId={yearId} onSubmit={sendReview} onReread={reread} />
 */
export function ReviewNoteDialog(props: ReviewNoteDialogProps) {
  const { target } = props;
  const key = target ? `${target.kind}:${target.documentId}:${target.groupId}` : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <ReviewNoteBody key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

function ReviewNoteBody({ target, onClose, userId, yearId, onSubmit, onReread }: ReviewNoteDialogProps & { target: ReviewTarget }) {
  const text = KIND_TEXT[target.kind];
  const id = useId();
  const [value, setValue] = useState(target.initial);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'unknown' | 'unread' | 'error'; message: string } | null>(null);
  // 送る版（開いたときの版。止められて読み直したら進める）と、前の送信が「分からない」で終わったか
  const [base, setBase] = useState<string | null>(target.base);
  const [afterUnknown, setAfterUnknown] = useState(false);
  const [pending, setPending] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const busy = pending || rereading;

  // 下書き（セルとダイアログごと）
  const draftKeyValue: DraftKey = useMemo(
    () => ({ userId, yearId, screen: 'documents', target: `${target.kind}:${target.documentId}:${target.groupId}` }),
    [userId, yearId, target.kind, target.documentId, target.groupId],
  );
  const writer = useMemo(() => createDraftWriter<ReviewDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const v = d?.value;
    return d && typeof v === 'object' && v !== null && typeof (v as ReviewDraft).note === 'string'
      ? { note: (v as ReviewDraft).note, savedAt: d.savedAt }
      : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const dirty = value !== target.initial;
  const count = noteLength(value);

  const change = (next: string) => {
    setValue(next);
    setFieldError(null);
    // 戻すか捨てるかを決めるまでは上書きしない。開いたときの値に戻したら消す
    if (draft) return;
    if (next === target.initial) writer.clear();
    else writer.write({ note: next });
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  const send = async () => {
    if (busy) return;
    const r = checkReviewNote(target.kind, value);
    if (!r.ok) {
      setFieldError(r.message);
      return;
    }
    setFieldError(null);
    setNotice(null);
    setPending(true);
    try {
      const out = await onSubmit({ target, note: r.note, base, afterUnknown });
      if (out.type === 'done') {
        writer.clear();
        onClose();
        return;
      }
      setNotice({ kind: out.kind, message: out.message });
      setAfterUnknown(out.kind === 'unknown');
      if (out.base !== undefined) setBase(out.base);
    } finally {
      setPending(false);
    }
  };

  const reread = async () => {
    if (busy) return;
    setRereading(true);
    try {
      const r = await onReread(target);
      if (r.ok) {
        setBase(r.base);
        setNotice(null);
      } else {
        setNotice({ kind: 'unread', message: REREAD_AGAIN_FAILED_MESSAGE });
      }
    } finally {
      setRereading(false);
    }
  };

  const restoreDraft = () => {
    if (!draft || busy) return;
    setValue(draft.note);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const noteId = `${id}-note`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid={text.testids.dialog}
        className="sm:max-w-lg"
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
        <DialogHeader>
          <DialogTitle>{target.heading}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{target.subject}</DialogDescription>
        </DialogHeader>
        {notice ? (
          <div
            role="alert"
            data-testid="documents-review-error"
            data-kind={notice.kind}
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          >
            <p className="font-medium text-destructive">{notice.message}</p>
            {notice.kind === 'unread' ? (
              <Button size="sm" variant="outline" onClick={() => void reread()} disabled={busy} aria-busy={rereading || undefined}>
                {rereading ? '読み直しています…' : '読み直す'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor={noteId}>{text.label}</Label>
            <span
              data-testid={text.testids.count}
              className={cn('text-xs tabular-nums text-muted-foreground', count > REVIEW_NOTE_MAX && 'text-destructive')}
            >
              {count}/{REVIEW_NOTE_MAX}
            </span>
          </div>
          <Textarea
            id={noteId}
            data-testid={text.testids.note}
            value={value}
            rows={4}
            placeholder={target.kind === 'paper' ? PAPER_NOTE_PLACEHOLDER : undefined}
            onChange={(e) => change(e.target.value)}
            disabled={busy}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${helpId} ${errorId}` : helpId}
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            {text.help}
          </p>
          {fieldError ? (
            <p id={errorId} className="text-sm text-destructive">
              {fieldError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            やめる
          </Button>
          <Button data-testid={text.testids.submit} onClick={() => void send()} disabled={busy} aria-busy={pending || undefined}>
            {pending ? text.pending : text.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない入力を捨てますか"
        description="閉じると、このダイアログに入れた内容は消えます。"
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
