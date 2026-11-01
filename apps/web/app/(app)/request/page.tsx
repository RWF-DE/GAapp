import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { RequestTabs } from '@/components/lending/request-tabs';
import { RequestScreen } from '@/components/requests/request-screen';
import { LoadingState } from '@/components/states';

// 申請（/request。団体代表。画面の設計 3.5。T11）。クエリ（group）は RequestScreen が useSearchParams で読み、zod で確かめる。
// T21：テント等のタブ（「机・椅子」「テント等」。`?tab=lending`）で包む。机・椅子は RequestScreen のまま（作り直さない）。
// その団体の区分で申請できるテント等の備品がなければ、タブを出さずに今の画面のまま（components/lending/request-tabs.tsx）。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/request">
        <RequestTabs>
          <RequestScreen />
        </RequestTabs>
      </RequireAudience>
    </Suspense>
  );
}
