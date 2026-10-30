import { Suspense } from 'react';
import { PlaceholderPage } from '@/components/layout/placeholder-page';
import { LoadingState } from '@/components/states';

// キャスター机交換（/swaps）の雛形（T09a）。T13 がこのファイルを中身に置き換える。
// ページは <Suspense> と <RequireAudience href="/swaps"> で包んで画面の部品を置くだけにする（画面の設計 1.2・1.9）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PlaceholderPage href="/swaps" />
    </Suspense>
  );
}
