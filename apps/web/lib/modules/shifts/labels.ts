// シフト・作業の列挙の表示名（02 の列挙型 task_status の表示名。T20・D-56）。/tasks・ダッシュボードの欄・履歴が読む。
// lib/labels.ts に置かないのは、lib/labels.ts がどの画面の最初に読む JS にも丸ごと入るため（締切と予定の labels.ts と同じ。
// notes/T18.md の「後半の実装で決めたこと」の 2）。履歴の表の名前（AUDIT_TABLE_LABELS の5表）だけは共有の一覧に行を足す。
// import は型だけ（lib/data/history.ts・components/portal から読む）。
import type { Enums } from '@gaapp/shared';

/** 作業の状態（task_status） */
export type TaskStatus = Enums<'task_status'>;

/** 作業の状態の一覧（02 の列挙の並び：未着手・作業中・完了。状態のボタンの並び） */
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done'];

/** 作業の状態：未着手・作業中・完了 */
export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  todo: '未着手',
  doing: '作業中',
  done: '完了',
};
