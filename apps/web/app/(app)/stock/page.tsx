import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { StockScreen } from '@/components/stock/stock-screen';
import { LoadingState } from '@/components/states';

// 在庫入力（/stock?room=…。T10）。ページは <Suspense> と <RequireAudience href="/stock"> で包んで画面の部品を置くだけにする
// （画面の設計 1.2・1.9）。クエリ（room）は画面の部品で useSearchParams から読み、zod で確かめる。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/stock">
        <StockScreen />
      </RequireAudience>
    </Suspense>
  );
}
