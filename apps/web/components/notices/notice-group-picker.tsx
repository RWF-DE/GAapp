'use client';

// 宛先の団体を選ぶ（お知らせを書く・編集のダイアログ。宛先が「指定の団体」のときだけ出す。04「お知らせ一覧」の書く、notes/T17.md
// 「後半（画面）の約束」4。T17）。その年度の団体を区分（模擬店・部門・企業・休憩所）ごとに、団体の並び（sort_order → 名前 → id）で
// チェックの一覧にする。「団体を探す」で名前と別名で絞る（EntitySelect と同じ比べ方。全角・半角と大文字・小文字の違いを無視する）。
// 選んだ id は団体の並びで返す（今の一覧にない id〔消えた団体〕は、チェックを変えたときに外れる。送るときもダイアログが外す）。
import { GROUP_CATEGORIES } from '@gaapp/shared';
import { useId, useMemo, useState } from 'react';
import { matchesEntity } from '@/components/common/entity-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { NoticeGroupOption } from '@/lib/data/notices';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function NoticeGroupPicker({
  groups,
  value,
  onChange,
  disabled = false,
  error,
}: {
  /** その年度の団体（団体の並び） */
  groups: readonly NoticeGroupOption[];
  /** 選んだ団体の id */
  value: readonly string[];
  /** 選んだ団体の id（団体の並び） */
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** 欄の誤り（宛先の団体） */
  error?: string;
}) {
  const [search, setSearch] = useState('');
  const base = useId();
  const selected = useMemo(() => new Set(value), [value]);
  const count = groups.filter((g) => selected.has(g.id)).length;
  const visible = groups.filter((g) => matchesEntity({ id: g.id, name: g.name, keywords: g.aliases }, search));
  const byCategory = GROUP_CATEGORIES.map((c) => ({ category: c, items: visible.filter((g) => g.category === c) })).filter((x) => x.items.length > 0);

  // チェックを変えたら、今の一覧の団体だけを団体の並びで返す
  const toggle = (id: string, on: boolean) => onChange(groups.filter((g) => (g.id === id ? on : selected.has(g.id))).map((g) => g.id));

  return (
    <fieldset
      data-testid="notice-group-picker"
      data-field="groupIds"
      className={cn('space-y-2 rounded-md border p-3', error && 'border-destructive')}
    >
      <legend className="px-1 text-sm font-medium">宛先の団体</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="団体を探す（名前・別名）"
          aria-label="団体を探す"
          className="h-8 min-w-0 flex-1 basis-48"
          disabled={disabled}
        />
        <span data-testid="notice-group-count" className="text-sm text-muted-foreground" aria-live="polite">
          {count} 団体を選んでいます
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([])} disabled={disabled || count === 0}>
          選択を外す
        </Button>
      </div>
      <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border bg-background p-2">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">この年度の団体がありません</p>
        ) : byCategory.length === 0 ? (
          <p className="text-sm text-muted-foreground">見つかりません</p>
        ) : (
          byCategory.map(({ category, items }) => (
            <div key={category} role="group" aria-labelledby={`${base}-${category}`} className="space-y-1">
              <p id={`${base}-${category}`} className="text-xs font-medium text-muted-foreground">
                {CATEGORY_LABELS[category]}
              </p>
              <ul className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
                {items.map((g) => {
                  const id = `${base}-g-${g.id}`;
                  return (
                    <li key={g.id} className="flex min-w-0 items-center gap-2">
                      <Checkbox id={id} checked={selected.has(g.id)} disabled={disabled} onCheckedChange={(c) => toggle(g.id, c === true)} />
                      <Label htmlFor={id} className="min-w-0 font-normal [overflow-wrap:anywhere]">
                        {g.name}
                      </Label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
      {error ? (
        <p data-field-error="groupIds" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
