// ビルド時に埋め込まれる公開の設定（NEXT_PUBLIC_*）。秘密の値はここに置かない。
// process.env.NEXT_PUBLIC_* は文字どおりに書いたときだけ Next.js が置き換えるので、まとめてここで読む。

/** Supabase の URL（ローカルは http://127.0.0.1:54321） */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
/** Supabase の publishable キー（secret キーは使わない） */
export const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
/** GitHub Pages 向けの basePath（例 /GAapp）。ローカルと E2E は空 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
/**
 * Google のアカウント選択を学校のドメインに絞るヒント（hd パラメーター。任意）。
 * 見た目だけのもので、拒否は DB のフック（0007_auth.sql の定数）が行う。
 */
export const GOOGLE_HD_HINT = process.env.NEXT_PUBLIC_GOOGLE_HD_HINT ?? '';
// ローカル専用のテスト用ログイン（NEXT_PUBLIC_ENABLE_TEST_LOGIN）は、ビルドで中身ごと消えるように
// app/(auth)/login/page.tsx で process.env を直接比べる（ここで定数にすると消えないことがある）。
