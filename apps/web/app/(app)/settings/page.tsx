import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { SettingsScreen } from '@/components/settings/settings-screen';
import { LoadingState } from '@/components/states';

// マスタ設定（/settings。画面の設計 3.2。T09）。部門長以上（開けるタブは段ごと。D-50）。タブはクエリの tab（画面の部品で useSearchParams から読み、
// 合わない値は既定の years にする）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/settings">
        <SettingsScreen />
      </RequireAudience>
    </Suspense>
  );
}
