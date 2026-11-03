'use client';

// 提出物の設定のタブ（部門長以上。04「提出状況 /documents（PC）」の提出物の設定、notes/T19.md「パート B・C の約束」6。T19・D-55）。
// - 一覧（締切 → 題名 → id）：題名・締切・対象（区分の表示名を「・」でつなぎ、飲食の団体だけなら「（飲食の団体だけ）」）・ファイル（要る・
//   要らない）・承認の数（「承認 3／10」）と、「編集」「削除」（終了した年度は出さない）。見出しの横に「提出物を登録」と、複製元のある年度なら
//   「前年度から写す」（どちらも終了した年度は出さない）。
// - 登録・編集は doc-form-dialog.tsx、前年度から写すは doc-copy-dialog.tsx。
// - 削除：「提出 {N} 件とファイル {M} 件も消えます。元に戻せません。」（N は未提出でない提出の数、M はファイルの数。どちらも 0 なら「元に戻せ
//   ません。」だけ）と確かめ、読んだときの updated_at を条件に入れて delete（doc-write.ts の (B1)）→ どの提出にも属さなくなったファイルの片付け
//   →「「{題名}」を削除しました」。N は、確かめを開いたときに表 document_submissions をその提出物で読んで数える（今の対象から外れた団体の
//   提出も一緒に消えるため。v_document_status は今の対象の団体だけ。2026-11-03。レビューの UX-5）。数えている間は押せず、読めなければ
//   数を言わずに確かめる。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  cleanupDocumentOrphans,
  deleteDocument,
  documentSubmissionCountOptions,
  invalidateDocuments,
  readDocument,
  type DocumentRow,
  type DocumentsBoardData,
} from '@/lib/data/documents';
import { classifyError, effectOf, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { buildDocumentsBoard } from '@/lib/modules/documents/board';
import { DocCopyDialog, targetText } from './doc-copy-dialog';
import { DocFormDialog, type DocFormTarget } from './doc-form-dialog';
import { runDocDelete } from './doc-write';
import { approvedCountText, columnDeadlineText } from './documents-board';

/** 提出物がない（設定のタブ） */
export const SETTINGS_EMPTY_TEXT = '提出物はまだありません';
/** 提出物がないときの添え書き（書けるとき） */
export const SETTINGS_ADD_HINT = '「提出物を登録」から登録できます。';
/** 削除で、読み直すと（0 行の理由を見ると）もうなかった */
export const DOC_ALREADY_DELETED_MESSAGE = 'すでに削除されていました（ほかの人が削除した可能性があります）';
/** 削除で、版が違った */
export const DOC_DELETE_CHANGED_MESSAGE = 'ほかの人がこの提出物を先に変えました。読み直しました。内容を確かめてから、もう一度削除してください';

/** 削除の確かめの説明（提出 N 件とファイル M 件。どちらも 0 なら「元に戻せません。」だけ） */
export function deleteConfirmText(submissions: number, files: number): string {
  return submissions === 0 && files === 0 ? '元に戻せません。' : `提出 ${submissions} 件とファイル ${files} 件も消えます。元に戻せません。`;
}
/** 削除の確かめで、消える提出を数えている（「削除する」は押せない） */
export const DELETE_COUNTING_TEXT = '消える提出とファイルを数えています…';
/** 削除の確かめで、消える提出の数を読めなかった（押せる） */
export const DELETE_COUNT_FAILED_TEXT = '提出とファイルの記録も消えます（数を読み込めませんでした）。元に戻せません。';

export interface DocumentsSettingsProps {
  data: DocumentsBoardData;
  yearId: string;
  userId: string | null;
  /** 書けるか（部門長以上で、年度が終了でない） */
  writable: boolean;
  /** 複製元（prev_year_id）のある年度か（「前年度から写す」を出す） */
  hasPrevYear: boolean;
  now: number;
  /** 提出状況を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden・invalid_state の後） */
  onReloadMembership: () => void;
}

export function DocumentsSettings({ data, yearId, userId, writable, hasPrevYear, now, onReload, onReloadMembership }: DocumentsSettingsProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const board = useMemo(() => buildDocumentsBoard(data, 'all', now), [data, now]);
  const [form, setForm] = useState<DocFormTarget | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const canWrite = writable && !!userId;

  // 削除の確かめの提出の数（開いたときに読む。今の対象から外れた団体の提出も数える。レビューの UX-5）
  const countQ = useQuery(documentSubmissionCountOptions(yearId, deleting?.id ?? null));
  /** 削除の確かめの説明（提出は読んだ数、ファイルはその提出物の全部〔v_document_files。対象によらない〕） */
  const deleteDescription = (doc: DocumentRow): string => {
    if (countQ.data !== undefined) return deleteConfirmText(countQ.data, (data.files ?? []).filter((f) => f.document_id === doc.id).length);
    return countQ.isError ? DELETE_COUNT_FAILED_TEXT : DELETE_COUNTING_TEXT;
  };

  const confirmDelete = async () => {
    const doc = deleting;
    if (!doc) return;
    // 同じ確かめのダイアログで、前の削除が消せたか分からずに終わった（deleteError は unknown のときだけ立ち、閉じると消える）
    const afterUnknown = deleteError !== null;
    setDeleteError(null);
    const r = await runDocDelete({ send: () => deleteDocument(doc), reread: () => readDocument(doc.id), baseVersion: doc.updated_at }, onAuthError);
    switch (r.type) {
      case 'deleted':
        // 提出とファイルの行は cascade で消える。Storage の物はどの提出にも属さなくなるので片付ける（失敗しても知らせない）
        await cleanupDocumentOrphans(yearId).catch(() => null);
        invalidateDocuments(queryClient, yearId);
        if (r.before && afterUnknown) toast.success(`「${doc.title}」は削除されていました`);
        else if (r.before) toast.info(DOC_ALREADY_DELETED_MESSAGE);
        else toast.success(`「${doc.title}」を削除しました`);
        return;
      case 'changed':
        onReload();
        toast.error(DOC_DELETE_CHANGED_MESSAGE);
        return;
      case 'unknown':
        // 消せたか分からない：確かめのダイアログを開いたまま知らせる（もう一度押すと、同じ版で送る）
        setDeleteError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed': {
        const c = classifyError(r.error);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          onReloadMembership();
          onReload();
        } else if (effect.reload === 'data') onReload();
        toast.error(messageFor(c));
        return;
      }
    }
  };

  const counting = deleting !== null && countQ.data === undefined && !countQ.isError;

  return (
    <div data-testid="documents-settings" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">提出物の設定</h2>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {hasPrevYear ? (
              <Button data-testid="documents-settings-copy" variant="outline" onClick={() => setCopyOpen(true)}>
                <Copy aria-hidden />
                前年度から写す
              </Button>
            ) : null}
            <Button data-testid="documents-settings-add" onClick={() => setForm({ type: 'new' })}>
              <Plus aria-hidden />
              提出物を登録
            </Button>
          </div>
        ) : null}
      </div>

      {board.columns.length === 0 ? (
        <div data-testid="documents-settings-empty">
          <EmptyState title={SETTINGS_EMPTY_TEXT} description={canWrite ? SETTINGS_ADD_HINT : undefined} />
        </div>
      ) : (
        // relative：見出しの読み上げ用の文字（sr-only。position: absolute）を表の中に収める（ページを横に広げない）
        <div className="relative w-full overflow-x-auto rounded-md border">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">提出物の一覧</caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="min-w-40 border-b px-3 py-2 font-medium">
                  題名
                </th>
                <th scope="col" className="border-b px-3 py-2 font-medium whitespace-nowrap">
                  締切
                </th>
                <th scope="col" className="min-w-32 border-b px-3 py-2 font-medium">
                  対象
                </th>
                <th scope="col" className="border-b px-3 py-2 font-medium whitespace-nowrap">
                  ファイル
                </th>
                <th scope="col" className="border-b px-3 py-2 font-medium whitespace-nowrap">
                  承認
                </th>
                {canWrite ? (
                  <th scope="col" className="border-b px-3 py-2 font-medium">
                    <span className="sr-only">操作</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {board.columns.map((column) => {
                const doc = column.doc;
                return (
                  <tr key={doc.id} data-testid="documents-settings-row" data-document-id={doc.id}>
                    <th scope="row" className="border-b px-3 py-2 text-left font-medium [overflow-wrap:anywhere]">
                      {doc.title}
                    </th>
                    <td className="border-b px-3 py-2 whitespace-nowrap">{columnDeadlineText(doc.deadline, now)}</td>
                    <td className="border-b px-3 py-2">{targetText(doc)}</td>
                    <td className="border-b px-3 py-2 whitespace-nowrap">{doc.requires_file ? '要る' : '要らない'}</td>
                    <td className="border-b px-3 py-2 whitespace-nowrap tabular-nums">{approvedCountText(column)}</td>
                    {canWrite ? (
                      <td className="border-b px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <Button data-testid="documents-settings-edit" size="sm" variant="outline" onClick={() => setForm({ type: 'edit', doc })}>
                            編集
                          </Button>
                          <Button
                            data-testid="documents-settings-delete"
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleting(doc);
                            }}
                          >
                            削除
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && userId ? (
        <DocFormDialog
          target={form}
          onClose={() => setForm(null)}
          yearId={yearId}
          userId={userId}
          writable={writable}
          groups={data.groups}
          statuses={data.statuses}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
        />
      ) : null}
      {canWrite && hasPrevYear ? (
        <DocCopyDialog open={copyOpen} onClose={() => setCopyOpen(false)} yearId={yearId} onReloadMembership={onReloadMembership} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setDeleteError(null);
          }
        }}
        title={deleting ? `「${deleting.title}」を削除しますか` : ''}
        description={deleting ? deleteDescription(deleting) : undefined}
        confirmLabel="削除する"
        pendingLabel="削除しています…"
        destructive
        confirmDisabled={counting}
        onConfirm={confirmDelete}
      >
        <div data-testid="documents-delete-confirm">
          {deleteError ? (
            <p role="alert" data-testid="documents-delete-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
