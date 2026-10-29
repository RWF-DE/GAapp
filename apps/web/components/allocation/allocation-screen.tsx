'use client';

// 振り分け /allocation（画面の設計 3.9、04「振り分け」、D-34・D-39。T13）。
// - 管理者は振り分け中に自動振り分け・最小変更で再実行・確定・Excel 出力。計算エンジン（Worker と highs）は、管理者が振り分け中に
//   この画面を開いたときだけ読み込み始める。
// - 部員はいつでも読み取り専用（在庫・余り・検証・Excel 出力つき。書き込みのボタンは出さない。Q1）。
// - 閲覧のみは確定後だけ、行の一覧（運び元・運び先・団体・品目・数）。在庫・申請は RLS で読めないので、余り・検証・団体別は出さない（Q1）。
// 段 1：読み込みと表示・自動振り分け・検証の一覧・確定・Excel。
// 段 2：行の手での編集（未保存の変更に溜めて save_allocation_rows で保存）、部屋の見出しからの「今年は使用不可にする」、
// precheck の E002 の操作（運び元の変更と削除だけ）。
import type { AllocateMode, Issue } from '@gaapp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { PageHeader } from '@/components/common/page-header';
import { StaleBanner } from '@/components/common/stale-banner';
import { TokyoTime } from '@/components/common/tokyo-time';
import { YearStatusActions } from '@/components/common/year-status-actions';
import { EmptyState, ErrorState, ForbiddenState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getAllocatorEngine, useEngineState, type AllocatorEngine } from '@/lib/allocation/engine';
import { groupViews } from '@/lib/allocation/group-view';
import { isFixedRow, isReplaceableRow } from '@/lib/allocation/input';
import { issueTarget, type IssueTarget } from '@/lib/allocation/issue-target';
import type { FailureLine } from '@/lib/allocation/failure-view';
import { describeRule } from '@/lib/allocation/rule-text';
import { unusableChecklist } from '@/lib/allocation/unusable';
import { itemTabs, tabKeyByItem } from '@/lib/allocation/tabs';
import { buildViewModel, namesOf } from '@/lib/allocation/view-model';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf, type Audience } from '@/lib/auth/membership';
import { saveAutoAllocations } from '@/lib/data/allocation';
import { downloadAllocationXlsx, ExportBlockedError, isBeforeConfirm } from '@/lib/data/export';
import { setRoomUsable, type FixedRowOp } from '@/lib/data/room-years';
import { loadSnapshot, useSnapshot, type Snapshot, type SnapshotPart } from '@/lib/data/snapshot';
import { useValidation } from '@/lib/data/validation';
import { useVersionWatch } from '@/lib/data/version-watch';
import { fetchYearVersion, isAllocationFinal } from '@/lib/data/year';
import { toStoredRows } from '@/lib/data/year-data';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { AutoResult, seconds } from './auto-result';
import { allocationHref, parseAllocationQuery, type AllocationQuery } from './allocation-query';
import { autoBlockOf, AutoRunLock, MODE_LABELS, RunInert, useAutoAllocation, type AutoRunDeps } from './auto-run';
import { useRowFocus } from './use-row-focus';
import { GroupViewList } from './group-view';
import { ItemTabView } from './item-tab-view';
import { IssuesPanel, ProblemsList } from './issues-panel';
import { PendingBar, PendingNotices } from './pending-bar';
import { AddRowDialog, rowLabel, SourceDialog, UnusableDialog } from './row-dialogs';
import { RowEditProvider, type RowEditApi } from './row-edit';
import { usePendingRows } from './use-pending';

export { allocationHref, parseAllocationQuery, type AllocationQuery } from './allocation-query';

export function AllocationScreen() {
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  if (!m?.year) return <LoadingState />;
  const role = m.role;
  const status = m.year.status;
  const audiences = audiencesOf(m);

  if (role !== 'admin' && role !== 'staff') {
    // 閲覧のみ（Q1）：確定後だけ。RequireAudience（href）は確定前の viewer を通さないが、念のためここでも分ける
    if (role !== 'viewer') return <ForbiddenState />;
    if (!isAllocationFinal(status)) return <ForbiddenState description="振り分けは確定後に表示されます。" />;
  }

  if (status === 'preparing' || status === 'requesting') {
    return (
      <>
        <PageHeader title="振り分け" />
        <Toolbar disabled isAdmin={role === 'admin'} canExport={false} />
        <EmptyState
          title="締切の後に振り分けます"
          description="申請の締切（振り分けを始める）はホームのダッシュボードから行います。"
          action={
            <AppLink href="/" className="underline underline-offset-2">
              ホームへ
            </AppLink>
          }
        />
      </>
    );
  }

  const part: SnapshotPart = role === 'admin' || role === 'staff' ? 'full' : 'public';
  return <AllocationBody key={`${m.year.id}:${part}`} yearId={m.year.id} part={part} isAdmin={role === 'admin'} audiences={audiences} />;
}

/** 上部のボタン（段 1：自動振り分け・最小変更で再実行・Excel 出力。確定は YearStatusActions） */
function Toolbar({
  disabled = false,
  isAdmin,
  canExport,
  autoDisabled = true,
  minimalDisabled = true,
  exportDisabled = true,
  exporting = false,
  onAuto,
  onExport,
  autoHint,
  emphasizeMinimal = false,
}: {
  disabled?: boolean;
  isAdmin: boolean;
  canExport: boolean;
  autoDisabled?: boolean;
  minimalDisabled?: boolean;
  exportDisabled?: boolean;
  exporting?: boolean;
  onAuto?: (mode: AllocateMode) => void;
  onExport?: () => void;
  autoHint?: string | null;
  /** 部屋を使用不可にした後：「最小変更で再実行」を目立たせる */
  emphasizeMinimal?: boolean;
}) {
  return (
    <div className="mb-3 space-y-1 print:hidden" data-testid="allocation-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <>
            <Button disabled={disabled || autoDisabled} onClick={() => onAuto?.('full')}>
              自動振り分け
            </Button>
            <Button
              variant={emphasizeMinimal ? 'default' : 'outline'}
              className={cn(emphasizeMinimal && 'ring-2 ring-amber-400 ring-offset-2')}
              data-emphasized={emphasizeMinimal ? 'true' : undefined}
              disabled={disabled || minimalDisabled}
              onClick={() => onAuto?.('minimal_change')}
            >
              最小変更で再実行
            </Button>
          </>
        ) : null}
        {canExport || disabled ? (
          <Button variant="outline" disabled={disabled || exportDisabled || exporting} onClick={onExport}>
            {exporting ? 'Excel を作成中…' : 'Excel出力'}
          </Button>
        ) : null}
      </div>
      {autoHint ? (
        <p className="text-sm text-muted-foreground" data-testid="auto-hint">
          {autoHint}
        </p>
      ) : null}
    </div>
  );
}

function AllocationBody({ yearId, part, isAdmin, audiences }: { yearId: string; part: SnapshotPart; isAdmin: boolean; audiences: Audience[] }) {
  const snap = useSnapshot(yearId, part);
  if (snap.isPending) return <LoadingState />;
  if (snap.isError || !snap.data) {
    return <ErrorState message={messageFor(classifyError(snap.error))} onRetry={() => void snap.refetch()} />;
  }
  return (
    <AllocationLoaded
      snapshot={snap.data}
      refetch={() => snap.refetch()}
      fetching={snap.isFetching}
      isAdmin={isAdmin}
      audiences={audiences}
    />
  );
}

function AllocationLoaded({
  snapshot,
  refetch,
  fetching,
  isAdmin,
  audiences,
}: {
  snapshot: Snapshot;
  refetch: () => Promise<unknown>;
  fetching: boolean;
  isAdmin: boolean;
  audiences: Audience[];
}) {
  const yearId = snapshot.year.id;
  const status = snapshot.year.status;
  const full = snapshot.part === 'full';
  const allocating = status === 'allocating';
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const query = useMemo(() => parseAllocationQuery(new URLSearchParams(params.toString())), [params]);

  const vm = useMemo(() => buildViewModel(snapshot), [snapshot]);
  const stored = useMemo(() => toStoredRows(snapshot).rows, [snapshot]);
  // 行の手での編集（管理者・振り分け中だけ。確定中・終了・部員・閲覧のみは読み取り）
  const editable = isAdmin && allocating && full;
  const pend = usePendingRows({ snapshot, refetch, editable });
  const dirty = pend.pending.length > 0;
  const rows = pend.rows;
  const validation = useValidation(full ? snapshot : undefined, dirty ? rows : undefined);
  const tabs = useMemo(() => itemTabs(vm.items), [vm]);
  const tabByItem = useMemo(() => tabKeyByItem(tabs), [tabs]);
  const rowItem = useMemo(() => new Map(rows.map((r) => [r.id, r.itemId])), [rows]);
  const names = useMemo(() => namesOf(vm), [vm]);
  const rulesByCode = useMemo(() => new Map(snapshot.rules.map((r) => [r.code, r])), [snapshot.rules]);
  const ruleText = useCallback((code: string) => {
    const r = rulesByCode.get(code);
    return r ? describeRule(r, vm) : undefined;
  }, [rulesByCode, vm]);
  const groups = useMemo(
    () => (full && validation.yearData ? groupViews(vm, validation.yearData.data, rows) : []),
    [full, validation.yearData, vm, rows],
  );

  // 計算エンジン：管理者が振り分け中に開いたときだけ（部員・閲覧のみと、振り分け中以外は Worker を作らない）
  const engine = useMemo<AllocatorEngine | null>(
    () => (isAdmin && allocating && typeof window !== 'undefined' ? getAllocatorEngine() : null),
    [isAdmin, allocating],
  );
  const [engineLoadMs, setEngineLoadMs] = useState<number | null>(null);
  useEffect(() => {
    if (!engine) return;
    let alive = true;
    void engine.warmup().then((o) => {
      if (alive && o.ok && o.loadMs > 0) setEngineLoadMs(o.loadMs);
    });
    return () => {
      alive = false;
    };
  }, [engine]);
  const engineState = useEngineState(engine);

  const heldVersion = snapshot.version;
  const deps: AutoRunDeps = useMemo(
    () => ({
      engine,
      loadFresh: () => loadSnapshot(yearId, 'full'),
      publish: (s) => queryClient.setQueryData(queryKeys.snapshot(yearId, 'full'), s),
      save: ({ rows, mode, baseVersion }) => saveAutoAllocations({ yearId, rows, mode, baseVersion }),
      readVersion: () => fetchYearVersion(yearId),
      reload: async (e) => {
        if (effectOf(classifyError(e)).reload === 'year') {
          await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
          reloadMembership();
          return;
        }
        await refetch();
      },
      heldVersion: () => heldVersion,
    }),
    [engine, yearId, queryClient, reloadMembership, refetch, heldVersion],
  );
  const auto = useAutoAllocation(deps);
  const running = auto.state.running;
  const { stale } = useVersionWatch(yearId, snapshot.version, { paused: running });

  // 保存したら知らせる（toast）
  const lastToast = useRef<unknown>(null);
  useEffect(() => {
    const o = auto.state.outcome;
    if (!o || o === lastToast.current || o.kind !== 'saved' || o.verified) return;
    lastToast.current = o;
    const c = o.counts;
    toast.success(`保存しました（追加 ${c.inserted}・変更 ${c.updated}・削除 ${c.deleted}、計算 ${seconds(o.elapsedMs)} 秒）`);
  }, [auto.state.outcome]);

  // ---- 移動（検証の一覧・precheck の項目から） ----
  const [highlightRoom, setHighlightRoom] = useState<string | null>(null);
  // 項目を押して移った回数（同じ項目をもう一度押したとき、URL も state も同じなので、これでもう一度スクロールする）
  const [focusKey, setFocusKey] = useState(0);
  const setQuery = useCallback((q: Partial<AllocationQuery>) => router.forceReplace(allocationHref(q)), [router]);
  const currentTab = tabs.find((t) => t.key === query.tab) ?? tabs[0] ?? null;
  const targetOf = useCallback(
    (issue: Pick<Issue, 'refs'>): IssueTarget => issueTarget(issue, { rowItem, tabByItem }, audiences, status),
    [rowItem, tabByItem, audiences, status],
  );
  const goTo = useCallback(
    (t: IssueTarget) => {
      const d = t.destination;
      if (d.kind !== 'none') setFocusKey((k) => k + 1);
      switch (d.kind) {
        case 'row':
          setHighlightRoom(null);
          setQuery({ view: 'item', tab: d.tab ?? currentTab?.key, row: d.rowId });
          return;
        case 'room':
          setHighlightRoom(d.roomId);
          setQuery({ view: 'item', tab: d.tab ?? currentTab?.key });
          return;
        case 'group':
          setHighlightRoom(null);
          setQuery({ view: 'group', group: d.groupId });
          return;
        case 'tab':
          setHighlightRoom(null);
          setQuery({ view: 'item', tab: d.tab });
          return;
        case 'none':
          return;
      }
    },
    [setQuery, currentTab],
  );

  // ?row=… で開いたら、その行のタブを開いてスクロールし、目立たせる（行のタブが違えば直す）
  useRowFocus({ row: query.row, view: query.view, rowItem, tabByItem, currentTabKey: currentTab?.key, setQuery, focusKey });
  useEffect(() => {
    if (highlightRoom) document.querySelector(`[data-room-block="${CSS.escape(highlightRoom)}"]`)?.scrollIntoView({ block: 'start' });
  }, [highlightRoom, currentTab, focusKey]);
  useEffect(() => {
    if (query.view === 'group' && query.group) {
      document.querySelector(`[data-group-block="${CSS.escape(query.group)}"]`)?.scrollIntoView({ block: 'start' });
    }
  }, [query.view, query.group, focusKey]);

  // ---- 自動振り分け ----
  const [confirmMode, setConfirmMode] = useState<AllocateMode | null>(null);
  const replaceable = stored.filter(isReplaceableRow).length;
  const autoRows = replaceable;
  const problems = validation.yearData?.problems ?? [];
  const unverified = auto.state.outcome?.kind === 'unverified';
  const { disabled: autoDisabled, reason: autoBlock } = autoBlockOf({
    allocating,
    running,
    dirty,
    problemCount: problems.length,
    unverified,
    engineState,
  });
  const engineNote = isAdmin && allocating && engineState === 'failed' ? '計算エンジンを読み込めませんでした。「自動振り分け」を押すと、もう一度読み込みます。' : null;

  // ---- Excel 出力（Q3：確定前は確かめて、ファイル名に「_確定前」） ----
  const [xlsxConfirm, setXlsxConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const doExport = async () => {
    setExporting(true);
    try {
      const { fileName } = await downloadAllocationXlsx(snapshot);
      toast.success(`${fileName} を保存しました`);
    } catch (e) {
      toast.error(e instanceof ExportBlockedError ? e.message : 'Excel を作れませんでした。もう一度試してください');
      if (!(e instanceof ExportBlockedError)) console.error(e);
    } finally {
      setExporting(false);
    }
  };
  const onExport = () => (isBeforeConfirm(status) ? setXlsxConfirm(true) : void doExport());

  // ---- 行の操作（段 2） ----
  const [sourceRowId, setSourceRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [unusableRoom, setUnusableRoom] = useState<string | null>(null);
  const [usableRoom, setUsableRoom] = useState<string | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [suggestMinimal, setSuggestMinimal] = useState<string | null>(null);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const pendingIds = useMemo(
    () => new Set(pend.pending.map((c) => (c.op === 'insert' ? c.tempId : c.id))),
    [pend.pending],
  );
  const editApi = useMemo<RowEditApi | null>(
    () =>
      editable
        ? {
            vm,
            rows,
            pendingIds,
            isUsable: (roomId) => vm.roomById.get(roomId)?.usable ?? true,
            edit: pend.edit,
            revert: pend.revert,
            openSource: setSourceRowId,
            requestDelete: setDeleteRowId,
            openUnusable: setUnusableRoom,
            openUsable: setUsableRoom,
          }
        : null,
    [editable, vm, rows, pendingIds, pend.edit, pend.revert],
  );
  const checklist = useMemo(() => {
    if (!unusableRoom) return [];
    const order = new Map(vm.items.map((it, k) => [it.id, k]));
    const gOrder = new Map(vm.groups.map((g, k) => [g.id, k]));
    return unusableChecklist(rows, unusableRoom).sort(
      (a, b) => (order.get(a.row.itemId) ?? 0) - (order.get(b.row.itemId) ?? 0) || (gOrder.get(a.row.groupId) ?? 0) - (gOrder.get(b.row.groupId) ?? 0),
    );
  }, [rows, unusableRoom, vm]);
  const onChecklistOp = (op: FixedRowOp, rowId: string) => {
    if (op === 'unpin') pend.edit({ op: 'update', id: rowId, patch: { pinned: false } });
    else if (op === 'delete') pend.edit({ op: 'delete', id: rowId });
    else setSourceRowId(rowId);
  };
  const changeRoomUsable = async (roomId: string, usable: boolean, note: string | null) => {
    setRoomBusy(true);
    try {
      await setRoomUsable(yearId, roomId, usable, note);
      await refetch();
      const name = vm.roomById.get(roomId)?.name ?? '';
      if (usable) {
        toast.success(`${name}を使用可に戻しました`);
        setSuggestMinimal(null);
      } else {
        toast.success(`${name}を今年は使用不可にしました`);
        setSuggestMinimal(roomId);
      }
      setUnusableRoom(null);
      setUsableRoom(null);
    } catch (e) {
      const c = classifyError(e);
      toast.error(messageFor(c, { names }));
      const eff = effectOf(c);
      if (eff.reload === 'year') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
        reloadMembership();
      } else if (eff.reload === 'data') {
        await refetch();
      }
    } finally {
      setRoomBusy(false);
    }
  };

  // E002（使用不可の部屋からの行）：運び元の変更と削除だけ（固定を外すは出さない。部屋がすでに使用不可なので、
  // save_allocation_rows が固定だけの update も E002 で拒否するため）。検証の一覧と precheck の項目に添える。
  // allocate の precheck の E002 は残すのルールの部屋だけ（固定・手動の行の E002 では止めず、validate が示す。03・D-25）なので、
  // 行の操作が要るのは主に検証の一覧の E002。
  const e002Actions = (issue: Issue) => {
    if (!editApi || issue.code !== 'E002') return null;
    const roomId = issue.refs.roomId;
    const inRoom = (issue.refs.rowIds ?? []).flatMap((id) => {
      const r = rowById.get(id);
      return r && r.sourceRoomId === roomId ? [r] : [];
    });
    if (inRoom.length === 0) return null;
    const fixed = inRoom.filter(isFixedRow);
    const autoCount = inRoom.length - fixed.length;
    return (
      <div className="ml-2 mt-1 space-y-1 text-xs" data-testid="e002-actions">
        {fixed.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-row-id-action={r.id}>
            <span className="min-w-0">
              {rowLabel(vm, r)}（{r.origin === 'manual' ? '手動' : '固定'}）
            </span>
            <span className="ml-auto flex gap-1">
              <Button size="xs" variant="outline" onClick={() => setSourceRowId(r.id)}>
                運び元を変える
              </Button>
              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => pend.edit({ op: 'delete', id: r.id })}>
                行を削除
              </Button>
            </span>
          </div>
        ))}
        {autoCount > 0 ? <p className="text-muted-foreground">自動の行 {autoCount} 行は「最小変更で再実行」でほかの部屋に移ります。</p> : null}
        {fixed.length > 0 && roomId ? (
          <p className="text-muted-foreground">
            固定を外して最小変更に任せたいときは、部屋を使用可に戻し、固定を外して保存してから使用不可にし直します（
            <button type="button" className="underline underline-offset-2" onClick={() => goTo({ destination: { kind: 'room', roomId, tab: null }, rule: null })}>
              部屋の見出しのメニューへ
            </button>
            ）。
          </p>
        ) : null}
      </div>
    );
  };
  const lineActions = (line: FailureLine) => (line.issue ? e002Actions(line.issue) : null);

  const errorsAfter = auto.state.outcome?.kind === 'saved' ? validation.issues.filter((i) => i.severity === 'error').length : 0;
  const hasRows = stored.length > 0;

  return (
    <>
    {/* 計算中は本体を inert にし（クリックも Tab も届かない）、フォーカスはロックへ移す（AutoRunLock） */}
    <RunInert running={running}>
      <PageHeader
        title="振り分け"
        description={
          <span data-testid="auto-allocated-at">
            最終実行 {snapshot.year.auto_allocated_at ? <TokyoTime value={snapshot.year.auto_allocated_at} /> : 'まだ実行していません'}
          </span>
        }
        loadedAt={snapshot.loadedAt}
        onReload={() => void refetch()}
        reloading={fetching}
      />
      {stale ? <StaleBanner onReload={() => void refetch()} reloading={fetching} className="mb-3" /> : null}

      {engine ? (
        <span hidden data-testid="engine-state" data-state={engineState} data-load-ms={engineLoadMs === null ? undefined : Math.round(engineLoadMs)} />
      ) : null}
      {full ? (
        <Toolbar
          isAdmin={isAdmin && allocating}
          canExport={full}
          autoDisabled={autoDisabled}
          minimalDisabled={autoDisabled || autoRows === 0}
          exportDisabled={running || dirty}
          exporting={exporting}
          onAuto={(mode) => setConfirmMode(mode)}
          onExport={onExport}
          autoHint={isAdmin ? (autoBlock ?? engineNote) : null}
          emphasizeMinimal={suggestMinimal !== null && !dirty && !running}
        />
      ) : null}

      {isAdmin && (allocating || status === 'confirmed') ? (
        // 計算中は確定・確定を解除・終了を押せない（disabled の fieldset の中のボタンは押せない）
        <fieldset disabled={running} data-testid="year-status-fieldset" className="m-0 mb-3 min-w-0 border-0 p-0 print:hidden">
          <YearStatusActions
            year={snapshot.year}
            snapshotVersion={snapshot.version}
            validation={validation}
            stale={stale}
            unsaved={dirty}
            onReloadSnapshot={() => refetch()}
            names={names}
            closeExtras={
              <Button variant="outline" disabled={exporting} onClick={() => void doExport()}>
                振り分け表を書き出す
              </Button>
            }
          />
        </fieldset>
      ) : null}

      <div className="mb-3 space-y-2">
        {!isAdmin && full ? (
          <ReadOnlyNotice>部員は振り分けを見るだけです（自動振り分け・編集・確定は管理者が行います）。</ReadOnlyNotice>
        ) : null}
        {isAdmin && status === 'confirmed' ? <ReadOnlyNotice>確定中です。直すときは「確定を解除」してください。</ReadOnlyNotice> : null}
        {status === 'closed' ? <ReadOnlyNotice status="closed" /> : null}
        {pend.draft ? <DraftNotice savedAt={pend.draft.savedAt} onRestore={pend.draft.restore} onDiscard={pend.draft.discard} /> : null}
        {suggestMinimal && editable ? (
          <div role="status" data-testid="suggest-minimal" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950">
            {vm.roomById.get(suggestMinimal)?.name ?? ''}を今年は使用不可にしました。「最小変更で再実行」で、この部屋からの自動の行をほかの部屋に移してください。
          </div>
        ) : null}
        <PendingNotices api={pend} vm={vm} onReload={() => void refetch()} />
        {auto.state.outcome ? (
          <AutoResult
            outcome={auto.state.outcome}
            vm={vm}
            errorsAfter={errorsAfter}
            onIssue={(issue) => goTo(targetOf(issue))}
            onRecheck={auto.recheck}
            onReload={() => void refetch()}
            lineActions={lineActions}
          />
        ) : null}
        {!hasRows ? (
          <EmptyState
            className="rounded-md border border-dashed py-6"
            title="まだ自動振り分けをしていません"
            description={isAdmin && allocating ? '「自動振り分け」を押すと、申請と在庫から振り分けを作ります。' : undefined}
          />
        ) : null}
      </div>

      {/* 検証の一覧は xl（1280px）から右に置き、それより狭いときは表の下に回す（表の操作の列まで収めるため。B6） */}
      <div className={cn('grid gap-6', full && 'xl:grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0 space-y-3">
          {full ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="表示の切り替え">
              <Button size="sm" variant={query.view === 'item' ? 'default' : 'outline'} aria-pressed={query.view === 'item'} onClick={() => setQuery({ view: 'item', tab: currentTab?.key })}>
                品目別
              </Button>
              <Button size="sm" variant={query.view === 'group' ? 'default' : 'outline'} aria-pressed={query.view === 'group'} onClick={() => setQuery({ view: 'group' })}>
                団体別
              </Button>
              {editable ? (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAddOpen(true)}>
                  行を追加
                </Button>
              ) : null}
            </div>
          ) : null}
          {query.view === 'group' && full ? (
            <GroupViewList views={groups} highlightGroupId={query.group ?? null} />
          ) : currentTab ? (
            <RowEditProvider value={editApi}>
            <Tabs value={currentTab.key} onValueChange={(v) => setQuery({ view: 'item', tab: v })}>
              <div className="overflow-x-auto">
                <TabsList aria-label="品目">
                  {tabs.map((t) => (
                    <TabsTrigger key={t.key} value={t.key}>
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <ItemTabView
                vm={vm}
                rows={rows}
                tab={currentTab}
                highlightRowId={query.row ?? null}
                highlightRoomId={highlightRoom}
                readOnlyList={!full}
              />
            </Tabs>
            </RowEditProvider>
          ) : null}
        </div>
        {full ? (
          <aside className="min-w-0">
            {validation.status === 'skipped' ? null : (
              <IssuesPanel
                validation={validation}
                targetOf={targetOf}
                onSelect={(_, t) => goTo(t)}
                ruleText={ruleText}
                {...(editApi ? { issueActions: e002Actions } : {})}
              />
            )}
            {validation.status === 'skipped' && problems.length > 0 ? <ProblemsList problems={problems} ruleText={ruleText} /> : null}
          </aside>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmMode !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmMode(null);
        }}
        title={confirmMode ? `${MODE_LABELS[confirmMode]}を実行しますか` : ''}
        description={
          confirmMode === 'minimal_change'
            ? '前回の自動の行をできるだけ変えずに計算し直します。固定・手動の行は残ります。'
            : `自動の行 ${replaceable} 件を置き換えます。固定・手動の行は残ります。`
        }
        confirmLabel="実行する"
        onConfirm={() => {
          const mode = confirmMode;
          setConfirmMode(null);
          if (mode) void auto.start(mode);
        }}
      />
      <ConfirmDialog
        open={xlsxConfirm}
        onOpenChange={setXlsxConfirm}
        title="確定前の振り分けです"
        description="まだ確定していない振り分けを Excel に出します。共有用の確定版と取り違えないよう、ファイル名の最後に「_確定前」を付けます。"
        confirmLabel="出力する"
        onConfirm={() => {
          setXlsxConfirm(false);
          void doExport();
        }}
      />
    </RunInert>
    {editable ? (
      // 未保存の変更のバー（画面の下に固定）も計算中は届かない。包みは箱を作らない（display: contents）：
      // 箱を作るとバーの sticky がこの包み（バーと同じ高さ）の中でしか効かず、画面の下に固定されなくなる
      <div inert={running} className="contents">
        <PendingBar api={pend} vm={vm} />
        <SourceDialog
          row={sourceRowId ? (rowById.get(sourceRowId) ?? null) : null}
          vm={vm}
          rows={rows}
          onOpenChange={(o) => {
            if (!o) setSourceRowId(null);
          }}
          onPick={(roomId) => {
            if (sourceRowId) pend.edit({ op: 'update', id: sourceRowId, patch: { sourceRoomId: roomId } });
            setSourceRowId(null);
          }}
        />
        <ConfirmDialog
          open={deleteRowId !== null}
          onOpenChange={(o) => {
            if (!o) setDeleteRowId(null);
          }}
          title="行を削除しますか"
          description={
            deleteRowId && rowById.get(deleteRowId)
              ? `${rowLabel(vm, rowById.get(deleteRowId)!)}を削除します（未保存の変更に入れます。保存するまで DB は変わりません）。`
              : ''
          }
          destructive
          confirmLabel="削除する"
          onConfirm={() => {
            if (deleteRowId) pend.edit({ op: 'delete', id: deleteRowId });
            setDeleteRowId(null);
          }}
        />
        <AddRowDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          vm={vm}
          data={validation.yearData?.data ?? null}
          rows={rows}
          initialItemId={currentTab?.items[0]?.id}
          onAdd={(f) => {
            pend.edit({ op: 'insert', ...f });
            setAddOpen(false);
          }}
        />
        <UnusableDialog
          roomId={unusableRoom}
          vm={vm}
          checklist={checklist}
          pendingCount={pend.pending.length}
          busy={roomBusy}
          onOpenChange={(o) => {
            if (!o) setUnusableRoom(null);
          }}
          onOp={onChecklistOp}
          onConfirm={(note) => (unusableRoom ? changeRoomUsable(unusableRoom, false, note) : Promise.resolve())}
        />
        <ConfirmDialog
          open={usableRoom !== null}
          onOpenChange={(o) => {
            if (!o) setUsableRoom(null);
          }}
          title={`${usableRoom ? (vm.roomById.get(usableRoom)?.name ?? '') : ''}を使用可に戻しますか`}
          description="今年もこの部屋の在庫を振り分けに使えるようにします。固定を外して保存してから、もう一度使用不可にすることもできます。"
          confirmLabel="使用可に戻す"
          pending={roomBusy}
          onConfirm={() => (usableRoom ? changeRoomUsable(usableRoom, true, null) : undefined)}
        />
      </div>
    ) : null}
    <AutoRunLock state={auto.state} onCancel={auto.cancel} />
    </>
  );
}
