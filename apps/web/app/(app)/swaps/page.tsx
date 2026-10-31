import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { SwapsScreen } from '@/components/swaps/swaps-screen';
import { LoadingState } from '@/components/states';

// キャスター机交換（/swaps。画面の設計 3.10。T13）。部門長以上。クエリは使わない。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/swaps">
        <SwapsScreen />
      </RequireAudience>
    </Suspense>
  );
}
