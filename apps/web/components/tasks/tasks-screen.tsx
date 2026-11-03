'use client';

// 作業一覧（/tasks。PC・スマホ。04「作業一覧」、notes/T20.md「画面の約束」7・13。T20・D-56）。
// - 読む：開いている年度の作業の全部と表示名（先読み・記録・先送りの対象。lib/data/screen-queries.ts の planTasksPrefetch）。部門長以上は
//   ロールの一覧も（担当者を選ぶ一覧と「担当者が総務でない」）。最終読み込みと「読み直す」。
// - 進み具合（その年度の全部で「完了 12／20（作業中 5・未着手 3・締切を過ぎた 2）」）、絞り込み（`?filter=`。件数つき。既定は総務部門員が
//   自分の作業、部門長以上がすべて）、`?task=`（ダッシュボードから来た作業を目立たせて見える所に送る。絞り込みは「すべて」にする）。
// - 状態のボタン（担当者と部門長以上。終了した年度を除く）は set_task_status（(B1)。task-write.ts の runTaskStatus）。
// - 部門長以上（終了した年度を除く）：「作業を足す」・編集・削除。ダイアログは動的 import（総務部門員の JS に入れない）。
// - 終了した年度では、状態のボタン・作る・編集・削除を出さず、総務に「終了した年度のため、シフトと作業は読むだけです」の帯を出す。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import { isLead, isSoumu, type AppRole } from '@/lib/auth/roles';
import { deleteTask, dropTaskFromCache, invalidateTasks, putTaskInCache, readTask, setTaskStatus, tasksOptions, type TaskRow } from '@/lib/data/tasks';
import { useYearRow } from '@/lib/data/year';
import { classifyError, effectOf, messageFor, TASK_CONFLICT_MESSAGE, TASK_MISSING_MESSAGE, unknownOutcomeMessage } from '@/lib/errors';
import { TASK_STATUS_LABELS, type TaskStatus } from '@/lib/modules/shifts/labels';
import { nameMapOf } from '@/lib/modules/shifts/names';
import { canEditTasks, canSetTaskStatus, CLOSED_SHIFTS, seesMemberRoles } from '@/lib/modules/shifts/permissions';
import { shiftMembersOptions, soumuNamesOptions } from '@/lib/modules/shifts/reads';
import {
  filterTasks,
  parseTaskParams,
  sortTasks,
  TASK_FILTER_LABELS,
  TASK_FILTERS,
  taskFilterCounts,
  taskProgress,
  taskProgressText,
  tasksHref,
  type TaskFilter,
} from '@/lib/modules/shifts/tasks';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import type { TaskFormTarget } from './task-form-dialog';
import { TaskList } from './task-list';
import { runTaskDelete, runTaskStatus } from './task-write';

// 部門長以上の部品（作る・編集のダイアログ）は動的 import（総務部門員の /tasks の JS に入れない）
const TaskFormDialog = dynamic(() => import('./task-form-dialog').then((m) => m.TaskFormDialog), { ssr: false });

/** 空の表示（04「作業一覧」） */
export const TASKS_EMPTY_TEXTS = {
  none: '作業はまだありません',
  addHint: '「作業を足す」から作れます。',
  filtered: '条件に合う作業はありません',
} as const;
/** 状態のボタンで、応答が届かず版が読んだときのまま */
export const STATUS_UNKNOWN_MESSAGE = '保存できたか分かりません。もう一度押すと、確かめてから送ります';
/** 削除で、版が違った */
export const TASK_DELETE_CHANGED_MESSAGE = 'ほかの人がこの作業を先に変えました。読み直しました。内容を確かめてから、もう一度削除してください';

const TOGGLE_ON = 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground';

export function TasksScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <TasksBoard key={m.year.id} membership={m} yearId={m.year.id} userId={userId} />;
}

function TasksBoard({ membership: m, yearId, userId }: { membership: Membership; yearId: string; userId: string | null }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const filterLabelId = useId();
  const yearQ = useYearRow(yearId);
  const role = m.role;
  const lead = isLead(role);
  const q = useQuery(tasksOptions(yearId));
  const namesQ = useQuery(soumuNamesOptions(yearId));
  const membersQ = useQuery({ ...shiftMembersOptions(yearId), enabled: lead });
  // 画面を開いた時刻（締切を過ぎた・近いの判定）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  const status = yearQ.data?.status ?? m.year?.status ?? null;
  const editable = canEditTasks(role, status) && !!userId;
  const names = useMemo(() => nameMapOf(namesQ.data), [namesQ.data]);
  const roles = useMemo(
    () => (seesMemberRoles(role) && membersQ.data ? new Map<string, AppRole>(membersQ.data.map((r) => [r.user_id, r.role])) : null),
    [role, membersQ.data],
  );

  const [form, setForm] = useState<TaskFormTarget | null>(null);
  const [deleting, setDeleting] = useState<TaskRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [statusNotice, setStatusNotice] = useState<{ id: string; message: string } | null>(null);

  const reload = () => {
    setNow(Date.now());
    void q.refetch();
    void namesQ.refetch();
    if (lead) void membersQ.refetch();
    void yearQ.refetch();
  };
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };

  const parsed = parseTaskParams(params, lead);
  const highlightRow = q.data && parsed.highlight ? (q.data.find((t) => t.id === parsed.highlight) ?? null) : null;
  // ?task= の作業（読めた作業だけ）があれば、絞り込みは「すべて」にする
  const filter: TaskFilter = highlightRow ? 'all' : parsed.filter;
  const setFilter = (f: TaskFilter) => router.forceReplace(tasksHref(f, lead));

  const changeStatus = async (t: TaskRow, next: TaskStatus) => {
    if (pendingIds.has(t.id)) return;
    setPendingIds((s) => new Set(s).add(t.id));
    setStatusNotice((n) => (n?.id === t.id ? null : n));
    try {
      const r = await runTaskStatus({ status: next, baseVersion: t.updated_at, send: () => setTaskStatus(t, next), reread: () => readTask(t.id) }, onAuthError);
      switch (r.type) {
        case 'saved':
          putTaskInCache(queryClient, yearId, r.row);
          invalidateTasks(queryClient, yearId);
          toast.success(r.before ? '保存されていました' : `「${t.title}」を${TASK_STATUS_LABELS[next]}にしました`);
          return;
        case 'conflict':
          if (r.row) putTaskInCache(queryClient, yearId, r.row);
          invalidateTasks(queryClient, yearId);
          toast.error(r.row ? `${TASK_CONFLICT_MESSAGE}（今は「${TASK_STATUS_LABELS[r.row.status]}」です）` : TASK_CONFLICT_MESSAGE);
          return;
        case 'missing':
          dropTaskFromCache(queryClient, yearId, t.id);
          invalidateTasks(queryClient, yearId);
          toast.error(TASK_MISSING_MESSAGE);
          return;
        case 'unknown':
          setStatusNotice({ id: t.id, message: STATUS_UNKNOWN_MESSAGE });
          return;
        case 'failed': {
          const c = classifyError(r.error);
          const effect = effectOf(c);
          if (effect.reload === 'year') {
            reloadYear();
            reload();
          } else if (effect.reload === 'data') reload();
          toast.error(messageFor(c, { rpc: 'set_task_status' }));
          return;
        }
      }
    } finally {
      setPendingIds((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
    }
  };

  const confirmDelete = async () => {
    const t = deleting;
    if (!t) return;
    const afterUnknown = deleteError !== null;
    setDeleteError(null);
    const r = await runTaskDelete({ send: () => deleteTask(t), reread: () => readTask(t.id), baseVersion: t.updated_at }, onAuthError);
    switch (r.type) {
      case 'deleted':
        dropTaskFromCache(queryClient, yearId, t.id);
        invalidateTasks(queryClient, yearId);
        if (r.before && afterUnknown) toast.success(`「${t.title}」は削除されていました`);
        else if (r.before) toast.info('すでに削除されていました（ほかの人が削除した可能性があります）');
        else toast.success(`「${t.title}」を削除しました`);
        return;
      case 'changed':
        invalidateTasks(queryClient, yearId);
        toast.error(TASK_DELETE_CHANGED_MESSAGE);
        return;
      case 'unknown':
        setDeleteError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed': {
        const c = classifyError(r.error);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          reloadYear();
          reload();
        } else if (effect.reload === 'data') reload();
        toast.error(messageFor(c));
        return;
      }
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="作業一覧"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={reload}
        reloading={q.isFetching || namesQ.isFetching}
        actions={
          editable ? (
            <Button data-testid="tasks-add" onClick={() => setForm({ type: 'new' })} disabled={!q.data}>
              <Plus aria-hidden />
              作業を足す
            </Button>
          ) : undefined
        }
      />
      {status === 'closed' && isSoumu(role) ? <ReadOnlyNotice>{CLOSED_SHIFTS}</ReadOnlyNotice> : null}
      {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      {namesQ.isError && !namesQ.data ? <ErrorBanner error={namesQ.error} onRetry={() => void namesQ.refetch()} /> : null}
      <QueryState query={q}>
        {(rows) => {
          const counts = taskFilterCounts(rows, userId, now);
          const shown = sortTasks(filterTasks(rows, filter, userId, now));
          return (
            <div className="space-y-4">
              {rows.length > 0 ? (
                <p data-testid="tasks-progress" className="text-sm font-medium">
                  {taskProgressText(taskProgress(rows, now))}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <span id={filterLabelId} className="text-sm text-muted-foreground">
                  絞り込み
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={2}
                  value={filter}
                  onValueChange={(v) => {
                    if (v) setFilter(v as TaskFilter);
                  }}
                  aria-labelledby={filterLabelId}
                  data-testid="tasks-filter"
                  className="flex-wrap"
                >
                  {TASK_FILTERS.map((f) => (
                    <ToggleGroupItem key={f} value={f} className={TOGGLE_ON} data-filter={f}>
                      {TASK_FILTER_LABELS[f]}（{counts[f]}）
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {shown.length > 0 ? (
                <TaskList
                  tasks={shown}
                  now={now}
                  names={names}
                  roles={roles}
                  highlightId={highlightRow?.id ?? null}
                  canSetStatus={(t) => canSetTaskStatus(role, status, t, userId)}
                  canEdit={editable}
                  pendingIds={pendingIds}
                  notice={statusNotice}
                  onStatus={(t, s) => void changeStatus(t, s)}
                  onEdit={(t) => setForm({ type: 'edit', task: t })}
                  onDelete={(t) => {
                    setDeleteError(null);
                    setDeleting(t);
                  }}
                />
              ) : (
                <div data-testid="tasks-empty">
                  <EmptyState
                    title={rows.length === 0 ? TASKS_EMPTY_TEXTS.none : TASKS_EMPTY_TEXTS.filtered}
                    description={rows.length === 0 && editable ? TASKS_EMPTY_TEXTS.addHint : undefined}
                  />
                </div>
              )}
            </div>
          );
        }}
      </QueryState>
      {/* 開いているダイアログは、書けなくなっても（権限か年度の状態が変わった）入力を残して出したまま（送るボタンを押せなくする） */}
      {(editable || form !== null) && userId ? (
        <TaskFormDialog
          target={form}
          onClose={() => setForm(null)}
          yearId={yearId}
          userId={userId}
          writable={editable}
          members={membersQ.data ?? []}
          names={names}
          onReload={reload}
          onReloadMembership={reloadYear}
          onReloadMembers={() => void membersQ.refetch()}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setDeleteError(null);
          }
        }}
        title={deleting ? `「${deleting.title}」を削除しますか` : ''}
        description="元に戻せません。"
        confirmLabel="削除する"
        pendingLabel="削除しています…"
        destructive
        onConfirm={confirmDelete}
      >
        <div data-testid="task-delete-confirm">
          {deleteError ? (
            <p role="alert" data-testid="task-delete-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
