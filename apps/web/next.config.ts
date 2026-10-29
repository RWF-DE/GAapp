import type { NextConfig } from 'next';

// GitHub Pages は https://<組織>.github.io/<リポジトリ名>/ で公開されるため、
// ビルド時に NEXT_PUBLIC_BASE_PATH（例: /GAapp）を渡す。ローカルと E2E では空にする。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
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
