'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface EntityOption {
  id: string;
  name: string;
  /** まとまりの見出し（団体の区分、場所の建物・種類など）。名前と同じく検索に効く */
  group?: string;
  /** 検索に効く別の言葉（別名など） */
  keywords?: readonly string[];
  disabled?: boolean;
}

/** 検索の比べ方をそろえる（全角・半角〔NFKC〕と大文字・小文字の違いを無視する） */
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * 選択肢が検索の言葉に当たるか。名前・group・keywords だけを見る（id の UUID は見ない）。
 * 空白で区切った言葉が全部（部分一致で）含まれていれば当たり。空なら全部当たる。
 */
export function matchesEntity(option: EntityOption, search: string): boolean {
  const terms = normalize(search).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalize([option.name, option.group ?? '', ...(option.keywords ?? [])].join('\n'));
  return terms.every((t) => haystack.includes(t));
}

/**
 * 団体・場所・品目を名前で選ぶ（cmdk の Combobox。画面の設計 1.4。T09a）。
 * group（区分・建物など）ごとに見出しを分け、名前・group・keywords で絞れる。並びは渡した順（sort_order → 名前 → id で並べて渡す）。
 * 絞り込みは cmdk の既定（value〔ここでは id〕も含めたあいまい一致と点の順の並べ替え）を使わず、matchesEntity で自前で行う。
 *
 * @example
 * <EntitySelect label="団体" options={groups.map((g) => ({ id: g.id, name: g.name, group: CATEGORY_LABELS[g.category] }))}
 *   value={groupId} onChange={setGroupId} />
 */
export function EntitySelect({
  label,
  options,
  value,
  onChange,
  placeholder = '選んでください',
  searchPlaceholder = '名前で探す',
  emptyText = '見つかりません',
  allowClear = false,
  disabled = false,
  className,
}: {
  /** 読み上げの名前（「団体」など） */
  label: string;
  options: readonly EntityOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** 「選ばない」を出す */
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = options.find((o) => o.id === value) ?? null;
  const searching = normalize(search).trim() !== '';
  const groups = useMemo(() => {
    const m = new Map<string, EntityOption[]>();
    for (const o of options) {
      if (!matchesEntity(o, search)) continue;
      const k = o.group ?? '';
      const list = m.get(k);
      if (list) list.push(o);
      else m.set(k, [o]);
    }
    return [...m.entries()];
  }, [options, search]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch('');
  };

  const pick = (id: string | null) => {
    onChange(id);
    changeOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !selected && 'text-muted-foreground', className)}
        >
          <span className="truncate">{selected ? selected.name : placeholder}</span>
          <ChevronsUpDown aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
            aria-label={`${label}を${searchPlaceholder}`}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {allowClear && !searching ? (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={() => pick(null)}>
                  選ばない
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map(([g, list]) => (
              <CommandGroup key={g || '_'} heading={g || undefined}>
                {list.map((o) => (
                  <CommandItem
                    key={o.id}
                    value={o.id}
                    disabled={o.disabled}
                    onSelect={() => pick(o.id)}
                  >
                    <Check aria-hidden className={cn('size-4', o.id === value ? 'opacity-100' : 'opacity-0')} />
                    {o.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
