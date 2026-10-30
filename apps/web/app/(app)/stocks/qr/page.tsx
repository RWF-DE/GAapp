import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { StockQrScreen } from '@/components/stock/stock-qr-screen';
import { LoadingState } from '@/components/states';

// 部屋の QR の印刷（/stocks/qr?rooms=…。T10）。ページは <Suspense> と <RequireAudience href="/stocks/qr"> で包んで画面の部品を置くだけにする
// （画面の設計 1.2・1.9）。クエリ（rooms）は画面の部品で useSearchParams から読み、zod で確かめる。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/stocks/qr">
        <StockQrScreen />
      </RequireAudience>
    </Suspense>
  );
}
