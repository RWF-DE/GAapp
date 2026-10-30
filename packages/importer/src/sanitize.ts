// 個人情報の扱い（D-03）：メールアドレスはどの列にあっても、パターンで見つけて捨てる。値は戻り値・例外・ログに出さない。
//
// 見つけ方：NFKC で正規化した文字列（全角の＠・．などは半角になる）で、@ ごとに左右へ伸ばす。
// 正規表現で local 部を先に探すと、@ のない長い文字の並びで時間が二乗になる（公開フォームの備考で管理者のブラウザを止められる）ので、
// @ のない文字列は先に飛ばし、@ から左へ local 部の文字を数える（@ は local 部に使えない文字なので、全体で線形）。
// 揺れ：@ の前後の空白（8 字まで）と、ドメインの区切りの「。」（NFKC の後も残る）を許す。

const LOCAL_CHAR = /^[\p{L}\p{N}._%+'!#$&*/=?^`{|}~-]$/u;
const DOMAIN = /[\p{L}\p{N}-]+(?:[.。][\p{L}\p{N}-]+)+/uy;
const MAX_GAP = 8;

export function normalizeText(s: string): string {
  return s.normalize('NFKC');
}

const isGap = (c: string) => c === ' ' || c === '\t';

/** n[0..end) の末尾から左へ、local 部の文字が続く長さ（UTF-16 の単位）を返す */
function localLength(n: string, end: number): number {
  let i = end;
  while (i > 0) {
    const lo = n.charCodeAt(i - 1);
    const isLow = lo >= 0xdc00 && lo <= 0xdfff;
    const width = isLow && i >= 2 && n.charCodeAt(i - 2) >= 0xd800 && n.charCodeAt(i - 2) <= 0xdbff ? 2 : 1;
    if (!LOCAL_CHAR.test(n.slice(i - width, i))) break;
    i -= width;
  }
  return end - i;
}

/** 正規化済みの文字列の中の、メールアドレスらしき範囲 [start, end)。重なりは 1 つにまとめる */
function emailSpans(n: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = n.indexOf('@'); at !== -1; at = n.indexOf('@', at + 1)) {
    // 右：@ の後の空白を飛ばして、ドメイン
    let r = at + 1;
    while (r < n.length && r - at - 1 < MAX_GAP && isGap(n[r]!)) r++;
    DOMAIN.lastIndex = r;
    const m = DOMAIN.exec(n);
    if (!m) continue;
    // 左：@ の前の空白を飛ばして、local 部
    let l = at;
    while (l > 0 && at - l < MAX_GAP && isGap(n[l - 1]!)) l--;
    const len = localLength(n, l);
    if (len === 0) continue;
    const start = l - len;
    const end = r + m[0].length;
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return spans;
}

export function containsEmail(s: string): boolean {
  const n = normalizeText(s);
  return n.includes('@') && emailSpans(n).length > 0;
}

/** メールアドレスらしき部分を取り除く。取り除いたかどうかも返す */
export function stripEmails(s: string): { text: string; stripped: boolean } {
  const n = normalizeText(s);
  if (!n.includes('@')) return { text: s, stripped: false };
  const spans = emailSpans(n);
  if (spans.length === 0) return { text: s, stripped: false };
  let text = '';
  let from = 0;
  for (const [a, b] of spans) {
    text += n.slice(from, a);
    from = b;
  }
  return { text: text + n.slice(from), stripped: true };
}
