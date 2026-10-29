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

/**
 * 団体・場所・品目を名前で選ぶ（cmdk の Combobox。画面の設計 1.4。T09a）。
 * group（区分・建物など）ごとに見出しを分け、名前・group・keywords で絞れる。並びは渡した順（sort_order → 名前 → id で並べて渡す）。
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
  const selected = options.find((o) => o.id === value) ?? null;
  const groups = useMemo(() => {
    const m = new Map<string, EntityOption[]>();
    for (const o of options) {
      const k = o.group ?? '';
      const list = m.get(k);
      if (list) list.push(o);
      else m.set(k, [o]);
    }
    return [...m.entries()];
  }, [options]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <Command>
          <CommandInput placeholder={searchPlaceholder} aria-label={`${label}を${searchPlaceholder}`} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {allowClear ? (
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
                    keywords={[o.name, ...(o.group ? [o.group] : []), ...(o.keywords ?? [])]}
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
