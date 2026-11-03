// 作業一覧（/tasks）の絞り込み・並び・進み具合と、締切の度合い（04「作業一覧」・「ダッシュボードに出すもの（シフト・作業）」の時刻の
// 決まり、notes/T20.md「画面の約束」7・10。T20・D-56）。純粋な関数（時計は now だけ）。ダッシュボード（portal.ts）も締切の度合いに
// taskSeverity を使う（同じ境目）。
import type { TaskStatus } from './labels';

/** 締切の境目 */
const HOUR_MS = 60 * 60 * 1000;
/** 急ぎ：締切まで 24 時間未満（過ぎたもの・ちょうども） */
export const TASK_URGENT_MS = 24 * HOUR_MS;
/** 締切が近い：72 時間以内（3日以内） */
export const TASK_SOON_MS = 72 * HOUR_MS;

/** 作業の最小の形（絞り込み・並び・進み具合に使う列） */
export interface TaskLike {
  id: string;
  status: TaskStatus;
  due_at: string | null;
  assignee_id: string | null;
  created_at?: string;
}

/** 絞り込み（`?filter=`）：自分の作業・すべて・未完了・締切を過ぎた・締切が近い・担当者なし */
export type TaskFilter = 'mine' | 'all' | 'open' | 'overdue' | 'due-soon' | 'unassigned';

/** 絞り込みの並び（画面の切り替えの順） */
export const TASK_FILTERS: readonly TaskFilter[] = ['mine', 'all', 'open', 'overdue', 'due-soon', 'unassigned'];

/** 絞り込みの名前 */
export const TASK_FILTER_LABELS: Readonly<Record<TaskFilter, string>> = {
  mine: '自分の作業',
  all: 'すべて',
  open: '未完了',
  overdue: '締切を過ぎた',
  'due-soon': '締切が近い',
  unassigned: '担当者なし',
};

const timeOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 締切を過ぎたか（完了でなく、締切が今以前。締切ちょうどは過ぎた側） */
export function isTaskOverdue(t: Pick<TaskLike, 'status' | 'due_at'>, now: number): boolean {
  const due = timeOf(t.due_at);
  return t.status !== 'done' && due !== null && due <= now;
}

/** 締切が近いか（完了でなく、締切が今より後で 72 時間以内） */
export function isTaskDueSoon(t: Pick<TaskLike, 'status' | 'due_at'>, now: number): boolean {
  const due = timeOf(t.due_at);
  return t.status !== 'done' && due !== null && due > now && due - now <= TASK_SOON_MS;
}

/**
 * 締切の度合い（ダッシュボードの要対応。r＝締切 − 今）：r ≤ 0（締切ちょうどは過ぎた側）か r < 24 時間なら急ぎ、24 時間 ≤ r ≤ 72 時間なら
 * ふつう、72 時間より先か締切なしなら参考。
 */
export function taskSeverity(dueAt: string | null | undefined, now: number): 'urgent' | 'normal' | 'info' {
  const due = timeOf(dueAt);
  if (due === null) return 'info';
  const r = due - now;
  if (r < TASK_URGENT_MS) return 'urgent';
  return r <= TASK_SOON_MS ? 'normal' : 'info';
}

/** 絞り込みに入るか */
export function matchesTaskFilter(t: TaskLike, filter: TaskFilter, userId: string | null, now: number): boolean {
  switch (filter) {
    case 'mine':
      return !!userId && t.assignee_id === userId;
    case 'all':
      return true;
    case 'open':
      return t.status !== 'done';
    case 'overdue':
      return isTaskOverdue(t, now);
    case 'due-soon':
      return isTaskDueSoon(t, now);
    case 'unassigned':
      return t.status !== 'done' && t.assignee_id === null;
  }
}

/** 絞り込む（元の並びのまま） */
export function filterTasks<T extends TaskLike>(tasks: readonly T[], filter: TaskFilter, userId: string | null, now: number): T[] {
  return tasks.filter((t) => matchesTaskFilter(t, filter, userId, now));
}

/** 絞り込みごとの件数 */
export function taskFilterCounts(tasks: readonly TaskLike[], userId: string | null, now: number): Record<TaskFilter, number> {
  const out = { mine: 0, all: 0, open: 0, overdue: 0, 'due-soon': 0, unassigned: 0 } as Record<TaskFilter, number>;
  for (const t of tasks) for (const f of TASK_FILTERS) if (matchesTaskFilter(t, f, userId, now)) out[f]++;
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 作業の並び（04「作業一覧」）：完了でないものを先に、その中は締切の早い順（締切のないものは後）、同じなら作った日時の順・id の順。
 * 完了したものは後に同じ並びで。元の配列は変えない。
 */
export function sortTasks<T extends TaskLike>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const da = a.status === 'done' ? 1 : 0;
    const db = b.status === 'done' ? 1 : 0;
    if (da !== db) return da - db;
    const ta = timeOf(a.due_at);
    const tb = timeOf(b.due_at);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    }
    const ca = timeOf(a.created_at) ?? 0;
    const cb = timeOf(b.created_at) ?? 0;
    return ca - cb || cmp(a.id, b.id);
  });
}

/** 進み具合（その年度の作業の全部。絞り込みによらない） */
export interface TaskProgress {
  done: number;
  total: number;
  doing: number;
  todo: number;
  overdue: number;
}

export function taskProgress(tasks: readonly TaskLike[], now: number): TaskProgress {
  const p: TaskProgress = { done: 0, total: tasks.length, doing: 0, todo: 0, overdue: 0 };
  for (const t of tasks) {
    p[t.status]++;
    if (isTaskOverdue(t, now)) p.overdue++;
  }
  return p;
}

/** 進み具合の文（「完了 12／20（作業中 5・未着手 3・締切を過ぎた 2）」） */
export function taskProgressText(p: TaskProgress): string {
  return `完了 ${p.done}／${p.total}（作業中 ${p.doing}・未着手 ${p.todo}・締切を過ぎた ${p.overdue}）`;
}

/** 段の既定の絞り込み（総務部門員は自分の作業、部門長以上はすべて） */
export function defaultTaskFilter(lead: boolean): TaskFilter {
  return lead ? 'all' : 'mine';
}

/**
 * URL のクエリを読む：`?filter=`（知らない値・なしは段の既定）と `?task=<id>`（ダッシュボードから来た作業。空なら null）。
 */
export function parseTaskParams(params: Pick<URLSearchParams, 'get'>, lead: boolean): { filter: TaskFilter; highlight: string | null } {
  const f = params.get('filter');
  const filter = f !== null && (TASK_FILTERS as readonly string[]).includes(f) ? (f as TaskFilter) : defaultTaskFilter(lead);
  const highlight = params.get('task')?.trim() ?? '';
  return { filter, highlight: highlight === '' ? null : highlight };
}

/** 絞り込みを URL にする（`/tasks?filter=…`。段の既定は入れない） */
export function tasksHref(filter: TaskFilter, lead: boolean): string {
  return filter === defaultTaskFilter(lead) ? '/tasks' : `/tasks?filter=${filter}`;
}
