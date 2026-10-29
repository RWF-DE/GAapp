// local-supabase-env.mjs の型（playwright.config.ts から読むため）
export function localSupabaseEnv(): {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
};
