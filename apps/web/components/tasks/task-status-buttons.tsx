'use client';

// 作業の状態のボタン（04「作業一覧」の状態のボタン、notes/T20.md「画面の約束」7・13。T20・D-56）。「未着手」「作業中」「完了」の3つ。今の状態の
// ものは押せない（aria-pressed）。担当者と部門長以上に、終了した年度を除いて出す（出すかは呼ぶ側。canSetTaskStatus）。押すと set_task_status。
import { Button } from '@/components/ui/button';
import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from '@/lib/modules/shifts/labels';
import { cn } from '@/lib/utils';

export function TaskStatusButtons({
  title,
  status,
  pending,
  onChange,
}: {
  /** 作業の題名（読み上げの名前） */
  title: string;
  status: TaskStatus;
  /** 送っている間（3つとも押せない） */
  pending: boolean;
  onChange: (next: TaskStatus) => void;
}) {
  return (
    <div role="group" aria-label={`「${title}」の状態`} data-testid="tasks-item-status-buttons" className="inline-flex flex-wrap gap-1">
      {TASK_STATUSES.map((s) => {
        const current = s === status;
        return (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={current ? 'default' : 'outline'}
            data-testid={`task-set-${s}`}
            aria-pressed={current}
            disabled={current || pending}
            className={cn('min-w-16', current && 'disabled:opacity-100')}
            onClick={() => onChange(s)}
          >
            {TASK_STATUS_LABELS[s]}
          </Button>
        );
      })}
    </div>
  );
}
