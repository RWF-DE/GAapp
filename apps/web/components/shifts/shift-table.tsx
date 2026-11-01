'use client';

// シフト表の表（/shifts の中身。04「シフト表」の表・ますに出すもの・合計・読み上げ・足りないますを目立たせる、notes/T20.md「画面の約束」4・13。
// T20・D-56）。行は時間枠、列は持ち場。PC（md 以上）は見出しつきの table、狭い幅（スマホ）は同じ table を時間枠ごとのカードに並べ替える
// （CSS だけで。同じ表を2回描かない。列の見出しは隠し、ますの中に持ち場の名前を出す）。
// - ます：割り当てた人（表示名の順。自分は目立たせる。部門長以上の表では閲覧のみに変わった人に「総務でない人」）と「2/3」、足りなければ
//   「あと1人」（注意の色と文字）、多ければ「+1」、必要人数 0 は「2人」、ますのない所は「—」。足りない・多いは色だけで表さない。
// - 部門長以上（終了した年度を除く）はますを押すとますのダイアログ、時間枠の行と持ち場の列に「直す」「削除」。総務部門員は読むだけ。
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  cellAriaLabel,
  cellCountText,
  cellDiffText,
  isShortCell,
  totalText,
  type BoardDuty,
  type BoardSlot,
  type ShiftCell,
  type ShiftTable as ShiftTableModel,
} from '@/lib/modules/shifts/board';
import { NAME_UNKNOWN } from '@/lib/modules/shifts/names';
import { cn } from '@/lib/utils';

/** 閲覧のみに変わった人（部門長以上の表だけ。数に入れない） */
export const NOT_SOUMU_LABEL = '総務でない人';

export interface ShiftTableProps {
  table: ShiftTableModel;
  now: number;
  /** 足りないますだけを目立たせる（`?filter=short`） */
  filterShort: boolean;
  /** ますを押せる・時間枠と持ち場を直せる（部門長以上で、終了した年度でない） */
  writable: boolean;
  onCell?: (cell: ShiftCell) => void;
  onEditSlot?: (slot: BoardSlot) => void;
  onDeleteSlot?: (slot: BoardSlot) => void;
  onEditDuty?: (duty: BoardDuty) => void;
  onDeleteDuty?: (duty: BoardDuty) => void;
}

const STATE_CLASS: Record<ShiftCell['state'], string> = {
  none: 'text-muted-foreground',
  ok: '',
  short: 'bg-amber-50',
  over: 'bg-sky-50',
};

export function ShiftTable({ table, now, filterShort, writable, onCell, onEditSlot, onDeleteSlot, onEditDuty, onDeleteDuty }: ShiftTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card max-md:overflow-visible max-md:border-0 max-md:bg-transparent">
      <table data-testid="shifts-table" className="w-full border-collapse text-sm max-md:block">
        <caption className="sr-only">シフト表（行は時間枠、列は持ち場）</caption>
        <thead className="bg-muted/40 max-md:hidden">
          <tr>
            <th scope="col" className="w-36 border-b px-3 py-2 text-left font-medium">
              時間枠
            </th>
            {table.columns.map((d) => (
              <th key={d.id} scope="col" className="min-w-36 border-b border-l px-3 py-2 text-left align-top font-medium">
                <span className="block [overflow-wrap:anywhere]">{d.name}</span>
                {d.place ? <span className="block text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{d.place}</span> : null}
                {writable ? (
                  <span className="mt-1 flex gap-1">
                    <Button size="icon" variant="ghost" className="size-7" data-testid="shift-duty-edit" aria-label={`持ち場「${d.name}」を直す`} onClick={() => onEditDuty?.(d)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      data-testid="shift-duty-delete"
                      aria-label={`持ち場「${d.name}」を削除`}
                      onClick={() => onDeleteDuty?.(d)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                ) : null}
              </th>
            ))}
            <th scope="col" className="w-20 border-b border-l px-3 py-2 text-right font-medium">
              合計
            </th>
          </tr>
        </thead>
        <tbody className="max-md:block max-md:space-y-3">
          {table.rows.map((row) => (
            <tr key={row.slot.id} data-testid="shift-row" data-slot-id={row.slot.id} className="max-md:block max-md:rounded-lg max-md:border max-md:bg-card">
              <th scope="row" className="border-b px-3 py-2 text-left align-top font-semibold tabular-nums max-md:flex max-md:items-center max-md:gap-2 max-md:border-b">
                <span>{row.label}</span>
                {writable ? (
                  <span className="mt-1 flex gap-1 max-md:mt-0 max-md:ml-auto">
                    <Button size="icon" variant="ghost" className="size-7" data-testid="shift-slot-edit" aria-label={`時間枠 ${row.label} を直す`} onClick={() => onEditSlot?.(row.slot)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      data-testid="shift-slot-delete"
                      aria-label={`時間枠 ${row.label} を削除`}
                      onClick={() => onDeleteSlot?.(row.slot)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                ) : null}
              </th>
              {row.cells.map((cell) => (
                <ShiftCellView
                  key={cell.duty.id}
                  cell={cell}
                  rowLabel={row.label}
                  writable={writable}
                  dimmed={filterShort && !isShortCell(cell, now)}
                  highlighted={filterShort && isShortCell(cell, now)}
                  onClick={() => onCell?.(cell)}
                />
              ))}
              <td data-testid="shift-row-total" className="border-b border-l px-3 py-2 text-right align-top tabular-nums max-md:flex max-md:justify-between max-md:border-l-0">
                <span className="md:hidden text-muted-foreground">合計</span>
                {totalText(row.total)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-muted/30 max-md:hidden">
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-medium">
              合計
            </th>
            {table.columns.map((d, k) => (
              <td key={d.id} data-testid="shift-col-total" data-duty-id={d.id} className="border-l px-3 py-2 tabular-nums">
                {totalText(table.columnTotals[k]!)}
              </td>
            ))}
            <td className="border-l px-3 py-2 text-right tabular-nums">
              {totalText(
                table.columnTotals.reduce((t, c) => ({ count: t.count + c.count, required: t.required + c.required }), { count: 0, required: 0 }),
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ShiftCellView({
  cell,
  rowLabel,
  writable,
  dimmed,
  highlighted,
  onClick,
}: {
  cell: ShiftCell;
  rowLabel: string;
  writable: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onClick: () => void;
}) {
  const diff = cellDiffText(cell);
  const body = (
    <>
      <span className="font-medium text-muted-foreground md:hidden">{cell.duty.name}</span>
      {cell.members.length > 0 ? (
        <ul className="space-y-0.5">
          {cell.members.map((p) => (
            <li
              key={p.userId}
              data-testid="shift-cell-member"
              data-user-id={p.userId}
              data-me={p.me ? 'true' : undefined}
              data-not-soumu={p.soumu ? undefined : 'true'}
              className={cn('[overflow-wrap:anywhere]', p.me && 'rounded bg-primary/10 px-1 font-semibold text-primary', !p.soumu && 'text-muted-foreground line-through')}
            >
              {p.name ?? NAME_UNKNOWN}
              {p.me ? <span className="sr-only">（あなた）</span> : null}
              {!p.soumu ? <span className="ml-1 text-xs no-underline">（{NOT_SOUMU_LABEL}）</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="flex flex-wrap items-center gap-1.5">
        <span data-testid="shift-cell-count" className="tabular-nums">
          {cellCountText(cell)}
        </span>
        {cell.state === 'short' ? (
          <span data-testid="shift-cell-short" className="rounded bg-amber-200 px-1.5 text-xs font-semibold text-amber-950">
            {diff}
          </span>
        ) : null}
        {cell.state === 'over' ? (
          <span data-testid="shift-cell-over" className="rounded bg-sky-200 px-1.5 text-xs font-semibold text-sky-950">
            {diff}
          </span>
        ) : null}
      </span>
    </>
  );
  const common = {
    'data-testid': 'shift-cell',
    'data-slot-id': cell.slot.id,
    'data-duty-id': cell.duty.id,
    'data-state': cell.state,
    'data-short-highlight': highlighted ? 'true' : undefined,
  } as const;
  const tdClass = cn(
    'border-b border-l align-top max-md:block max-md:border-l-0',
    STATE_CLASS[cell.state],
    dimmed && 'opacity-40',
    highlighted && 'ring-2 ring-inset ring-amber-400',
  );
  if (writable) {
    return (
      <td {...common} className={tdClass}>
        <button
          type="button"
          className="flex h-full min-h-14 w-full flex-col items-start gap-1 px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={cellAriaLabel(cell, rowLabel)}
          onClick={onClick}
        >
          {body}
        </button>
      </td>
    );
  }
  return (
    <td {...common} className={cn(tdClass, 'px-3 py-2')}>
      <div className="flex flex-col items-start gap-1">{body}</div>
    </td>
  );
}
