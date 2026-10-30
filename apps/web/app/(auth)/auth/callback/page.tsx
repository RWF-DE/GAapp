'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LoadingState } from '@/components/states';
import { loginErrorMessage, takeRememberedNext } from '@/lib/auth/redirect';
import { getSupabase } from '@/lib/supabase/client';

/**
 * Google から戻る先（PKCE）。?code= をセッションに交換して、ログイン前のページへ戻す。
 * Supabase の Redirect URLs に、この URL（basePath 込み）を登録しておく。
 */
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<LoadingState className="min-h-dvh" label="ログインしています…" />}>
      <Callback />
    </Suspense>
  );
}

const noopSubscribe = () => () => {};

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  // エラーはクエリかハッシュに付いて戻る
  const hash = useSyncExternalStore(noopSubscribe, () => window.location.hash, () => '');
  const urlError = loginErrorMessage(params) ?? loginErrorMessage(new URLSearchParams(hash.replace(/^#/, '')));
  const code = params.get('code');
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (urlError || started.current) return; // 開発中の StrictMode で2回交換しない
    started.current = true;
    const next = takeRememberedNext();
    if (!code) {
      router.replace('/login/');
      return;
    }
    void getSupabase()
      .auth.exchangeCodeForSession(code)
      .then(({ error }) => {
        if (error) setExchangeError('ログインに失敗しました。もう一度お試しください。');
        else router.replace(next);
      });
  }, [code, urlError, router]);

  const error = urlError ?? exchangeError;
  if (!error) return <LoadingState className="min-h-dvh" label="ログインしています…" />;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6 text-center">
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
      <Link href="/login/" className="text-sm underline">
        ログインの画面に戻る
      </Link>
    </main>
  );
}
