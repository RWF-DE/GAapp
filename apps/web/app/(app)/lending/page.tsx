import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { LendingScreen } from '@/components/lending/lending-screen';
import { LoadingState } from '@/components/states';

// 備品と割り当て（/lending。04「テント等の貸し出し」。T21・D-57）。総務と閲覧のみ（閲覧のみは確定後の備品と割り当てだけ）。
// `?view=all`・`?category=`（割り当ての表の絞り込み）を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function LendingPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/lending">
        <LendingScreen />
      </RequireAudience>
    </Suspense>
  );
}
