'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { loginErrorMessage, oauthCallbackUrl, rememberNext, safeNextPath } from '@/lib/auth/redirect';
import { isTestLoginAvailable } from '@/lib/auth/test-login';
import { BASE_PATH, GOOGLE_HD_HINT, SUPABASE_URL } from '@/lib/env';
import { getSupabase } from '@/lib/supabase/client';

// テスト用ログイン（ローカル専用・E2E 用）。NEXT_PUBLIC_ENABLE_TEST_LOGIN=true でビルドしたときだけ読み込む。
// 文字どおりの process.env の比較にしておくと、フラグなしのビルド（本番）では import ごと消える（CI で確かめる）。
const TestLoginForm =
  process.env.NEXT_PUBLIC_ENABLE_TEST_LOGIN === 'true'
    ? dynamic(() => import('@/components/auth/test-login-form').then((m) => m.TestLoginForm), { ssr: false })
    : null;

const showTestLogin = TestLoginForm !== null && isTestLoginAvailable(true, SUPABASE_URL);

// クエリ（戻り先とエラー）はブラウザで読む（静的書き出しなので、ビルド時には分からない。Suspense が要る）
export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState className="min-h-dvh" />}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const { session } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const urlMessage = loginErrorMessage(params);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // ログイン済みなら戻り先へ
  useEffect(() => {
    if (session.status === 'signedIn') router.replace(next);
  }, [session.status, next, router]);

  const signInWithGoogle = async () => {
    setPending(true);
    setMessage(null);
    rememberNext(next);
    const { error } = await getSupabase().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: oauthCallbackUrl(window.location.origin, BASE_PATH),
        queryParams: { prompt: 'select_account', ...(GOOGLE_HD_HINT ? { hd: GOOGLE_HD_HINT } : {}) },
      },
    });
    if (error) {
      setPending(false);
      setMessage('ログインを始められませんでした。もう一度お試しください。');
    }
  };

  if (session.status === 'loading' || session.status === 'signedIn') {
    return <LoadingState className="min-h-dvh" />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div className="space-y-1 text-center">
        <p className="text-sm text-muted-foreground">電波祭 総務 机椅子管理</p>
        <h1 className="text-2xl font-bold">ログイン</h1>
      </div>
      {session.status === 'configError' ? (
        <p role="alert" className="text-sm text-destructive">
          {session.message}
        </p>
      ) : null}
      {message ?? urlMessage ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {message ?? urlMessage}
        </p>
      ) : null}
      <Button size="lg" onClick={signInWithGoogle} disabled={pending || session.status === 'configError'}>
        学校の Google アカウントでログイン
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        学校の Google アカウントだけが使えます。初めての人は、総務から招待を受けてからログインしてください。
      </p>
      {TestLoginForm && showTestLogin ? <TestLoginForm onSignedIn={() => router.replace(next)} /> : null}
    </main>
  );
}
