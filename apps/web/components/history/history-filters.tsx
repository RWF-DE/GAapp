'use client';

// 履歴の絞り込み（表〔複数〕・団体・期間・した人。画面の設計 3.12。T14）。値は URL に入れる（親が router.replace する）。
import { ChevronsUpDown, X } from 'lucide-react';
import { useId } from 'react';
import { EntitySelect, type EntityOption } from '@/components/common/entity-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AUDIT_TABLES,
  EMPTY_FILTER,
  hasFilter,
  isDateParam,
  NAME_UNKNOWN,
  OUTSIDE_LABEL,
  OUTSIDE_USER,
  tableLabel,
  type AuditTable,
  type HistoryFilter,
  type HistoryOptions,
} from '@/lib/data/history';
import { CATEGORY_LABELS, labelOf } from '@/lib/labels';

/** 表の選び（複数。チェックボックスの一覧） */
function TableSelect({
  value,
  onChange,
}: {
  value: readonly AuditTable[];
  onChange: (update: (tables: readonly AuditTable[]) => AuditTable[]) => void;
}) {
  const picked = new Set(value);
  // 続けて押したときに前の選びを落とさないよう、今の選び（親が持つ最新）から作る
  const toggle = (t: AuditTable, on: boolean) =>
    onChange((tables) => {
      const next = new Set(tables);
      if (on) next.add(t);
      else next.delete(t);
      return AUDIT_TABLES.filter((x) => next.has(x));
    });
  const summary = value.length === 0 ? 'すべての表' : value.map(tableLabel).join('・');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-label="表" className="w-full justify-between font-normal">
          <span className="truncate">{summary}</span>
          <ChevronsUpDown aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">表（複数選べます）</legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {AUDIT_TABLES.map((t) => (
              <TableCheck key={t} table={t} checked={picked.has(t)} onChange={(on) => toggle(t, on)} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">場所・品目・距離は年度をまたぐ表です（年度のない記録も出します）。</p>
          {value.length > 0 ? (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => onChange(() => [])}>
              表の選びを消す
            </Button>
          ) : null}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

function TableCheck({ table, checked, onChange }: { table: AuditTable; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="font-normal">
        {tableLabel(table)}
      </Label>
    </div>
  );
}

export function HistoryFilters({
  filter,
  options,
  onChange,
}: {
  filter: HistoryFilter;
  options: HistoryOptions;
  /** 絞り込みを変える（URL の反映を待たずに続けて変えても前の変更を落とさないよう、最新の絞り込みから作る関数を渡す） */
  onChange: (update: (f: HistoryFilter) => HistoryFilter) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const groupOptions: EntityOption[] = options.groups.map((g) => ({
    id: g.id,
    name: g.name,
    group: labelOf(CATEGORY_LABELS, g.category, g.category),
  }));
  const userOptions: EntityOption[] = [
    ...options.members.map((m) => ({ id: m.userId, name: m.displayName ?? `${NAME_UNKNOWN}（${m.userId.slice(0, 8)}）` })),
    { id: OUTSIDE_USER, name: OUTSIDE_LABEL, group: 'アプリの外' },
  ];
  // URL の団体・した人が選択肢にない（消えた団体・メンバーでない人）ときも、選んでいることが分かるように足す
  if (filter.groupId && !groupOptions.some((o) => o.id === filter.groupId)) {
    groupOptions.push({ id: filter.groupId, name: '（今の年度にない団体）' });
  }
  if (filter.user && !userOptions.some((o) => o.id === filter.user)) {
    userOptions.push({ id: filter.user, name: `（メンバーでない人 ${filter.user.slice(0, 8)}）` });
  }
  const setDate = (key: 'from' | 'to', v: string) => onChange((f) => ({ ...f, [key]: isDateParam(v) ? v : null }));

  return (
    <section aria-label="絞り込み" className="mb-4 rounded-lg border p-4" data-testid="history-filters">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1">
          <span className="text-sm font-medium">表</span>
          <TableSelect value={filter.tables} onChange={(update) => onChange((f) => ({ ...f, tables: update(f.tables) }))} />
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">団体</span>
          <EntitySelect
            label="団体"
            options={groupOptions}
            value={filter.groupId}
            onChange={(groupId) => onChange((f) => ({ ...f, groupId }))}
            placeholder="すべての団体"
            allowClear
          />
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">期間（日付。その日を含む）</span>
          <div className="flex items-center gap-2">
            <Label htmlFor={fromId} className="sr-only">
              期間の始め
            </Label>
            <Input id={fromId} type="date" value={filter.from ?? ''} max={filter.to ?? undefined} onChange={(e) => setDate('from', e.target.value)} />
            <span aria-hidden>〜</span>
            <Label htmlFor={toId} className="sr-only">
              期間の終わり
            </Label>
            <Input id={toId} type="date" value={filter.to ?? ''} min={filter.from ?? undefined} onChange={(e) => setDate('to', e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">した人</span>
          <EntitySelect
            label="した人"
            options={userOptions}
            value={filter.user}
            onChange={(user) => onChange((f) => ({ ...f, user }))}
            placeholder="すべての人"
            allowClear
          />
        </div>
      </div>
      {hasFilter(filter) ? (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => onChange(() => EMPTY_FILTER)}>
          <X aria-hidden />
          絞り込みを消す
        </Button>
      ) : null}
    </section>
  );
}
