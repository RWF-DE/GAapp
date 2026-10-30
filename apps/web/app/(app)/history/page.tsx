import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { HistoryScreen } from '@/components/history/history-screen';
import { LoadingState } from '@/components/states';

// 履歴（/history。画面の設計 3.12。T14）。管理者。クエリ（table・group・from・to・user）は画面の部品で useSearchParams から読む。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/history">
        <HistoryScreen />
      </RequireAudience>
    </Suspense>
  );
}
