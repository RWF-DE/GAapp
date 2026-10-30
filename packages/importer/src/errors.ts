/**
 * CSV の形が読めないときの失敗。メッセージに元データの値を入れない（列の見出しの規則・行の状態だけ）ので、
 * 呼び出し側（scripts の build）はそのまま表示してよい。それ以外の例外は表示しない。
 */
export class ImportFormatError extends Error {
  override name = 'ImportFormatError';
}
