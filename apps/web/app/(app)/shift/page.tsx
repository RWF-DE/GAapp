import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { MyShiftScreen } from '@/components/shifts/my-shift-screen';
import { LoadingState } from '@/components/states';

// 自分のシフト（/shift。04「自分のシフト」。T20・D-56）。総務（管理者・総務部門長・総務副部門長・総務部門員）。部門員がスマホで開く画面
// なので、シフト表の編集の部品は読み込まない。`?day=`（ダッシュボードの締切と予定から来た日を見える所に送る）を読むので Suspense で包む
// （静的書き出し。動的なセグメントなし）。
export default function MyShiftPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/shift">
        <MyShiftScreen />
      </RequireAudience>
    </Suspense>
  );
}
