import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { DocumentScreen } from '@/components/documents/document-screen';
import { LoadingState } from '@/components/states';

// 自団体の提出物（/document。04「自団体の提出物 /document（スマホ）」。T19・D-55）。店長・副店長（店長・副店長も務める管理者・閲覧のみを
// 含む）。`?group=`（代表する団体）と `?document=`（ダッシュボードから来た提出物を目立たせる）を読むので Suspense で包む（静的書き出し。
// 動的なセグメントなし）。
export default function DocumentPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/document">
        <DocumentScreen />
      </RequireAudience>
    </Suspense>
  );
}
