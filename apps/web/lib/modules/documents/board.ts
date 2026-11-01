// 提出状況（/documents。PC）の組み立て（04「提出状況」の提出状況のタブ・URL・絞り込み・提出物の設定の対象の数、notes/T19.md
// 「パート B・C の約束」1・5。T19・D-55）。純粋な関数（時計は now だけ）。
// - URL：`?tab=status|settings`（settings は部門長以上だけ）、`?status=`（未提出・承認待ち・差し戻し・承認・締切を過ぎた。ほかは「すべて」）、
//   `?document=`・`?group=`（uuid でなければ null）。parseDocumentsParams と documentsHref は往復で同じ状態に戻る。
// - 表：行は団体（sort_order → 名前 → id。どれかの提出物の対象の団体だけ）、列は提出物（締切 → 題名 → id）。セルは v_document_status の行
//   （対象の団体だけ。行がなければ「—」）。絞ると、合うセルのある行と列だけを出し、その中の合わないセルを薄くする。
// - 対象の判定（区分・飲食の団体だけ）は DB の v_document_status と同じ（targetsOf。設定のダイアログの「対象の団体：{N} 団体」と、
//   対象を狭めたときに外れる、提出の記録のある団体の数）。
// ダッシュボード（/）はこのファイルを読まない（提出状況の画面の部品なので、/ の JS に入れない）。
import { compareStrings } from '@gaapp/shared';
import type { BoardGroupRow, BoardStatusRow, DocumentRow } from '@/lib/data/documents';
import { DOCUMENT_FILTERS, statusOf, type DocumentFilter } from './labels';
import { deadlinePassed, documentMarks, type DocumentMarks } from './marks';
import type { DocumentsTier } from './permissions';
import type { DocumentFileRow } from './reads';

/** 提出状況のタブ */
export type DocumentsTab = 'status' | 'settings';

/** 提出状況の URL の状態 */
export interface DocumentsViewState {
  tab: DocumentsTab;
  filter: DocumentFilter;
  /** 目立たせる提出物（列）。group と両方あればそのセルのシートを開く */
  documentId: string | null;
  /** 目立たせる団体（行） */
  groupId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uuid の形のパラメータ（前後の空白を除いて小文字にする。形が違えば null） */
function uuidParam(params: Pick<URLSearchParams, 'get'>, name: string): string | null {
  const v = params.get(name)?.trim().toLowerCase() ?? '';
  return UUID.test(v) ? v : null;
}

/**
 * URL のクエリを読む（04「提出状況」）：tab は settings を部門長以上（tier が lead）だけに許し、ほかと知らない値は status。status は
 * not_submitted・submitted・returned・approved・overdue のどれか（ない・知らない値は all）。document・group は uuid の形だけ（小文字にする）。
 */
export function parseDocumentsParams(params: Pick<URLSearchParams, 'get'>, tier: DocumentsTier | null): DocumentsViewState {
  const status = params.get('status');
  const filter = status !== null && (DOCUMENT_FILTERS as readonly string[]).includes(status) ? (status as DocumentFilter) : 'all';
  return {
    tab: params.get('tab') === 'settings' && tier === 'lead' ? 'settings' : 'status',
    filter,
    documentId: uuidParam(params, 'document'),
    groupId: uuidParam(params, 'group'),
  };
}

/**
 * 状態 → `/documents` の URL（既定の値〔status のタブ・すべて〕と空の id は入れない。並びは tab・status・document・group）。
 *
 * @example
 * documentsHref({ tab: 'status', filter: 'submitted', documentId: null, groupId: null }) // '/documents?status=submitted'
 */
export function documentsHref(s: Partial<DocumentsViewState>): string {
  const q = new URLSearchParams();
  if (s.tab === 'settings') q.set('tab', 'settings');
  if (s.filter && s.filter !== 'all') q.set('status', s.filter);
  if (s.documentId) q.set('document', s.documentId);
  if (s.groupId) q.set('group', s.groupId);
  const str = q.toString();
  return str ? `/documents?${str}` : '/documents';
}

// ---------------------------------------------------------------- 並べ方と対象

/** 団体の並び（sort_order → 名前 → id。CLAUDE.md の約束） */
export function compareGroups(a: Pick<BoardGroupRow, 'sort_order' | 'name' | 'id'>, b: Pick<BoardGroupRow, 'sort_order' | 'name' | 'id'>): number {
  return a.sort_order - b.sort_order || compareStrings(a.name, b.name) || compareStrings(a.id, b.id);
}

const timeOrInf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** 提出物の並び（締切 → 題名 → id） */
export function compareDocuments(a: Pick<DocumentRow, 'deadline' | 'title' | 'id'>, b: Pick<DocumentRow, 'deadline' | 'title' | 'id'>): number {
  return timeOrInf(a.deadline) - timeOrInf(b.deadline) || compareStrings(a.title, b.title) || compareStrings(a.id, b.id);
}

/** その団体がその提出物の対象か（区分が対象の区分にあり、飲食の団体だけなら飲食の団体。v_document_status と同じ判定） */
export function isTargetOf(doc: Pick<DocumentRow, 'target_categories' | 'food_only'>, group: Pick<BoardGroupRow, 'category' | 'is_food'>): boolean {
  return doc.target_categories.includes(group.category) && (!doc.food_only || group.is_food);
}

/** 提出物の対象の団体（団体の並び） */
export function targetsOf<G extends Pick<BoardGroupRow, 'category' | 'is_food' | 'sort_order' | 'name' | 'id'>>(
  doc: Pick<DocumentRow, 'target_categories' | 'food_only'>,
  groups: readonly G[],
): G[] {
  return groups.filter((g) => isTargetOf(doc, g)).sort(compareGroups);
}

/**
 * 対象を狭めると外れる団体のうち、未提出でない提出（提出済み・差し戻し・承認）がある団体の数（04「提出物の設定」：「対象から外れる {N} 団体に
 * 提出の記録があります…」）。提出の記録は v_document_status の今の行（今の対象の団体の分）で見る。
 */
export function narrowingCount(
  doc: Pick<DocumentRow, 'id' | 'target_categories' | 'food_only'>,
  next: Pick<DocumentRow, 'target_categories' | 'food_only'>,
  data: { groups: readonly BoardGroupRow[]; statuses: readonly Pick<BoardStatusRow, 'document_id' | 'group_id' | 'status'>[] },
): number {
  const after = new Set(targetsOf(next, data.groups).map((g) => g.id));
  const recorded = new Set(
    data.statuses.filter((s) => s.document_id === doc.id && statusOf(s.status) !== 'not_submitted').map((s) => s.group_id),
  );
  return targetsOf(doc, data.groups).filter((g) => !after.has(g.id) && recorded.has(g.id)).length;
}

// ---------------------------------------------------------------- 表

/** 組み立ての材料（lib/data/documents.ts の DocumentsBoardData の一部） */
export interface DocumentsBoardInput {
  docs: readonly DocumentRow[];
  statuses: readonly BoardStatusRow[];
  groups: readonly BoardGroupRow[];
  /** 部門長以上だけ（総務部門員は null。ファイルの数を出さない） */
  files: readonly DocumentFileRow[] | null;
}

/** 1つのセル（団体 × その団体が対象の提出物） */
export interface BoardCell {
  documentId: string;
  groupId: string;
  row: BoardStatusRow;
  marks: DocumentMarks;
  /** 届いたファイルの数（部門長以上。総務部門員は null） */
  files: number | null;
  /** 今の絞り込みに合うか（合わないセルは薄くする） */
  matches: boolean;
}

/** 列（提出物） */
export interface BoardColumn {
  doc: DocumentRow;
  /** 対象の団体の数 */
  targets: number;
  /** 承認の数（「承認 3／10」） */
  approved: number;
  /** 締切を過ぎたか（「締切を過ぎました」） */
  deadlinePassed: boolean;
}

/** 空の表示の種類（提出物がない・対象の団体がない・絞り込みに合う提出がない） */
export type BoardEmpty = 'no_documents' | 'no_targets' | 'filtered';

export interface DocumentsBoard {
  /** 出す列（絞り込みに合うセルのある提出物。すべてなら全部の提出物） */
  columns: BoardColumn[];
  /** 出す行（絞り込みに合うセルのある団体。すべてならどれかの提出物の対象の団体） */
  rows: BoardGroupRow[];
  /** 全部のセル（キーは cellKey） */
  cells: ReadonlyMap<string, BoardCell>;
  /** 絞り込みごとの件数（セルの数。今の絞り込みによらない） */
  counts: Readonly<Record<DocumentFilter, number>>;
  filter: DocumentFilter;
  empty: BoardEmpty | null;
}

/** セルのキー */
export function cellKey(documentId: string, groupId: string): string {
  return `${documentId}:${groupId}`;
}

/** 印が絞り込みに合うか（すべてはどれも、締切を過ぎたは未提出・差し戻しのまま締切を過ぎたもの、ほかは状態） */
export function matchesFilter(marks: DocumentMarks, filter: DocumentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'overdue') return marks.overdue;
  return marks.status === filter;
}

/**
 * 表を組み立てる（04「提出状況」）。セルは v_document_status の行（その団体が対象の提出物。行は今の対象の団体だけ）で、提出物か団体が
 * 読めないものは除く。絞り込み（filter）が「すべて」でなければ、合うセルのある行と列だけを出し、合わないセルは matches が偽。
 */
export function buildDocumentsBoard(data: DocumentsBoardInput, filter: DocumentFilter, now: number): DocumentsBoard {
  const docs = [...data.docs].sort(compareDocuments);
  const groups = [...data.groups].sort(compareGroups);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const groupIds = new Set(groups.map((g) => g.id));
  const uploaded = new Map<string, number>();
  for (const f of data.files ?? []) {
    if (!f.uploaded) continue;
    const k = cellKey(f.document_id, f.group_id);
    uploaded.set(k, (uploaded.get(k) ?? 0) + 1);
  }
  const counts = Object.fromEntries(DOCUMENT_FILTERS.map((f) => [f, 0])) as Record<DocumentFilter, number>;
  const cells = new Map<string, BoardCell>();
  for (const row of data.statuses) {
    const doc = docById.get(row.document_id);
    if (!doc || !groupIds.has(row.group_id)) continue;
    const marks = documentMarks({ ...row, deadline: doc.deadline }, now);
    const k = cellKey(row.document_id, row.group_id);
    cells.set(k, {
      documentId: row.document_id,
      groupId: row.group_id,
      row,
      marks,
      files: data.files ? (uploaded.get(k) ?? 0) : null,
      matches: matchesFilter(marks, filter),
    });
    for (const f of DOCUMENT_FILTERS) if (matchesFilter(marks, f)) counts[f]++;
  }
  const cellList = [...cells.values()];
  const shown = filter === 'all' ? cellList : cellList.filter((c) => c.matches);
  const shownDocs = new Set(shown.map((c) => c.documentId));
  const shownGroups = new Set(shown.map((c) => c.groupId));
  const columns = docs
    .filter((d) => filter === 'all' || shownDocs.has(d.id))
    .map((doc) => {
      const mine = cellList.filter((c) => c.documentId === doc.id);
      return {
        doc,
        targets: mine.length,
        approved: mine.filter((c) => c.marks.status === 'approved').length,
        deadlinePassed: deadlinePassed(doc.deadline, now),
      };
    });
  const rows = groups.filter((g) => shownGroups.has(g.id));
  const empty: BoardEmpty | null =
    docs.length === 0 ? 'no_documents' : cells.size === 0 ? 'no_targets' : filter !== 'all' && shown.length === 0 ? 'filtered' : null;
  return { columns, rows, cells, counts, filter, empty };
}

/** そのセル（対象でなければ null。表の「—」） */
export function boardCell(board: Pick<DocumentsBoard, 'cells'>, documentId: string, groupId: string): BoardCell | null {
  return board.cells.get(cellKey(documentId, groupId)) ?? null;
}

/** 狭い幅の一覧（提出物ごとに、出す行のうちその提出物の対象の団体のセル。表と同じ並び・同じ薄さ） */
export function boardList(board: DocumentsBoard): { column: BoardColumn; cells: BoardCell[] }[] {
  return board.columns.map((column) => ({
    column,
    cells: board.rows.flatMap((g) => {
      const c = boardCell(board, column.doc.id, g.id);
      return c ? [c] : [];
    }),
  }));
}

/**
 * URL の目立たせ（document・group）を、表の今の絞り込みで出せるか確かめる（04「提出状況」：絞り込みでその列・行が出ないときは、絞り込みを
 * 「すべて」にする）。読めない・ない・形の違う id は何もしない（null にする）。両方あってそのセルがあれば、シートを開く。
 */
export function resolveDocumentsFocus(
  state: DocumentsViewState,
  data: DocumentsBoardInput,
  now: number,
): { filter: DocumentFilter; documentId: string | null; groupId: string | null; sheet: boolean } {
  const all = buildDocumentsBoard(data, 'all', now);
  const documentId = state.documentId && all.columns.some((c) => c.doc.id === state.documentId) ? state.documentId : null;
  const groupId = state.groupId && all.rows.some((g) => g.id === state.groupId) ? state.groupId : null;
  let filter = state.filter;
  if (filter !== 'all' && (documentId || groupId)) {
    const shown = buildDocumentsBoard(data, filter, now);
    const hiddenDoc = documentId !== null && !shown.columns.some((c) => c.doc.id === documentId);
    const hiddenGroup = groupId !== null && !shown.rows.some((g) => g.id === groupId);
    if (hiddenDoc || hiddenGroup) filter = 'all';
  }
  const sheet = documentId !== null && groupId !== null && boardCell(all, documentId, groupId) !== null;
  return { filter, documentId, groupId, sheet };
}
