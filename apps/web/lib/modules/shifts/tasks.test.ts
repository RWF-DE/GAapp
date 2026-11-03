// 作業一覧の絞り込み・並び・進み具合と締切の度合い（04「作業一覧」・「ダッシュボードに出すもの（シフト・作業）」の時刻の決まり、
// notes/T20.md「画面の約束」7。T20）：6つの絞り込みと件数、並び、進み具合の文、締切を過ぎた・近いの境目（締切ちょうど・72 時間）、度合いの
// 境目（0・24 時間・72 時間）、`?filter=`・`?task=` の読み取り（知らない値は段の既定）と URL。
import { describe, expect, it } from 'vitest';
import {
  filterTasks,
  isTaskDueSoon,
  isTaskOverdue,
  parseTaskParams,
  sortTasks,
  taskFilterCounts,
  taskProgress,
  taskProgressText,
  tasksHref,
  taskSeverity,
  type TaskLike,
} from './tasks';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2027-10-14T03:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const ME = 'me';

const task = (id: string, over: Partial<TaskLike> = {}): TaskLike => ({
  id,
  status: 'todo',
  due_at: null,
  assignee_id: null,
  created_at: '2027-10-01T00:00:00Z',
  ...over,
});

const list = (): TaskLike[] => [
  task('a', { assignee_id: ME, due_at: at(NOW - H) }), // 締切を過ぎた（自分）
  task('b', { assignee_id: 'other', status: 'doing', due_at: at(NOW + 10 * H) }), // 締切が近い
  task('c', { status: 'done', due_at: at(NOW - 5 * H), assignee_id: ME }), // 完了（過ぎていても数えない）
  task('d', {}), // 担当者なし・締切なし
  task('e', { assignee_id: ME, due_at: at(NOW + 100 * H) }),
];

describe('T20 締切の境目', () => {
  it('締切を過ぎた：完了でなく締切が今以前（ちょうどは過ぎた側）。締切が近い：今より後で 72 時間以内', () => {
    expect(isTaskOverdue({ status: 'todo', due_at: at(NOW) }, NOW)).toBe(true);
    expect(isTaskOverdue({ status: 'done', due_at: at(NOW - H) }, NOW)).toBe(false);
    expect(isTaskOverdue({ status: 'todo', due_at: null }, NOW)).toBe(false);
    expect(isTaskDueSoon({ status: 'todo', due_at: at(NOW) }, NOW)).toBe(false);
    expect(isTaskDueSoon({ status: 'doing', due_at: at(NOW + 72 * H) }, NOW)).toBe(true);
    expect(isTaskDueSoon({ status: 'doing', due_at: at(NOW + 72 * H + 1) }, NOW)).toBe(false);
  });

  it('度合い：締切 − 今が 0 以下・24 時間未満は急ぎ、24〜72 時間はふつう、72 時間より先と締切なしは参考', () => {
    expect(taskSeverity(at(NOW - H), NOW)).toBe('urgent');
    expect(taskSeverity(at(NOW), NOW)).toBe('urgent');
    expect(taskSeverity(at(NOW + 24 * H - 1), NOW)).toBe('urgent');
    expect(taskSeverity(at(NOW + 24 * H), NOW)).toBe('normal');
    expect(taskSeverity(at(NOW + 72 * H), NOW)).toBe('normal');
    expect(taskSeverity(at(NOW + 72 * H + 1), NOW)).toBe('info');
    expect(taskSeverity(null, NOW)).toBe('info');
    expect(taskSeverity('x', NOW)).toBe('info');
  });
});

describe('T20 絞り込み・並び・進み具合', () => {
  it('6つの絞り込みと件数（担当者なし・締切は完了でないものだけ）', () => {
    const ids = (f: Parameters<typeof filterTasks>[1]) => filterTasks(list(), f, ME, NOW).map((t) => t.id);
    expect(ids('mine')).toEqual(['a', 'c', 'e']);
    expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids('open')).toEqual(['a', 'b', 'd', 'e']);
    expect(ids('overdue')).toEqual(['a']);
    expect(ids('due-soon')).toEqual(['b']);
    expect(ids('unassigned')).toEqual(['d']);
    expect(filterTasks(list(), 'mine', null, NOW)).toEqual([]);
    expect(taskFilterCounts(list(), ME, NOW)).toEqual({ mine: 3, all: 5, open: 4, overdue: 1, 'due-soon': 1, unassigned: 1 });
  });

  it('並び：完了でないものを先に締切の早い順（締切なしは後）、同じなら作った順・id、完了は後', () => {
    const extra = [...list(), task('f', { due_at: at(NOW - H), created_at: '2027-09-30T00:00:00Z' })];
    expect(sortTasks(extra).map((t) => t.id)).toEqual(['f', 'a', 'b', 'e', 'd', 'c']);
  });

  it('進み具合（絞り込みによらない全部）と文', () => {
    const p = taskProgress(list(), NOW);
    expect(p).toEqual({ done: 1, total: 5, doing: 1, todo: 3, overdue: 1 });
    expect(taskProgressText(p)).toBe('完了 1／5（作業中 1・未着手 3・締切を過ぎた 1）');
  });
});

describe('T20 ?filter=・?task= と URL', () => {
  it('知らない値・なしは段の既定（部門員は自分の作業、部門長以上はすべて）。?task= は空なら null', () => {
    const p = (s: string, lead: boolean) => parseTaskParams(new URLSearchParams(s), lead);
    expect(p('', false)).toEqual({ filter: 'mine', highlight: null });
    expect(p('', true)).toEqual({ filter: 'all', highlight: null });
    expect(p('filter=overdue', false).filter).toBe('overdue');
    expect(p('filter=x', true).filter).toBe('all');
    expect(p('task=%20abc%20', false).highlight).toBe('abc');
    expect(p('task=', false).highlight).toBeNull();
  });

  it('段の既定は URL に入れない', () => {
    expect(tasksHref('mine', false)).toBe('/tasks');
    expect(tasksHref('all', true)).toBe('/tasks');
    expect(tasksHref('all', false)).toBe('/tasks?filter=all');
    expect(tasksHref('due-soon', true)).toBe('/tasks?filter=due-soon');
  });
});
