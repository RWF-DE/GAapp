import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { HomeScreen } from '@/components/dashboard/home-screen';
import { LoadingState } from '@/components/states';

// ホーム（/。画面の設計 3.1。T09）。admin・staff はダッシュボード、団体代表・閲覧のみはホーム。
// T04 のホームの「立場の一覧」（data-testid="home-year"・"home-roles"）は、同じ文字のまま全員に出す。
export default function HomePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/">
        <HomeScreen />
      </RequireAudience>
    </Suspense>
  );
}
