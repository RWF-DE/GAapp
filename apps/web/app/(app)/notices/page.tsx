import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { NoticesScreen } from '@/components/notices/notices-screen';
import { LoadingState } from '@/components/states';

// お知らせ一覧（/notices。04「お知らせ一覧」。T17・D-53）。招待されている全員（総務・閲覧のみ・店長・副店長）。
// 読めるお知らせは RLS が決め、書く・編集・削除は総務だけ（段で出し分ける）。`?audience=`（総務の絞り込み）と `?notice=`
// （ダッシュボードの欄から来たお知らせを目立たせる）を読むので Suspense で包む（静的書き出し。動的なセグメントなし）。
export default function NoticesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/notices">
        <NoticesScreen />
      </RequireAudience>
    </Suspense>
  );
}
