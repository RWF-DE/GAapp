import { Suspense } from 'react';
import { PlaceholderPage } from '@/components/layout/placeholder-page';
import { LoadingState } from '@/components/states';

// マスタ設定（/settings）の雛形（T09a）。T09 がこのファイルを中身に置き換える。
// ページは <Suspense> と <RequireAudience href="/settings"> で包んで画面の部品を置くだけにする（画面の設計 1.2・1.9）。
// クエリ（tab）は画面の部品で useSearchParams から読み、zod で確かめる（合わない値は無視して既定にする）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PlaceholderPage href="/settings" />
    </Suspense>
  );
}
