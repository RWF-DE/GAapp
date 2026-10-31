import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { FurnitureScreen } from '@/components/dashboard/furniture-screen';
import { LoadingState } from '@/components/states';

// 机椅子の状況（/furniture。04「机椅子の状況」。T16）。総務（管理者・総務部門長・総務副部門長・総務部門員）。
// T16 より前に / に出していたダッシュボード（版を先に読むスナップショット・検証・年度の状態の遷移・確定の流れ・版の見張り）を
// そのまま出す（D-51。部品と data-testid は components/dashboard のまま）。立場の一覧と代表する団体はダッシュボード（/）に出す。
export default function FurniturePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/furniture">
        <FurnitureScreen />
      </RequireAudience>
    </Suspense>
  );
}
