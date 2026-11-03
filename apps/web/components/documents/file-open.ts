// 届いたファイルを開く・保存する（04「提出物」のファイルの扱い。T19・D-55）。/document のカードと /documents のシートが使う。
// - 開く：押したときに先に空のタブを開き（ポップアップで止められないように）、createSignedUrl(path, 60) の URL をそのタブに入れる
//   （新しいタブの opener は外す）。タブを開けなければ POPUP_BLOCKED_MESSAGE、URL を作れなければタブを閉じて知らせる。
// - 保存：押したときに download の名前つきの署名つき URL（Content-Disposition: attachment）を作り、その URL へ移る（画面は離れない）。
// 署名つき URL は押したときに作り、60 秒だけ使う。キャッシュ・下書き・ログ・画面の URL に入れない（返さず、その場でタブ・移動に渡すだけ）。
// window はイベントの中だけで使う（プリレンダーの間はない）。テストは fileWindow の関数を差し替える。
// 署名つき URL を作る関数（lib/data/documents.ts）は、初めて開く・保存するときに読む（document-writes.ts。/document の最初に読む JS に
// 入れない。FU3 の PR B の案 5）。読めなければ、開くはタブを閉じ、どちらも failed（通信の失敗）を返す。
import { loadDocumentWrites } from './document-writes';

/** 署名つき URL を作る（初めてなら書き込みの JS を読んでから） */
const signLazily = (path: string, download?: string): Promise<string> => loadDocumentWrites().then((w) => w.signDocumentFile(path, download));

/** タブを開けなかった（ポップアップを止められた） */
export const POPUP_BLOCKED_MESSAGE = '新しいタブを開けませんでした。ポップアップを許可してから、もう一度「開く」を押してください';

/** ブラウザの道具（テストで差し替える） */
export const fileWindow = {
  /** 空のタブを開く（開けなければ null） */
  openBlank: (): Window | null => window.open('', '_blank'),
  /** 今のタブでその URL へ移る（保存。Content-Disposition: attachment なので画面は離れない） */
  assign: (url: string): void => window.location.assign(url),
};

/** 開く・保存の結果 */
export type FileOpenResult = { type: 'opened' } | { type: 'blocked' } | { type: 'failed'; error: unknown };

/**
 * 開く（押したときに呼ぶ）。先に空のタブを開いてから署名つき URL を作り、そのタブに入れる。
 *
 * @example
 * const r = await openDocumentFile(file.object_path);
 * if (r.type === 'blocked') setError(POPUP_BLOCKED_MESSAGE);
 */
export async function openDocumentFile(objectPath: string, sign: (path: string) => Promise<string> = (p) => signLazily(p)): Promise<FileOpenResult> {
  const tab = fileWindow.openBlank();
  if (!tab) return { type: 'blocked' };
  try {
    tab.opener = null;
  } catch {
    // opener を外せないブラウザでも開く（URL は Supabase のドメインなので、アプリの origin では動かない）
  }
  try {
    const url = await sign(objectPath);
    tab.location.href = url;
    return { type: 'opened' };
  } catch (e) {
    tab.close();
    return { type: 'failed', error: e };
  }
}

/**
 * 保存（押したときに呼ぶ）。download の名前（「{提出物}_{団体}_{n}.{拡張子}」。lib/modules/documents/files.ts の downloadNameFor）つきの
 * 署名つき URL を作り、その URL へ移る。
 */
export async function saveDocumentFile(
  objectPath: string,
  downloadName: string,
  sign: (path: string, download: string) => Promise<string> = (p, d) => signLazily(p, d),
): Promise<FileOpenResult> {
  try {
    const url = await sign(objectPath, downloadName);
    fileWindow.assign(url);
    return { type: 'opened' };
  } catch (e) {
    return { type: 'failed', error: e };
  }
}
