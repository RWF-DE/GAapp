'use client';

// 未保存の入力を確かめてから行う、年度の切り替えと手動のログアウト（画面の設計 1.3・1.3.1・1.4、D-33。T09a）。
import { useCallback } from 'react';
import { classifyError } from '@/lib/errors';
import { useUnsavedChangesApi } from '@/lib/unsaved-changes';
import { useAuth } from './auth-provider';

/**
 * 年度を切り替える。未保存の入力があれば「年度を切り替えますか（入力は下書きに残ります）」と確かめ、
 * やめれば何もしない（呼ぶ側の選択は今の年度のまま＝元に戻る）。切り替えたら true。
 *
 * @example
 * const setYear = useGuardedSetYear();
 * <select value={m.year.id} onChange={(e) => void setYear(e.target.value)}>…</select>
 */
export function useGuardedSetYear(): (yearId: string) => Promise<boolean> {
  const { setYear, membership } = useAuth();
  const { confirmLeave } = useUnsavedChangesApi();
  const current = membership.status === 'ready' ? membership.membership.year?.id : undefined;
  return useCallback(
    async (yearId: string) => {
      if (yearId === current) return false;
      if (!(await confirmLeave('year'))) return false;
      setYear(yearId);
      return true;
    },
    [setYear, confirmLeave, current],
  );
}

/**
 * 手動のログアウト（ヘッダー・未招待の画面のボタン）。未保存の入力があれば「ログアウトすると下書きも消えます」と確かめ、
 * やめればログアウトせず下書きも残す。続ければキャッシュ・その人の下書き・選んだ年度を消してログアウトする。ログアウトしたら true。
 */
export function useGuardedSignOut(): () => Promise<boolean> {
  const { signOut } = useAuth();
  const { confirmLeave } = useUnsavedChangesApi();
  return useCallback(async () => {
    if (!(await confirmLeave('signOut'))) return false;
    await signOut('manual');
    return true;
  }, [signOut, confirmLeave]);
}

/**
 * 認証のエラー（PGRST301〜303・401。2.5 の auth）の扱い。セッションの更新を1回試し、更新できたら 'retry'
 * （同じ要求を1回だけ送り直してよい）、だめなら下書きを残して強制の signOut をして 'signedOut'（AppShell が /login?next= に移す）。
 * 認証のエラーでなければ 'other'。
 *
 * @example
 * const onAuthError = useAuthErrorHandler();
 * onError: async (e) => { if ((await onAuthError(e)) === 'retry') m.mutate(vars); else toast.error(messageFor(classifyError(e))); }
 */
export function useAuthErrorHandler(): (e: unknown) => Promise<'retry' | 'signedOut' | 'other'> {
  const { reauthenticate } = useAuth();
  return useCallback(
    async (e: unknown) => {
      if (classifyError(e).kind !== 'auth') return 'other';
      return (await reauthenticate()) ? 'retry' : 'signedOut';
    },
    [reauthenticate],
  );
}
