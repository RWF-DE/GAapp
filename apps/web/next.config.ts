import type { NextConfig } from 'next';

// GitHub Pages は https://<組織>.github.io/<リポジトリ名>/ で公開されるため、
// ビルド時に NEXT_PUBLIC_BASE_PATH（例: /GAapp）を渡す。ローカルと E2E では空にする。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// ローカル専用のテスト用ログイン（E2E 用）。未設定でも 'false' として埋め込み、本番のビルドからフォームのコードごと消す
// （未設定のままだと Next.js は置き換えず、実行時の判定になってフォームのチャンクが残る）。
const enableTestLogin = process.env.NEXT_PUBLIC_ENABLE_TEST_LOGIN === 'true' ? 'true' : 'false';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  env: { NEXT_PUBLIC_ENABLE_TEST_LOGIN: enableTestLogin },
  // next dev が apps/web/AGENTS.md を自動生成しないようにする（生成物をコミットしない）。
  agentRules: false,
  transpilePackages: [
    '@gaapp/allocator',
    '@gaapp/exporter',
    '@gaapp/importer',
    '@gaapp/shared',
  ],
};

export default nextConfig;
