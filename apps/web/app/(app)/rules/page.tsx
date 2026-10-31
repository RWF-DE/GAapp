import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { RulesScreen } from '@/components/rules/rules-screen';
import { LoadingState } from '@/components/states';

// ルール（/rules。部門長以上）。クエリ（code）は画面の部品で useSearchParams から読む（画面の設計 1.2・1.9・3.8。T12）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/rules">
        <RulesScreen />
      </RequireAudience>
    </Suspense>
  );
}
