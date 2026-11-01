import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { LoadingState } from '@/components/states';
import { TasksScreen } from '@/components/tasks/tasks-screen';

// 作業一覧（/tasks。04「作業一覧」。T20・D-56）。総務（部門長以上は作る・直す・消す・担当者を決める、担当者は状態を変える）。
// `?filter=`（絞り込み）と `?task=`（ダッシュボードから来た作業を目立たせる）を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function TasksPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/tasks">
        <TasksScreen />
      </RequireAudience>
    </Suspense>
  );
}
