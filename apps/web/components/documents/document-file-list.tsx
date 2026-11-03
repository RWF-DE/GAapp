'use client';

// 提出のファイルの一覧と「ファイルを追加」（04「提出物」のファイルの扱い、notes/T19.md「パート B・C の約束」6。T19・D-55）。
// /document のカードと /documents のシートが使う（testid は画面ごとに渡す。04 の testid の表）。
// - 1件ずつ「ファイル 1（PDF・1.2 MB・10/5 17:00）」（created_at → id の順の番号。元のファイル名は出さない。Q16）と、状態ごとの操作：
//   届いた（開く・保存・外す〔書けるときだけ〕）、そのタブで上げている（「アップロード中…」）、そのタブで失敗した（「アップロードできませんでした」と
//   もう一度・外す）、届いていない（ほかの人・ほかのタブの予約や、開き直したとき。「届いていません（…）」と外す）。届いていないものは、
//   提出の状態によらず外せる（DB と同じ）。予約の応答が届かず DB の行がない失敗は、行の後ろに番号を続けて出す（予約の日時はない）。
// - 「ファイルを追加」は `<input type="file" accept="application/pdf,image/jpeg,image/png" multiple>` を開く（選んだファイルの確かめと
//   送信は use-document-uploader.ts）。5 つあれば押せなくし「ファイルは 5 つまでです」。
// - 上げている・上げ終えて読み直しを待つファイルも行として出す（番号・形・大きさ。上げている間は「アップロード中…」。レビューの UX-2）。
// - 進み具合は、いつも置いた1つの role="status" の中身だけを変えて知らせる（差し込み直すと、読み上げが最初の中身を読まないため。UX-2）。
// - その画面のどこかで上げている間は「保存」を押せなくし、理由を出す（保存は今のページを移すので、ページを離れる確かめが出るため。F2）。
import { useId, useRef } from 'react';
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

/** 届いたファイルを外す確かめの説明（/document のカードと /documents のシートで同じ。04「ファイルの扱い」の外す） */
export const REMOVE_CONFIRM_TEXT = '外したファイルは消えます。元に戻せません。';
/** 上げている間に「保存」を押せない理由（04「ファイルの扱い」。レビューの F2） */
export const SAVE_BLOCKED_TEXT = 'アップロード中は「保存」を押せません（終わってから押してください）';

/** 一覧の testid（04 の testid の表。/document は document-file…、シートは documents-sheet-file…） */
export interface FileListTestIds {
  /** 一覧（ul）。シートは一覧を包む欄〔documents-sheet-files〕に付けるので省く */
  list?: string;
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

/** /documents のシート（部門長以上の代理）の一覧の testid（一覧を包む欄が documents-sheet-files） */
export const SHEET_FILE_TESTIDS: FileListTestIds = {
  item: 'documents-sheet-file',
  open: 'documents-sheet-file-open',
  save: 'documents-sheet-file-save',
  remove: 'documents-sheet-file-remove',
  retry: 'documents-sheet-file-retry',
};

export const SHEET_ADDER_TESTIDS: FileAdderTestIds = {
  add: 'documents-sheet-file-add',
  input: 'documents-sheet-file-input',
  error: 'documents-sheet-file-error',
  uploading: 'documents-sheet-uploading',
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
 * 一覧の行を作る：DB の行（番号つき）と、そのタブだけにあって行にまだないもの（失敗と、上げている・上げ終えて読み直しを待つもの。番号を続ける）。
 * 状態は届いたか（v_document_files の uploaded）と、そのタブの上げている・失敗した・上げ終えた（sent）で決める（fileStateOf）。上げ終えて
 * 読み直しを待つものは「届いた」として出す（DB の行がまだないので、開く・保存・外すは出さない）。
 */
export function fileEntriesOf(
  files: readonly NumberedFile<DocumentFileRow>[],
  localOnly: readonly FailedUpload[],
  uploading: ReadonlySet<string>,
  failed: ReadonlyMap<string, FailedUpload>,
  sent: ReadonlySet<string> = new Set(),
): FileEntry[] {
  const failedIds = new Set(failed.keys());
  const rows: FileEntry[] = files.map(({ n, file }) => ({
    id: file.id,
    n,
    label: fileLabel(n, file),
    state: fileStateOf(file, { uploading, failed: failedIds, sent }),
    row: file,
  }));
  const extra: FileEntry[] = localOnly.map((f, k) => {
    const n = files.length + k + 1;
    return {
      id: f.fileId,
      n,
      label: `ファイル ${n}（${CONTENT_TYPE_LABELS[f.contentType]}・${formatFileSize(f.blob.size)}）`,
      state: uploading.has(f.fileId) ? 'uploading' : sent.has(f.fileId) && !failed.has(f.fileId) ? 'uploaded' : 'failed',
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
  saveBlocked = false,
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
  /** その画面のどこかで上げている（「保存」を押せず、理由を出す。開くは押せる） */
  saveBlocked?: boolean;
  onOpen: (e: FileEntry) => void;
  onSave: (e: FileEntry) => void;
  onRemove: (e: FileEntry) => void;
  onRetry: (e: FileEntry) => void;
}) {
  const saveHintId = useId();
  if (entries.length === 0) return null;
  const showSaveHint = saveBlocked && entries.some((e) => e.state === 'uploaded' && e.row);
  return (
    <div className="space-y-1">
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
                    <Button
                      data-testid={testIds.save}
                      size="sm"
                      variant="outline"
                      disabled={saveBlocked}
                      onClick={() => onSave(e)}
                      aria-label={`${name}を保存`}
                      aria-describedby={showSaveHint ? saveHintId : undefined}
                    >
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
      {showSaveHint ? (
        <p id={saveHintId} className="text-xs text-muted-foreground">
          {SAVE_BLOCKED_TEXT}
        </p>
      ) : null}
    </div>
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
      {/* 読み上げの欄はいつも置き、中身だけを変える（上げていない間は空で、高さも間もとらない。終わった知らせは toast。レビューの UX-2） */}
      <div role="status" className="empty:mb-0">
        {progress ? (
          <div data-testid={testIds.uploading} className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950">
            <p className="font-medium">{uploadingText(progress)}</p>
            <p className="text-xs">{UPLOADING_LEAVE_MESSAGE}</p>
          </div>
        ) : null}
      </div>
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
