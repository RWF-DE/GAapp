import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { RequestScreen } from '@/components/requests/request-screen';
import { LoadingState } from '@/components/states';

// 申請（/request。団体代表。画面の設計 3.5。T11）。クエリ（group）は RequestScreen が useSearchParams で読み、zod で確かめる。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/request">
        <RequestScreen />
      </RequireAudience>
    </Suspense>
  );
}
