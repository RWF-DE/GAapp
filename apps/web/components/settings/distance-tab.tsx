'use client';

// 距離のタブ（画面の設計 3.2「距離」。T09）。建物どうしの距離の上書き（0〜20）。建物は rooms の building から選ぶ（自由入力も）。
// DB が建物の組の向きをそろえる（D-15）ので、画面は並べ替えない。場所ごとの追加コストは場所のタブで直す（ここでは一覧だけ）。
import { zodResolver } from '@hookform/resolvers/zod';
import { MAX_DISTANCE_COST } from '@gaapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable } from '@/components/common/data-table';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deleteDistance, fetchDistanceOverrides, fetchRooms, insertDistance, updateDistance } from '@/lib/data/settings';
import type { DistanceOverrideRow, RoomRow } from '@/lib/db/types';
import { classifyError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { BUILDING_MAX } from '@/lib/schemas/common';
import { distanceFormSchema, type DistanceFormInput, type DistanceFormOutput } from '@/lib/schemas/settings';
import { Field, FormSheet, settingsKeys, TabHeading, useSettings, useWriteErrorHandler } from './shared';

const keyOf = (r: Pick<DistanceOverrideRow, 'building_a' | 'building_b'>) => `${r.building_a}\u0000${r.building_b}`;

export function DistanceTab() {
  const { globalWritable } = useSettings();
  const distQ = useQuery({ queryKey: settingsKeys.distance(), queryFn: () => fetchDistanceOverrides() });
  const roomsQ = useQuery({ queryKey: settingsKeys.rooms(), queryFn: () => fetchRooms() });
  const [editing, setEditing] = useState<DistanceOverrideRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DistanceOverrideRow | null>(null);
  const queryClient = useQueryClient();
  const onError = useWriteErrorHandler();

  const buildings = useMemo(
    () => [...new Set((roomsQ.data ?? []).map((r) => r.building?.trim()).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b, 'ja')),
    [roomsQ.data],
  );

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.distance() }),
      queryClient.invalidateQueries({ queryKey: ['year'] }),
    ]);
  };

  const columns = useMemo<ColumnDef<DistanceOverrideRow>[]>(
    () => [
      { accessorKey: 'building_a', header: '建物A' },
      { accessorKey: 'building_b', header: '建物B' },
      { accessorKey: 'cost', header: 'コスト', meta: { align: 'right' } },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          globalWritable ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                編集
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(row.original)}>
                削除
              </Button>
            </div>
          ) : null,
      },
    ],
    [globalWritable],
  );

  const roomCols = useMemo<ColumnDef<RoomRow>[]>(
    () => [
      { accessorKey: 'name', header: '場所' },
      { id: 'building', header: '建物', cell: ({ row }) => row.original.building ?? '—' },
      { accessorKey: 'extra_cost', header: '追加コスト', meta: { align: 'right' } },
    ],
    [],
  );

  return (
    <div className="space-y-8">
      <section>
        <TabHeading
          title="建物どうしの距離の上書き"
          description={`距離を変えると、次の自動振り分けから効きます（すべての年度に効きます）。コストは 0〜${MAX_DISTANCE_COST}。`}
          actions={
            globalWritable ? (
              <Button onClick={() => setEditing('new')} data-testid="distance-add">
                距離を足す
              </Button>
            ) : null
          }
        />
        <QueryState
          query={distQ}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="距離の上書きはありません" description="建物どうしの距離は、決まった表で計算します。" />}
        >
          {(rows) => <DataTable columns={columns} data={rows} getRowId={keyOf} caption="距離の上書き" />}
        </QueryState>
      </section>

      <section>
        <TabHeading
          title="場所ごとの追加コスト"
          description={
            <>
              運び出しにくい部屋の追加コストは
              <AppLink href="/settings?tab=rooms" className="mx-1 underline">
                場所のタブ
              </AppLink>
              で直します。
            </>
          }
        />
        <QueryState query={roomsQ} isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="場所がありません" />}>
          {(rows) => (
            <DataTable
              columns={roomCols}
              data={rows.filter((r) => r.extra_cost > 0)}
              getRowId={(r) => r.id}
              empty={<EmptyState title="追加コストのある場所はありません" />}
              containerClassName="max-h-[40vh]"
              caption="追加コストのある場所"
            />
          )}
        </QueryState>
      </section>

      <FormSheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? '距離を足す' : '距離を編集'}>
        {editing !== null ? (
          <DistanceForm
            row={editing === 'new' ? null : editing}
            buildings={buildings}
            onDone={async () => {
              setEditing(null);
              await invalidate();
            }}
          />
        ) : null}
      </FormSheet>

      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`${deleting.building_a}・${deleting.building_b} の距離の上書きを削除しますか`}
          description="決まった表の距離に戻ります。すべての年度に効きます。"
          destructive
          confirmLabel="削除する"
          pendingLabel="削除中…"
          onConfirm={async () => {
            try {
              await deleteDistance(deleting);
              toast.success('距離の上書きを削除しました');
              await invalidate();
            } catch (e) {
              await onError(e, { dataKeys: [queryKeys.distance()] });
              throw e;
            }
          }}
        />
      ) : null}
    </div>
  );
}

function DistanceForm({ row, buildings, onDone }: { row: DistanceOverrideRow | null; buildings: readonly string[]; onDone: () => Promise<void> }) {
  const onError = useWriteErrorHandler();
  const listId = useId();
  const form = useForm<DistanceFormInput, unknown, DistanceFormOutput>({
    resolver: zodResolver(distanceFormSchema),
    defaultValues: { building_a: row?.building_a ?? '', building_b: row?.building_b ?? '', cost: String(row?.cost ?? 0) },
  });
  const { register, handleSubmit, formState, setError } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);

  const onSubmit = handleSubmit(async (v) => {
    setSaving(true);
    try {
      if (row) await updateDistance(row, v.cost);
      else await insertDistance(v);
      toast.success(`${v.building_a}・${v.building_b} の距離を保存しました`);
      form.reset(form.getValues());
      await onDone();
    } catch (e) {
      const c = classifyError(e);
      if (c.code === '23505') setError('building_b', { message: 'その組はすでにあります' });
      else if (c.code === '23514') setError('cost', { message: '入力が範囲を超えています（同じ建物どうしは入れられません）' });
      else await onError(e, { dataKeys: [queryKeys.distance()] });
    } finally {
      setSaving(false);
    }
  });
  const err = (k: keyof DistanceFormInput) => formState.errors[k]?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="distance-form">
      <datalist id={listId}>
        {buildings.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <Field label="建物A" error={err('building_a')} hint="場所の建物から選ぶか、入力します">
        {(p) => <Input {...p} {...register('building_a')} list={listId} readOnly={!!row} maxLength={BUILDING_MAX} />}
      </Field>
      <Field label="建物B" error={err('building_b')}>
        {(p) => <Input {...p} {...register('building_b')} list={listId} readOnly={!!row} maxLength={BUILDING_MAX} />}
      </Field>
      <Field label={`コスト（0〜${MAX_DISTANCE_COST}）`} error={err('cost')}>
        {(p) => <Input {...p} {...register('cost')} inputMode="numeric" />}
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </form>
  );
}
