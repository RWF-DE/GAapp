'use client';

// 提出のファイルの一覧と「ファイルを追加」（04「提出物」のファイルの扱い、notes/T19.md「パート B・C の約束」6。T19・D-55）。
// /document のカードと /documents のシートが使う（testid は画面ごとに渡す。04 の testid の表）。
// - 1件ずつ「ファイル 1（PDF・1.2 MB・10/5 17:00）」（created_at → id の順の番号。元のファイル名は出さない。Q16）と、状態ごとの操作：
//   届いた（開く・保存・外す〔書けるときだけ〕）、そのタブで上げている（「アップロード中…」）、そのタブで失敗した（「アップロードできませんでした」と
//   もう一度・外す）、届いていない（ほかの人・ほかのタブの予約や、開き直したとき。「届いていません（…）」と外す）。届いていないものは、
//   提出の状態によらず外せる（DB と同じ）。予約の応答が届かず DB の行がない失敗は、行の後ろに番号を続けて出す（予約の日時はない）。
// - 「ファイルを追加」は `<input type="file" accept="application/pdf,image/jpeg,image/png" multiple>` を開く（選んだファイルの確かめと
//   送信は use-document-uploader.ts）。5 つあれば押せなくし「ファイルは 5 つまでです」。
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { DocumentFileRow } from '@/lib/data/documents';
import {
  FILE_ACCEPT,
  FILE_HINT,
  FILES_FULL_MESSAGE,
  fileLabel,
  fileStateOf,
  formatFileSize,
  MAX_FILES,
  type FileState,
  type NumberedFile,
} from '@/lib/modules/documents/files';
import { CONTENT_TYPE_LABELS } from '@/lib/modules/documents/labels';
import { cn } from '@/lib/utils';
import { FILE_STATE_TEXTS, UPLOADING_LEAVE_MESSAGE, uploadingText, type FailedUpload, type UploadProgress } from './use-document-uploader';

/** 一覧の testid（04 の testid の表。/document は document-file…、シートは documents-sheet-file…） */
export interface FileListTestIds {
  list: string;
  item: string;
  /** 名前（/document だけ） */
  label?: string;
  open: string;
  save: string;
  remove: string;
  retry: string;
}

/** 「ファイルを追加」の testid */
export interface FileAdderTestIds {
  add: string;
  input: string;
  /** 「PDF・JPEG・PNG。…」（/document だけ） */
  hint?: string;
  error: string;
  uploading: string;
}

export const REP_FILE_TESTIDS: FileListTestIds = {
  list: 'document-files',
  item: 'document-file',
  label: 'document-file-label',
  open: 'document-file-open',
  save: 'document-file-save',
  remove: 'document-file-remove',
  retry: 'document-file-retry',
};

export const REP_ADDER_TESTIDS: FileAdderTestIds = {
  add: 'document-file-add',
  input: 'document-file-input',
  hint: 'document-file-hint',
  error: 'document-file-error',
  uploading: 'document-uploading',
};

/** 一覧の1件 */
export interface FileEntry {
  /** file_id */
  id: string;
  n: number;
  label: string;
  state: FileState;
  /** DB の行（予約の応答が届かず行のない、そのタブの失敗は null） */
  row: DocumentFileRow | null;
}

/**
 * 一覧の行を作る：DB の行（番号つき）と、そのタブだけにある失敗（DB の行がない。番号を続ける）。状態は届いたか（v_document_files の
 * uploaded）と、そのタブの上げている・失敗したで決める（fileStateOf）。
 */
export function fileEntriesOf(
  files: readonly NumberedFile<DocumentFileRow>[],
  localOnly: readonly FailedUpload[],
  uploading: ReadonlySet<string>,
  failed: ReadonlyMap<string, FailedUpload>,
): FileEntry[] {
  const failedIds = new Set(failed.keys());
  const rows: FileEntry[] = files.map(({ n, file }) => ({
    id: file.id,
    n,
    label: fileLabel(n, file),
    state: fileStateOf(file, { uploading, failed: failedIds }),
    row: file,
  }));
  const extra: FileEntry[] = localOnly.map((f, k) => {
    const n = files.length + k + 1;
    return {
      id: f.fileId,
      n,
      label: `ファイル ${n}（${CONTENT_TYPE_LABELS[f.contentType]}・${formatFileSize(f.blob.size)}）`,
      state: uploading.has(f.fileId) ? 'uploading' : 'failed',
      row: null,
    };
  });
  return [...rows, ...extra];
}

const STATE_TEXT_CLASS: Readonly<Record<Exclude<FileState, 'uploaded'>, string>> = {
  uploading: 'text-muted-foreground',
  failed: 'font-medium text-destructive',
  missing: 'text-amber-800',
};

export function DocumentFileList({
  entries,
  testIds,
  canRemoveUploaded,
  canRemovePending,
  canRetry,
  disabled,
  onOpen,
  onSave,
  onRemove,
  onRetry,
}: {
  entries: readonly FileEntry[];
  testIds: FileListTestIds;
  /** 届いたファイルの「外す」を出すか（書ける状態） */
  canRemoveUploaded: boolean;
  /** 届いていないファイルの「外す」を出すか（年度が書けるとき。提出の状態によらない） */
  canRemovePending: boolean;
  /** 失敗したファイルの「もう一度」を出すか（ファイルを足せる状態） */
  canRetry: boolean;
  /** 上げている・外している・提出している間は押せない（開く・保存は押せる） */
  disabled: boolean;
  onOpen: (e: FileEntry) => void;
  onSave: (e: FileEntry) => void;
  onRemove: (e: FileEntry) => void;
  onRetry: (e: FileEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <ul data-testid={testIds.list} className="divide-y rounded-md border">
      {entries.map((e) => {
        const name = `ファイル ${e.n}`;
        return (
          <li key={e.id} data-testid={testIds.item} data-file-id={e.id} data-state={e.state} className="space-y-2 px-3 py-2.5">
            <p className="text-sm [overflow-wrap:anywhere]">
              <span data-testid={testIds.label}>{e.label}</span>
              {e.state !== 'uploaded' ? (
                <span className={cn('mt-0.5 block text-xs', STATE_TEXT_CLASS[e.state])}>{FILE_STATE_TEXTS[e.state]}</span>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              {e.state === 'uploaded' && e.row ? (
                <>
                  <Button data-testid={testIds.open} size="sm" variant="outline" onClick={() => onOpen(e)} aria-label={`${name}を開く`}>
                    開く
                  </Button>
                  <Button data-testid={testIds.save} size="sm" variant="outline" onClick={() => onSave(e)} aria-label={`${name}を保存`}>
                    保存
                  </Button>
                  {canRemoveUploaded ? (
                    <Button
                      data-testid={testIds.remove}
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      disabled={disabled}
                      onClick={() => onRemove(e)}
                      aria-label={`${name}を外す`}
                    >
                      外す
                    </Button>
                  ) : null}
                </>
              ) : null}
              {e.state === 'failed' && canRetry ? (
                <Button data-testid={testIds.retry} size="sm" variant="outline" disabled={disabled} onClick={() => onRetry(e)} aria-label={`${name}をもう一度送る`}>
                  もう一度
                </Button>
              ) : null}
              {(e.state === 'failed' || e.state === 'missing') && canRemovePending ? (
                <Button
                  data-testid={testIds.remove}
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={disabled}
                  onClick={() => onRemove(e)}
                  aria-label={`${name}を外す`}
                >
                  外す
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 「ファイルを追加」と、アップロード中の文・ファイルの知らせ。追加のボタンは canAdd のときだけ出す（知らせと進み具合は書けなくなっても出す）。
 */
export function DocumentFileAdder({
  testIds,
  canAdd,
  count,
  disabled,
  progress,
  error,
  onFiles,
}: {
  testIds: FileAdderTestIds;
  canAdd: boolean;
  /** その提出のファイルの数（届いていないもの・そのタブの失敗を含む） */
  count: number;
  disabled: boolean;
  progress: UploadProgress | null;
  error: string | null;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = count >= MAX_FILES;
  return (
    <div className="space-y-2">
      {progress ? (
        <div role="status" data-testid={testIds.uploading} className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950">
          <p className="font-medium">{uploadingText(progress)}</p>
          <p className="text-xs">{UPLOADING_LEAVE_MESSAGE}</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid={testIds.error} className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {canAdd ? (
        <div className="space-y-1">
          <Button data-testid={testIds.add} variant="outline" className="w-full sm:w-auto" disabled={disabled || full} onClick={() => inputRef.current?.click()}>
            ファイルを追加
          </Button>
          <input
            ref={inputRef}
            data-testid={testIds.input}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(ev) => {
              const files = ev.target.files ? Array.from(ev.target.files) : [];
              // 同じファイルをもう一度選べるように空にする（選んだファイルは送る側が持つ）
              ev.target.value = '';
              if (files.length > 0) onFiles(files);
            }}
          />
          <p data-testid={testIds.hint} className="text-xs text-muted-foreground">
            {full ? FILES_FULL_MESSAGE : FILE_HINT}
          </p>
        </div>
      ) : null}
    </div>
  );
}
