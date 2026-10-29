import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig は Next.js のために jsx: preserve なので、テストでは React の automatic runtime に変換する
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@/': fileURLToPath(new URL('./', import.meta.url)) } },
  test: { name: 'web', include: ['**/*.test.ts', '**/*.test.tsx'], exclude: ['node_modules', '.next', 'out'] },
});
