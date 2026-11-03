'use client';

// 終了した年度のファイルの削除と片付け（04「提出状況 /documents（PC）」の終了した年度、「提出物」のファイルの扱い、Q3。notes/T19.md
// 「パート B・C の約束」6。T19・D-55）。終了した年度の部門長以上に、提出状況のタブの上で出す。
// - 管理者：「この年度のファイルをすべて削除（{N} 件・{X} MB）」（N・X は document_storage_usage の file_count・file_bytes）と、先に要るものを
//   保存するよう書く。押すと確かめ（理由は任意。500 字まで。空なら DB が「提出物のファイルの削除」にする）→ delete_year_document_files →
//   片付け（どの提出にも属さなくなった Storage の物を remove）→「ファイル {N} 件を削除しました」。状態・日時・理由は残る。
// - ファイルがなく、提出物に files_deleted_at があれば「この年度のファイルは {日時} に削除しました」。
// - 片付けで消せなかった物（使った量の orphan_count）が残れば「置き場から消せなかったファイルが {k} 件あります。「片付ける」を押してください」と
//   「片付ける」（片付けをもう一度）。何度しても同じ結果になる（残った物だけを消す）。
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { reasonError } from '@/components/common/reason-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { cleanupDocumentOrphans, deleteYearDocumentFiles, type DocumentRow, type DocumentStorageUsage } from '@/lib/data/documents';
import { formatDateTime } from '@/lib/datetime';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { formatFileSize } from '@/lib/modules/documents/files';
import { sendWithAuth } from './submission-write';

/** 削除の前に書く説明（Q3） */
export const DELETE_FILES_HELP = '削除すると、提出物のファイルは開けなくなります（状態・日時・理由は残ります）。要るファイルは先に「保存」してください。';

/** 削除のボタン（「この年度のファイルをすべて削除（{N} 件・{X} MB）」） */
export function deleteFilesLabel(usage: Pick<DocumentStorageUsage, 'file_count' | 'file_bytes'>): string {
  return `この年度のファイルをすべて削除（${usage.file_count} 件・${formatFileSize(usage.file_bytes)}）`;
}

/** 削除の確かめの説明 */
export function deleteFilesConfirmText(usage: Pick<DocumentStorageUsage, 'file_count' | 'file_bytes'>): string {
  return `${usage.file_count} 件（${formatFileSize(usage.file_bytes)}）を削除します。元に戻せません。`;
}

/** 消せなかった物が残っている */
export function leftoverText(k: number): string {
  return `置き場から消せなかったファイルが ${k} 件あります。「片付ける」を押してください`;
}

/** ファイルを削除した日時（提出物の files_deleted_at のいちばん早いもの。なければ null） */
export function filesDeletedAt(docs: readonly Pick<DocumentRow, 'files_deleted_at'>[]): string | null {
  let first: string | null = null;
  for (const d of docs) {
    if (!d.files_deleted_at) continue;
    if (first === null || Date.parse(d.files_deleted_at) < Date.parse(first)) first = d.files_deleted_at;
  }
  return first;
}

export interface DeleteYearFilesProps {
  yearId: string;
  /** 管理者か（削除のボタンを出す） */
  admin: boolean;
  /** 使った量（読み込み中は undefined） */
  usage: DocumentStorageUsage | undefined;
  docs: readonly Pick<DocumentRow, 'files_deleted_at'>[];
  /** 消せなかった物の知らせを出すか（開いたときの片付けの間は出さない） */
  showLeftover: boolean;
  /** 削除・片付けの後の読み直し（使った量・提出状況・ダッシュボード） */
  onChanged: () => void;
  /** 年度の行と立場を読み直す（forbidden・invalid_state の後） */
  onReloadMembership: () => void;
}

export function DeleteYearFiles({ yearId, admin, usage, docs, showLeftover, onChanged, onReloadMembership }: DeleteYearFilesProps) {
  const onAuthError = useAuthErrorHandler();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const deletedAt = filesDeletedAt(docs);

  const confirm = async () => {
    const err = reasonError(reason, false);
    setReasonErr(err);
    if (err) throw new Error('keep-open');
    setError(null);
    const sent = await sendWithAuth(() => deleteYearDocumentFiles(yearId, reason.trim() || null), onAuthError);
    if (!sent.ok) {
      const c = classifyError(sent.error);
      setError(messageFor(c, { rpc: 'delete_year_document_files' }));
      if (effectOf(c).reload === 'year') onReloadMembership();
      onChanged();
      throw new Error('keep-open');
    }
    toast.success(`ファイル ${sent.value.deleted} 件を削除しました`);
    onChanged();
  };

  const cleanup = async () => {
    setCleaning(true);
    setCleanupError(null);
    try {
      await cleanupDocumentOrphans(yearId);
    } catch (e) {
      setCleanupError(messageFor(classifyError(e), { rpc: 'document_orphan_paths' }));
    } finally {
      setCleaning(false);
      onChanged();
    }
  };

  if (!usage) return null;
  const showDelete = admin && usage.file_count > 0;
  const showDeleted = usage.file_count === 0 && deletedAt !== null;
  const showClean = showLeftover && usage.orphan_count > 0;
  if (!showDelete && !showDeleted && !showClean && !cleanupError) return null;

  return (
    <div className="space-y-3">
      {showDelete ? (
        <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <Button
            data-testid="documents-delete-files"
            variant="destructive"
            className="h-auto min-h-9 w-full py-2 text-left whitespace-normal sm:w-auto"
            onClick={() => {
              setReason('');
              setReasonErr(null);
              setError(null);
              setOpen(true);
            }}
          >
            {deleteFilesLabel(usage)}
          </Button>
          <p className="text-sm">{DELETE_FILES_HELP}</p>
        </div>
      ) : null}
      {showDeleted ? (
        <p data-testid="documents-files-deleted" className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          この年度のファイルは {formatDateTime(deletedAt)} に削除しました
        </p>
      ) : null}
      {showClean || cleanupError ? (
        <div role="status" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {showClean ? <p>{leftoverText(usage.orphan_count)}</p> : null}
          {cleanupError ? (
            <p role="alert" data-testid="documents-cleanup-error" className="font-medium text-destructive">
              {cleanupError}
            </p>
          ) : null}
          <Button data-testid="documents-cleanup" size="sm" variant="outline" disabled={cleaning} aria-busy={cleaning || undefined} onClick={() => void cleanup()}>
            {cleaning ? '片付けています…' : '片付ける'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="この年度の提出物のファイルをすべて削除しますか"
        description={deleteFilesConfirmText(usage)}
        confirmLabel="すべて削除する"
        pendingLabel="削除しています…"
        destructive
        onConfirm={confirm}
      >
        <div data-testid="documents-delete-files-confirm" className="space-y-2">
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Label htmlFor={`${id}-reason`}>理由（任意）</Label>
          <Textarea
            id={`${id}-reason`}
            data-testid="documents-delete-files-reason"
            value={reason}
            rows={3}
            placeholder="空なら「提出物のファイルの削除」"
            onChange={(e) => {
              setReason(e.target.value);
              setReasonErr(null);
            }}
            aria-invalid={reasonErr ? true : undefined}
          />
          {reasonErr ? (
            <p role="alert" className="text-sm text-destructive">
              {reasonErr}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
