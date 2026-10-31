import { Suspense } from 'react';
import { AllocationScreen } from '@/components/allocation/allocation-screen';
import { RequireAudience } from '@/components/auth/require-audience';
import { LoadingState } from '@/components/states';

// 振り分け（/allocation。画面の設計 3.9。T13）。クエリ（view・tab・row・group）は画面の部品で useSearchParams から読み、zod で確かめる。
// 立場は lib/navigation.ts の表から引く（総務はいつでも、viewer は確定後だけ。Q1・D-50）。確定前の viewer には、RequireAudience が
// 「権限がありません」に「振り分けは確定後に表示されます。」を添える（T15b。画面の部品の中の確かめも二重の守りとして残す）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/allocation">
        <AllocationScreen />
      </RequireAudience>
    </Suspense>
  );
}
