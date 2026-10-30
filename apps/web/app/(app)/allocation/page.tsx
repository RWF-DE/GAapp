import { Suspense } from 'react';
import { AllocationScreen } from '@/components/allocation/allocation-screen';
import { RequireAudience } from '@/components/auth/require-audience';
import { LoadingState } from '@/components/states';

// 振り分け（/allocation。画面の設計 3.9。T13）。クエリ（view・tab・row・group）は画面の部品で useSearchParams から読み、zod で確かめる。
// 立場：admin・staff はいつでも、viewer は確定後だけ（Q1）。確定前の viewer には「確定後に表示されます」を出すため、
// href ではなく allow で通し、画面の部品が年度の状態で分ける。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience allow={['admin', 'staff', 'viewer']}>
        <AllocationScreen />
      </RequireAudience>
    </Suspense>
  );
}
