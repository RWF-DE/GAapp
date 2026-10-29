'use client';

// 団体のタブ（画面の設計 3.2「団体」。T09）。団体名は Excel の集計に使える名前だけ（groupNameSchema と、年度の全団体の
// checkGroupNames。D-27）。表示名は空欄なら null。削除は申請・振り分け・団体代表・招待も消える。参照している有効なルールが
// あれば削除できない（rulesReferencing）。CSV の取り込みは groups-csv-dialog.tsx。
import { zodResolver } from '@hookform/resolvers/zod';
import { checkGroupNames, GROUP_CATEGORIES } from '@gaapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { DataTable } from '@/components/common/data-table';
import { EntitySelect } from '@/components/common/entity-select';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  deleteGroup,
  fetchGroups,
  fetchMembers,
  fetchRooms,
  insertGroup,
  matchesWritten,
  readGroup,
  readGroupByName,
  updateGroup,
} from '@/lib/data/settings';
import type { GroupRow, RoomRow } from '@/lib/db/types';
import { CATEGORY_LABELS, ROOM_KIND_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NAME_MAX } from '@/lib/schemas/common';
import { groupFormSchema, joinAliases, type GroupFormInput, type GroupFormOutput } from '@/lib/schemas/settings';
import { GroupsCsvDialog } from './groups-csv-dialog';
import { DeleteWithRefsDialog } from './rule-refs';
import { Field, FormSheet, selectClass, settingsKeys, TabHeading, useLockedSave, useSettings, useWriteErrorHandler, type LockedSaveRun } from './shared';

export function GroupsTab() {
  const { year, yearWritable } = useSettings();
  const groupsQ = useQuery({ queryKey: settingsKeys.groups(year.id), queryFn: () => fetchGroups(year.id) });
  const roomsQ = useQuery({ queryKey: settingsKeys.rooms(), queryFn: () => fetchRooms() });
  const membersQ = useQuery({ queryKey: settingsKeys.members(year.id), queryFn: () => fetchMembers(year.id) });
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<GroupRow | null>(null);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();
  const onError = useWriteErrorHandler();
  const confirmed = year.status === 'confirmed';

  const roomName = useMemo(() => new Map((roomsQ.data ?? []).map((r) => [r.id, r.name] as const)), [roomsQ.data]);
  const repCount = membersQ.data?.repCount;

  const columns = useMemo<ColumnDef<GroupRow>[]>(
    () => [
      { accessorKey: 'name', header: '団体名' },
      { id: 'display_name', header: '表示名（企画名）', cell: ({ row }) => row.original.display_name ?? '—' },
      { id: 'aliases', header: '別名', cell: ({ row }) => row.original.aliases.join('、') },
      { id: 'category', header: '区分', cell: ({ row }) => CATEGORY_LABELS[row.original.category] },
      { id: 'is_food', header: '飲食', cell: ({ row }) => (row.original.is_food ? '飲食' : '') },
      {
        id: 'location',
        header: '使用場所',
        cell: ({ row }) =>
          row.original.location_room_id ? (roomName.get(row.original.location_room_id) ?? '（不明な場所）') : '校内に分散',
      },
      { accessorKey: 'sort_order', header: '並び順', meta: { align: 'right' } },
      { id: 'reps', header: '代表者', cell: ({ row }) => (repCount ? (repCount.get(row.original.id) ?? 0) : '…'), meta: { align: 'right' } },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          yearWritable ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                編集
              </Button>
              {!confirmed ? (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(row.original)}>
                  削除
                </Button>
              ) : null}
            </div>
          ) : null,
      },
    ],
    [yearWritable, confirmed, roomName, repCount],
  );

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.year(year.id) });
  };

  return (
    <div>
      <TabHeading
        title="団体"
        description={
          <>
            団体名は Excel の集計に使える名前だけにします（半角の * ? ~、先頭の = &lt; &gt;、「(計)」「使用不可」「余り」「残す」は使えません）。
            {confirmed ? ' 確定中は、団体の削除と区分・使用場所の変更はできません。' : ''}
          </>
        }
        actions={
          yearWritable ? (
            <>
              <Button variant="outline" onClick={() => setImporting(true)} data-testid="groups-csv-open">
                団体を CSV で取り込む
              </Button>
              <Button onClick={() => setEditing('new')} data-testid="group-add">
                団体を足す
              </Button>
            </>
          ) : null
        }
      />
      <QueryState
        query={groupsQ}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title="団体がありません" description="「団体を足す」か「団体を CSV で取り込む」から入れてください。" />}
      >
        {(rows) => <DataTable columns={columns} data={rows} getRowId={(r) => r.id} caption="団体の一覧" />}
      </QueryState>

      <FormSheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? '団体を足す' : '団体を編集'}>
        {editing !== null && groupsQ.data && roomsQ.data ? (
          <GroupForm
            group={editing === 'new' ? null : editing}
            groups={groupsQ.data}
            rooms={roomsQ.data}
            onDone={async () => {
              setEditing(null);
              await invalidate();
            }}
          />
        ) : null}
      </FormSheet>

      {deleting ? (
        <DeleteWithRefsDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`「${deleting.name}」を削除しますか`}
          description="この団体の申請・振り分け・団体代表・招待も消えます。元に戻せません。"
          target={{ groupId: deleting.id }}
          what="団体"
          onConfirm={async () => {
            try {
              await deleteGroup(deleting);
              toast.success(`「${deleting.name}」を削除しました`);
              await invalidate();
            } catch (e) {
              await onError(e, { dataKeys: [settingsKeys.groups(year.id)], unknownMessage: null });
              throw e;
            }
          }}
        />
      ) : null}

      {importing && groupsQ.data && roomsQ.data ? (
        <GroupsCsvDialog
          groups={groupsQ.data}
          rooms={roomsQ.data}
          onClose={() => setImporting(false)}
          onSaved={async () => {
            setImporting(false);
            await invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function GroupForm({
  group,
  groups,
  rooms,
  onDone,
}: {
  group: GroupRow | null;
  groups: readonly GroupRow[];
  rooms: readonly RoomRow[];
  onDone: () => Promise<void>;
}) {
  const { year } = useSettings();
  // 入力の元（更新で送る updated_at）。conflict の後は読み直した行にする（2.6 の (B1)。入力は残す）
  const [base, setBase] = useState(group);
  const confirmed = year.status === 'confirmed';
  const form = useForm<GroupFormInput, unknown, GroupFormOutput>({
    resolver: zodResolver(groupFormSchema),
    defaultValues: {
      name: group?.name ?? '',
      display_name: group?.display_name ?? '',
      aliases: joinAliases(group?.aliases),
      category: group?.category ?? 'stall',
      is_food: group?.is_food ?? false,
      location_room_id: group?.location_room_id ?? '',
      sort_order: String(group?.sort_order ?? 0),
    },
  });
  const { register, handleSubmit, formState, setValue, setError, control } = form;
  const isFood = useWatch({ control, name: 'is_food' });
  const location = useWatch({ control, name: 'location_room_id' });
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const roomOptions = useMemo(
    () =>
      rooms.map((r) => ({
        id: r.id,
        name: r.name,
        group: r.building ?? ROOM_KIND_LABELS[r.kind],
        keywords: r.aliases,
      })),
    [rooms],
  );

  // 入力（zod の後）から、送る・読み直す・比べる呼び出しを作る（保存と、読み直せなかった後の「読み直す」で同じものを使う）
  const callFor = (v: GroupFormOutput): LockedSaveRun<GroupRow> => {
    // 送る値（zod で前後の空白を除き、空なら null にした後）。読み直した行もこの値で比べる
    const values = {
      name: v.name,
      display_name: v.display_name,
      aliases: v.aliases,
      category: v.category,
      is_food: v.is_food,
      location_room_id: v.location_room_id,
      sort_order: v.sort_order,
    };
    const onSaved = async (earlier: boolean) => {
      toast.success(earlier ? `「${v.name}」は保存されていました` : base ? `「${v.name}」を保存しました` : `「${v.name}」を足しました`);
      form.reset(form.getValues());
      await onDone();
    };
    return base
      ? {
          write: () => updateGroup(base, values),
          reread: () => readGroup(base.id),
          matches: (row) => matchesWritten(row, values),
          baseVersion: base.updated_at,
          onRebase: (row) => row && setBase(row),
          onSaved,
        }
      : {
          write: () => insertGroup(year.id, values),
          reread: () => readGroupByName(year.id, values.name),
          matches: (row) => matchesWritten(row, { ...values, year_id: year.id }),
          baseVersion: null,
          insert: true,
          onSaved,
        };
  };
  const locked = useLockedSave<GroupRow>({
    dataKeys: [settingsKeys.groups(year.id)],
    current: () => {
      const p = groupFormSchema.safeParse(form.getValues());
      return p.success ? callFor(p.data) : null;
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    // 年度の全団体（編集後）で名前の重複を見る（大文字・小文字・全角半角だけの違いも。D-27）。
    // 足すときは、名前が入力と完全に同じ団体は外す：応答が届かなかった前の送信が通っていれば、読み直した一覧に自分の足した団体が
    // 入っているため。同じ名前の行は DB の unique (year_id, name) が 23505 で止め、読み直して決める（2.6 の (B1)。
    // 入力と同じなら「保存されていました」、違えば「同じものがすでにあります」）
    const others = groups.filter((g) => (base ? g.id !== base.id : g.name !== v.name));
    const after = [...others.map((g) => ({ name: g.name })), { name: v.name }];
    const nameErrors = checkGroupNames(after).filter((e) => e.path === `groups.${after.length - 1}.name`);
    if (nameErrors.length > 0) {
      setError('name', { message: nameErrors[0]!.message });
      return;
    }
    setSaving(true);
    try {
      await locked.run(callFor(v));
    } finally {
      setSaving(false);
    }
  });
  const err = (k: keyof GroupFormInput) => formState.errors[k]?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="group-form">
      {locked.notice}
      <Field label="団体名" error={err('name')}>
        {(p) => <Input {...p} {...register('name')} maxLength={NAME_MAX} />}
      </Field>
      <Field label="表示名（企画名。任意）" error={err('display_name')}>
        {(p) => <Input {...p} {...register('display_name')} maxLength={NAME_MAX} />}
      </Field>
      <Field label="別名（フォームでの表記。| で区切る）" error={err('aliases')}>
        {(p) => <Input {...p} {...register('aliases')} />}
      </Field>
      <Field label="区分" error={err('category')} hint={confirmed && group ? '確定中は変えられません' : undefined}>
        {(p) =>
          // 確定中の既存の団体は区分を変えない（登録しない欄は defaultValues のまま送られる。disabled にすると値が消えるため）
          confirmed && group ? (
            <Input {...p} value={CATEGORY_LABELS[group.category]} readOnly />
          ) : (
            <select {...p} {...register('category')} className={selectClass}>
              {GROUP_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          )
        }
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox id="group-is-food" checked={isFood} onCheckedChange={(c) => setValue('is_food', c === true, { shouldDirty: true })} />
        <Label htmlFor="group-is-food">飲食の団体</Label>
      </div>
      <div className="space-y-1.5">
        <Label>使用場所</Label>
        <EntitySelect
          label="使用場所"
          options={roomOptions}
          value={location === '' ? null : location}
          onChange={(id) => setValue('location_room_id', id ?? '', { shouldDirty: true, shouldValidate: true })}
          placeholder="校内に分散（場所なし）"
          allowClear
          disabled={confirmed && !!group}
        />
        {err('location_room_id') ? <p className="text-xs text-destructive">{err('location_room_id')}</p> : null}
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
