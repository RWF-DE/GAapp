// テント等の貸し出しの CSV（T21・D-57。04「備品と割り当て」の CSV 出力、notes/T21.md「画面の約束」10）。純粋関数。
// /lending の「CSV 出力」が押したときに動的 import で読む（/ と /request の JS に入れない）。ExcelJS を含む packages/exporter は
// import しない。
// - ファイル名 `{年度名}_テント等の貸し出し.csv`。UTF-8・BOM つき・CRLF。RFC 4180 の引用（`,` `"` 改行を含む欄は `"` で囲み、`"` は2つ）。
// - 式として読まれる先頭の文字（`=` `+` `-` `@`、タブ、CR、LF）で始まる欄は頭に `'` を付ける（CSV の式の注入を防ぐ）。
// - メモのメールアドレスは「(メールアドレス削除)」に置き換える（年度データと同じ文字。見つけ方は packages/importer の stripEmails と同じ。
//   importer は取り除くだけで置き換えないので、見つけ方をここに写した）。書いた人の名前は入れない。
import type { GroupCategory } from '@gaapp/shared';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cellKey, sortLendingGroups, sortLendingItems, type LendingCountRow, type LendingGroupKey, type LendingItemKey } from './counts';
import { NO_LOCATION_TEXT } from './labels';

/** メールアドレスを置き換える文字（packages/exporter の EMAIL_REDACTED と同じ。年度データの JSON と同じ文字） */
export const EMAIL_REDACTED = '(メールアドレス削除)';

/** ファイル名（`{年度名}_テント等の貸し出し.csv`） */
export function lendingCsvFileName(yearLabel: string): string {
  return `${yearLabel}_テント等の貸し出し.csv`;
}

// ---- メールアドレスの見つけ方（packages/importer/src/sanitize.ts と同じ。NFKC で正規化し、@ ごとに左右へ伸ばす。線形） ----

const LOCAL_CHAR = /^[\p{L}\p{N}._%+'!#$&*/=?^`{|}~-]$/u;
const DOMAIN = /[\p{L}\p{N}-]+(?:[.。][\p{L}\p{N}-]+)+/uy;
const MAX_GAP = 8;
const isGap = (c: string) => c === ' ' || c === '\t';

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

function emailSpans(n: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = n.indexOf('@'); at !== -1; at = n.indexOf('@', at + 1)) {
    let r = at + 1;
    while (r < n.length && r - at - 1 < MAX_GAP && isGap(n[r]!)) r++;
    DOMAIN.lastIndex = r;
    const m = DOMAIN.exec(n);
    if (!m) continue;
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

/** 文字（コードポイント）ごとに NFKC にした文字列と、その各位置の元の文字列での位置（最後に元の長さ） */
function normalizeWithMap(s: string): { n: string; map: number[] } {
  let n = '';
  const map: number[] = [];
  let at = 0;
  for (const ch of s) {
    const nc = ch.normalize('NFKC');
    for (let k = 0; k < nc.length; k++) map.push(at);
    n += nc;
    at += ch.length;
  }
  map.push(s.length);
  return { n, map };
}

/**
 * メールアドレスらしき部分を「(メールアドレス削除)」に置き換える（なければそのまま）。見つけ方は importer と同じ（全角の＠・．も
 * 見つけるよう NFKC にしてから探す）。文字ごとに NFKC にして元の位置に戻すので、メールアドレスの外の文字（全角の「：」など）は変えない。
 */
export function redactEmails(s: string): string {
  if (!s.normalize('NFKC').includes('@')) return s;
  const { n, map } = normalizeWithMap(s);
  const spans = emailSpans(n);
  if (spans.length === 0) return s;
  // 正規化した位置 → 元の位置（終わりが元の1文字の途中なら、その文字の後ろまで）
  const startOf = (a: number) => map[a]!;
  const endOf = (b: number) => {
    let j = b;
    while (j < n.length && map[j] === map[b - 1]) j++;
    return map[j]!;
  };
  let out = '';
  let from = 0;
  for (const [a, b] of spans) {
    out += s.slice(from, startOf(a)) + EMAIL_REDACTED;
    from = endOf(b);
  }
  return out + s.slice(from);
}

// ---- 欄 ----

const FORMULA_START = /^[=+\-@\t\r\n]/;

/** 1つの欄（式として読まれる先頭の文字に `'` を付け、`,` `"` 改行を含めば `"` で囲む） */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = String(value);
  if (FORMULA_START.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** CSV の材料（/lending が読んだ行のまま） */
export interface LendingCsvInput {
  yearLabel: string;
  items: readonly LendingItemKey[];
  groups: readonly (LendingGroupKey & { category: GroupCategory; location: { name: string } | null })[];
  requests: readonly LendingCountRow[];
  assignments: readonly LendingCountRow[];
  records: readonly {
    group_id: string;
    lending_item_id: string;
    lent_count: number;
    returned_count: number;
    damaged_count: number;
    note: string | null;
  }[];
}

/**
 * CSV を作る（BOM つきの文字列とファイル名）。行は申請・割り当て・記録のどれかがある団体（団体の並び）。数は行がなければ空欄
 * （0 と分ける）。使用場所がなければ「校内に分散」。メモはその団体の記録のメモを「{備品}：{メモ}」で「／」でつなぐ（備品の並び）。
 */
export function buildLendingCsv(input: LendingCsvInput): { fileName: string; text: string } {
  const items = sortLendingItems(input.items);
  const requests = new Map(input.requests.map((r) => [cellKey(r.group_id, r.lending_item_id), r.count]));
  const assignments = new Map(input.assignments.map((r) => [cellKey(r.group_id, r.lending_item_id), r.count]));
  const records = new Map(input.records.map((r) => [cellKey(r.group_id, r.lending_item_id), r]));
  const used = new Set([...input.requests, ...input.assignments, ...input.records].map((r) => r.group_id));
  const header = ['区分', '団体', '使用場所', ...items.flatMap((i) => [`${i.name}の申請`, `${i.name}の割り当て`, `${i.name}の渡した数`, `${i.name}の返った数`, `${i.name}の破損`]), 'メモ'];
  const lines = [header.map(csvCell).join(',')];
  for (const g of sortLendingGroups(input.groups)) {
    if (!used.has(g.id)) continue;
    const cells: (string | number | null)[] = [CATEGORY_LABELS[g.category] ?? g.category, g.name, g.location?.name ?? NO_LOCATION_TEXT];
    const memos: string[] = [];
    for (const i of items) {
      const k = cellKey(g.id, i.id);
      const rec = records.get(k);
      cells.push(requests.get(k) ?? null, assignments.get(k) ?? null, rec?.lent_count ?? null, rec?.returned_count ?? null, rec?.damaged_count ?? null);
      const note = rec?.note?.trim();
      if (note) memos.push(`${i.name}：${redactEmails(note)}`);
    }
    cells.push(memos.join('／'));
    lines.push(cells.map(csvCell).join(','));
  }
  return { fileName: lendingCsvFileName(input.yearLabel), text: `\uFEFF${lines.join('\r\n')}\r\n` };
}
