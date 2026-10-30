import { Suspense } from 'react';
import { PlaceholderPage } from '@/components/layout/placeholder-page';
import { LoadingState } from '@/components/states';

// 履歴（/history）の雛形（T09a）。T14 がこのファイルを中身に置き換える。
// ページは <Suspense> と <RequireAudience href="/history"> で包んで画面の部品を置くだけにする（画面の設計 1.2・1.9）。
// クエリ（table・group・from・to・user）は画面の部品で useSearchParams から読み、zod で確かめる（合わない値は無視して既定にする）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PlaceholderPage href="/history" />
    </Suspense>
  );
}
