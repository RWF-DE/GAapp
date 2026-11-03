// 提出状況の CSV（部門長以上の「CSV で保存」。04「提出状況」の CSV、notes/T19.md「パート B・C の約束」5。T19・D-55）。純粋な関数。
// /documents の「CSV で保存」が押したときに動的 import で読む（/ と /document の JS に入れない）。
// - ファイル名 `{年度名}_提出状況.csv`。UTF-8・BOM つき・CRLF。RFC 4180 の引用（`,` `"` 改行を含む欄は `"` で囲み、`"` は2つ）。
// - 式として読まれる先頭の文字（`=` `+` `-` `@`、タブ、CR、LF）で始まる欄は頭に `'` を付ける（CSV の式の注入を防ぐ。テント等の貸し出しの
//   CSV と同じ）。
// - 絞り込みによらず、その年度の全部の行（団体 × その団体が対象の提出物。団体の並び → 提出物の並び）。
// - 列：団体・区分・提出物・締切・状態（未提出・承認待ち・差し戻し・承認）・提出日時・代理（「代理」か空）・承認／差し戻しの日時。日時は
//   Asia/Tokyo の「2026/10/05 17:00」。理由・メモ・ファイル・した人は入れない（Q11。個人情報を広げない）。
import type { BoardGroupRow, BoardStatusRow, DocumentRow } from '@/lib/data/documents';
import { formatDateTime } from '@/lib/datetime';
import { CATEGORY_LABELS, labelOf } from '@/lib/labels';
import { compareDocuments, compareGroups } from './board';
import { SOUMU_STATUS_LABELS, statusOf } from './labels';

/** ファイル名（`{年度名}_提出状況.csv`） */
export function documentsCsvFileName(yearLabel: string): string {
  return `${yearLabel}_提出状況.csv`;
}

/** 見出しの行 */
export const DOCUMENTS_CSV_HEADER = ['団体', '区分', '提出物', '締切', '状態', '提出日時', '代理', '承認／差し戻しの日時'] as const;

const FORMULA_START = /^[=+\-@\t\r\n]/;

/** 1つの欄（式として読まれる先頭の文字に `'` を付け、`,` `"` 改行を含めば `"` で囲む） */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let v = String(value);
  if (FORMULA_START.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** CSV の材料（/documents が読んだ行のまま） */
export interface DocumentsCsvInput {
  docs: readonly DocumentRow[];
  groups: readonly BoardGroupRow[];
  statuses: readonly BoardStatusRow[];
}

/**
 * CSV の文字列（BOM つき・CRLF）。行は v_document_status の行（その団体が対象の提出物）を、団体の並び → 提出物の並びに。承認／差し戻しの
 * 日時は、今の状態が承認か差し戻しのときだけ（前の差し戻しの日時は出さない）。
 */
export function buildDocumentsCsv(input: DocumentsCsvInput): string {
  const docs = [...input.docs].sort(compareDocuments);
  const docIndex = new Map(docs.map((d, k) => [d.id, k]));
  const groups = [...input.groups].sort(compareGroups);
  const byGroup = new Map<string, BoardStatusRow[]>();
  for (const row of input.statuses) {
    if (!docIndex.has(row.document_id)) continue;
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row);
    byGroup.set(row.group_id, list);
  }
  const lines = [DOCUMENTS_CSV_HEADER.map(csvCell).join(',')];
  for (const g of groups) {
    const rows = (byGroup.get(g.id) ?? []).sort((a, b) => docIndex.get(a.document_id)! - docIndex.get(b.document_id)!);
    for (const row of rows) {
      const doc = docs[docIndex.get(row.document_id)!]!;
      const status = statusOf(row.status);
      const reviewed = status === 'approved' || status === 'returned' ? formatDateTime(row.reviewed_at) : '';
      lines.push(
        [
          g.name,
          labelOf(CATEGORY_LABELS, g.category, g.category),
          doc.title,
          formatDateTime(doc.deadline),
          SOUMU_STATUS_LABELS[status],
          formatDateTime(row.submitted_at),
          row.proxy ? '代理' : '',
          reviewed,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
