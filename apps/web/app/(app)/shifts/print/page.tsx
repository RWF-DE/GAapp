import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { ShiftsPrintScreen } from '@/components/shifts/shifts-print-screen';
import { LoadingState } from '@/components/states';

// シフト表の印刷（/shifts/print。04「シフト表の印刷」。T20・D-56）。総務。ナビに出さず、シフト表の「印刷」から開く。`?day=` と
// `?view=table|people` を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function ShiftsPrintPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/shifts/print">
        <ShiftsPrintScreen />
      </RequireAudience>
    </Suspense>
  );
}
