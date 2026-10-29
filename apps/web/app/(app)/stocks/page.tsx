import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { StocksScreen } from '@/components/stock/stocks-screen';
import { LoadingState } from '@/components/states';

// 在庫一覧（/stocks。T10）。ページは <Suspense> と <RequireAudience href="/stocks"> で包んで画面の部品を置くだけにする（画面の設計 1.2・1.9）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/stocks">
        <StocksScreen />
      </RequireAudience>
    </Suspense>
  );
}
