'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase/client';

/**
 * ローカル専用のメール＋パスワードのテスト用ログイン（E2E 用。D-02）。
 * seed のテストユーザー（@example.test）でログインする。本番のビルドには含まれない（login/page.tsx と lib/auth/test-login.ts）。
 */
export function TestLoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error: err } = await getSupabase().auth.signInWithPassword({ email, password });
    setPending(false);
    if (err) {
      setError('メールアドレスかパスワードが違います。');
      return;
    }
    onSignedIn();
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-dashed p-4"
      aria-labelledby="test-login-title"
      data-testid="test-login-form"
    >
      <h2 id="test-login-title" className="text-sm font-medium">
        テスト用ログイン（ローカル専用）
      </h2>
      <label className="block space-y-1 text-sm">
        <span>メールアドレス</span>
        <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>パスワード</span>
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" className="w-full" disabled={pending}>
        テスト用ユーザーでログイン
      </Button>
    </form>
  );
}
