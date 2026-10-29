// 個人情報の扱い（D-03）：メールアドレスはどの列にあっても、パターンで見つけて捨てる。値は戻り値・例外・ログに出さない。

/** NFKC で正規化した文字列に当てる（全角の＠なども @ になる） */
const EMAIL_G = /[\p{L}\p{N}._%+'!#$&*/=?^`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

export function normalizeText(s: string): string {
  return s.normalize('NFKC');
}

export function containsEmail(s: string): boolean {
  return new RegExp(EMAIL_G.source, 'u').test(normalizeText(s));
}

/** メールアドレスらしき部分を取り除く。取り除いたかどうかも返す */
export function stripEmails(s: string): { text: string; stripped: boolean } {
  const n = normalizeText(s);
  const text = n.replace(EMAIL_G, '');
  return text === n ? { text: s, stripped: false } : { text, stripped: true };
}
