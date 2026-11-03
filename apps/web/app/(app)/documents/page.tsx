import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { DocumentsScreen } from '@/components/documents/documents-screen';
import { LoadingState } from '@/components/states';

// 提出状況（/documents。04「提出状況 /documents（PC）」。T19・D-55）。総務（管理者・総務部門長・総務副部門長・総務部門員）。閲覧のみ・店長・
// 副店長には権限なしを出す（Q5。ナビにも出ない）。`?tab=`・`?status=`・`?document=`・`?group=` を読むので Suspense で包む（静的書き出し。
// 動的なセグメントなし）。
export default function DocumentsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/documents">
        <DocumentsScreen />
      </RequireAudience>
    </Suspense>
  );
}
