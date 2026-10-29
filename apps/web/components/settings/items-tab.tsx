'use client';

// 品目のタブ（画面の設計 3.2「品目」。T09）。items は年度をまたぐ表。コードは作った後に変えない（ルールがコードで参照するため）。
// 削除は出さない（使われていれば消せず、フェーズ1で消す用途がない）。
import { zodResolver } from '@hookform/resolvers/zod';
import { GROUP_CATEGORIES } from '@gaapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable } from '@/components/common/data-table';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchItems, insertItem, matchesWritten, readItem, readItemByCode, updateItem } from '@/lib/data/settings';
import type { ItemRow } from '@/lib/db/types';
import { CATEGORY_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NAME_MAX } from '@/lib/schemas/common';
import { itemFormSchema, ITEM_CODE_MAX, joinAliases, type ItemFormInput, type ItemFormOutput } from '@/lib/schemas/settings';
import { Field, FormSheet, GlobalReadOnlyNote, settingsKeys, TabHeading, useLockedSave, useSettings, type LockedSaveRun } from './shared';

export function ItemsTab() {
  const { globalWritable } = useSettings();
  const itemsQ = useQuery({ queryKey: settingsKeys.items(), queryFn: () => fetchItems() });
  const [editing, setEditing] = useState<ItemRow | 'new' | null>(null);
  const queryClient = useQueryClient();

  const columns = useMemo<ColumnDef<ItemRow>[]>(
    () => [
      { accessorKey: 'code', header: 'コード', cell: ({ row }) => <span className="font-mono">{row.original.code}</span> },
      { accessorKey: 'name', header: '表示名' },
      { id: 'aliases', header: 'フォームでの表記', cell: ({ row }) => row.original.aliases.join('、') },
      {
        id: 'categories',
        header: '申請できる区分',
        cell: ({ row }) => row.original.requestable_categories.map((c) => CATEGORY_LABELS[c]).join('・') || '—',
      },
      { accessorKey: 'sort_order', header: '並び順', meta: { align: 'right' } },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          globalWritable ? (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                編集
              </Button>
            </div>
          ) : null,
      },
    ],
    [globalWritable],
  );

  return (
    <div>
      <TabHeading
        title="品目"
        description={
          <>
            品目の変更はすべての年度と、Excel の様式・振り分け画面のタブに効きます。コードは作った後に変えられません。
            <GlobalReadOnlyNote what="品目" />
          </>
        }
        actions={
          globalWritable ? (
            <Button onClick={() => setEditing('new')} data-testid="item-add">
              品目を足す
            </Button>
          ) : null
        }
      />
      <QueryState query={itemsQ} isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="品目がありません" />}>
        {(rows) => <DataTable columns={columns} data={rows} getRowId={(r) => r.id} caption="品目の一覧" />}
      </QueryState>
      <FormSheet
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? '品目を足す' : '品目を編集'}
        description="品目の変更はすべての年度に効きます。"
      >
        {editing !== null ? (
          <ItemForm
            item={editing === 'new' ? null : editing}
            onDone={async () => {
              setEditing(null);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.items() }),
                queryClient.invalidateQueries({ queryKey: ['year'] }),
              ]);
            }}
          />
        ) : null}
      </FormSheet>
    </div>
  );
}

function ItemForm({ item, onDone }: { item: ItemRow | null; onDone: () => Promise<void> }) {
  // 入力の元（更新で送る updated_at）。conflict の後は読み直した行にする（2.6 の (B1)。入力は残す）
  const [base, setBase] = useState(item);
  const form = useForm<ItemFormInput, unknown, ItemFormOutput>({
    resolver: zodResolver(itemFormSchema),
    defaultValues: {
      code: item?.code ?? '',
      name: item?.name ?? '',
      aliases: joinAliases(item?.aliases),
      requestable_categories: item ? [...item.requestable_categories] : [...GROUP_CATEGORIES],
      sort_order: String(item?.sort_order ?? 0),
    },
  });
  const { register, handleSubmit, formState, setValue, control } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const categories = useWatch({ control, name: 'requestable_categories' });

  // 入力（zod の後）から、送る・読み直す・比べる呼び出しを作る（保存と、読み直せなかった後の「読み直す」で同じものを使う）
  const callFor = (v: ItemFormOutput): LockedSaveRun<ItemRow> => {
    // 送る値（zod の後）。更新ではコードを送らない（作った後は変えない）。読み直した行もこの値で比べる
    const patch = { name: v.name, aliases: v.aliases, requestable_categories: v.requestable_categories, sort_order: v.sort_order };
    const values = { code: v.code, ...patch };
    const onSaved = async (earlier: boolean) => {
      toast.success(earlier ? `「${v.name}」は保存されていました` : base ? `「${v.name}」を保存しました` : `「${v.name}」を足しました`);
      form.reset(form.getValues());
      await onDone();
    };
    return base
      ? {
          write: () => updateItem(base, patch),
          reread: () => readItem(base.id),
          matches: (row) => matchesWritten(row, patch),
          baseVersion: base.updated_at,
          onRebase: (row) => row && setBase(row),
          onSaved,
        }
      : {
          write: () => insertItem(values),
          reread: () => readItemByCode(values.code),
          matches: (row) => matchesWritten(row, values),
          baseVersion: null,
          insert: true,
          onSaved,
        };
  };
  const locked = useLockedSave<ItemRow>({
    dataKeys: [queryKeys.items()],
    current: () => {
      const p = itemFormSchema.safeParse(form.getValues());
      return p.success ? callFor(p.data) : null;
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    setSaving(true);
    try {
      await locked.run(callFor(v));
    } finally {
      setSaving(false);
    }
  });
  const err = (k: keyof ItemFormInput) => formState.errors[k]?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="item-form">
      {locked.notice}
      <Field label="コード" error={err('code')} hint={base ? '作った後は変えられません（ルールがコードで参照するため）' : '半角の英小文字・数字・_（例 long_desk_2）'}>
        {(p) => <Input {...p} {...register('code')} readOnly={!!base} maxLength={ITEM_CODE_MAX} className="font-mono" />}
      </Field>
      <Field label="表示名" error={err('name')}>
        {(p) => <Input {...p} {...register('name')} maxLength={NAME_MAX} />}
      </Field>
      <Field label="フォームでの表記（別名。| で区切る）" error={err('aliases')}>
        {(p) => <Input {...p} {...register('aliases')} />}
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">申請できる区分</legend>
        <div className="flex flex-wrap gap-4">
          {GROUP_CATEGORIES.map((c) => {
            const id = `item-cat-${c}`;
            return (
              <div key={c} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={categories.includes(c)}
                  onCheckedChange={(on) =>
                    setValue(
                      'requestable_categories',
                      on === true ? GROUP_CATEGORIES.filter((x) => x === c || categories.includes(x)) : categories.filter((x) => x !== c),
                      { shouldDirty: true },
                    )
                  }
                />
                <Label htmlFor={id}>{CATEGORY_LABELS[c]}</Label>
              </div>
            );
          })}
        </div>
      </fieldset>
      <Field label="並び順" error={err('sort_order')}>
        {(p) => <Input {...p} {...register('sort_order')} inputMode="numeric" />}
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </form>
  );
}
