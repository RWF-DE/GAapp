'use client';

// コードからの移動（画面の設計 1.4 の UnsavedChangesGuard の (2)。T09a）。useRouter の push・replace を直接使わず、
// 未保存の入力を確かめてから移る。ESLint で useRouter の import を止めている（このフォルダと (auth) のページだけ例外）。
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useUnsavedChangesApi } from '@/lib/unsaved-changes';

export interface GuardedRouter {
  /** 未保存の入力があれば確かめてから移る。移ったら true */
  push: (href: string, opts?: { scroll?: boolean }) => Promise<boolean>;
  replace: (href: string, opts?: { scroll?: boolean }) => Promise<boolean>;
  /** 確かめずに移る（もう確かめた後・未ログインのときの /login への移動・ログアウトの後など。入力は下書きに残る） */
  forcePush: (href: string) => void;
  forceReplace: (href: string) => void;
  refresh: () => void;
}

/**
 * @example
 * const router = useGuardedRouter();
 * await router.push(`/stock?room=${roomId}`);
 */
export function useGuardedRouter(): GuardedRouter {
  const router = useRouter();
  const { confirmLeave } = useUnsavedChangesApi();
  return useMemo(
    () => ({
      push: async (href, opts) => {
        if (!(await confirmLeave('navigate'))) return false;
        router.push(href, opts);
        return true;
      },
      replace: async (href, opts) => {
        if (!(await confirmLeave('navigate'))) return false;
        router.replace(href, opts);
        return true;
      },
      forcePush: (href) => router.push(href),
      forceReplace: (href) => router.replace(href),
      refresh: () => router.refresh(),
    }),
    [router, confirmLeave],
  );
}
