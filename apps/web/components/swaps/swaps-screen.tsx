'use client';

// キャスター机交換 /swaps（画面の設計 3.10、04「キャスター机交換」。T13）。管理者。PC。
// - スナップショット（版を先に読む）から swapRows（T09a。ダッシュボードの了承状況と同じ数え方）で対象を作る。
// - 操作（振り分け中だけ）：依頼済みにする・了承・拒否（総務が代わりに記録）・未依頼に戻す（依頼済み・拒否のときだけ）。
//   どれも set_consent。了承で置き換えの行が固定され、拒否で固定が外れ、版が上がるので、操作のたびにスナップショットを読み直す。
// - 注意の列：依頼の後に増えた・了承の後に増えた（W102）・拒否なのに置き換えが残っている（振り分け画面へのリンク）。
// - 団体代表が /my で回答を変えると版が上がるので、版の見張り（StaleBanner）で気づける（Q4）。
// - 「交換依頼一覧（Excel）」：exporter の exportSwapsXlsx を動的 import。
import type { ColumnDef } from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable } from '@/components/common/data-table';
import { ErrorBanner } from '@/components/common/error-banner';
import { useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { StaleBanner } from '@/components/common/stale-banner';
import { TokyoTime } from '@/components/common/tokyo-time';
import { EmptyState, ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { buildViewModel, namesOf } from '@/lib/allocation/view-model';
import { useAuth } from '@/lib/auth/auth-provider';
import { ExportBlockedError } from '@/lib/data/export';
import { useSnapshot, type Snapshot } from '@/lib/data/snapshot';
import { SWAP_ATTENTION_MESSAGES, swapRows, type SwapRow } from '@/lib/data/swaps';
import { useVersionWatch } from '@/lib/data/version-watch';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { CONSENT_STATUS_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NOTE_MAX } from '@/lib/schemas/common';
import { downloadSwapsXlsx, setSwapConsent } from './swaps-data';
import { statusTone, SWAP_DONE, swapOpDescription, swapOps, type SwapOpOption } from './swap-ops';

export function SwapsScreen() {
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  if (!m?.year) return <LoadingState />;
  return <SwapsBody key={m.year.id} yearId={m.year.id} />;
}

function SwapsBody({ yearId }: { yearId: string }) {
  const snap = useSnapshot(yearId, 'full');
  if (snap.isPending) {
    return (
      <>
        <PageHeader title="キャスター机交換" />
        <LoadingState />
      </>
    );
  }
  if (snap.isError || !snap.data) {
    return (
      <>
        <PageHeader title="キャスター机交換" />
        <ErrorState message={messageFor(classifyError(snap.error))} onRetry={() => void snap.refetch()} />
      </>
    );
  }
  return <SwapsLoaded snapshot={snap.data} refetch={() => snap.refetch()} fetching={snap.isFetching} />;
}

interface SwapView extends SwapRow {
  id: string;
  groupName: string;
  displayName: string | null;
  location: string;
  pair: string;
}

interface PendingOp {
  row: SwapView;
  option: SwapOpOption;
}

function SwapsLoaded({ snapshot, refetch, fetching }: { snapshot: Snapshot; refetch: () => Promise<unknown>; fetching: boolean }) {
  const yearId = snapshot.year.id;
  const status = snapshot.year.status;
  const allocating = status === 'allocating';
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const notLatest = useNotLatestYearConfirm();
  const vm = useMemo(() => buildViewModel(snapshot), [snapshot]);
  const names = useMemo(() => namesOf(vm), [vm]);
  const rows = useMemo<SwapView[]>(
    () =>
      swapRows(snapshot).map((r) => {
        const g = vm.groupById.get(r.groupId);
        return {
          ...r,
          id: `${r.groupId}|${r.fromItemId}|${r.toItemId}`,
          groupName: g?.name ?? '（不明な団体）',
          displayName: g?.displayName ?? null,
          location: g?.locationRoomId ? (vm.roomById.get(g.locationRoomId)?.name ?? '') : '',
          pair: `${vm.itemById.get(r.fromItemId)?.name ?? '?'}→${vm.itemById.get(r.toItemId)?.name ?? '?'}`,
        };
      }),
    [snapshot, vm],
  );
  const [busy, setBusy] = useState(false);
  const { stale } = useVersionWatch(yearId, snapshot.version, { paused: busy });
  const [op, setOp] = useState<PendingOp | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const open = async (row: SwapView, option: SwapOpOption) => {
    if (!(await notLatest.confirmBeforeWrite())) return;
    setNote(row.note ?? '');
    setOp({ row, option });
  };

  const run = async () => {
    if (!op) return;
    const { row, option } = op;
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await setSwapConsent({
        groupId: row.groupId,
        fromItemId: row.fromItemId,
        toItemId: row.toItemId,
        status: option.op,
        note: trimmed === (row.note ?? '').trim() ? undefined : trimmed,
      });
      toast.success(`${SWAP_DONE[option.op]}（${row.groupName}）`);
      setOp(null);
    } catch (e) {
      setError(e);
      setOp(null);
      if (effectOf(classifyError(e)).reload === 'year') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
        reloadMembership();
      }
    } finally {
      // 了承・拒否で行の固定が変わり、版が上がる。失敗しても今の状態を見せるために読み直す
      await refetch();
      setBusy(false);
    }
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const { fileName } = await downloadSwapsXlsx(snapshot);
      toast.success(`${fileName} を保存しました`);
    } catch (e) {
      toast.error(e instanceof ExportBlockedError ? e.message : 'Excel を作れませんでした。もう一度試してください');
      if (!(e instanceof ExportBlockedError)) console.error(e);
    } finally {
      setExporting(false);
    }
  };

  // 企画名は、どの団体にもなければ列を出さない（PC の幅を注意の列に回す）
  const hasDisplayName = rows.some((r) => r.displayName);
  // 交換（元 → 先）が1種類だけなら列にせず、件数の行に書く
  const pairs = new Set(rows.map((r) => r.pair));
  // 列は描画ごとに作る（操作のボタンが busy・allocating・最新でない年度の確かめを使うため）
  const columns: ColumnDef<SwapView>[] = [
      { accessorKey: 'groupName', header: '団体', cell: ({ row }) => <span className="font-medium">{row.original.groupName}</span> },
      ...(hasDisplayName
        ? [{ accessorKey: 'displayName', header: '企画名', cell: ({ row }) => row.original.displayName ?? '' } satisfies ColumnDef<SwapView>]
        : []),
      { accessorKey: 'location', header: '使用場所' },
      ...(pairs.size > 1 ? [{ accessorKey: 'pair', header: '交換' } satisfies ColumnDef<SwapView>] : []),
      { accessorKey: 'current', header: '今の置き換え台数', meta: { align: 'right' } },
      {
        accessorKey: 'asked',
        header: '依頼した台数',
        meta: { align: 'right' },
        cell: ({ row }) => (row.original.asked === null ? '—' : row.original.asked),
      },
      {
        accessorKey: 'status',
        header: '状況',
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <Badge variant={statusTone(row.original.status)} data-testid="swap-status">
              {CONSENT_STATUS_LABELS[row.original.status]}
            </Badge>
            {row.original.updatedAt ? (
              <div className="text-xs text-muted-foreground">
                <TokyoTime value={row.original.updatedAt} format="short" />
              </div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'attention',
        header: '注意',
        cell: ({ row }) => {
          const a = row.original.attention;
          if (!a) return null;
          return (
            <span className="block min-w-44 max-w-60 whitespace-normal text-sm text-amber-700" data-testid="swap-attention" data-attention={a}>
              {a === 'rerun' ? (
                <>
                  拒否されています。
                  <AppLink href={`/allocation?view=group&group=${row.original.groupId}`} className="underline underline-offset-2">
                    振り分け画面
                  </AppLink>
                  で『最小変更で再実行』が要ります
                </>
              ) : (
                SWAP_ATTENTION_MESSAGES[a]
              )}
            </span>
          );
        },
      },
      {
        accessorKey: 'note',
        header: '備考',
        enableSorting: false,
        cell: ({ row }) => <span className="line-clamp-2 block max-w-48 whitespace-pre-wrap text-sm">{row.original.note ?? ''}</span>,
      },
      {
        id: 'ops',
        header: '操作',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex gap-1" data-testid="swap-ops">
            {swapOps(row.original, allocating).map((o) => (
              <Button
                key={o.op}
                size="sm"
                variant={o.op === 'declined' ? 'outline' : o.op === 'not_asked' ? 'ghost' : 'secondary'}
                disabled={busy || o.disabledReason !== null}
                title={o.disabledReason ?? undefined}
                onClick={() => void open(row.original, o)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        ),
      },
  ];

  const attentionCount = rows.filter((r) => r.attention !== null).length;

  return (
    <div data-testid="swaps-screen">
      <PageHeader
        title="キャスター机交換"
        description="了承が要る置き換え（机(木) → キャスター机など）の台数と、団体の了承の状況です。"
        loadedAt={snapshot.loadedAt}
        onReload={() => void refetch()}
        reloading={fetching}
        actions={
          <Button variant="outline" disabled={exporting || rows.length === 0} onClick={() => void exportXlsx()}>
            {exporting ? 'Excel を作成中…' : '交換依頼一覧（Excel）'}
          </Button>
        }
      />
      {stale ? <StaleBanner onReload={() => void refetch()} reloading={fetching} className="mb-3" /> : null}
      {!allocating ? (
        status === 'confirmed' || status === 'closed' ? (
          <ReadOnlyNotice status={status} className="mb-3" />
        ) : (
          <ReadOnlyNotice className="mb-3">交換の依頼と了承は、振り分け中（締切の後）だけ記録できます。</ReadOnlyNotice>
        )
      ) : null}
      {error ? (
        <ErrorBanner
          error={error}
          context={{ rpc: 'set_consent', names }}
          onReload={() => void refetch()}
          className="mb-3"
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="キャスター机への置き換えはありません"
          description={allocating ? '自動振り分けで置き換えが入ると、ここに出ます。' : undefined}
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" data-testid="swaps-summary">
            {pairs.size === 1 ? `${[...pairs][0]}：` : ''}
            {rows.length} 件
            {attentionCount > 0 ? `（注意 ${attentionCount} 件）` : ''}
            ・置き換え 計 {rows.reduce((s, r) => s + r.current, 0)} 台
          </p>
          <DataTable columns={columns} data={rows} getRowId={(r) => r.id} containerClassName="max-h-[75vh]" />
        </>
      )}
      <ConfirmDialog
        open={op !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setOp(null);
        }}
        title={op ? `${op.row.groupName}（${op.row.pair}）を「${op.option.label}」にします` : ''}
        description={op ? swapOpDescription(op.option.op, op.row) : undefined}
        confirmLabel={op?.option.label ?? '記録する'}
        destructive={op?.option.op === 'declined'}
        pending={busy}
        confirmDisabled={note.length > NOTE_MAX}
        onConfirm={run}
      >
        <div className="space-y-1">
          <Label htmlFor="swap-note">備考（任意）</Label>
          <Textarea id="swap-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={busy} />
          {note.length > NOTE_MAX ? <p className="text-sm text-destructive">備考は {NOTE_MAX} 字までです</p> : null}
        </div>
      </ConfirmDialog>
      {notLatest.dialog}
    </div>
  );
}

