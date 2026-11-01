// 提出状況の CSV（04「提出状況」の CSV。T19）：ファイル名、BOM・CRLF・RFC 4180 の引用・式の無害化、列（理由・メモ・ファイル・した人は
// 入れない）、絞り込みによらず全部の行（団体の並び → 提出物の並び）、日時は Asia/Tokyo。
import { describe, expect, it } from 'vitest';
import type { BoardGroupRow, BoardStatusRow, DocumentRow } from '@/lib/data/documents';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { buildDocumentsCsv, csvCell, DOCUMENTS_CSV_HEADER, documentsCsvFileName } from './csv';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = uuid(1);
const D2 = uuid(2);
const G1 = uuid(11);
const G2 = uuid(12);

const doc = (id: string, title: string, deadline: string): DocumentRow => ({
  id,
  title,
  description: '説明は入れない',
  deadline,
  target_categories: ['stall'],
  food_only: false,
  requires_file: true,
  files_deleted_at: null,
  updated_at: 't',
});
const group = (id: string, name: string, sort_order: number, category: BoardGroupRow['category'] = 'stall'): BoardGroupRow => ({
  id,
  name,
  display_name: '企画名は入れない',
  category,
  is_food: false,
  sort_order,
});
const status = (documentId: string, groupId: string, over: Partial<BoardStatusRow> = {}): BoardStatusRow => ({
  document_id: documentId,
  group_id: groupId,
  status: 'not_submitted',
  submitted_at: null,
  submitted_by: null,
  proxy: false,
  late: false,
  reviewed_at: null,
  reviewed_by: null,
  review_note: null,
  updated_at: null,
  ...over,
});

describe('T19 提出状況の CSV', () => {
  it('ファイル名は `{年度名}_提出状況.csv`', () => {
    expect(documentsCsvFileName('R8')).toBe('R8_提出状況.csv');
  });

  it('欄：式として読まれる先頭（= + - @ タブ CR LF）に `\'` を付け、`,` `"` 改行を含めば引用する', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('\nb')).toBe(`"'\nb"`);
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
  });

  it('BOM つき・CRLF。全部の行を団体の並び → 提出物の並びに。状態は総務の言い方、代理は「代理」、承認／差し戻しの日時は今が承認か差し戻しのときだけ', () => {
    const text = buildDocumentsCsv({
      docs: [doc(D2, '食品,の"届け"', '2026-10-20T08:00:00Z'), doc(D1, '=出店計画', '2026-10-05T08:00:00Z')],
      groups: [group(G2, '模擬店02', 2), group(G1, '電気科', 1, 'department')],
      statuses: [
        status(D2, G2, { status: 'returned', submitted_at: '2026-10-03T00:00:00Z', reviewed_at: '2026-10-04T00:00:00Z', review_note: '理由は入れない' }),
        status(D1, G2, { status: 'submitted', submitted_at: '2026-10-05T09:00:00Z', proxy: true, submitted_by: uuid(90), reviewed_at: '2026-10-01T00:00:00Z' }),
        status(D1, G1, { status: 'approved', reviewed_at: '2026-10-06T01:02:00Z', review_note: '紙のメモも入れない' }),
        // 読めない提出物の行は出さない
        status(uuid(99), G1),
      ],
    });
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe(DOCUMENTS_CSV_HEADER.join(','));
    expect(DOCUMENTS_CSV_HEADER).toEqual(['団体', '区分', '提出物', '締切', '状態', '提出日時', '代理', '承認／差し戻しの日時']);
    expect(lines.slice(1)).toEqual([
      "電気科,部門,'=出店計画,2026/10/05 17:00,承認,,,2026/10/06 10:02",
      "模擬店02,模擬店,'=出店計画,2026/10/05 17:00,承認待ち,2026/10/05 18:00,代理,",
      '模擬店02,模擬店,"食品,の""届け""",2026/10/20 17:00,差し戻し,2026/10/03 09:00,,2026/10/04 09:00',
    ]);
    for (const secret of ['理由は入れない', '紙のメモも入れない', '説明は入れない', '企画名は入れない', uuid(90)]) expect(text).not.toContain(secret);
  });

  it('csv.ts は「CSV で保存」を押したときに動的 import で読む小さなモジュール（React・Supabase・画面の部品を読まない）', () => {
    const g = staticImportGraph('lib/modules/documents/csv.ts');
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.packages.filter((p) => /^(react|next|@supabase|@tanstack|zod)/.test(p))).toEqual([]);
  });
});
