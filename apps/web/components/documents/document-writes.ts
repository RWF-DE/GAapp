// 自団体の提出物（/document）の書き込みと、ファイルを開く・保存するときに使う JS を、初めて使うときに読む（04「自団体の提出物」の
// 書き込みの JS。FU3 の PR B の案 5。D-45 の FU3 の直し）。lib/data/documents.ts は、RPC の引数の形と入力の確かめ（zod）・提出物の書き込み・
// Storage のアップロードと署名つき URL を持つので、/document の部品（カード・ファイルの一覧・アップロードの状態・提出の送り方）はそれを
// 静的に import せず、ファイルを足す・上げ直す・外す、「提出した」・取り消す、開く・保存するときに loadDocumentWrites() で読む（2回目からは
// 読み終えたものを使う）。提出状況（/documents）は lib/data/documents.ts を静的に読むので、同じものがすぐに返る。
// 読めなかったとき（通信の失敗）は TypeError（lib/errors の classifyError が network にする）として投げる。呼ぶ側は何も送らずに止め、その操作の
// エラーを出す所に通信の失敗の文言を出す（次に呼んだときに読み直す）。
import type * as Writes from '@/lib/data/documents';

/** 書き込みの関数（lib/data/documents.ts の中身） */
export type DocumentWrites = typeof Writes;

/** 読み込み（テストで差し替える。既定は lib/data/documents.ts の動的 import） */
export const documentWritesImport = {
  load: (): Promise<DocumentWrites> => import('@/lib/data/documents'),
};

let loading: Promise<DocumentWrites> | null = null;

/**
 * 書き込みの JS を読む。
 *
 * @example
 * const w = await loadDocumentWrites();
 * await w.submitDocument(documentId, groupId, base);
 */
export function loadDocumentWrites(): Promise<DocumentWrites> {
  loading ??= documentWritesImport.load().catch((e: unknown) => {
    loading = null;
    throw e instanceof TypeError ? e : new TypeError('書き込みの JS を読み込めませんでした');
  });
  return loading;
}

/** 確かめのダイアログを開いたときに、先に読み始める（読めなくても何もしない。押したときに loadDocumentWrites がもう一度読む） */
export function preloadDocumentWrites(): void {
  loadDocumentWrites().catch(() => undefined);
}

/** テストだけで使う：読み終えたものを忘れる（ページを開き直したことにする） */
export function resetDocumentWritesForTest(): void {
  loading = null;
}
