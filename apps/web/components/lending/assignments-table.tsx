'use client';

// 割り当ての表（04「備品と割り当て」の割り当ての表と編集、notes/T21.md「画面の約束」4。T21・D-57）。
// - 行は団体（区分 → 並び → 名前 → id）。既定は申請・割り当て・記録のどれかがある団体（と未保存の変更のある団体）だけで、「すべての団体」
//   （`?view=all`）でその年度の全部。区分で絞れる（`?category=`）。団体名の横に使用場所と屋外の印。
// - 列は備品ごとに「申請｜割り当て」（閲覧のみは割り当てだけ）。セルの印：unassigned（申請が1以上で割り当てがない）・differs（申請と
//   違う）・same・empty（申請も割り当てもない）と、未保存の変更。
// - 部門長以上で確定前・終了でない年度は、割り当てのセルが数の欄（0〜10000。空にすると未入力に戻す）。備品の列の見出しに「申請どおりに入れる」。
import type { GroupCategory } from '@gaapp/shared';
import { GROUP_CATEGORIES } from '@gaapp/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AssignmentEditMap, LendingBoardData } from '@/lib/data/lending';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cellKey } from '@/lib/modules/lending/counts';
import { LENDING_FORM_MESSAGES, parseAssignmentCell } from '@/lib/schemas/lending';
import { cn } from '@/lib/utils';
import { GroupPlace, groupDisplayName } from './common';

/** 表の絞り込み（URL の `?view=all`・`?category=`） */
export interface AssignmentFilter {
  all: boolean;
  category: GroupCategory | null;
}

/** URL のクエリから絞り込みを読む（知らない値は既定） */
export function parseAssignmentFilter(params: { get(name: string): string | null }): AssignmentFilter {
  const c = params.get('category');
  return {
    all: params.get('view') === 'all',
    category: c && (GROUP_CATEGORIES as readonly string[]).includes(c) ? (c as GroupCategory) : null,
  };
}

/** 絞り込み → `/lending` の URL */
export function lendingHref(f: AssignmentFilter): string {
  const q = new URLSearchParams();
  if (f.all) q.set('view', 'all');
  if (f.category) q.set('category', f.category);
  const s = q.toString();
  return s ? `/lending?${s}` : '/lending';
}

/** セルの印 */
export type CellState = 'unassigned' | 'differs' | 'same' | 'empty';

/**
 * セルの印（申請は総務だけ。閲覧のみ〔request が undefined で、申請を読まない〕は empty か same）。value は未保存の変更があればその数
 * （null は未入力）、なければ DB の割り当て。
 */
export function cellState(request: number | undefined, value: number | null, soumu: boolean): CellState {
  if (!soumu) return value === null ? 'empty' : 'same';
  const r = request ?? 0;
  if (value === null) return r >= 1 ? 'unassigned' : 'empty';
  return value === r ? 'same' : 'differs';
}

export interface AssignmentsTableProps {
  data: LendingBoardData;
  /** 申請の列を出すか（総務） */
  soumu: boolean;
  /** 割り当てを直せるか（部門長以上・確定前・終了でない） */
  editable: boolean;
  edits: AssignmentEditMap;
  onEdit: (groupId: string, itemId: string, count: number | null) => void;
  onFill: (itemId: string) => void;
  filter: AssignmentFilter;
  onFilterChange: (next: AssignmentFilter) => void;
}

export function AssignmentsTable({ data, soumu, editable, edits, onEdit, onFill, filter, onFilterChange }: AssignmentsTableProps) {
  const categoryId = useId();
  const requests = new Map((data.requests ?? []).map((r) => [cellKey(r.group_id, r.lending_item_id), r.count]));
  const assignments = new Map(data.assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a.count]));
  const used = new Set<string>([...(data.requests ?? []), ...data.assignments, ...(data.records ?? [])].map((r) => r.group_id));
  for (const key of edits.keys()) used.add(key.split(':')[0] ?? '');
  const rows = data.groups.filter((g) => (filter.all || used.has(g.id)) && (!filter.category || g.category === filter.category));
  const items = data.items;

  return (
    <section aria-labelledby="lending-assignments-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h2 id="lending-assignments-heading" className="text-lg font-semibold">
          団体ごとの割り当て
        </h2>
        <div className="flex items-center gap-2 print:hidden">
          <Checkbox
            id={`${categoryId}-all`}
            data-testid="lending-view-all"
            checked={filter.all}
            onCheckedChange={(v) => onFilterChange({ ...filter, all: v === true })}
          />
          <Label htmlFor={`${categoryId}-all`} className="font-normal">
            {/* 「入れる」の説明は直せる人だけ（読むだけの総務部門員・閲覧のみ・終了した年度・確定中には出さない。撮影で見つけた） */}
            {editable ? 'すべての団体（申請のない企業・休憩所などにも入れる）' : 'すべての団体'}
          </Label>
        </div>
        <label className="flex items-center gap-2 text-sm print:hidden">
          <span className="text-muted-foreground">区分</span>
          <select
            data-testid="lending-category-filter"
            className="h-8 rounded-md border bg-background px-2"
            value={filter.category ?? ''}
            onChange={(e) => onFilterChange({ ...filter, category: (e.target.value || null) as GroupCategory | null })}
          >
            <option value="">すべて</option>
            {GROUP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? null : rows.length === 0 ? (
        <EmptyState
          title={filter.all || filter.category ? '条件に合う団体はありません' : '申請・割り当て・記録のある団体はまだありません'}
          description={!filter.all && editable ? '「すべての団体」にすると、申請のない団体にも割り当てられます。' : undefined}
        />
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border">
          <table data-testid="lending-assignments" className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th rowSpan={soumu ? 2 : 1} className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium">
                  団体
                </th>
                {items.map((it) => (
                  <th key={it.id} colSpan={soumu ? 2 : 1} className="border-l px-2 py-2 text-center font-medium">
                    <div className="text-foreground">{it.name}</div>
                    {editable && soumu ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className="mt-1 print:hidden"
                        data-testid="lending-fill-requested"
                        data-item-id={it.id}
                        onClick={() => onFill(it.id)}
                      >
                        申請どおりに入れる
                      </Button>
                    ) : null}
                  </th>
                ))}
              </tr>
              {soumu ? (
                <tr>
                  {items.map((it) => [
                    <th key={`${it.id}-r`} className="border-l px-2 py-1 text-right font-normal">
                      申請
                    </th>,
                    <th key={`${it.id}-a`} className="px-2 py-1 text-right font-normal">
                      割り当て
                    </th>,
                  ])}
                </tr>
              ) : null}
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} data-testid="lending-assignment-row" data-group-id={g.id} className="border-t">
                  <th scope="row" className="sticky left-0 z-[1] bg-background px-3 py-2 text-left font-normal">
                    <div className="font-medium [overflow-wrap:anywhere]">{groupDisplayName(g)}</div>
                    <GroupPlace group={g} />
                  </th>
                  {items.map((it) => {
                    const key = cellKey(g.id, it.id);
                    const request = requests.get(key);
                    const edit = edits.get(key);
                    const db = assignments.get(key);
                    const value = edit ? edit.count : (db ?? null);
                    const state = cellState(request, value, soumu);
                    const label = `${groupDisplayName(g)}の${it.name}の割り当て`;
                    return [
                      soumu ? (
                        <td key={`${it.id}-r`} className="border-l px-2 py-1 text-right tabular-nums text-muted-foreground">
                          {request === undefined ? '—' : request}
                        </td>
                      ) : null,
                      <td
                        key={`${it.id}-a`}
                        data-testid="lending-cell"
                        data-group-id={g.id}
                        data-item-id={it.id}
                        data-state={state}
                        data-unsaved={edit ? 'true' : undefined}
                        className={cn(
                          'px-2 py-1 text-right tabular-nums',
                          !soumu && 'border-l',
                          state === 'unassigned' && 'bg-destructive/10',
                          state === 'differs' && 'text-amber-800',
                          edit && 'bg-amber-100',
                        )}
                      >
                        {editable ? (
                          <CellInput value={value} label={label} invalid={state === 'unassigned'} onCommit={(n) => onEdit(g.id, it.id, n)} />
                        ) : value === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          value
                        )}
                      </td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 割り当てのセルの数の欄（入力中は文字のまま持ち、確定〔blur・Enter〕で数にする。空は未入力に戻す） */
function CellInput({ value, label, invalid, onCommit }: { value: number | null; label: string; invalid: boolean; onCommit: (n: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const n = parseAssignmentCell(text);
    setText(null);
    if (n === undefined) {
      toast.error(LENDING_FORM_MESSAGES.count);
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Input
      data-testid="lending-cell-input"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="ml-auto h-8 w-16 text-right tabular-nums"
      inputMode="numeric"
      autoComplete="off"
      value={text ?? (value === null ? '' : String(value))}
      placeholder="—"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') setText(null);
      }}
    />
  );
}
