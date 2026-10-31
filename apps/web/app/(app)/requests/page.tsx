import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { RequestsScreen } from '@/components/requests/requests-screen';
import { LoadingState } from '@/components/states';

// 申請一覧（/requests。部門長以上は読み書き、総務部門員は読み取り。画面の設計 3.6。T11）。
// クエリ（category・filter）は RequestsScreen が useSearchParams で読み、zod で確かめる（合わない値は無視して既定にする）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/requests">
        <RequestsScreen />
      </RequireAudience>
    </Suspense>
  );
}
