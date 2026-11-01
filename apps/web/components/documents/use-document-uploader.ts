'use client';

// ファイルを足す・上げ直す・外す（04「提出物」のファイルの扱い、notes/T19.md「パート B・C の約束」6。T19・D-55）。/document のカードと
// /documents のシート（代理）が使う。そのタブの状態（上げている・失敗した〔作り直した Blob を持つ〕・提出〔提出物 × 団体。uploadSlot〕ごとの
// 進み具合と知らせ）を持ち、上げている間は、アプリの中で移る前・年度を切り替える前・ページを閉じる前に確かめる（未保存の入力の守り。
// useUnsavedChanges）。/document は団体が1つなので提出物ごと、/documents はセル（団体 × 提出物）ごとに分かれる。
// - 選んだファイルは送る前に全部確かめる：中身 → 先頭のバイトで決めた形 → 数（その提出のファイル〔届いていないもの・そのタブの失敗を
//   含む〕と合わせて 5 つまで）→ JPEG は作り直した後の大きさ（PDF・PNG はそのまま）。1つでも合わなければどれも送らずに、理由をその
//   提出の知らせに出す（ファイルの名前は出さない・残さない。Q16）。写真の作り直し（image.ts）は JPEG を選んだときだけ動的 import する
//   （/document と /documents の最初に読む JS に入れない）。確かめが通ったら、最新でない年度なら確かめてから送る（D-31。動詞は「変更」）。
// - 選んだ順に1つずつ：file_id（uuid）を作って予約（content_type は先頭のバイトで決めた形、size は送る Blob の大きさそのまま）→ 返った
//   path へ upload（upsert: false。409 はもう届いていた）。
//   - 予約が invalid_state・forbidden・not_found（提出の状態・年度・立場が変わった）：残りのファイルは送らずに止める。
//   - 予約が入力の誤り（形・大きさ・番号の重なり）：そのファイルは送らない（同じ file_id でもう一度送っても同じなので、失敗の印も付けない）。
//   - 通信の失敗・Storage が拒んだ（403・413・415）・そのほか：「アップロードできませんでした」（もう一度・外す）にして次のファイルへ。
//     「もう一度」は同じ file_id で予約し直し（同じ行が返る）、同じ path へ上げ直す（409 はもう届いていた）。
// - 全部終わったら（止めたときも）その団体の提出物を読み直し、届くまでその提出の操作を止める（予約で提出の版が進むので、古い版で
//   「提出した」を送らない）。
// - 部品が外れたら（団体・年度を切り替えた、画面を離れた）残りのファイルは送らない（送っている1つは止められない）。
// 署名つきアップロードの URL は作らない（upload だけ）。元のファイル名はどこにも持たない。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { discardDocumentFile, newDocumentUuid, reserveDocumentFile, uploadDocumentFile, type DocumentFileRow } from '@/lib/data/documents';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { checkPicked, checkPrepared, IMAGE_DECODE_MESSAGE, SNIFF_BYTES, sniffContentType, type PickedFile } from '@/lib/modules/documents/files';
import type { DocumentContentType } from '@/lib/modules/documents/labels';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { sendWithAuth, type AuthErrorHandler } from './submission-write';

/** アップロード中の文（{k}/{n} は今送っているファイルの番号と、送る数） */
export function uploadingText(p: UploadProgress): string {
  return p.current > 0 ? `アップロード中…（${p.current}/${p.total}）` : 'アップロード中…';
}
/** アップロード中に添える文（離れるときの確かめと同じ中身） */
export const UPLOADING_LEAVE_MESSAGE = 'アップロード中です。離れると、残りのファイルは送られません';
/** 1件の状態の文 */
export const FILE_STATE_TEXTS = {
  uploading: 'アップロード中…',
  failed: 'アップロードできませんでした',
  missing: '届いていません（アップロードの途中か、失敗しました）',
} as const;
/** 外すの応答が届かず、外せたか分からない（04 の書き込みの決まり） */
export const DISCARD_UNKNOWN_MESSAGE = '外せたか分かりません。もう一度「外す」を押すと、確かめてから送ります';

/** どの提出物・団体のファイルか */
export interface DocumentFileTarget {
  documentId: string;
  groupId: string;
}

/**
 * そのタブの状態（進み具合・知らせ・押せないか・そのタブだけの失敗）を分ける鍵：提出（提出物 × 団体）。/document は団体が1つ、/documents の
 * シートはセルごと（同じ提出物のほかの団体のシートに、進み具合を持ち込まない）。
 */
export function uploadSlot(t: DocumentFileTarget): string {
  return `${t.documentId}:${t.groupId}`;
}

/** そのタブで失敗したファイル（「もう一度」で同じ file_id・同じ Blob を送る） */
export interface FailedUpload extends DocumentFileTarget {
  fileId: string;
  /** 送る物（JPEG は作り直した後） */
  blob: Blob;
  contentType: DocumentContentType;
}

/** 提出ごとの進み具合（current は今送っているファイルの番号。0 は確かめ・作り直しの間） */
export interface UploadProgress {
  current: number;
  total: number;
}

/** 外すの結果（busy は、その提出のほかの操作の途中で送らなかった） */
export type RemoveFileResult = { type: 'removed' } | { type: 'unknown' } | { type: 'failed'; error: unknown } | { type: 'busy' };

export interface DocumentUploaderOptions {
  yearId: string;
  /** 書き込みの前の確かめ（最新でない年度なら確かめる。D-31。やめれば false） */
  confirmWrite: () => Promise<boolean>;
  /** その団体の提出物の読み取りを読み直す（届くまで待つ） */
  reread: (target: DocumentFileTarget) => Promise<unknown>;
  /** 止められた後の画面の動き（forbidden・invalid_state は年度の行と立場を読み直す。effectOf） */
  onYearEffect: (error: unknown) => void;
  onAuthError: AuthErrorHandler;
  /** 写真の作り直し（テストで差し替える。既定は image.ts を動的 import して reencodeJpeg） */
  reencode?: (file: Blob) => Promise<Blob>;
}

export interface DocumentUploader {
  /** 選んだファイルを確かめて、1つずつ上げる（existing はその提出のファイルの数。届いていないもの・そのタブだけの失敗を含む） */
  add: (target: DocumentFileTarget, files: readonly File[], existing: number) => Promise<void>;
  /** 失敗したファイルを、同じ file_id・同じ Blob で上げ直す */
  retry: (fileId: string) => Promise<void>;
  /** 外す（row がなければ、そのタブの失敗を消すだけ）。届いたファイルは呼ぶ前に確かめる */
  remove: (target: DocumentFileTarget, fileId: string, row: Pick<DocumentFileRow, 'id' | 'object_path'> | null) => Promise<RemoveFileResult>;
  /** その提出（slot は uploadSlot）の進み具合（上げていなければ null） */
  progress: (slot: string) => UploadProgress | null;
  /** その提出のファイルを上げている・外している（その間は足す・外す・提出・取り消しを押せない） */
  busy: (slot: string) => boolean;
  /** その提出のファイルの知らせ（選んだファイルの確かめ・予約・上げる・外す・開く・保存の失敗） */
  error: (slot: string) => string | null;
  setError: (slot: string, message: string | null) => void;
  /** そのタブで上げているファイル（file_id） */
  uploading: ReadonlySet<string>;
  /** そのタブで失敗したファイル */
  failed: ReadonlyMap<string, FailedUpload>;
  /** そのタブだけにある失敗（DB の行がない。予約の応答が届かなかった）。rowIds はその提出の今のファイルの行の id */
  localOnly: (slot: string, rowIds: ReadonlySet<string>) => FailedUpload[];
  /** どれかの提出のファイルを上げている */
  active: boolean;
}

type SendOutcome =
  | { type: 'done' }
  /** 失敗の印を付けて次へ（もう一度で送り直せる） */
  | { type: 'failed'; message: string; error: unknown }
  /** そのファイルは送らずに次へ（予約の入力の誤り） */
  | { type: 'dropped'; message: string; error: unknown }
  /** 残りを送らずに止める（予約が invalid_state・forbidden・not_found・認証） */
  | { type: 'stopped'; message: string; error: unknown };

const RESERVE_CONTEXT = { rpc: 'reserve_document_file' } as const;

async function readHead(file: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    return null;
  }
}

/** 選んだファイルの大きさと、先頭のバイトで決めた形（読めなければ形なし） */
async function pickOf(file: File): Promise<PickedFile> {
  if (file.size <= 0) return { size: file.size, type: null };
  const head = await readHead(file);
  return { size: file.size, type: head ? sniffContentType(head) : null };
}

/**
 * ファイルの操作（上の決まり）。
 *
 * @example
 * const uploader = useDocumentUploader({ yearId, confirmWrite: () => notLatest.confirmBeforeWrite(), reread, onYearEffect, onAuthError });
 * <input type="file" onChange={(e) => void uploader.add({ documentId, groupId }, [...e.target.files], existing)} />
 */
export function useDocumentUploader(options: DocumentUploaderOptions): DocumentUploader {
  const optsRef = useRef(options);
  useLayoutEffect(() => {
    optsRef.current = options;
  });
  // 部品が外れたら、残りのファイルは送らない（Strict Mode の付け直しでは戻す）
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  // 進み具合・外している・知らせ・押せないかは提出（uploadSlot）ごと。上げている・失敗したは file_id ごと
  const [progressMap, setProgressMap] = useState<ReadonlyMap<string, UploadProgress>>(() => new Map());
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const [uploading, setUploading] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlyMap<string, FailedUpload>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  // 同じ提出の操作を重ねない（描き直しを待たずに見る）
  const busyRef = useRef(new Set<string>());

  const active = progressMap.size > 0;
  useUnsavedChanges(active);

  const setProgress = useCallback((slot: string, p: UploadProgress | null) => {
    setProgressMap((prev) => {
      const next = new Map(prev);
      if (p) next.set(slot, p);
      else next.delete(slot);
      return next;
    });
  }, []);
  const setError = useCallback((slot: string, message: string | null) => {
    setErrors((prev) => {
      if (!message && !prev.has(slot)) return prev;
      const next = new Map(prev);
      if (message) next.set(slot, message);
      else next.delete(slot);
      return next;
    });
  }, []);
  const markUploading = useCallback((fileId: string, on: boolean) => {
    setUploading((prev) => {
      const next = new Set(prev);
      if (on) next.add(fileId);
      else next.delete(fileId);
      return next;
    });
  }, []);
  const putFailed = useCallback((item: FailedUpload | null, fileId: string) => {
    setFailed((prev) => {
      if (!item && !prev.has(fileId)) return prev;
      const next = new Map(prev);
      if (item) next.set(fileId, item);
      else next.delete(fileId);
      return next;
    });
  }, []);

  /** 1つ送る：予約（同じ file_id なら同じ行）→ 上げる（409 はもう届いていた） */
  const sendOne = useCallback(async (item: FailedUpload): Promise<SendOutcome> => {
    const o = optsRef.current;
    const reserved = await sendWithAuth(
      () =>
        reserveDocumentFile({
          yearId: o.yearId,
          documentId: item.documentId,
          groupId: item.groupId,
          fileId: item.fileId,
          contentType: item.contentType,
          size: item.blob.size,
        }),
      o.onAuthError,
    );
    if (!reserved.ok) {
      const c = classifyError(reserved.error);
      const message = messageFor(c, RESERVE_CONTEXT);
      if (c.kind === 'state' || c.kind === 'forbidden' || c.kind === 'not_found' || c.kind === 'auth') {
        return { type: 'stopped', message, error: reserved.error };
      }
      if (c.kind === 'input') return { type: 'dropped', message, error: reserved.error };
      return { type: 'failed', message, error: reserved.error };
    }
    const path = reserved.value.object_path;
    const up = await sendWithAuth(() => uploadDocumentFile(path, item.blob, item.contentType), o.onAuthError);
    if (!up.ok) return { type: 'failed', message: messageFor(classifyError(up.error)), error: up.error };
    return { type: 'done' };
  }, []);

  /** 失敗の後の画面の動き（年度の行と立場を読み直すものだけ。一覧は終わった後にまとめて読み直す） */
  const yearEffect = useCallback((error: unknown) => {
    if (effectOf(classifyError(error)).reload === 'year') optsRef.current.onYearEffect(error);
  }, []);

  /** 終わった後：その団体の提出物を読み直す（届くまで操作を止めたまま） */
  const finish = useCallback(
    async (target: DocumentFileTarget) => {
      try {
        await optsRef.current.reread(target);
      } catch {
        // 読み直せなくても終える（画面の読み取りの失敗の表示と「読み直す」が出る）
      }
      const slot = uploadSlot(target);
      busyRef.current.delete(slot);
      setProgress(slot, null);
    },
    [setProgress],
  );

  const add = useCallback(
    async (target: DocumentFileTarget, files: readonly File[], existing: number) => {
      const slot = uploadSlot(target);
      if (files.length === 0 || busyRef.current.has(slot)) return;
      busyRef.current.add(slot);
      setError(slot, null);
      setProgress(slot, { current: 0, total: files.length });
      let sent = false;
      try {
        // 1. 中身・形・数（作り直す前）
        const picked = await Promise.all(files.map(pickOf));
        const first = checkPicked(picked, existing);
        if (!first.ok) {
          setError(slot, first.message);
          return;
        }
        // 2. JPEG を作り直す（PDF・PNG はそのまま）→ 大きさ。作り直す部品は JPEG を選んだときだけ読み込む
        let reencode = optsRef.current.reencode;
        if (!reencode && picked.some((p) => p.type === 'image/jpeg')) {
          try {
            reencode = (await import('@/lib/modules/documents/image')).reencodeJpeg;
          } catch (e) {
            // 部品を読み込めなかった（通信の失敗）。写真が読めないのではないので、通信の文言にする
            setError(slot, messageFor(classifyError(e instanceof TypeError ? e : new TypeError('chunk'))));
            return;
          }
        }
        const prepared: { blob: Blob; contentType: DocumentContentType }[] = [];
        for (let k = 0; k < files.length; k++) {
          const type = picked[k]!.type!;
          if (type === 'image/jpeg' && reencode) {
            try {
              prepared.push({ blob: await reencode(files[k]!), contentType: type });
            } catch {
              setError(slot, IMAGE_DECODE_MESSAGE);
              return;
            }
          } else {
            prepared.push({ blob: files[k]!, contentType: type });
          }
        }
        const second = checkPrepared(prepared.map((p) => p.blob.size));
        if (!second.ok) {
          setError(slot, second.message);
          return;
        }
        // 3. 最新でない年度なら確かめる（D-31）
        if (!(await optsRef.current.confirmWrite()) || unmounted.current) return;
        // 4. 1つずつ予約して上げる
        sent = true;
        for (let k = 0; k < prepared.length; k++) {
          if (unmounted.current) break;
          setProgress(slot, { current: k + 1, total: prepared.length });
          const item: FailedUpload = { ...target, fileId: newDocumentUuid(), blob: prepared[k]!.blob, contentType: prepared[k]!.contentType };
          markUploading(item.fileId, true);
          const r = await sendOne(item);
          markUploading(item.fileId, false);
          if (r.type === 'done') continue;
          setError(slot, r.message);
          yearEffect(r.error);
          if (r.type === 'failed') putFailed(item, item.fileId);
          if (r.type === 'stopped') break;
        }
      } finally {
        if (sent) await finish(target);
        else {
          busyRef.current.delete(slot);
          setProgress(slot, null);
        }
      }
    },
    [finish, markUploading, putFailed, sendOne, setError, setProgress, yearEffect],
  );

  const retry = useCallback(
    async (fileId: string) => {
      const item = failed.get(fileId);
      if (!item) return;
      const target: DocumentFileTarget = { documentId: item.documentId, groupId: item.groupId };
      const slot = uploadSlot(target);
      if (busyRef.current.has(slot)) return;
      busyRef.current.add(slot);
      setError(slot, null);
      setProgress(slot, { current: 0, total: 1 });
      if (!(await optsRef.current.confirmWrite()) || unmounted.current) {
        busyRef.current.delete(slot);
        setProgress(slot, null);
        return;
      }
      try {
        setProgress(slot, { current: 1, total: 1 });
        markUploading(fileId, true);
        putFailed(null, fileId);
        const r = await sendOne(item);
        markUploading(fileId, false);
        if (r.type === 'done') return;
        setError(slot, r.message);
        yearEffect(r.error);
        // 予約の入力の誤り（番号の重なりなど）は、もう一度でも同じなので失敗の印を外す（足し直してもらう）
        if (r.type !== 'dropped') putFailed(item, fileId);
      } finally {
        await finish(target);
      }
    },
    [failed, finish, markUploading, putFailed, sendOne, setError, setProgress, yearEffect],
  );

  const remove = useCallback(
    async (target: DocumentFileTarget, fileId: string, row: Pick<DocumentFileRow, 'id' | 'object_path'> | null): Promise<RemoveFileResult> => {
      // DB の行のない失敗（予約の応答が届かず、読み直しても行がない）は、そのタブから消すだけ
      if (!row) {
        putFailed(null, fileId);
        return { type: 'removed' };
      }
      const slot = uploadSlot(target);
      if (busyRef.current.has(slot)) return { type: 'busy' };
      busyRef.current.add(slot);
      setRemoving((prev) => new Set(prev).add(slot));
      setError(slot, null);
      try {
        const o = optsRef.current;
        const sent = await sendWithAuth(() => discardDocumentFile(row), o.onAuthError);
        if (sent.ok) {
          if (sent.value.type === 'unknown') return { type: 'unknown' };
          putFailed(null, fileId);
          await o.reread(target).catch(() => undefined);
          return { type: 'removed' };
        }
        const c = classifyError(sent.error);
        setError(slot, messageFor(c, { rpc: 'discard_document_file' }));
        // もうない（not_found）・ない・立場が変わった（forbidden）ファイルは、そのタブの失敗の印も外す
        if (c.kind === 'not_found' || c.kind === 'forbidden') putFailed(null, fileId);
        yearEffect(sent.error);
        await o.reread(target).catch(() => undefined);
        return { type: 'failed', error: sent.error };
      } finally {
        busyRef.current.delete(slot);
        setRemoving((prev) => {
          const next = new Set(prev);
          next.delete(slot);
          return next;
        });
      }
    },
    [putFailed, setError, yearEffect],
  );

  const localOnly = useCallback(
    (slot: string, rowIds: ReadonlySet<string>) => [...failed.values()].filter((f) => uploadSlot(f) === slot && !rowIds.has(f.fileId)),
    [failed],
  );

  return useMemo(
    () => ({
      add,
      retry,
      remove,
      progress: (slot: string) => progressMap.get(slot) ?? null,
      busy: (slot: string) => progressMap.has(slot) || removing.has(slot),
      error: (slot: string) => errors.get(slot) ?? null,
      setError,
      uploading,
      failed,
      localOnly,
      active,
    }),
    [add, retry, remove, progressMap, removing, errors, setError, uploading, failed, localOnly, active],
  );
}
