import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@gaapp/shared';
import { earlyAwareFetch } from '@/lib/boot/early-fetch';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/env';

export type AppSupabaseClient = SupabaseClient<Database>;

let client: AppSupabaseClient | null = null;

/** 接続の設定が足りなければ、その説明を返す（ビルド時の環境変数の付け忘れ） */
export function supabaseConfigError(): string | null {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return 'NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY を設定してビルドしてください';
  }
  return null;
}

/**
 * セッションを localStorage に置くキー（supabase-js の既定と同じ `sb-<URL のホストの最初の部分>-auth-token`）。
 * 明示して createClient に渡し、ログアウトに失敗したときに同じキーを消せるようにする（auth-provider の signOut）。
 */
export function authStorageKey(): string {
  return `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
}

/**
 * ブラウザの Supabase クライアント（1つだけ作る）。publishable キーと PKCE フローを使う。
 * セッションは localStorage に保存し、トークンは自動で更新する（ログイン状態の保持）。
 * fetch は earlyAwareFetch（ページを開いたときのリクエストを覚え、<head> の script が先に送った応答があれば使う。D-45）。
 * 静的書き出しのプリレンダーでは呼ばない（useEffect やイベントの中だけで呼ぶ）。
 */
export function getSupabase(): AppSupabaseClient {
  if (client) return client;
  const configError = supabaseConfigError();
  if (configError) throw new Error(configError);
  client = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      storageKey: authStorageKey(),
      autoRefreshToken: true,
      // コードの交換は /auth/callback/ で明示的に行う（二重に交換しないように）
      detectSessionInUrl: false,
    },
    global: { fetch: earlyAwareFetch },
  });
  return client;
}
