import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { LendingRecordsScreen } from '@/components/lending/records-screen';
import { LoadingState } from '@/components/states';

// 受け渡し・返却（/lending/records。スマホ。04「テント等の貸し出し」。T21・D-57）。総務（部門員を含む）。
// `?group=`（団体の欄）・`?filter=`（状態のチップ）を読むので Suspense で包む（静的書き出し。団体は動的なセグメントにしない）。
export default function LendingRecordsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/lending/records">
        <LendingRecordsScreen />
      </RequireAudience>
    </Suspense>
  );
}
