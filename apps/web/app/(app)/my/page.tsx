import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { MyScreen } from '@/components/my/my-screen';
import { LoadingState } from '@/components/states';

// 自団体の振り分け（/my。画面の設計 3.11。T13）。団体代表。クエリ（group）は画面の部品で useSearchParams から読み、
// zod で確かめる（合わない値は無視して最初の団体にする）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/my">
        <MyScreen />
      </RequireAudience>
    </Suspense>
  );
}
