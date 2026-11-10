import { Suspense } from 'react';
import { RequireAudience } from '@/components/auth/require-audience';
import { RoomPhotosScreen } from '@/components/room-photos/room-photos-screen';
import { LoadingState } from '@/components/states';

// 現状復帰の写真（/room-photos?room=…。T25・D-63）。ページは <Suspense> と <RequireAudience href="/room-photos">（総務と、区分「部門」の
// 団体の代表）で包んで画面の部品を置くだけにする。クエリ（room）は画面の部品で useSearchParams から読み、zod で確かめる。
export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RequireAudience href="/room-photos">
        <RoomPhotosScreen />
      </RequireAudience>
    </Suspense>
  );
}
