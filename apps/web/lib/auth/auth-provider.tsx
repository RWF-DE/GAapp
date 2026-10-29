'use client';

import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { draftsOnSignIn, draftsOnSignOut, type SignOutKind } from '@/lib/drafts';
import { getSupabase, supabaseConfigError } from '@/lib/supabase/client';
import { loadMembershipSource } from './load-membership';
import { buildMembership, myYears, type Membership, type MembershipSource } from './membership';
import { clearSelectedYear, readSelectedYear, writeSelectedYear } from './selected-year';

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

export type { SignOutKind };

export interface AuthContextValue {
  session: SessionState;
  membership: MembershipState;
  /**
   * 同じ利用者の立場を裏で読み直している間 true。その間も membership は前の値のまま 'ready'
   * （画面を外さない。入力・開いているダイアログを残す。画面の設計 1.3）
   */
  isRefreshing: boolean;
  /** 立場を読み直す（年度の状態の遷移の後・state・forbidden の後・エラーからの再試行） */
  reloadMembership: () => void;
  /**
   * 開く年度を変える（sessionStorage の `gaapp:year:<user_id>`。D-31）。
   * 画面からは直接呼ばず、未保存の入力を確かめる useGuardedSetYear（lib/auth/guarded.ts）を使う（ESLint で止めている）。
   */
  setYear: (yearId: string) => void;
  /**
   * ログアウト（その端末のセッションだけ。scope: 'local'）。キャッシュと選んだ年度は必ず消す。
   * manual（ヘッダーのボタン。確かめは呼ぶ側＝useGuardedSignOut）はその人の下書きも消し、forced（401 など）は下書きを残す（D-33）。
   */
  signOut: (kind?: SignOutKind) => Promise<void>;
  /** 401 などの後：セッションの更新を1回試す。更新できたら true（同じ要求を1回だけ送り直してよい）。だめなら強制の signOut */
  reauthenticate: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const LOAD_ERROR = '利用者の情報を読み込めませんでした。';
const REFRESH_ERROR = '立場を読み直せませんでした。表示は前の立場のままです。しばらくしてから再読み込みしてください。';

interface Loaded {
  userId: string;
  /** 何回目の読み込みの結果か（reloadKey） */
  key: number;
  /** 読めた立場の元（読めなければ null） */
  source: MembershipSource | null;
}

/**
 * ログイン状態と立場を保持する。supabase-js がセッションを localStorage に保存し、トークンを自動で更新する。
 * ログインしたら（ページを開くたびにも）accept_my_invitations を呼んでから立場を読む。
 *
 * - 'loading' にするのは、初回の読み込みと利用者（user_id）が変わったときだけ。同じ利用者の reloadMembership では
 *   前の membership を 'ready' のまま出し、isRefreshing を立てる。読み直しの失敗は前の値を残して toast で知らせる。
 * - ログアウト・利用者の切り替えで消すもの（1.3 の (a)〜(c)）：
 *   (a) 手動：キャッシュ・その人の下書き・選んだ年度。(b) 強制（401・ほかのタブのログアウト）：キャッシュ・選んだ年度（下書きは残す）。
 *   (c) 前と違う user_id でログイン：キャッシュと、自分以外の下書き。
 * QueryClientProvider の中に置く（キャッシュを消すため）。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // 設定の付け忘れはビルド時に決まるので、最初の状態で判定する
  const [session, setSession] = useState<SessionState>(() => {
    const message = supabaseConfigError();
    return message ? { status: 'configError', message } : { status: 'loading' };
  });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<{ userId: string; yearId: string | null } | null>(null);

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

  // 利用者が変わったとき（ログイン・ログアウト・切り替え）の片付けと、そのタブで選んだ年度の読み込み
  const prevUserRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = userId;
    if (prev === userId) return;
    if (prev) {
      // (b)・(c)：前の人のキャッシュと選んだ年度を消す（手動のログアウトでは signOut の中で先に消している）
      queryClient.clear();
      clearSelectedYear(prev);
    }
    if (userId) draftsOnSignIn(userId); // (c)：自分以外の下書きを消す
  }, [userId, queryClient]);

  // そのタブで選んだ年度（setYear で置いた値。まだなければ sessionStorage から読む）
  const selectedYearId = useMemo(
    () => (!userId ? null : selected && selected.userId === userId ? selected.yearId : readSelectedYear(userId)),
    [userId, selected],
  );
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedYearId;
  }, [selectedYearId]);

  // 立場を読む。同じ利用者の読み直しでは前の値を残す（失敗しても残す）
  const loadedRef = useRef<Loaded | null>(null);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    loadMembershipSource(getSupabase(), userId).then(
      (source) => {
        if (!active) return;
        // 選んだ年度にロールも団体代表もなくなっていれば、覚えた値を消す（既定の最新の年度に戻る。D-31）
        const chosen = selectedRef.current;
        if (chosen && !myYears(source).some((y) => y.id === chosen)) {
          writeSelectedYear(userId, null);
          setSelected({ userId, yearId: null });
        }
        setLoaded({ userId, key: reloadKey, source });
      },
      () => {
        if (!active) return;
        const prev = loadedRef.current;
        if (prev && prev.userId === userId && prev.source) {
          toast.error(REFRESH_ERROR);
          setLoaded({ ...prev, key: reloadKey });
        } else {
          setLoaded({ userId, key: reloadKey, source: null });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [userId, reloadKey]);

  const source = loaded && loaded.userId === userId ? loaded.source : null;
  const built = useMemo(() => (source ? buildMembership(source, selectedYearId) : null), [source, selectedYearId]);

  const membership = useMemo<MembershipState>(() => {
    if (!userId) return { status: 'idle' };
    if (!loaded || loaded.userId !== userId) return { status: 'loading' };
    if (built) return { status: 'ready', membership: built };
    return loaded.key === reloadKey ? { status: 'error', message: LOAD_ERROR } : { status: 'loading' };
  }, [userId, loaded, built, reloadKey]);
  const isRefreshing = membership.status === 'ready' && loaded !== null && loaded.key !== reloadKey;

  const reloadMembership = useCallback(() => setReloadKey((k) => k + 1), []);

  const setYear = useCallback(
    (yearId: string) => {
      if (!userId) return;
      writeSelectedYear(userId, yearId);
      setSelected({ userId, yearId });
    },
    [userId],
  );

  const signOut = useCallback(
    async (kind: SignOutKind = 'manual') => {
      queryClient.clear();
      if (userId) {
        draftsOnSignOut(kind, userId);
        clearSelectedYear(userId);
      }
      await getSupabase().auth.signOut({ scope: 'local' });
    },
    [queryClient, userId],
  );

  const reauthenticate = useCallback(async () => {
    try {
      const { data, error } = await getSupabase().auth.refreshSession();
      if (!error && data.session) return true;
    } catch {
      // 更新できなければ下で強制の signOut
    }
    await signOut('forced');
    return false;
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, membership, isRefreshing, reloadMembership, setYear, signOut, reauthenticate }),
    [session, membership, isRefreshing, reloadMembership, setYear, signOut, reauthenticate],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth は AuthProvider の中で使う');
  return ctx;
}
