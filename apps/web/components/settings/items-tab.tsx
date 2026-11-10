'use client';

// 品目のタブ（画面の設計 3.2「品目」。T09）。items は年度をまたぐ表。コードは作った後に変えない（ルールがコードで参照するため）。
// 削除は出さない（使われていれば消せず、フェーズ1で消す用途がない）。
// 品目の画像（管理者。T23・D-61）：9 品目と備品（数えるだけ）の行に画像（共通の部品）と「画像を足す」「画像を替える」「画像を外す」。
// 足す・替えるは写真の欄（「撮る」と「写真を選ぶ」。作り直し・注意の文・順番は在庫入力の「新しく登録」と同じ）、外すは確かめの後に
// set_item_image(…, null)。替えた・外した前の画像は Storage から消す（lib/item-images/upload.ts）。送った・外した後は path と行の一覧
// （updated_at が進む）を読み直す（invalidateItemImagePaths）。備品を削除したら、そのフォルダの物を Storage から片付ける。
// 品目の表の下に「備品（数えるだけ）」の欄（管理者。T22・D-60）：count_items の名前・最初から出す・並びの編集と追加、数の行がない物の
// 削除（23503 は「数が入力された物は削除できません」）。保存は1行ずつの楽観ロック（useLockedSave）。
import { zodResolver } from '@hookform/resolvers/zod';
import { GROUP_CATEGORIES } from '@gaapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ItemImage } from '@/components/common/item-image';
import { ItemPhotoDialog } from '@/components/common/item-photo-field';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable } from '@/components/common/data-table';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  deleteCountItem,
  fetchCountItems,
  fetchItems,
  insertCountItem,
  insertItem,
  matchesWritten,
  readCountItem,
  readCountItemByName,
  readItem,
  readItemByCode,
  updateCountItem,
  updateItem,
} from '@/lib/data/settings';
import type { CountItemRow, ItemRow } from '@/lib/db/types';
import {
  itemImagePathsOptions,
  removeDeletedItemImages,
  removeItemImage,
  sendItemImage,
  useItemImageUrls,
  type ItemImageKind,
  type ItemImagePaths,
  type ItemImageUrls,
} from '@/lib/data/item-images';
import { CATEGORY_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NAME_MAX } from '@/lib/schemas/common';
import { COUNT_ITEM_NAME_MAX } from '@/lib/schemas/count-items';
import {
  countItemFormSchema,
  itemFormSchema,
  ITEM_CODE_MAX,
  joinAliases,
  type CountItemFormInput,
  type CountItemFormOutput,
  type ItemFormInput,
  type ItemFormOutput,
} from '@/lib/schemas/settings';
import {
  Field,
  FormSheet,
  GlobalReadOnlyNote,
  settingsKeys,
  TabHeading,
  useLockedSave,
  useSettings,
  useWriteErrorHandler,
  type LockedSaveRun,
} from './shared';

export function ItemsTab() {
  const { globalWritable } = useSettings();
  const itemsQ = useQuery({ queryKey: settingsKeys.items(), queryFn: () => fetchItems() });
  const [editing, setEditing] = useState<ItemRow | 'new' | null>(null);
  const queryClient = useQueryClient();
  const imagePaths = useQuery(itemImagePathsOptions('item')).data ?? NO_PATHS;
  const images = useItemImageUrls((itemsQ.data ?? []).map((r) => imagePaths.get(r.id)));
  const imageEdit = useImageEdit('item', imagePaths);

  const columns = useMemo<ColumnDef<ItemRow>[]>(
    () => [
      imageColumn<ItemRow>(imagePaths, images),
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
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                編集
              </Button>
              <ImageButtons row={row.original} paths={imagePaths} onEdit={imageEdit.open} />
            </div>
          ) : null,
      },
    ],
    [globalWritable, imagePaths, images, imageEdit.open],
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
      {imageEdit.dialogs}
      <CountItemsSection />
    </div>
  );
}

const NO_PATHS: ItemImagePaths = new Map();

type ImageAction = { row: { id: string; name: string }; action: 'add' | 'replace' | 'remove' };

/** 画像を足す・替える・外すボタン（管理者。画像があれば替える・外す、なければ足す） */
function ImageButtons({
  row,
  paths,
  onEdit,
}: {
  row: { id: string; name: string };
  paths: ItemImagePaths;
  onEdit: (a: ImageAction) => void;
}) {
  if (!paths.has(row.id)) {
    return (
      <Button size="sm" variant="outline" onClick={() => onEdit({ row, action: 'add' })} data-testid="item-image-add">
        画像を足す
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => onEdit({ row, action: 'replace' })} data-testid="item-image-replace">
        画像を替える
      </Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onEdit({ row, action: 'remove' })} data-testid="item-image-remove">
        画像を外す
      </Button>
    </>
  );
}

/** 画像を足す・替える（写真のダイアログ）と外す（確かめのダイアログ）。成功したら toast、失敗はダイアログに出す */
function useImageEdit(kind: ItemImageKind, paths: ItemImagePaths) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ImageAction | null>(null);
  const open = useMemo(() => (a: ImageAction) => setTarget(a), []);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const close = () => {
    setTarget(null);
    setRemoveError(null);
  };
  const dialogs = (
    <>
      <ItemPhotoDialog
        open={target !== null && target.action !== 'remove'}
        onOpenChange={(o) => !o && close()}
        title={target ? `「${target.row.name}」の${target.action === 'replace' ? '画像を替える' : '画像を足す'}` : '画像を足す'}
        description={target?.action === 'replace' ? '送ると前の画像は消えます。写真は縮めてから送ります（位置情報などは残りません）。' : undefined}
        onSubmit={async (file, imageId) => {
          if (!target) return null;
          const r = await sendItemImage(queryClient, kind, target.row.id, file, { imageId });
          if (!r.ok) return r.message;
          toast.success(`「${target.row.name}」の画像を${target.action === 'replace' ? '替えました' : '足しました'}`);
          return null;
        }}
      />
      <ConfirmDialog
        open={target !== null && target.action === 'remove'}
        onOpenChange={(o) => !o && close()}
        title={target ? `「${target.row.name}」の画像を外しますか` : '画像を外しますか'}
        description="画像を外します。名前はそのまま残ります。"
        destructive
        confirmLabel="外す"
        pendingLabel="外しています…"
        confirmDisabled={!!target && !paths.has(target.row.id)}
        onConfirm={async () => {
          if (!target) return;
          const r = await removeItemImage(queryClient, kind, target.row.id);
          if (!r.ok) {
            setRemoveError(r.message);
            throw new Error('remove failed');
          }
          toast.success(`「${target.row.name}」の画像を外しました`);
        }}
      >
        {removeError ? (
          <p role="alert" className="text-sm text-destructive">
            {removeError}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
  return { open, dialogs };
}

/** 品目の画像の列（ItemImage。マスタ設定の2つの表で使う） */
function imageColumn<T extends { id: string; name: string }>(paths: ItemImagePaths, images: ItemImageUrls): ColumnDef<T> {
  return { id: 'image', header: '画像', cell: ({ row }) => <ItemImage name={row.original.name} path={paths.get(row.original.id)} images={images} zoomable /> };
}

/** 備品（数えるだけ）の書き込みのエラーの文言の文脈（23505・23503・名前の誤り） */
const COUNT_ITEMS_CONTEXT = { table: 'count_items' } as const;

/** 品目のタブの「備品（数えるだけ）」の欄（04「マスタ設定」。T22・D-60） */
function CountItemsSection() {
  const { globalWritable } = useSettings();
  const countItemsQ = useQuery({ queryKey: settingsKeys.countItems(), queryFn: () => fetchCountItems() });
  const [editing, setEditing] = useState<CountItemRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CountItemRow | null>(null);
  const queryClient = useQueryClient();
  const imagePaths = useQuery(itemImagePathsOptions('count_item')).data ?? NO_PATHS;
  const images = useItemImageUrls((countItemsQ.data ?? []).map((r) => imagePaths.get(r.id)));
  const imageEdit = useImageEdit('count_item', imagePaths);
  const onError = useWriteErrorHandler();
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: settingsKeys.countItems() }),
      // 在庫入力・在庫一覧の名前の一覧（場所・品目の読み込みに入っている）
      queryClient.invalidateQueries({ queryKey: ['year'] }),
    ]);

  const columns = useMemo<ColumnDef<CountItemRow>[]>(
    () => [
      imageColumn<CountItemRow>(imagePaths, images),
      { accessorKey: 'name', header: '名前' },
      { id: 'always', header: '最初から出す', cell: ({ row }) => (row.original.always_shown ? '出す' : '—') },
      { accessorKey: 'sort_order', header: '並び順', meta: { align: 'right' } },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          globalWritable ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                編集
              </Button>
              <ImageButtons row={row.original} paths={imagePaths} onEdit={imageEdit.open} />
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(row.original)}>
                削除
              </Button>
            </div>
          ) : null,
      },
    ],
    [globalWritable, imagePaths, images, imageEdit.open],
  );

  return (
    <section className="mt-10" aria-label="備品（数えるだけ）" data-testid="count-items-settings">
      <TabHeading
        title="備品（数えるだけ）"
        description={
          <>
            在庫入力で数だけを数える物（ゴミ箱・延長コードなど）です。申請・振り分け・Excel には入りません。変更はすべての年度に効きます。
            「最初から出す」物は、在庫入力のすべての場所に最初から行が出ます。ほかの物は在庫入力の「その他」から選べます（在庫入力でも新しい名前を足せます）。
            数が入力された物は削除できません。
          </>
        }
        actions={
          globalWritable ? (
            <Button onClick={() => setEditing('new')} data-testid="count-item-settings-add">
              備品（数えるだけ）を足す
            </Button>
          ) : null
        }
      />
      <QueryState query={countItemsQ} isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="備品（数えるだけ）がありません" />}>
        {(rows) => <DataTable columns={columns} data={rows} getRowId={(r) => r.id} caption="備品（数えるだけ）の一覧" />}
      </QueryState>
      <FormSheet
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? '備品（数えるだけ）を足す' : '備品（数えるだけ）を編集'}
        description="変更はすべての年度に効きます。"
      >
        {editing !== null ? (
          <CountItemForm
            item={editing === 'new' ? null : editing}
            onDone={async () => {
              setEditing(null);
              await invalidate();
            }}
          />
        ) : null}
      </FormSheet>
      {imageEdit.dialogs}
      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`「${deleting.name}」を削除しますか`}
          description="数が入力された物は削除できません。削除はすべての年度に効きます。"
          destructive
          confirmLabel="削除する"
          pendingLabel="削除中…"
          onConfirm={async () => {
            try {
              await deleteCountItem(deleting);
              // 消した備品の画像（とフォルダの残りの物）を Storage から片付ける（失敗しても知らせない。02「品目の画像」）
              void removeDeletedItemImages('count_item', deleting.id);
              toast.success(`「${deleting.name}」を削除しました`);
              await invalidate();
            } catch (e) {
              await onError(e, { context: COUNT_ITEMS_CONTEXT, dataKeys: [settingsKeys.countItems()], unknownMessage: null });
              throw e;
            }
          }}
        />
      ) : null}
    </section>
  );
}

function CountItemForm({ item, onDone }: { item: CountItemRow | null; onDone: () => Promise<void> }) {
  // 入力の元（更新で送る updated_at）。conflict の後は読み直した行にする（2.6 の (B1)。入力は残す）
  const [base, setBase] = useState(item);
  const form = useForm<CountItemFormInput, unknown, CountItemFormOutput>({
    resolver: zodResolver(countItemFormSchema),
    defaultValues: {
      name: item?.name ?? '',
      always_shown: item?.always_shown ?? false,
      sort_order: String(item?.sort_order ?? 0),
    },
  });
  const { register, handleSubmit, formState, setValue, control } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const alwaysShown = useWatch({ control, name: 'always_shown' });

  const callFor = (v: CountItemFormOutput): LockedSaveRun<CountItemRow> => {
    const values = { name: v.name, always_shown: v.always_shown, sort_order: v.sort_order };
    const onSaved = async (earlier: boolean) => {
      toast.success(earlier ? `「${v.name}」は保存されていました` : base ? `「${v.name}」を保存しました` : `「${v.name}」を足しました`);
      form.reset(form.getValues());
      await onDone();
    };
    return base
      ? {
          target: `id:${base.id}`,
          write: () => updateCountItem(base, values),
          reread: () => readCountItem(base.id),
          matches: (row) => matchesWritten(row, values),
          baseVersion: base.updated_at,
          onRebase: (row) => row && setBase(row),
          onSaved,
        }
      : {
          target: `name:${values.name}`,
          write: () => insertCountItem(values),
          reread: () => readCountItemByName(values.name),
          matches: (row) => matchesWritten(row, values),
          baseVersion: null,
          insert: true,
          onSaved,
        };
  };
  const locked = useLockedSave<CountItemRow>({
    dataKeys: [settingsKeys.countItems()],
    context: COUNT_ITEMS_CONTEXT,
    current: () => {
      const p = countItemFormSchema.safeParse(form.getValues());
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
  const err = (k: keyof CountItemFormInput) => formState.errors[k]?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="count-item-form">
      {locked.notice}
      <Field label="名前" error={err('name')} hint="1〜50 字。全角・半角と大文字小文字だけが違う名前は、同じ名前として扱います">
        {(p) => <Input {...p} {...register('name')} maxLength={COUNT_ITEM_NAME_MAX + 20} />}
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="count-item-always"
          checked={alwaysShown}
          onCheckedChange={(on) => setValue('always_shown', on === true, { shouldDirty: true })}
        />
        <Label htmlFor="count-item-always">最初から出す（在庫入力のすべての場所に最初から行を出す）</Label>
      </div>
      <Field label="並び順" error={err('sort_order')}>
        {(p) => <Input {...p} {...register('sort_order')} inputMode="numeric" />}
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </form>
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
          target: `id:${base.id}`,
          write: () => updateItem(base, patch),
          reread: () => readItem(base.id),
          matches: (row) => matchesWritten(row, patch),
          baseVersion: base.updated_at,
          onRebase: (row) => row && setBase(row),
          onSaved,
        }
      : {
          target: `code:${values.code}`,
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
