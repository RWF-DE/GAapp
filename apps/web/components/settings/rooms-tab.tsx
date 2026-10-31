'use client';

// 場所のタブ（画面の設計 3.2「場所」。T09）。rooms は年度をまたぐ表（開いている年度のどれかの admin が書ける。D-01）。
// 今年の使用（room_years）は年度ごと。振り分け中に固定・手動の行がある部屋は、ここでは使用不可にせず振り分け画面へ案内する（3.9）。
import { zodResolver } from '@hookform/resolvers/zod';
import { ROOM_KINDS } from '@gaapp/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { DataTable } from '@/components/common/data-table';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { readRoomYear, roomYearMatches, setRoomUsable } from '@/lib/data/room-years';
import {
  deleteRoom,
  fetchAllocationSources,
  fetchRooms,
  fetchRoomYears,
  insertRoom,
  lockedRowOutcome,
  matchesWritten,
  readRoom,
  readRoomByName,
  updateRoom,
} from '@/lib/data/settings';
import type { RoomRow, RoomYearRow } from '@/lib/db/types';
import { ROOM_KIND_LABELS } from '@/lib/labels';
import { classifyError, messageFor } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { BUILDING_MAX, NAME_MAX, NOTE_MAX } from '@/lib/schemas/common';
import { joinAliases, roomFormSchema, roomUsableSchema, type RoomFormInput, type RoomFormOutput } from '@/lib/schemas/settings';
import { MAX_DISTANCE_COST } from '@gaapp/shared';
import { DeleteWithRefsDialog } from './rule-refs';
import { Field, FormSheet, GlobalReadOnlyNote, selectClass, settingsKeys, TabHeading, useLockedSave, useSettings, useWriteErrorHandler, type LockedSaveRun } from './shared';

/** 開いている年度の管理者でない人（総務部門長・総務副部門長）の場所のタブの説明（04「マスタ設定」の場所。D-50） */
const ROOMS_YEAR_ONLY_NOTE =
  '場所の追加・編集・削除は管理者が行います（すべての年度で共有の表のため）。今年の使用（使用不可と理由のメモ）は年度ごとで、各行の「変える」から変えられます。';

interface RoomView extends RoomRow {
  usable: boolean;
  usableNote: string | null;
  roomYear: RoomYearRow | null;
}

export function RoomsTab() {
  const { year, globalWritable, yearWritable } = useSettings();
  const roomsQ = useQuery({ queryKey: settingsKeys.rooms(), queryFn: () => fetchRooms() });
  const roomYearsQ = useQuery({ queryKey: settingsKeys.roomYears(year.id), queryFn: () => fetchRoomYears(year.id) });
  const guardSources = year.status === 'allocating' || year.status === 'confirmed';
  const sourcesQ = useQuery({
    queryKey: settingsKeys.allocationSources(year.id),
    queryFn: () => fetchAllocationSources(year.id),
    enabled: guardSources && yearWritable,
  });
  const [editing, setEditing] = useState<RoomRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoomRow | null>(null);
  // 今年の使用のダイアログは場所の id で持ち、読み直した後の行（room_years の updated_at）で保存する（2.3）
  const [usableOfId, setUsableOfId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const onError = useWriteErrorHandler();

  const views = useMemo<RoomView[] | undefined>(() => {
    if (!roomsQ.data || !roomYearsQ.data) return undefined;
    const ry = new Map(roomYearsQ.data.map((r) => [r.room_id, r] as const));
    return roomsQ.data.map((r) => {
      const y = ry.get(r.id) ?? null;
      return { ...r, usable: y?.usable ?? true, usableNote: y?.note ?? null, roomYear: y };
    });
  }, [roomsQ.data, roomYearsQ.data]);

  const usableOf = usableOfId ? (views?.find((v) => v.id === usableOfId) ?? null) : null;

  const combined = {
    data: views,
    isPending: roomsQ.isPending || roomYearsQ.isPending,
    isError: roomsQ.isError || roomYearsQ.isError,
    error: roomsQ.error ?? roomYearsQ.error,
    refetch: () => Promise.all([roomsQ.refetch(), roomYearsQ.refetch()]),
  };

  const columns = useMemo<ColumnDef<RoomView>[]>(
    () => [
      { accessorKey: 'name', header: '名前' },
      { id: 'aliases', header: '別名', cell: ({ row }) => row.original.aliases.join('、') },
      { id: 'kind', header: '種類', cell: ({ row }) => ROOM_KIND_LABELS[row.original.kind] },
      { id: 'building', header: '建物', cell: ({ row }) => row.original.building ?? '—' },
      { id: 'floor', header: '階', cell: ({ row }) => row.original.floor ?? '—', meta: { align: 'right' } },
      { id: 'storage', header: '保管場所', cell: ({ row }) => (row.original.is_storage ? '保管場所' : '') },
      { accessorKey: 'extra_cost', header: '追加コスト', meta: { align: 'right' } },
      { accessorKey: 'sort_order', header: '並び順', meta: { align: 'right' } },
      {
        id: 'usable',
        header: '今年の使用',
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            {row.original.usable ? (
              <span>使用可</span>
            ) : (
              <>
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
                  使用不可
                </Badge>
                {row.original.usableNote ? <span className="text-xs text-muted-foreground">{row.original.usableNote}</span> : null}
              </>
            )}
            {yearWritable ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs underline"
                aria-label={`${row.original.name}の今年の使用を変える`}
                onClick={() => setUsableOfId(row.original.id)}
              >
                変える
              </Button>
            ) : null}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            {globalWritable ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
                  編集
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(row.original)}>
                  削除
                </Button>
              </>
            ) : null}
          </div>
        ),
      },
    ],
    [globalWritable, yearWritable],
  );

  const invalidateRooms = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.rooms() }),
      // 場所は全年度のスナップショット・画面に効く
      queryClient.invalidateQueries({ queryKey: ['year'] }),
    ]);
  };

  return (
    <div>
      <TabHeading
        title="場所"
        description={
          // 場所を直せない総務部門長・総務副部門長（終了していない年度）には、できること〔今年の使用〕だけを書く。建物の入れ方は直せる人に
          <>
            {globalWritable || !yearWritable ? '場所の変更はすべての年度に効きます（今年の使用だけは年度ごと）。' : null}
            {globalWritable ? '建物の中の部屋は建物を入れてください（空欄の部屋は、距離の計算で別の建物として扱われます）。' : null}
            <GlobalReadOnlyNote what="場所" yearWritableNote={ROOMS_YEAR_ONLY_NOTE} />
          </>
        }
        actions={
          globalWritable ? (
            <Button onClick={() => setEditing('new')} data-testid="room-add">
              場所を足す
            </Button>
          ) : null
        }
      />
      <QueryState
        query={combined}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title="場所がありません" description="「場所を足す」から入れてください。" />}
      >
        {(rows) => <DataTable columns={columns} data={rows} getRowId={(r) => r.id} caption="場所の一覧" />}
      </QueryState>

      <FormSheet
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? '場所を足す' : '場所を編集'}
        description="場所の変更はすべての年度に効きます。"
      >
        {editing !== null ? (
          <RoomForm
            room={editing === 'new' ? null : editing}
            onDone={async () => {
              setEditing(null);
              await invalidateRooms();
            }}
          />
        ) : null}
      </FormSheet>

      {deleting ? (
        <DeleteWithRefsDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`「${deleting.name}」を削除しますか`}
          description="在庫・振り分け・団体の使用場所・どれかの年度の今年の使用から使われている場所は削除できません。削除はすべての年度に効きます。"
          target={{ roomId: deleting.id }}
          what="場所"
          onConfirm={async () => {
            try {
              await deleteRoom(deleting);
              toast.success(`「${deleting.name}」を削除しました`);
              await invalidateRooms();
            } catch (e) {
              await onError(e, { dataKeys: [queryKeys.rooms()], unknownMessage: null });
              throw e;
            }
          }}
        />
      ) : null}

      {usableOf ? (
        <UsableDialog
          room={usableOf}
          fixedRows={sourcesQ.data?.fixed.get(usableOf.id) ?? 0}
          allRows={sourcesQ.data?.all.get(usableOf.id) ?? 0}
          sourcesReady={!guardSources || sourcesQ.isSuccess}
          sourcesError={guardSources && sourcesQ.isError ? sourcesQ.error : null}
          sourcesReloading={sourcesQ.isFetching}
          onReloadSources={() => void sourcesQ.refetch()}
          onClose={() => setUsableOfId(null)}
        />
      ) : null}
    </div>
  );
}

function RoomForm({ room, onDone }: { room: RoomRow | null; onDone: () => Promise<void> }) {
  // 入力の元（更新で送る updated_at）。conflict の後は読み直した行にする（2.6 の (B1)。入力は残す）
  const [base, setBase] = useState(room);
  const form = useForm<RoomFormInput, unknown, RoomFormOutput>({
    resolver: zodResolver(roomFormSchema),
    defaultValues: {
      name: room?.name ?? '',
      aliases: joinAliases(room?.aliases),
      kind: room?.kind ?? 'room',
      building: room?.building ?? '',
      floor: room?.floor === null || room?.floor === undefined ? '' : String(room.floor),
      is_storage: room?.is_storage ?? false,
      extra_cost: String(room?.extra_cost ?? 0),
      sort_order: String(room?.sort_order ?? 0),
    },
  });
  const { register, handleSubmit, formState, setValue, control } = form;
  const isStorage = useWatch({ control, name: 'is_storage' });
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);

  // 入力（zod の後）から、送る・読み直す・比べる呼び出しを作る（保存と、読み直せなかった後の「読み直す」で同じものを使う）
  const callFor = (v: RoomFormOutput): LockedSaveRun<RoomRow> => {
    // 送る値（zod で前後の空白を除き、空なら null にした後）。読み直した行もこの値で比べる
    const values = {
      name: v.name,
      aliases: v.aliases,
      kind: v.kind,
      building: v.building,
      floor: v.floor,
      is_storage: v.is_storage,
      extra_cost: v.extra_cost,
      sort_order: v.sort_order,
    };
    const onSaved = async (earlier: boolean) => {
      toast.success(earlier ? `「${v.name}」は保存されていました` : base ? `「${v.name}」を保存しました` : `「${v.name}」を足しました`);
      form.reset(form.getValues());
      await onDone();
    };
    return base
      ? {
          target: `id:${base.id}`,
          write: () => updateRoom(base, values),
          reread: () => readRoom(base.id),
          matches: (row) => matchesWritten(row, values),
          baseVersion: base.updated_at,
          onRebase: (row) => row && setBase(row),
          onSaved,
        }
      : {
          target: `name:${values.name}`,
          write: () => insertRoom(values),
          reread: () => readRoomByName(values.name),
          matches: (row) => matchesWritten(row, values),
          baseVersion: null,
          insert: true,
          onSaved,
        };
  };
  const locked = useLockedSave<RoomRow>({
    dataKeys: [queryKeys.rooms()],
    current: () => {
      const p = roomFormSchema.safeParse(form.getValues());
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
  const err = (k: keyof RoomFormInput) => formState.errors[k]?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-testid="room-form">
      {locked.notice}
      <Field label="名前" error={err('name')}>
        {(p) => <Input {...p} {...register('name')} maxLength={NAME_MAX} />}
      </Field>
      <Field label="別名（フォームでの表記。| で区切る）" error={err('aliases')}>
        {(p) => <Input {...p} {...register('aliases')} />}
      </Field>
      <Field label="種類" error={err('kind')}>
        {(p) => (
          <select {...p} {...register('kind')} className={selectClass}>
            {ROOM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ROOM_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="建物（任意）" error={err('building')} hint="空欄の部屋は、距離の計算で別の建物として扱われます">
        {(p) => <Input {...p} {...register('building')} maxLength={BUILDING_MAX} />}
      </Field>
      <Field label="階（任意）" error={err('floor')} hint="体育館・屋外は空欄（1階として扱う）">
        {(p) => <Input {...p} {...register('floor')} inputMode="numeric" />}
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="room-is-storage"
          checked={isStorage}
          onCheckedChange={(c) => setValue('is_storage', c === true, { shouldDirty: true })}
        />
        <Label htmlFor="room-is-storage">保管場所（在庫を数える場所）</Label>
      </div>
      <Field label={`追加コスト（0〜${MAX_DISTANCE_COST}）`} error={err('extra_cost')} hint="運び出しにくい部屋ほど大きくします">
        {(p) => <Input {...p} {...register('extra_cost')} inputMode="numeric" />}
      </Field>
      <Field label="並び順" error={err('sort_order')}>
        {(p) => <Input {...p} {...register('sort_order')} inputMode="numeric" />}
      </Field>
      <Button type="submit" disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </form>
  );
}

function UsableDialog({
  room,
  fixedRows,
  allRows,
  sourcesReady,
  sourcesError,
  sourcesReloading,
  onReloadSources,
  onClose,
}: {
  room: RoomView;
  fixedRows: number;
  allRows: number;
  sourcesReady: boolean;
  /** 振り分けの行（運び元）の読み込みの失敗。あれば使用不可にする前に知らせ、読み直せるようにする */
  sourcesError: unknown;
  sourcesReloading: boolean;
  onReloadSources: () => void;
  onClose: () => void;
}) {
  const { year } = useSettings();
  const queryClient = useQueryClient();
  const [usable, setUsable] = useState(room.usable);
  const [note, setNote] = useState(room.usableNote ?? '');
  const [saving, setSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  // 入力の元（開いたときの room_years の行。行がなければ null）。setRoomUsable にはこの行の updated_at を渡し、
  // conflict の後は読み直した行にする（2.6 の (B1)。入力は残す）
  const [base, setBase] = useState<RoomYearRow | null>(room.roomYear);
  // 判定が changed（ほかの人が変えた）で入力の元にした行の設定（ほかの人の変更として出す。次の保存で消す）
  const [changedTo, setChangedTo] = useState<{ usable: boolean; note: string | null } | null>(null);
  const roomNames = { names: { room: (id: string) => (id === room.id ? room.name : undefined) } };
  const baseVersion = base?.updated_at ?? null;

  // 入力（zod の後）から、送る・読み直す・比べる呼び出しを作る（保存と、読み直せなかった後の「読み直す」で同じものを使う）
  const callFor = (u: boolean, n: string | null): LockedSaveRun<RoomYearRow> => ({
    // 楽観ロック（T09a）：入力の元の room_years.updated_at（行がなければ null）で保存する。応答が届かなかったとき・
    // conflict・not_found のときは (year_id, room_id) で読み直して決める（2.6 の (B1)）
    target: room.id,
    write: () => setRoomUsable(year.id, room.id, baseVersion, u, n),
    reread: () => readRoomYear(year.id, room.id),
    matches: (row) => roomYearMatches(row, u, n),
    baseVersion,
    onRebase: (row) => {
      setBase(row);
      setChangedTo(row ? { usable: row.usable, note: row.note } : { usable: true, note: null });
    },
    onSaved: async (earlier) => {
      toast.success(earlier ? `「${room.name}」の今年の使用は保存されていました` : `「${room.name}」を今年は${u ? '使用可' : '使用不可'}にしました`);
      // 閉じてから読み直す（開いたまま読み直すと、自分の保存がほかの人の変更に見えるため）
      onClose();
      await queryClient.invalidateQueries({ queryKey: queryKeys.year(year.id) });
    },
  });
  const locked = useLockedSave<RoomYearRow>({
    dataKeys: [settingsKeys.roomYears(year.id)],
    context: roomNames,
    current: () => {
      const p = roomUsableSchema.safeParse({ usable, note });
      return p.success ? callFor(p.data.usable, p.data.note) : null;
    },
  });
  // 裏の読み直し（invalidate）で受け取った行も、保存の後の読み直しと同じ判定（lockedRowOutcome。settleLockedWrite と同じ比べ方）を
  // 通す。changed（入力の元から版が進み、いまの入力と違う）のときだけ、ほかの人の変更として出す。saved（自分の前の送信が後から
  // 通っていた・同じ値）と not-saved（誰も変えていない）では出さない
  const liveOutcome = lockedRowOutcome(room.roomYear, { matches: (row) => roomYearMatches(row, usable, note), baseVersion });
  // 入力の元を付け替えた直後は、裏の読み直しが届くまで古い行が changed に見えるので、付け替えた行（changedTo）を先に使う
  const otherSetting = changedTo ?? (liveOutcome === 'changed' ? { usable: room.usable, note: room.usableNote } : null);
  useUnsavedChanges(usable !== room.usable || note !== (room.usableNote ?? ''));

  // 使用不可にするときの守り（3.2・3.9）：振り分け中は固定・手動の行、確定中は振り分けの行があれば、ここでは押せない
  const makingUnusable = room.usable && !usable;
  const blockedByFixed = makingUnusable && year.status === 'allocating' && fixedRows > 0;
  const blockedByConfirmed = makingUnusable && year.status === 'confirmed' && allRows > 0;
  const blocked = blockedByFixed || blockedByConfirmed || (makingUnusable && !sourcesReady);

  const save = async () => {
    const parsed = roomUsableSchema.safeParse({ usable, note });
    if (!parsed.success) {
      setNoteError(parsed.error.issues[0]?.message ?? '入力が正しくありません');
      return;
    }
    setSaving(true);
    setChangedTo(null);
    try {
      await locked.run(callFor(parsed.data.usable, parsed.data.note));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>「{room.name}」の今年の使用</DialogTitle>
          <DialogDescription>{year.label} だけに効きます（ほかの年度は変わりません）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {otherSetting ? (
            <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950" data-testid="usable-changed-by-other">
              ほかの人がこの場所の今年の使用を変えました。いまの設定は「{otherSetting.usable ? '使用可' : '使用不可'}」
              {otherSetting.note ? `（メモ：${otherSetting.note}）` : ''}です。確かめてから保存してください。
            </p>
          ) : null}
          {locked.notice}
          <div className="flex items-center gap-2">
            <Checkbox id="room-usable" checked={usable} onCheckedChange={(c) => setUsable(c === true)} />
            <Label htmlFor="room-usable">今年は使用する</Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="room-usable-note">理由のメモ（任意）</Label>
            <Textarea id="room-usable-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={2} />
            {noteError ? <p className="text-xs text-destructive">{noteError}</p> : null}
          </div>
          {blockedByFixed ? (
            <p role="alert" className="text-sm text-destructive">
              この場所から運ぶ固定・手動の振り分けの行が {fixedRows} 行あります。先に振り分け画面の部屋の見出しから行を直してください（使用不可にした後では、その行を直せなくなるため）。
              <AppLink href="/allocation" className="ml-1 underline">
                振り分け画面へ
              </AppLink>
            </p>
          ) : null}
          {makingUnusable && !sourcesReady ? (
            sourcesError ? (
              <div role="alert" className="space-y-2 text-sm text-destructive" data-testid="usable-sources-error">
                <p>
                  振り分けの行を読めなかったので、この場所を使用不可にできるかを確かめられません（{messageFor(classifyError(sourcesError))}）。
                </p>
                <Button type="button" size="sm" variant="outline" onClick={onReloadSources} disabled={sourcesReloading}>
                  {sourcesReloading ? '読み直し中…' : '読み直す'}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                振り分けの行を確かめています…
              </p>
            )
          ) : null}
          {blockedByConfirmed ? (
            <p role="alert" className="text-sm text-destructive">
              確定中は、振り分けのある場所を使用不可にできません。確定を解除してから直してください。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            やめる
          </Button>
          <Button onClick={() => void save()} disabled={saving || blocked}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
