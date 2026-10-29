'use client';

import { MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import { parseCount } from '@/components/common/count-stepper';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatShortDateTime } from '@/lib/datetime';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cellKey, rewriteTargetOf, shownCount, type MatrixRow, type PendingCells, type RequestMatrix } from '@/lib/data/requests';
import { MAX_COUNT } from '@gaapp/shared';
import { cn } from '@/lib/utils';

/** セルの印（保存の結果）：conflict（ほかの人が先に変えた。読み直した値）・error（保存できなかった。入力は残す） */
export type CellMark = 'conflict' | 'error';

const MARK_TEXT: Record<CellMark, string> = {
  conflict: 'ほかの人が先に変えました。読み直した値です',
  error: '保存できませんでした',
};

/**
 * 申請一覧の表（団体 × 品目。画面の設計 3.6。T11）。団体名の列を固定し、表の中だけを横にスクロールする。
 * 区分で申請できない品目のセルは「—」。0 でない申請が残っていれば灰色で出して印をつける（管理者は 0 にできる）。
 */
export function RequestsTable({
  matrix,
  pending,
  marks,
  totals,
  editable,
  busy = false,
  admin,
  onCellChange,
  onProxy,
  onMarkSubmitted,
}: {
  matrix: RequestMatrix;
  pending: PendingCells;
  marks: Readonly<Record<string, CellMark>>;
  totals: Readonly<Record<string, number>>;
  /** セルを編集できる（管理者で、確定中・終了でない） */
  editable: boolean;
  /** 保存中（セルを読み取り専用にし、代理入力・提出済みにする・0にするを押せなくする。列は隠さない） */
  busy?: boolean;
  admin: boolean;
  onCellChange: (row: MatrixRow, itemId: string, value: number) => void;
  onProxy: (row: MatrixRow) => void;
  onMarkSubmitted: (row: MatrixRow) => void;
}) {
  return (
    <div className="relative max-h-[70vh] w-full overflow-auto rounded-md border" data-testid="requests-table">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">団体ごとの申請の数</caption>
        <thead className="sticky top-0 z-20 bg-background">
          <tr>
            <th scope="col" className="sticky left-0 z-30 min-w-40 border-b bg-background px-2 py-2 text-left font-medium">
              団体
            </th>
            {matrix.items.map((item) => (
              <th key={item.id} scope="col" className="min-w-20 border-b px-2 py-2 text-right font-medium whitespace-nowrap">
                {item.name}
              </th>
            ))}
            <th scope="col" className="border-b px-2 py-2 text-left font-medium whitespace-nowrap">
              提出
            </th>
            <th scope="col" className="border-b px-2 py-2 text-left font-medium">
              備考
            </th>
            {admin && editable ? (
              <th scope="col" className="border-b px-2 py-2 text-left font-medium">
                <span className="sr-only">操作</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.group.id} data-row-id={row.group.id} data-group-name={row.group.name} className="group/row">
              <th scope="row" className="sticky left-0 z-10 border-b bg-background px-2 py-1 text-left font-normal">
                <div className="font-medium">{row.group.name}</div>
                <div className="text-xs text-muted-foreground">{CATEGORY_LABELS[row.group.category]}</div>
              </th>
              {matrix.items.map((item) => {
                const key = cellKey(row.group.id, item.id);
                const cell = row.cells[item.id]!;
                const value = shownCount(pending, row, item.id);
                // 未保存のセルは、今の表の数と同じでも色をつける（表が古いと DB の数と違うことがある。保存の読み直しで決まる）
                const isPending = Object.hasOwn(pending, key);
                const mark = marks[key];
                return (
                  <td
                    key={item.id}
                    data-cell={`${row.group.name}:${item.code}`}
                    data-pending={isPending || undefined}
                    data-mark={mark}
                    title={mark ? MARK_TEXT[mark] : undefined}
                    className={cn(
                      'border-b px-1 py-1 text-right tabular-nums',
                      isPending && 'bg-amber-50',
                      mark === 'conflict' && 'ring-2 ring-sky-400 ring-inset',
                      mark === 'error' && 'ring-2 ring-destructive ring-inset',
                    )}
                  >
                    {cell.requestable ? (
                      editable ? (
                        <CellInput
                          label={`${row.group.name}の${item.name}`}
                          value={value}
                          readOnly={busy}
                          onCommit={(v) => onCellChange(row, item.id, v)}
                        />
                      ) : (
                        <span className="px-2">{value}</span>
                      )
                    ) : cell.count > 0 || isPending ? (
                      <NotRequestableCell
                        value={value}
                        note={rewriteTargetOf(item, matrix.items) ? `${rewriteTargetOf(item, matrix.items)!.name}として扱う` : '申請できない品目（E006）'}
                        canZero={editable && value > 0}
                        disabled={busy}
                        onZero={() => onCellChange(row, item.id, 0)}
                      />
                    ) : (
                      <span className="px-2 text-muted-foreground" aria-label="申請できない品目">
                        —
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="border-b px-2 py-1 whitespace-nowrap" data-testid="submitted-cell">
                {row.submission?.submitted_at ? (
                  formatShortDateTime(row.submission.submitted_at)
                ) : (
                  <span className="font-medium text-amber-700">未提出</span>
                )}
              </td>
              <td className="border-b px-2 py-1">
                {row.note ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`${row.group.name}の備考を見る`}>
                        <MessageSquareText aria-hidden className="text-sky-700" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="max-w-sm text-sm whitespace-pre-wrap">{row.note}</PopoverContent>
                  </Popover>
                ) : null}
              </td>
              {admin && editable ? (
                <td className="border-b px-2 py-1 whitespace-nowrap">
                  <div className="flex gap-1">
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => onProxy(row)}>
                      代理入力
                    </Button>
                    {!row.submitted ? (
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => onMarkSubmitted(row)}>
                        提出済みにする
                      </Button>
                    ) : null}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot className="sticky bottom-0 z-20 bg-background">
          <tr>
            <th scope="row" className="sticky left-0 z-30 border-t bg-background px-2 py-2 text-left font-medium">
              合計
            </th>
            {matrix.items.map((item) => (
              <td key={item.id} className="border-t px-2 py-2 text-right font-medium tabular-nums" data-total={item.code}>
                {totals[item.id] ?? 0}
              </td>
            ))}
            <td className="border-t" colSpan={admin && editable ? 3 : 2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** 申請できない品目に残っている数（灰色と印。印の説明は title と読み上げに。管理者は 0 にできる） */
function NotRequestableCell({
  value,
  note,
  canZero,
  disabled,
  onZero,
}: {
  value: number;
  note: string;
  canZero: boolean;
  disabled: boolean;
  onZero: () => void;
}) {
  return (
    <span className="inline-flex items-center justify-end gap-1 px-1 whitespace-nowrap text-muted-foreground" title={note}>
      <span>{value}</span>
      <span aria-hidden className="rounded bg-muted px-1 text-[10px]">
        ※
      </span>
      <span className="sr-only">（{note}）</span>
      {canZero ? (
        <Button size="xs" variant="ghost" className="h-6 px-1 text-xs" disabled={disabled} onClick={onZero}>
          0にする
        </Button>
      ) : null}
    </span>
  );
}

/** 表のセルの数の入力（入力中は文字を持ち、確定（blur・Enter）で 0〜10000 の整数にする。数字でなければ元に戻す） */
function CellInput({
  label,
  value,
  readOnly,
  onCommit,
}: {
  label: string;
  value: number;
  readOnly: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    if (readOnly) {
      setText(null);
      return;
    }
    const n = parseCount(text, 0, MAX_COUNT);
    setText(null);
    if (n !== null && n !== value) onCommit(n);
  };
  return (
    <Input
      aria-label={label}
      className="h-8 w-16 px-1 text-right tabular-nums"
      inputMode="numeric"
      autoComplete="off"
      readOnly={readOnly}
      value={text ?? String(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setText(null);
        }
      }}
    />
  );
}
