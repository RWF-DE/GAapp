// local-supabase-env.mjs の型（playwright.config.ts と e2e/support から読むため）
export function localSupabaseEnv(): {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
};
export function localDbUrl(): string;
export function assertLocalDbUrl(url: string): void;
