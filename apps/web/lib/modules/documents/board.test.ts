// 提出状況（/documents）の組み立て（04「提出状況」。T19）：URL の読み書き（往復で同じ状態）、団体 × 提出物の表（並び・対象の「—」・
// 印・ファイルの数）、絞り込み（合うセルのある行と列だけ・合わないセルは薄く・件数）、空の表示、狭い幅の一覧、目立たせ（絞り込みで出なければ
// 「すべて」・両方あればシート）、対象の判定（区分・飲食）と、対象を狭めたときに外れる提出の記録のある団体の数。
import { describe, expect, it } from 'vitest';
import type { BoardGroupRow, BoardStatusRow, DocumentRow } from '@/lib/data/documents';
import {
  boardCell,
  boardList,
  buildDocumentsBoard,
  documentsHref,
  isTargetOf,
  narrowingCount,
  parseDocumentsParams,
  resolveDocumentsFocus,
  targetsOf,
  type DocumentsBoardInput,
  type DocumentsViewState,
} from './board';
import type { DocumentFileRow } from './reads';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = uuid(1); // 10/5 17:00 締切（過ぎた）・模擬店と部門
const D2 = uuid(2); // 10/20 締切・飲食の模擬店だけ
const D3 = uuid(3); // 10/20 締切・企業だけ（対象の団体なし）
const G1 = uuid(11); // 模擬店（飲食）sort 1
const G2 = uuid(12); // 模擬店 sort 2
const G3 = uuid(13); // 部門 sort 2（名前で G2 より前）
const G4 = uuid(14); // 休憩所（どの提出物の対象でもない）

/** 開いた時刻：10/6 9:00（Asia/Tokyo） */
const NOW = Date.parse('2026-10-06T00:00:00Z');

const doc = (id: string, over: Partial<DocumentRow>): DocumentRow => ({
  id,
  title: '書類',
  description: null,
  deadline: '2026-10-20T08:00:00Z',
  target_categories: ['stall'],
  food_only: false,
  requires_file: true,
  files_deleted_at: null,
  updated_at: 't',
  ...over,
});
const group = (id: string, over: Partial<BoardGroupRow>): BoardGroupRow => ({
  id,
  name: '団体',
  display_name: null,
  category: 'stall',
  is_food: false,
  sort_order: 1,
  ...over,
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
const file = (id: string, documentId: string, groupId: string, uploaded: boolean): DocumentFileRow => ({
  id,
  document_id: documentId,
  group_id: groupId,
  object_path: `y/${groupId}/${documentId}/${id}.pdf`,
  content_type: 'application/pdf',
  size: 100,
  created_at: '2026-10-01T00:00:00Z',
  uploaded,
  stored_size: uploaded ? 100 : null,
});

const DOCS = [
  doc(D2, { title: '食品の届け', target_categories: ['stall'], food_only: true }),
  doc(D1, { title: '出店計画', deadline: '2026-10-05T08:00:00Z', target_categories: ['stall', 'department'] }),
  doc(D3, { title: '企業の書類', target_categories: ['company'] }),
];
const GROUPS = [
  group(G4, { name: '休憩所', category: 'rest_area', sort_order: 9 }),
  group(G2, { name: '模擬店02', sort_order: 2 }),
  group(G1, { name: '模擬店01', is_food: true, sort_order: 1 }),
  group(G3, { name: '電気科', category: 'department', sort_order: 2 }),
];
/** v_document_status（対象の団体の行だけ。D1 は G1・G2・G3、D2 は G1） */
const STATUSES = [
  status(D1, G1, { status: 'approved', submitted_at: '2026-10-04T00:00:00Z', reviewed_at: '2026-10-05T00:00:00Z', updated_at: 'v' }),
  status(D1, G2, { status: 'submitted', submitted_at: '2026-10-05T09:00:00Z', late: true, proxy: true, updated_at: 'v' }),
  status(D1, G3),
  status(D2, G1, { status: 'returned', submitted_at: '2026-10-03T00:00:00Z', reviewed_at: '2026-10-04T00:00:00Z', review_note: '理由', updated_at: 'v' }),
];
const INPUT: DocumentsBoardInput = {
  docs: DOCS,
  groups: GROUPS,
  statuses: STATUSES,
  files: [file('f1', D1, G1, true), file('f2', D1, G1, true), file('f3', D1, G2, false)],
};

describe('T19 URL（parseDocumentsParams・documentsHref）', () => {
  const p = (q: string) => new URLSearchParams(q);

  it('tab は settings を部門長以上だけに。status は5つのどれか（ほかは all）。document・group は uuid の形だけ（小文字）', () => {
    expect(parseDocumentsParams(p('tab=settings'), 'lead').tab).toBe('settings');
    expect(parseDocumentsParams(p('tab=settings'), 'staff').tab).toBe('status');
    expect(parseDocumentsParams(p('tab=nope'), 'lead').tab).toBe('status');
    for (const s of ['not_submitted', 'submitted', 'returned', 'approved', 'overdue'] as const) expect(parseDocumentsParams(p(`status=${s}`), 'staff').filter).toBe(s);
    expect(parseDocumentsParams(p('status=pending'), 'lead').filter).toBe('all');
    expect(parseDocumentsParams(p(''), 'lead')).toEqual({ tab: 'status', filter: 'all', documentId: null, groupId: null });
    expect(parseDocumentsParams(p(`document=${D1.toUpperCase()}&group=%20${G1}%20`), 'lead')).toMatchObject({ documentId: D1, groupId: G1 });
    expect(parseDocumentsParams(p('document=x&group=1'), 'lead')).toMatchObject({ documentId: null, groupId: null });
  });

  it('documentsHref は既定の値を入れず、parse と往復で同じ状態に戻る', () => {
    expect(documentsHref({})).toBe('/documents');
    expect(documentsHref({ tab: 'status', filter: 'all', documentId: null, groupId: null })).toBe('/documents');
    expect(documentsHref({ filter: 'submitted' })).toBe('/documents?status=submitted');
    const states: DocumentsViewState[] = [
      { tab: 'settings', filter: 'all', documentId: null, groupId: null },
      { tab: 'status', filter: 'overdue', documentId: D1, groupId: null },
      { tab: 'status', filter: 'returned', documentId: D2, groupId: G1 },
      { tab: 'status', filter: 'all', documentId: null, groupId: G3 },
    ];
    for (const s of states) {
      const href = documentsHref(s);
      expect(parseDocumentsParams(new URLSearchParams(href.split('?')[1] ?? ''), 'lead'), href).toEqual(s);
    }
  });
});

describe('T19 表（buildDocumentsBoard）', () => {
  it('行は対象の団体だけ（sort_order → 名前 → id）、列は提出物（締切 → 題名 → id）。対象でないセルは null（「—」）', () => {
    const b = buildDocumentsBoard(INPUT, 'all', NOW);
    expect(b.rows.map((g) => g.id)).toEqual([G1, G2, G3]);
    // 同じ締切（10/20）は題名の順（企業の書類 → 食品の届け）
    expect(b.columns.map((c) => c.doc.id)).toEqual([D1, D3, D2]);
    expect(b.columns.map((c) => c.doc.title)).toEqual(['出店計画', '企業の書類', '食品の届け']);
    expect(boardCell(b, D2, G2)).toBeNull();
    expect(boardCell(b, D3, G1)).toBeNull();
    expect(boardCell(b, D1, G4)).toBeNull();
    expect(b.empty).toBeNull();
  });

  it('列の数（承認 1／3）と締切を過ぎたか、セルの印と届いたファイルの数（部門長以上だけ）', () => {
    const b = buildDocumentsBoard(INPUT, 'all', NOW);
    const d1 = b.columns.find((c) => c.doc.id === D1)!;
    expect(d1).toMatchObject({ targets: 3, approved: 1, deadlinePassed: true });
    expect(b.columns.find((c) => c.doc.id === D3)).toMatchObject({ targets: 0, approved: 0, deadlinePassed: false });
    expect(boardCell(b, D1, G1)).toMatchObject({ files: 2, marks: { status: 'approved', paper: false } });
    expect(boardCell(b, D1, G2)).toMatchObject({ files: 0, marks: { status: 'submitted', late: true, proxy: true, overdue: false } });
    expect(boardCell(b, D1, G3)!.marks.overdue).toBe(true);
    // 総務部門員（ファイルを読まない）は数を出さない
    const staff = buildDocumentsBoard({ ...INPUT, files: null }, 'all', NOW);
    expect(boardCell(staff, D1, G1)!.files).toBeNull();
  });

  it('絞り込みごとの件数（今の絞り込みによらない）', () => {
    const b = buildDocumentsBoard(INPUT, 'submitted', NOW);
    expect(b.counts).toEqual({ all: 4, not_submitted: 1, submitted: 1, returned: 1, approved: 1, overdue: 1 });
  });

  it('絞ると、合うセルのある行と列だけを出し、その中の合わないセルは matches が偽（薄くする）', () => {
    const b = buildDocumentsBoard(INPUT, 'returned', NOW);
    expect(b.rows.map((g) => g.id)).toEqual([G1]);
    expect(b.columns.map((c) => c.doc.id)).toEqual([D2]);
    const over = buildDocumentsBoard(INPUT, 'overdue', NOW);
    expect(over.rows.map((g) => g.id)).toEqual([G3]);
    expect(over.columns.map((c) => c.doc.id)).toEqual([D1]);
    // 承認待ちが D1×G2 と D2×G1 にあると、行は G1・G2、列は D1・D2。その中の D1×G1（承認）は薄く、D2×G2 は対象でない
    const twoSubmitted = { ...INPUT, statuses: STATUSES.map((s) => (s.document_id === D2 ? { ...s, status: 'submitted' as const } : s)) };
    const submitted = buildDocumentsBoard(twoSubmitted, 'submitted', NOW);
    expect(submitted.rows.map((g) => g.id)).toEqual([G1, G2]);
    expect(submitted.columns.map((c) => c.doc.id)).toEqual([D1, D2]);
    expect(boardCell(submitted, D1, G2)!.matches).toBe(true);
    expect(boardCell(submitted, D2, G1)!.matches).toBe(true);
    expect(boardCell(submitted, D1, G1)!.matches).toBe(false);
    expect(boardCell(submitted, D2, G2)).toBeNull();
    // 一覧も同じ行・同じ薄さ（提出物ごとに、出す行のうち対象の団体）
    expect(boardList(buildDocumentsBoard(INPUT, 'all', NOW)).map((x) => [x.column.doc.id, x.cells.map((c) => c.groupId)])).toEqual([
      [D1, [G1, G2, G3]],
      [D3, []],
      [D2, [G1]],
    ]);
    expect(boardList(submitted).map((x) => [x.column.doc.id, x.cells.map((c) => [c.groupId, c.matches])])).toEqual([
      [
        D1,
        [
          [G1, false],
          [G2, true],
        ],
      ],
      [D2, [[G1, true]]],
    ]);
  });

  it('空の表示：提出物がない・対象の団体がない・絞り込みに合う提出がない', () => {
    expect(buildDocumentsBoard({ ...INPUT, docs: [], statuses: [] }, 'all', NOW).empty).toBe('no_documents');
    expect(buildDocumentsBoard({ ...INPUT, docs: [DOCS[2]!], statuses: [] }, 'all', NOW).empty).toBe('no_targets');
    expect(buildDocumentsBoard({ ...INPUT, statuses: STATUSES.slice(0, 1) }, 'returned', NOW).empty).toBe('filtered');
  });

  it('読めない提出物・団体の行は除く', () => {
    const b = buildDocumentsBoard({ ...INPUT, statuses: [...STATUSES, status(uuid(99), G1), status(D1, uuid(98))] }, 'all', NOW);
    expect(b.counts.all).toBe(4);
  });
});

describe('T19 目立たせ（resolveDocumentsFocus）', () => {
  const st = (over: Partial<DocumentsViewState>): DocumentsViewState => ({ tab: 'status', filter: 'all', documentId: null, groupId: null, ...over });

  it('両方あってそのセルがあればシートを開く。対象でないセル・ない id は開かない（ない id は null にする）', () => {
    expect(resolveDocumentsFocus(st({ documentId: D1, groupId: G2 }), INPUT, NOW)).toEqual({ filter: 'all', documentId: D1, groupId: G2, sheet: true });
    expect(resolveDocumentsFocus(st({ documentId: D2, groupId: G2 }), INPUT, NOW).sheet).toBe(false);
    expect(resolveDocumentsFocus(st({ documentId: uuid(77), groupId: uuid(78) }), INPUT, NOW)).toEqual({
      filter: 'all',
      documentId: null,
      groupId: null,
      sheet: false,
    });
  });

  it('絞り込みでその列・行が出ないときは、絞り込みを「すべて」にする（出るならそのまま）', () => {
    expect(resolveDocumentsFocus(st({ filter: 'returned', documentId: D1 }), INPUT, NOW).filter).toBe('all');
    expect(resolveDocumentsFocus(st({ filter: 'returned', documentId: D2 }), INPUT, NOW).filter).toBe('returned');
    expect(resolveDocumentsFocus(st({ filter: 'overdue', groupId: G1 }), INPUT, NOW).filter).toBe('all');
    expect(resolveDocumentsFocus(st({ filter: 'overdue' }), INPUT, NOW).filter).toBe('overdue');
  });
});

describe('T19 対象の判定と、対象を狭めたときの提出の記録（isTargetOf・targetsOf・narrowingCount）', () => {
  it('区分が対象の区分にあり、飲食の団体だけなら飲食の団体（v_document_status と同じ）', () => {
    expect(isTargetOf(DOCS[0]!, GROUPS[2]!)).toBe(true); // 飲食の模擬店
    expect(isTargetOf(DOCS[0]!, GROUPS[1]!)).toBe(false); // 飲食でない模擬店
    expect(targetsOf(DOCS[1]!, GROUPS).map((g) => g.id)).toEqual([G1, G2, G3]);
    expect(targetsOf(DOCS[2]!, GROUPS)).toEqual([]);
  });

  it('外れる団体のうち未提出でない提出がある団体の数（区分を外す・飲食の団体だけにする）。広げれば 0', () => {
    const data = { groups: GROUPS, statuses: STATUSES };
    // 部門を外す：外れるのは G3（未提出）→ 0
    expect(narrowingCount(DOCS[1]!, { target_categories: ['stall'], food_only: false }, data)).toBe(0);
    // 飲食の団体だけ：外れるのは G2（提出済み）と G3（未提出）→ 1
    expect(narrowingCount(DOCS[1]!, { target_categories: ['stall', 'department'], food_only: true }, data)).toBe(1);
    // 模擬店を外す：外れるのは G1（承認）と G2（提出済み）→ 2
    expect(narrowingCount(DOCS[1]!, { target_categories: ['department'], food_only: false }, data)).toBe(2);
    expect(narrowingCount(DOCS[0]!, { target_categories: ['stall', 'company'], food_only: false }, data)).toBe(0);
  });
});
