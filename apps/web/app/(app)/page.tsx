import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { PortalScreen } from '@/components/portal/portal-screen';
import { LoadingState } from '@/components/states';

// ダッシュボード（/。04「ダッシュボード」。T16。D-51）。招待されている人は全員。総務（管理者・総務部門長・総務副部門長・
// 総務部門員）は「ダッシュボード」、閲覧のみ・店長・副店長は「ホーム」。どの立場にも、最初に立場の一覧（data-testid="home-year"・
// "home-roles"。T04 のホームと同じ文字）を出す。T16 より前のダッシュボードの中身は机椅子の状況（/furniture）に移した。
// この page から、スナップショット・検証・机椅子の状況の部品を import しない（団体代表・閲覧のみの / を軽くする）。
export default function HomePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/">
        <PortalScreen />
      </RequireAudience>
    </Suspense>
  );
}
