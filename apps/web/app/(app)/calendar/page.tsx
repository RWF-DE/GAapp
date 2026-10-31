import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { CalendarScreen } from '@/components/calendar/calendar-screen';
import { LoadingState } from '@/components/states';

// 締切と予定（/calendar。04「締切と予定」。T18・D-54）。招待されている全員（総務・閲覧のみ・店長・副店長）。
// 読める項目は RLS が決め、登録・編集・削除は部門長以上だけ（段で出し分ける）。`?past=`・`?kind=`・`?audience=`（絞り込み）と
// `?event=`（ダッシュボードの欄から来た項目を目立たせる）を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function CalendarPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/calendar">
        <CalendarScreen />
      </RequireAudience>
    </Suspense>
  );
}
