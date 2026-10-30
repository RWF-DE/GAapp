'use client';

import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getSupabase, supabaseConfigError } from '@/lib/supabase/client';
import { loadMembership } from './load-membership';
import type { Membership } from './membership';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; session: Session }
  | { status: 'configError'; message: string };

export type MembershipState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; membership: Membership }
  | { status: 'error'; message: string };

interface AuthContextValue {
  session: SessionState;
  membership: MembershipState;
  /** 立場を読み直す（エラーからの再試行など） */
  reloadMembership: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * ログイン状態を保持する。supabase-js がセッションを localStorage に保存し、トークンを自動で更新する。
 * ログインしたら（ページを開くたびにも）accept_my_invitations を呼んでから、今の年度の立場を読む。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  // 設定の付け忘れはビルド時に決まるので、最初の状態で判定する
  const [session, setSession] = useState<SessionState>(() => {
    const message = supabaseConfigError();
    return message ? { status: 'configError', message } : { status: 'loading' };
  });
  // 読み込んだ立場は「誰の、何回目の読み込みか」と一緒に持つ（ユーザーが変われば自動で読み込み中になる）
  const [loaded, setLoaded] = useState<{ key: string; state: MembershipState } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const configured = session.status !== 'configError';
  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabase();
    let active = true;
    const apply = (s: Session | null) => {
      if (active) setSession(s ? { status: 'signedIn', session: s } : { status: 'signedOut' });
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    // コールバックの中で supabase の非同期の関数を呼ばない（supabase-js のロックで止まるため）。状態を置くだけにする
    const { data } = supabase.auth.onAuthStateChange((_event, s) => apply(s));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [configured]);

  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  const loadKey = userId ? `${userId}:${reloadKey}` : null;

  useEffect(() => {
    if (!userId || !loadKey) return;
    let active = true;
    loadMembership(getSupabase(), userId).then(
      (m) => active && setLoaded({ key: loadKey, state: { status: 'ready', membership: m } }),
      () => active && setLoaded({ key: loadKey, state: { status: 'error', message: '利用者の情報を読み込めませんでした。' } }),
    );
    return () => {
      active = false;
    };
  }, [userId, loadKey]);

  const membership = useMemo<MembershipState>(
    () => (!loadKey ? { status: 'idle' } : loaded?.key === loadKey ? loaded.state : { status: 'loading' }),
    [loadKey, loaded],
  );

  const reloadMembership = useCallback(() => setReloadKey((k) => k + 1), []);
  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ session, membership, reloadMembership, signOut }),
    [session, membership, reloadMembership, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth は AuthProvider の中で使う');
  return ctx;
}
