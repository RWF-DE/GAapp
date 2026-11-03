import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { ShiftsScreen } from '@/components/shifts/shifts-screen';
import { LoadingState } from '@/components/states';

// シフト表（/shifts。04「シフト表」。T20・D-56）。総務（部門長以上は作る・直す、総務部門員は読むだけ）。`?day=`（日のタブ）と
// `?filter=short`（足りないますを目立たせる）を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function ShiftsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/shifts">
        <ShiftsScreen />
      </RequireAudience>
    </Suspense>
  );
}
