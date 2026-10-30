import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@gaapp/shared';
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
 * ブラウザの Supabase クライアント（1つだけ作る）。publishable キーと PKCE フローを使う。
 * セッションは localStorage に保存し、トークンは自動で更新する（ログイン状態の保持）。
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
      autoRefreshToken: true,
      // コードの交換は /auth/callback/ で明示的に行う（二重に交換しないように）
      detectSessionInUrl: false,
    },
  });
  return client;
}
