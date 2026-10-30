import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      // apps/web（既定は node。DOM が要る部品のテストはファイルの先頭に `// @vitest-environment jsdom` を書く。画面の設計 7.1）
      'apps/web',
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
      // E2E の補助の純粋な部分（DB につながない。シナリオの行の作り方・データセット。画面の設計 7.2）
      { test: { name: 'e2e-support', include: ['e2e/**/*.test.ts'] } },
    ],
  },
});
