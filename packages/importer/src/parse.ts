// Googleフォームの回答 CSV の読み取り（04「CSV取り込み」、設計 3.7）。
// 種類ごとの列の対応表にある列（団体名・品目・備考・タイムスタンプ）だけを読み、それ以外の列は読まずに捨てる（D-03）。
import { MAX_COUNT } from '@gaapp/shared';
import { parseCsvLoose } from './csv';
import { ImportFormatError } from './errors';
import { containsEmail, normalizeText, stripEmails } from './sanitize';

export type FormKind = 'stall' | 'department' | 'company';
export const FORM_KINDS: readonly FormKind[] = ['stall', 'department', 'company'];

export type RejectReason = 'misaligned' | 'invalid_number' | 'invalid_timestamp' | 'empty';

export type ParsedFormResponse = {
  /** CSV のレコード番号（見出し＝1。セル内の改行は数えない） */
  rowNumber: number;
  /** タイムスタンプ（Asia/Tokyo として読み、+09:00 の ISO で返す） */
  submittedAt: string;
  /** 模擬店・部門は団体名の列のうち空でない方。企業は null（手で団体を選ぶ） */
  groupName: string | null;
  /** 品目コード → 数（列名は items.aliases で対応） */
  counts: Record<string, number>;
  /** 備考。アプリでは保存するが、fixtures には書かない */
  note: string | null;
};

export type ParsedForm = {
  kind: FormKind;
  responses: ParsedFormResponse[];
  /** 取り込まない行。中身は持たない（行番号と理由だけ） */
  rejected: { rowNumber: number; reason: RejectReason }[];
  /** 対応表にない列の見出し（中身は読まない）。見出しがメールのパターンなら「(列N)」にする */
  ignoredColumns: string[];
};

/**
 * 列の対応表（種類ごと）。見出しは NFKC で正規化し、空白を除いてから比べる。
 * 本物のフォームの見出しに合わせて直すのはここだけ（R8 の元データは使わない〔D-40〕ので、本物のフォームの CSV を取り込むときに確かめる。notes/T05.md）。
 */
export const FORM_COLUMN_MAP: Record<
  FormKind,
  { timestamp: RegExp; name: RegExp | null; note: RegExp }
> = {
  // 模擬店は「飲食模擬店を運営しますか？」の答えで団体名の列が2つに分かれる
  stall: { timestamp: /^(タイムスタンプ|timestamp)$/i, name: /^団体名/, note: /^備考/ },
  department: { timestamp: /^(タイムスタンプ|timestamp)$/i, name: /^(団体名|部門名)/, note: /^備考/ },
  // 企業フォームには団体名が入っていない（R8 ではすべて「オプション 1」）ので読まない
  company: { timestamp: /^(タイムスタンプ|timestamp)$/i, name: null, note: /^備考/ },
};

const compact = (s: string) => normalizeText(s).replace(/\s+/gu, '');

type Col = { index: number; role: 'timestamp' | 'name' | 'note' | 'item'; code?: string };

export function classifyHeaders(
  kind: FormKind,
  header: readonly string[],
  items: readonly { code: string; aliases: readonly string[] }[],
): { cols: Col[]; ignored: string[] } {
  const map = FORM_COLUMN_MAP[kind];
  const aliases = items
    .flatMap((it) => it.aliases.map((a) => ({ code: it.code, alias: compact(a) })))
    .filter((a) => a.alias !== '')
    .sort((a, b) => b.alias.length - a.alias.length);
  const cols: Col[] = [];
  const ignored: string[] = [];
  let hasTimestamp = false;
  header.forEach((h, index) => {
    const n = compact(h);
    let col: Col | null = null;
    if (n !== '') {
      if (map.timestamp.test(n) && !hasTimestamp) {
        col = { index, role: 'timestamp' };
        hasTimestamp = true;
      } else if (map.note.test(n)) col = { index, role: 'note' };
      else if (map.name?.test(n)) col = { index, role: 'name' };
      else {
        const hit = aliases.find((a) => n.includes(a.alias));
        if (hit) col = { index, role: 'item', code: hit.code };
      }
    }
    if (col) cols.push(col);
    else ignored.push(h.trim() === '' || containsEmail(h) ? `(列${index + 1})` : h.trim());
  });
  return { cols, ignored };
}

const JST_MINUTES = 9 * 60;

/** タイムスタンプ（Google フォーム／スプレッドシートの書式）を、+09:00 の ISO にする。読めなければ null */
export function parseTimestamp(raw: string): string | null {
  const s = normalizeText(raw).trim();
  const m =
    /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T]+(?:(午前|午後|AM|PM)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/iu.exec(
      s,
    );
  if (!m) return null;
  const [, y, mo, d, ampm, hh, mi, ss, off] = m;
  let hour = hh === undefined ? 0 : Number(hh);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  if (ampm !== undefined) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm === '午後' || ampm.toUpperCase() === 'PM';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = JST_MINUTES;
  if (off !== undefined) {
    if (off.toUpperCase() === 'Z') offset = 0;
    else {
      const sign = off[0] === '-' ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    }
  }
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const jst = new Date(local - offset * 60_000 + JST_MINUTES * 60_000);
  return jst.toISOString().slice(0, 19) + '+09:00';
}

/** 数のセル。空は 0。読めなければ null */
export function parseCountCell(raw: string): number | null {
  const s = normalizeText(raw).trim().replace(/[個台脚本つ]$/u, '').trim();
  if (s === '') return 0;
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_COUNT ? n : null;
}

export function parseFormCsv(
  kind: FormKind,
  csv: string,
  items: readonly { code: string; aliases: readonly string[] }[],
): ParsedForm {
  const rows = parseCsvLoose(csv);
  const header = rows[0];
  if (!header) throw new ImportFormatError('CSV に見出しの行がありません');
  const { cols, ignored } = classifyHeaders(kind, header, items);
  const ts = cols.find((c) => c.role === 'timestamp');
  if (!ts) throw new ImportFormatError('タイムスタンプの列が見つかりません（見出しは「タイムスタンプ」にしてください）');
  const nameCols = cols.filter((c) => c.role === 'name');
  if (FORM_COLUMN_MAP[kind].name && nameCols.length === 0) throw new ImportFormatError('団体名の列が見つかりません');
  const itemCols = cols.filter((c) => c.role === 'item');
  if (itemCols.length === 0) throw new ImportFormatError('品目の列が見つかりません（見出しが items の aliases と合いません）');
  const noteCols = cols.filter((c) => c.role === 'note');
  // 見出しのない列（値があればずれた行）
  // 読む列のいちばん右の位置。これより手前で切れた行は、足りない列を空（＝0）として取り込まず、ずれた行にする
  const lastReadIndex = Math.max(...cols.map((c) => c.index));
  const unnamed = new Set(header.map((h, i) => (compact(h) === '' ? i : -1)).filter((i) => i >= 0));

  const responses: ParsedFormResponse[] = [];
  const rejected: ParsedForm['rejected'] = [];
  rows.slice(1).forEach((cells, k) => {
    const rowNumber = k + 2;
    const reject = (reason: RejectReason) => rejected.push({ rowNumber, reason });
    if (cells.every((c) => c.trim() === '')) return reject('empty');
    // 列がずれている行：見出しより右、または見出しのない列に値がある
    const shifted = cells.some((c, i) => c.trim() !== '' && (i >= header.length || unnamed.has(i)));
    if (shifted || cells.length <= lastReadIndex) return reject('misaligned');

    const submittedAt = parseTimestamp(cells[ts.index] ?? '');
    if (submittedAt === null) return reject('invalid_timestamp');

    const counts: Record<string, number> = {};
    for (const col of itemCols) {
      const raw = cells[col.index] ?? '';
      const { text, stripped } = stripEmails(raw);
      // 数の列にメールが入っているのは、列がずれた行
      if (stripped) return reject('misaligned');
      const n = parseCountCell(text);
      if (n === null) return reject('invalid_number');
      counts[col.code!] = (counts[col.code!] ?? 0) + n;
    }

    let groupName: string | null = null;
    for (const col of nameCols) {
      const v = stripEmails(cells[col.index] ?? '').text.trim();
      if (v !== '') {
        groupName = v;
        break;
      }
    }
    const noteParts = noteCols
      .map((col) => stripEmails(cells[col.index] ?? '').text.trim())
      .filter((v) => v !== '');
    responses.push({
      rowNumber,
      submittedAt,
      groupName,
      counts,
      note: noteParts.length ? noteParts.join('\n') : null,
    });
  });
  return { kind, responses, rejected, ignoredColumns: ignored };
}
