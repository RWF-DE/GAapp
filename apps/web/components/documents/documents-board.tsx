'use client';

// 提出状況のタブの表と、狭い幅の提出物ごとの一覧・絞り込み・目立たせ（04「提出状況 /documents（PC）」の提出状況、notes/T19.md「パート B・C の
// 約束」6。T19・D-55）。組み立ては lib/modules/documents/board.ts（純粋な関数）。
// - 表（lg 以上）：行は団体（sort_order → 名前 → id）、列は提出物（締切 → 題名 → id）。団体の列を固定し、列が多ければ表の中だけを横に送る。
//   列の見出しは題名・締切（過ぎていれば「締切を過ぎました」）・承認の数。セルは状態の印（締切の後・代理・紙・締切を過ぎた）と、部門長以上には
//   届いたファイルの数（「ファイル 2」。0 は出さない）。その団体が対象でないセルは「—」（押せない）。セルは押せるボタン（読み上げの名前は「{団体}・{提出物}：{状態}」）。
// - 狭い幅（lg 未満）：提出物ごとの一覧（提出物の見出しの下に、対象の団体ごとに1行）。表と一覧はどちらか一方だけを描く（同じセルを2回描かない。
//   幅は画面を描いた後に決め、最初の描画は表）。
// - 絞り込み（`?status=`。件数つき）で、合うセルのある行と列だけを出し、その中の合わないセルを薄くする（一覧も同じ）。
// - `?document=`・`?group=` の列・行（一覧では提出物）を目立たせて見える所に送る。
// 色だけで表さず、状態の文字を出す。変数名は doc・docs（ブラウザの document を隠さない）。
import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { BoardGroupRow } from '@/lib/data/documents';
import { tokyoToday } from '@/lib/datetime';
import { formatShortDateTimeWeekday } from '@/lib/datetime-weekday';
import { CATEGORY_LABELS } from '@/lib/labels';
import { boardCell, boardList, type BoardCell, type BoardColumn, type DocumentsBoard } from '@/lib/modules/documents/board';
import { DOCUMENT_FILTER_LABELS, DOCUMENT_FILTERS, DOCUMENT_MARK_LABELS, SOUMU_STATUS_LABELS, type DocumentFilter } from '@/lib/modules/documents/labels';
import { cn } from '@/lib/utils';
import { DOCUMENT_MARK_CLASS, DocumentStatusBadge } from './status-badge';

/** 締切を過ぎた列の見出しの文（「締切と予定」の DATED_OVERDUE と同じ文字） */
export const COLUMN_OVERDUE_TEXT = '締切を過ぎました';

/** 表を出す幅（Tailwind の lg。これより狭いと提出物ごとの一覧） */
export const WIDE_QUERY = '(min-width: 1024px)';

/**
 * 表を出す幅か（画面を描いた後に決める。最初の描画は表。matchMedia のない環境〔プリレンダー・テスト〕では表のまま）。
 * window は effect の中だけで使う（静的書き出しのプリレンダーの間はない）。
 */
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return wide;
}

/** 列の見出しの締切（「10/5（月）17:00」。年は開いた時刻の Asia/Tokyo の年と違うときだけ付ける） */
export function columnDeadlineText(deadline: string, now: number): string {
  const year = Number(tokyoToday(new Date(now)).slice(0, 4));
  return formatShortDateTimeWeekday(deadline, year) || '—';
}

/** 承認の数（「承認 3／10」） */
export function approvedCountText(column: Pick<BoardColumn, 'approved' | 'targets'>): string {
  return `承認 ${column.approved}／${column.targets}`;
}

/** セルの読み上げの名前（「{団体}・{提出物}：{状態}」） */
export function cellLabel(groupName: string, title: string, cell: BoardCell): string {
  return `${groupName}・${title}：${SOUMU_STATUS_LABELS[cell.marks.status]}`;
}

const bool = (v: boolean) => (v ? 'true' : 'false');

/** 状態のほかの印（締切の後・代理・紙・締切を過ぎた）。色だけで表さず、文字を出す */
function CellMarks({ cell, className }: { cell: BoardCell; className?: string }) {
  const marks: string[] = [];
  if (cell.marks.late) marks.push(DOCUMENT_MARK_LABELS.late);
  if (cell.marks.proxy) marks.push(DOCUMENT_MARK_LABELS.proxy);
  if (cell.marks.paper) marks.push(DOCUMENT_MARK_LABELS.paper);
  if (cell.marks.overdue) marks.push(DOCUMENT_MARK_LABELS.overdue);
  if (marks.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {marks.map((m) => (
        <Badge key={m} variant="outline" className={cn('px-1.5 py-0 text-[11px] font-normal', DOCUMENT_MARK_CLASS)}>
          {m}
        </Badge>
      ))}
    </span>
  );
}

/** 届いたファイルの数（部門長以上。0 のときは出さない） */
function CellFiles({ show, cell }: { show: boolean; cell: BoardCell }) {
  if (!show || !cell.files) return null;
  return (
    <span data-testid="documents-cell-files" className="text-xs text-muted-foreground">
      ファイル {cell.files}
    </span>
  );
}

const TOGGLE_ON = 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground';

/** 絞り込み（件数つき。押すと `?status=` を置き換える） */
export function DocumentsFilter({
  filter,
  counts,
  onChange,
}: {
  filter: DocumentFilter;
  counts: Readonly<Record<DocumentFilter, number>>;
  onChange: (next: DocumentFilter) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id={labelId} className="text-sm text-muted-foreground">
        状態
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={2}
        value={filter}
        onValueChange={(v) => {
          if (v) onChange(v as DocumentFilter);
        }}
        aria-labelledby={labelId}
        data-testid="documents-filter"
        className="flex-wrap"
      >
        {DOCUMENT_FILTERS.map((f) => (
          <ToggleGroupItem key={f} value={f} data-testid="documents-filter-item" data-status={f} data-count={counts[f]} className={TOGGLE_ON}>
            {DOCUMENT_FILTER_LABELS[f]}
            <span className="tabular-nums">{counts[f]}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export interface DocumentsBoardViewProps {
  board: DocumentsBoard;
  /** 部門長以上（セルに届いたファイルの数を出す） */
  showFiles: boolean;
  /** 開いた時刻・「読み直す」を押した時刻（締切の出し方） */
  now: number;
  /** 目立たせる提出物（列）と団体（行） */
  highlightDocumentId: string | null;
  highlightGroupId: string | null;
  /** 表（lg 以上）か、提出物ごとの一覧か */
  wide: boolean;
  onOpenCell: (documentId: string, groupId: string) => void;
}

/**
 * 表か一覧（どちらか一方）。目立たせる列・行・提出物は、描いた後に見える所に送る。
 */
export function DocumentsBoardView({ board, showFiles, now, highlightDocumentId, highlightGroupId, wide, onOpenCell }: DocumentsBoardViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 目立たせる列・行（一覧では提出物）を見える所に送る（ダッシュボードの締切と予定・要対応から来る）
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const el =
      (highlightDocumentId
        ? root.querySelector(wide ? `[data-testid="documents-col"][data-document-id="${highlightDocumentId}"]` : `[data-testid="documents-list-document"][data-document-id="${highlightDocumentId}"]`)
        : null) ?? (highlightGroupId && wide ? root.querySelector(`[data-testid="documents-row"][data-group-id="${highlightGroupId}"]`) : null);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [highlightDocumentId, highlightGroupId, wide]);

  return (
    <div ref={ref}>
      {wide ? (
        <BoardTable
          board={board}
          showFiles={showFiles}
          now={now}
          highlightDocumentId={highlightDocumentId}
          highlightGroupId={highlightGroupId}
          onOpenCell={onOpenCell}
        />
      ) : (
        <BoardList
          board={board}
          showFiles={showFiles}
          now={now}
          highlightDocumentId={highlightDocumentId}
          highlightGroupId={highlightGroupId}
          onOpenCell={onOpenCell}
        />
      )}
    </div>
  );
}

type PartProps = Omit<DocumentsBoardViewProps, 'wide'>;

function ColumnHeading({ column, now }: { column: BoardColumn; now: number }) {
  return (
    <>
      <span className="block font-medium [overflow-wrap:anywhere]">{column.doc.title}</span>
      <span className="block text-xs font-normal text-muted-foreground">{columnDeadlineText(column.doc.deadline, now)}</span>
      {column.deadlinePassed ? <span className="block text-xs font-medium text-amber-800">{COLUMN_OVERDUE_TEXT}</span> : null}
      <span className="block text-xs font-normal text-muted-foreground">{approvedCountText(column)}</span>
    </>
  );
}

function BoardTable({ board, showFiles, now, highlightDocumentId, highlightGroupId, onOpenCell }: PartProps) {
  return (
    <div className="relative max-h-[70vh] w-full overflow-auto rounded-md border" data-testid="documents-table">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">団体ごとの提出の状況</caption>
        <thead className="sticky top-0 z-20 bg-background">
          <tr>
            <th scope="col" className="sticky left-0 z-30 min-w-40 border-b bg-background px-2 py-2 text-left align-bottom font-medium">
              団体
            </th>
            {board.columns.map((column) => (
              <th
                key={column.doc.id}
                scope="col"
                data-testid="documents-col"
                data-document-id={column.doc.id}
                className={cn('min-w-36 border-b px-2 py-2 text-left align-bottom', column.doc.id === highlightDocumentId && 'bg-amber-50')}
              >
                <ColumnHeading column={column} now={now} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {board.rows.map((group) => {
            const rowHighlighted = group.id === highlightGroupId;
            return (
              <tr key={group.id} data-testid="documents-row" data-group-id={group.id}>
                <th
                  scope="row"
                  className={cn('sticky left-0 z-10 border-b bg-background px-2 py-1 text-left font-normal', rowHighlighted && 'bg-amber-50')}
                >
                  <span className="block font-medium [overflow-wrap:anywhere]">{group.name}</span>
                  <span className="block text-xs text-muted-foreground">{CATEGORY_LABELS[group.category]}</span>
                </th>
                {board.columns.map((column) => (
                  <td
                    key={column.doc.id}
                    className={cn('border-b px-1 py-1 align-top', (rowHighlighted || column.doc.id === highlightDocumentId) && 'bg-amber-50/60')}
                  >
                    <CellButton
                      board={board}
                      group={group}
                      column={column}
                      showFiles={showFiles}
                      highlighted={rowHighlighted || column.doc.id === highlightDocumentId}
                      onOpenCell={onOpenCell}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CellButton({
  board,
  group,
  column,
  showFiles,
  highlighted,
  onOpenCell,
}: {
  board: DocumentsBoard;
  group: BoardGroupRow;
  column: BoardColumn;
  showFiles: boolean;
  highlighted: boolean;
  onOpenCell: (documentId: string, groupId: string) => void;
}) {
  const cell = boardCell(board, column.doc.id, group.id);
  if (!cell) {
    // その団体が対象でない（押せない「—」）
    return (
      <span
        data-testid="documents-cell"
        data-document-id={column.doc.id}
        data-group-id={group.id}
        data-status="none"
        data-late="false"
        data-proxy="false"
        data-paper="false"
        data-overdue="false"
        data-dimmed="false"
        data-highlighted={bool(highlighted)}
        className="block px-2 py-1.5 text-muted-foreground"
      >
        <span aria-hidden>—</span>
        <span className="sr-only">対象でない</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="documents-cell"
      data-document-id={cell.documentId}
      data-group-id={cell.groupId}
      data-status={cell.marks.status}
      data-late={bool(cell.marks.late)}
      data-proxy={bool(cell.marks.proxy)}
      data-paper={bool(cell.marks.paper)}
      data-overdue={bool(cell.marks.overdue)}
      data-dimmed={bool(!cell.matches)}
      data-highlighted={bool(highlighted)}
      aria-label={cellLabel(group.name, column.doc.title, cell)}
      onClick={() => onOpenCell(cell.documentId, cell.groupId)}
      className={cn(
        'flex w-full min-w-28 flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        !cell.matches && 'opacity-40',
      )}
    >
      <DocumentStatusBadge status={cell.marks.status} labels={SOUMU_STATUS_LABELS} />
      <CellMarks cell={cell} />
      <CellFiles show={showFiles} cell={cell} />
    </button>
  );
}

function BoardList({ board, showFiles, now, highlightDocumentId, highlightGroupId, onOpenCell }: PartProps) {
  const groups = new Map(board.rows.map((g) => [g.id, g]));
  return (
    <div data-testid="documents-list" className="space-y-4">
      {boardList(board).map(({ column, cells }) => {
        const headingId = `documents-list-${column.doc.id}`;
        return (
          <section
            key={column.doc.id}
            data-testid="documents-list-document"
            data-document-id={column.doc.id}
            aria-labelledby={headingId}
            className={cn('scroll-mt-20 rounded-lg border', column.doc.id === highlightDocumentId && 'ring-2 ring-amber-300')}
          >
            <header id={headingId} className="space-y-0.5 border-b px-3 py-2 text-sm">
              <ColumnHeading column={column} now={now} />
            </header>
            <ul className="divide-y">
              {cells.map((cell) => {
                const group = groups.get(cell.groupId);
                if (!group) return null;
                return (
                  <li key={cell.groupId}>
                    <button
                      type="button"
                      data-testid="documents-list-item"
                      data-document-id={cell.documentId}
                      data-group-id={cell.groupId}
                      data-status={cell.marks.status}
                      aria-label={cellLabel(group.name, column.doc.title, cell)}
                      onClick={() => onOpenCell(cell.documentId, cell.groupId)}
                      className={cn(
                        'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        !cell.matches && 'opacity-40',
                        cell.groupId === highlightGroupId && 'bg-amber-50',
                      )}
                    >
                      <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{group.name}</span>
                      <span className="flex flex-wrap items-center gap-1">
                        <DocumentStatusBadge status={cell.marks.status} labels={SOUMU_STATUS_LABELS} />
                        <CellMarks cell={cell} />
                        <CellFiles show={showFiles} cell={cell} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
