'use client';

// 振り分け /allocation（画面の設計 3.9、04「振り分け」、D-34・D-39。T13）。
// - 管理者は振り分け中に自動振り分け・最小変更で再実行・確定・Excel 出力。計算エンジン（Worker と highs）は、管理者が振り分け中に
//   この画面を開いたときだけ読み込み始める。
// - 部員はいつでも読み取り専用（在庫・余り・検証・Excel 出力つき。書き込みのボタンは出さない。Q1）。
// - 閲覧のみは確定後だけ、行の一覧（運び元・運び先・団体・品目・数）。在庫・申請は RLS で読めないので、余り・検証・団体別は出さない（Q1）。
// 段 1：読み込みと表示・自動振り分け・検証の一覧・確定・Excel。行の手での編集と部屋の「使用不可にする」は段 2。
import type { AllocateMode, Issue } from '@gaapp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageHeader } from '@/components/common/page-header';
import { StaleBanner } from '@/components/common/stale-banner';
import { TokyoTime } from '@/components/common/tokyo-time';
import { YearStatusActions } from '@/components/common/year-status-actions';
import { EmptyState, ErrorState, ForbiddenState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getAllocatorEngine, useEngineState, type AllocatorEngine } from '@/lib/allocation/engine';
import { groupViews } from '@/lib/allocation/group-view';
import { isReplaceableRow } from '@/lib/allocation/input';
import { issueTarget, type IssueTarget } from '@/lib/allocation/issue-target';
import { describeRule } from '@/lib/allocation/rule-text';
import { itemTabs, tabKeyByItem } from '@/lib/allocation/tabs';
import { buildViewModel, namesOf } from '@/lib/allocation/view-model';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf, type Audience } from '@/lib/auth/membership';
import { saveAutoAllocations } from '@/lib/data/allocation';
import { downloadAllocationXlsx, ExportBlockedError, isBeforeConfirm } from '@/lib/data/export';
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
import { AutoRunLock, MODE_LABELS, useAutoAllocation, type AutoRunDeps } from './auto-run';
import { GroupViewList } from './group-view';
import { ItemTabView } from './item-tab-view';
import { IssuesPanel, ProblemsList } from './issues-panel';

/** URL のクエリ（合わない値は無視して既定にする。画面の設計 1.1） */
const querySchema = z.object({
  view: z.enum(['item', 'group']).catch('item'),
  tab: z.string().trim().min(1).max(50).optional().catch(undefined),
  row: z.uuid().optional().catch(undefined),
  group: z.uuid().optional().catch(undefined),
});
export type AllocationQuery = z.output<typeof querySchema>;

export function parseAllocationQuery(params: URLSearchParams): AllocationQuery {
  return querySchema.parse({
    view: params.get('view') ?? undefined,
    tab: params.get('tab') ?? undefined,
    row: params.get('row') ?? undefined,
    group: params.get('group') ?? undefined,
  });
}

export function allocationHref(q: Partial<AllocationQuery>): string {
  const p = new URLSearchParams();
  if (q.view && q.view !== 'item') p.set('view', q.view);
  if (q.tab) p.set('tab', q.tab);
  if (q.row) p.set('row', q.row);
  if (q.group) p.set('group', q.group);
  const s = p.toString();
  return s ? `/allocation?${s}` : '/allocation';
}

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
}) {
  return (
    <div className="mb-3 space-y-1 print:hidden" data-testid="allocation-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin ? (
          <>
            <Button disabled={disabled || autoDisabled} onClick={() => onAuto?.('full')}>
              自動振り分け
            </Button>
            <Button variant="outline" disabled={disabled || minimalDisabled} onClick={() => onAuto?.('minimal_change')}>
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
  const validation = useValidation(full ? snapshot : undefined);
  const tabs = useMemo(() => itemTabs(vm.items), [vm]);
  const tabByItem = useMemo(() => tabKeyByItem(tabs), [tabs]);
  const rowItem = useMemo(() => new Map(stored.map((r) => [r.id, r.itemId])), [stored]);
  const names = useMemo(() => namesOf(vm), [vm]);
  const rulesByCode = useMemo(() => new Map(snapshot.rules.map((r) => [r.code, r])), [snapshot.rules]);
  const ruleText = useCallback((code: string) => {
    const r = rulesByCode.get(code);
    return r ? describeRule(r, vm) : undefined;
  }, [rulesByCode, vm]);
  const groups = useMemo(
    () => (full && validation.yearData ? groupViews(vm, validation.yearData.data, stored) : []),
    [full, validation.yearData, vm, stored],
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
  const setQuery = useCallback((q: Partial<AllocationQuery>) => router.forceReplace(allocationHref(q)), [router]);
  const currentTab = tabs.find((t) => t.key === query.tab) ?? tabs[0] ?? null;
  const targetOf = useCallback(
    (issue: Pick<Issue, 'refs'>): IssueTarget => issueTarget(issue, { rowItem, tabByItem }, audiences, status),
    [rowItem, tabByItem, audiences, status],
  );
  const goTo = useCallback(
    (t: IssueTarget) => {
      const d = t.destination;
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
  useEffect(() => {
    if (!query.row) return;
    const itemId = rowItem.get(query.row);
    const tab = itemId ? tabByItem.get(itemId) : undefined;
    if (tab && query.view === 'item' && tab !== currentTab?.key) {
      setQuery({ view: 'item', tab, row: query.row });
      return;
    }
    document.querySelector(`[data-row-id="${CSS.escape(query.row)}"]`)?.scrollIntoView({ block: 'center' });
  }, [query.row, query.view, rowItem, tabByItem, currentTab, setQuery]);
  useEffect(() => {
    if (highlightRoom) document.querySelector(`[data-room-block="${CSS.escape(highlightRoom)}"]`)?.scrollIntoView({ block: 'start' });
  }, [highlightRoom, currentTab]);
  useEffect(() => {
    if (query.view === 'group' && query.group) {
      document.querySelector(`[data-group-block="${CSS.escape(query.group)}"]`)?.scrollIntoView({ block: 'start' });
    }
  }, [query.view, query.group]);

  // ---- 自動振り分け ----
  const [confirmMode, setConfirmMode] = useState<AllocateMode | null>(null);
  const replaceable = stored.filter(isReplaceableRow).length;
  const autoRows = replaceable;
  const problems = validation.yearData?.problems ?? [];
  const unverified = auto.state.outcome?.kind === 'unverified';
  const autoBlock: string | null = !allocating
    ? null
    : running
      ? null
      : problems.length > 0
        ? '入力に誤りがあるので、自動振り分けはできません（下の一覧を直してください）'
        : unverified
          ? '前の保存が保存されたか確かめるまで、もう一度実行できません'
          : engineState === 'loading' || engineState === 'idle'
            ? '計算エンジンを読み込み中（初回だけ。約 1.2 MB）'
            : null;
  const autoDisabled = !allocating || running || problems.length > 0 || unverified || engineState === 'loading' || engineState === 'idle';
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

  const errorsAfter = auto.state.outcome?.kind === 'saved' ? validation.issues.filter((i) => i.severity === 'error').length : 0;
  const hasRows = stored.length > 0;

  return (
    <>
    <div aria-busy={running || undefined}>
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
          exportDisabled={running}
          exporting={exporting}
          onAuto={(mode) => setConfirmMode(mode)}
          onExport={onExport}
          autoHint={isAdmin ? (autoBlock ?? engineNote) : null}
        />
      ) : null}

      {isAdmin && (allocating || status === 'confirmed') ? (
        <div className="mb-3 print:hidden">
          <YearStatusActions
            year={snapshot.year}
            snapshotVersion={snapshot.version}
            validation={validation}
            stale={stale}
            unsaved={false}
            onReloadSnapshot={() => refetch()}
            names={names}
            closeExtras={
              <Button variant="outline" disabled={exporting} onClick={() => void doExport()}>
                振り分け表を書き出す
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="mb-3 space-y-2">
        {!isAdmin && full ? (
          <ReadOnlyNotice>部員は振り分けを見るだけです（自動振り分け・編集・確定は管理者が行います）。</ReadOnlyNotice>
        ) : null}
        {isAdmin && status === 'confirmed' ? <ReadOnlyNotice>確定中です。直すときは「確定を解除」してください。</ReadOnlyNotice> : null}
        {status === 'closed' ? <ReadOnlyNotice status="closed" /> : null}
        {auto.state.outcome ? (
          <AutoResult
            outcome={auto.state.outcome}
            vm={vm}
            errorsAfter={errorsAfter}
            onIssue={(issue) => goTo(targetOf(issue))}
            onRecheck={auto.recheck}
            onReload={() => void refetch()}
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

      <div className={cn('grid gap-6', full && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
        <div className="min-w-0 space-y-3">
          {full ? (
            <div className="flex gap-1" role="group" aria-label="表示の切り替え">
              <Button size="sm" variant={query.view === 'item' ? 'default' : 'outline'} aria-pressed={query.view === 'item'} onClick={() => setQuery({ view: 'item', tab: currentTab?.key })}>
                品目別
              </Button>
              <Button size="sm" variant={query.view === 'group' ? 'default' : 'outline'} aria-pressed={query.view === 'group'} onClick={() => setQuery({ view: 'group' })}>
                団体別
              </Button>
            </div>
          ) : null}
          {query.view === 'group' && full ? (
            <GroupViewList views={groups} highlightGroupId={query.group ?? null} />
          ) : currentTab ? (
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
                rows={stored}
                tab={currentTab}
                highlightRowId={query.row ?? null}
                highlightRoomId={highlightRoom}
                readOnlyList={!full}
              />
            </Tabs>
          ) : null}
        </div>
        {full ? (
          <aside className="min-w-0">
            {validation.status === 'skipped' ? null : (
              <IssuesPanel validation={validation} targetOf={targetOf} onSelect={(_, t) => goTo(t)} ruleText={ruleText} />
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
    </div>
    <AutoRunLock state={auto.state} onCancel={auto.cancel} />
    </>
  );
}
