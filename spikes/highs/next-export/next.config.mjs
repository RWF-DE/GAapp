// 本体（T01）と同じ設定：output: 'export'、basePath = /リポジトリ名、trailingSlash、images.unoptimized
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/GAapp';
export default {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};
