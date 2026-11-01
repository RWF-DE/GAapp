'use client';

// 作業の一覧（/tasks の中身。04「作業一覧」の1件に出すもの・形、notes/T20.md「画面の約束」7・13。T20・D-56）。
// 広い PC（lg 以上）は CSS grid の表のような並び（列：状態・題名と説明・担当者・締切・更新・操作。列の見出しの行は aria-hidden）、それより
// 狭い幅（スマホと md）は1件ずつのカードを縦に重ねる。同じ <ul> を幅で並べ替え、DOM を2つ作らない（お知らせ一覧と同じ）。
// 説明は書いたとおりの文字で出す（改行を残し、長い語も折り返す。リンクにしない・HTML として読まない）。
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AppRole } from '@/lib/auth/roles';
import { isSoumu } from '@/lib/auth/roles';
import type { TaskRow } from '@/lib/data/tasks';
import { formatDateTimeSeconds, formatShortDateTime, tokyoToday } from '@/lib/datetime';
import { formatShortDateTimeWeekday } from '@/lib/datetime-weekday';
import { TASK_STATUS_LABELS, type TaskStatus } from '@/lib/modules/shifts/labels';
import { NAME_UNKNOWN } from '@/lib/modules/shifts/names';
import { isTaskOverdue } from '@/lib/modules/shifts/tasks';
import { cn } from '@/lib/utils';
import { TaskStatusButtons } from './task-status-buttons';

/** 1件の文言（04「作業一覧」） */
export const TASK_ITEM_TEXTS = {
  unassigned: '担当者なし',
  notSoumu: '担当者が総務でない',
  overdue: '締切を過ぎました',
  noDue: '締切なし',
} as const;

const STATUS_CLASS: Record<TaskStatus, string> = {
  todo: 'border-slate-300 bg-slate-50 text-slate-800',
  doing: 'border-sky-300 bg-sky-50 text-sky-900',
  done: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

export interface TaskListProps {
  tasks: readonly TaskRow[];
  now: number;
  names: ReadonlyMap<string, string>;
  /** 担当者のロール（部門長以上だけ。「担当者が総務でない」）。null なら分けない */
  roles: ReadonlyMap<string, AppRole> | null;
  /** `?task=` の作業（目立たせて見える所に送る） */
  highlightId: string | null;
  /** その作業の状態のボタンを出すか（担当者と部門長以上で、終了した年度でない） */
  canSetStatus: (t: TaskRow) => boolean;
  /** 編集・削除を出すか（部門長以上で、終了した年度でない） */
  canEdit: boolean;
  /** 状態を送っている作業 */
  pendingIds: ReadonlySet<string>;
  /** 状態のボタンの後の知らせ（応答が届かなかったとき） */
  notice: { id: string; message: string } | null;
  onStatus: (t: TaskRow, next: TaskStatus) => void;
  onEdit: (t: TaskRow) => void;
  onDelete: (t: TaskRow) => void;
}

export function TaskList(props: TaskListProps) {
  const { tasks, canEdit } = props;
  const showActions = canEdit || tasks.some((t) => props.canSetStatus(t));
  const cols = showActions
    ? 'lg:grid-cols-[6rem_minmax(0,1fr)_9rem_10rem_10rem_minmax(14rem,auto)]'
    : 'lg:grid-cols-[6rem_minmax(0,1fr)_9rem_10rem_10rem]';
  return (
    <div className="rounded-lg border bg-card">
      <div aria-hidden className={cn('hidden gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid', cols)}>
        <span>状態</span>
        <span>題名と説明</span>
        <span>担当者</span>
        <span>締切</span>
        <span>更新</span>
        {showActions ? <span className="text-right">操作</span> : null}
      </div>
      <ul data-testid="tasks-list" className="divide-y">
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} cols={cols} showActions={showActions} {...props} />
        ))}
      </ul>
    </div>
  );
}

function TaskItem({
  task: t,
  cols,
  showActions,
  now,
  names,
  roles,
  highlightId,
  canSetStatus,
  canEdit,
  pendingIds,
  notice,
  onStatus,
  onEdit,
  onDelete,
}: TaskListProps & { task: TaskRow; cols: string; showActions: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const highlighted = t.id === highlightId;
  // ダッシュボードから来た作業（?task=）は見える所に送る
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);
  const overdue = isTaskOverdue(t, now);
  const assigneeRole = t.assignee_id && roles ? roles.get(t.assignee_id) : undefined;
  const notSoumu = !!t.assignee_id && !!roles && assigneeRole !== undefined && !isSoumu(assigneeRole);
  const thisYear = Number(tokyoToday(new Date(now)).slice(0, 4));
  const updater = t.updated_by ? (names.get(t.updated_by) ?? NAME_UNKNOWN) : NAME_UNKNOWN;
  const statusOk = canSetStatus(t);
  return (
    <li
      ref={ref}
      data-testid="tasks-item"
      data-id={t.id}
      data-status={t.status}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('grid gap-2 px-4 py-3 lg:items-start lg:gap-4', cols, highlighted && 'bg-amber-50 ring-2 ring-inset ring-amber-300')}
    >
      <div>
        <Badge data-testid="tasks-item-status" variant="outline" className={STATUS_CLASS[t.status]}>
          {TASK_STATUS_LABELS[t.status]}
        </Badge>
      </div>
      <div className="min-w-0 space-y-1">
        <h3 data-testid="tasks-item-title" className={cn('font-semibold [overflow-wrap:anywhere]', t.status === 'done' && 'text-muted-foreground')}>
          {t.title}
        </h3>
        {t.note ? (
          <p data-testid="tasks-item-note" className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {t.note}
          </p>
        ) : null}
      </div>
      <div className="text-sm">
        <span className="text-xs text-muted-foreground lg:hidden">担当者：</span>
        <span data-testid="tasks-item-assignee" className="[overflow-wrap:anywhere]">
          {t.assignee_id ? (names.get(t.assignee_id) ?? NAME_UNKNOWN) : TASK_ITEM_TEXTS.unassigned}
        </span>
        {notSoumu ? (
          <Badge data-testid="tasks-item-not-soumu" variant="outline" className="ml-1 border-amber-400 bg-amber-50 text-amber-900">
            {TASK_ITEM_TEXTS.notSoumu}
          </Badge>
        ) : null}
      </div>
      <div className="text-sm">
        <span className="text-xs text-muted-foreground lg:hidden">締切：</span>
        <span data-testid="tasks-item-due" data-overdue={overdue ? 'true' : undefined} className={cn('tabular-nums', overdue && 'font-semibold text-destructive')}>
          {t.due_at ? formatShortDateTimeWeekday(t.due_at, thisYear) || '—' : TASK_ITEM_TEXTS.noDue}
          {overdue ? <span className="block text-xs">{TASK_ITEM_TEXTS.overdue}</span> : null}
        </span>
      </div>
      <p data-testid="tasks-item-updated" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {updater}が{' '}
        <time dateTime={t.updated_at} title={formatDateTimeSeconds(t.updated_at)}>
          {formatShortDateTime(t.updated_at)}
        </time>{' '}
        に更新
      </p>
      {showActions ? (
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {statusOk ? <TaskStatusButtons title={t.title} status={t.status} pending={pendingIds.has(t.id)} onChange={(s) => onStatus(t, s)} /> : null}
          {canEdit ? (
            <>
              <Button size="sm" variant="outline" data-testid="tasks-item-edit" onClick={() => onEdit(t)} aria-label={`「${t.title}」を編集`}>
                編集
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" data-testid="tasks-item-delete" onClick={() => onDelete(t)} aria-label={`「${t.title}」を削除`}>
                削除
              </Button>
            </>
          ) : null}
          {notice?.id === t.id ? (
            <p role="alert" data-testid="tasks-error" data-kind="unknown" className="w-full text-sm text-destructive">
              {notice.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
