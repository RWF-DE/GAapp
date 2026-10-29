/**
 * ローカル専用のメール＋パスワードのテスト用ログイン（E2E 用。D-02）を出してよいか。
 * ビルド時のフラグ（NEXT_PUBLIC_ENABLE_TEST_LOGIN=true）に加え、Supabase の URL がこの端末（127.0.0.1・localhost）のときだけ。
 * 本番のビルドはフラグを付けないので出ない。フラグを付け間違えても、本番の Supabase に向いていれば出ない。
 */
export function isTestLoginAvailable(flag: boolean, supabaseUrl: string): boolean {
  if (!flag) return false;
  try {
    const host = new URL(supabaseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}
