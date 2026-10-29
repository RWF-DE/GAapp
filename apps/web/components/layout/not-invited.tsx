'use client';

import { Button } from '@/components/ui/button';

/**
 * 招待されていない人に出す画面（04「画面仕様」の前書き：「総務から招待されていません」だけを表示する）。
 * ほかの情報（年度・ナビゲーション）は出さない。別のアカウントでログインし直せるよう、ログアウトだけ置く。
 */
export function NotInvited({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-xl font-bold">総務から招待されていません</h1>
      <Button variant="outline" onClick={onSignOut}>
        ログアウト
      </Button>
    </main>
  );
}
