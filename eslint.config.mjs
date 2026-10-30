import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TEST_CODE = (pkg) => [`packages/${pkg}/src/**/*.test.ts`, `packages/${pkg}/src/testing/**`];
const NO_HIGHS = {
  name: 'highs',
  message: 'highs は呼ぶ側（Web Worker・テスト）が読み込んで allocate に渡す。型は allocator の LpSolver を使う',
};
const NO_TESTING = {
  name: '@gaapp/shared/testing',
  message: '@gaapp/shared/testing は Node 専用のテスト用。テスト（*.test.ts・src/testing/・scripts/）からだけ使う',
};
const NO_SIBLINGS = (names) =>
  names.map((n) => ({ name: `@gaapp/${n}`, message: `依存の向き（shared ← allocator・exporter・importer ← apps/web）に反する` }));
const NO_NODE = { group: ['node:*'], message: 'ブラウザで動くコードに Node の API は使わない（テスト用は src/testing/ へ）' };

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      'spikes/**',
      'supabase/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [...nextVitals],
    settings: { next: { rootDir: 'apps/web' } },
    languageOptions: { globals: { ...globals.browser } },
  },
  // ---- 依存の向き（設計 1 章）：shared ← allocator・exporter・importer ← apps/web ----
  // テストのためのコード（*.test.ts・src/testing/**・scripts/**）は @gaapp/shared/testing と highs を import してよい。
  // exporter・importer から allocator への禁止には例外を作らない。
  {
    files: ['packages/shared/src/**/*.ts'],
    ignores: [...TEST_CODE('shared')],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [NO_HIGHS, NO_TESTING, ...NO_SIBLINGS(['allocator', 'exporter', 'importer'])],
          patterns: [NO_NODE],
        },
      ],
    },
  },
  {
    files: ['packages/allocator/src/**/*.ts'],
    ignores: [...TEST_CODE('allocator')],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NO_HIGHS, NO_TESTING, ...NO_SIBLINGS(['exporter', 'importer'])], patterns: [NO_NODE] },
      ],
    },
  },
  {
    files: ['packages/exporter/src/**/*.ts', 'packages/importer/src/**/*.ts'],
    ignores: [...TEST_CODE('exporter'), ...TEST_CODE('importer')],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_HIGHS, NO_TESTING, ...NO_SIBLINGS(['allocator'])] }],
    },
  },
  {
    files: [...TEST_CODE('exporter'), ...TEST_CODE('importer')],
    rules: { 'no-restricted-imports': ['error', { paths: [...NO_SIBLINGS(['allocator'])] }] },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { paths: [NO_TESTING] }] },
  },
);
