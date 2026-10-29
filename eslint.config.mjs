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

// ---- apps/web（画面の設計 1.4・1.8。T09a）----
// - highs は apps/web/workers/ の外から import しない（wasm を読むのは振り分けの Worker だけ）。
//   @gaapp/allocator/testing も highs を読むので apps/web からは使わない。
// - @gaapp/exporter（ExcelJS 約 0.9 MB）は使う所で `await import('@gaapp/exporter')` する。型だけの import はよい。テストは例外。
// - next/navigation の useRouter を直接使わない（push・replace が未保存の入力の確かめを通らないため）。
//   移動は useGuardedRouter（WEB_GUARDED_ROUTER_FILES に置く）を使う。除外するのは、そのファイルと、
//   AppShell の外にある (auth) のページ、未ログインのときの強制の移動だけをする AppShell。
const WEB_GUARDED_ROUTER_FILES = ['apps/web/lib/navigation.ts', 'apps/web/lib/navigation/**'];
const WEB_ROUTER_EXEMPT = [
  ...WEB_GUARDED_ROUTER_FILES,
  'apps/web/app/(auth)/**',
  'apps/web/components/layout/app-shell.tsx',
];
const WEB_TESTS = ['apps/web/**/*.test.{ts,tsx}'];
const WEB_WORKERS = ['apps/web/workers/**'];
const webImports = ({ highs = true, exporter = true, router = true } = {}) => [
  'error',
  {
    paths: [
      NO_TESTING,
      { name: '@gaapp/allocator/testing', message: '@gaapp/allocator/testing は Node のテストと E2E の補助だけで使う（highs を読むため）' },
      ...(highs
        ? [{ name: 'highs', message: 'highs は振り分けの Worker（apps/web/workers/）の中だけで読み込む' }]
        : []),
      ...(exporter
        ? [
            {
              name: '@gaapp/exporter',
              allowTypeImports: true,
              message: "@gaapp/exporter（ExcelJS）は使う所で `await import('@gaapp/exporter')` する（最初の読み込みを重くしない）",
            },
          ]
        : []),
      ...(router
        ? [
            {
              name: 'next/navigation',
              importNames: ['useRouter'],
              message: 'useRouter の push・replace は未保存の入力の確かめを通らない。useGuardedRouter（lib/navigation）を使う',
            },
          ]
        : []),
    ],
    patterns: highs ? [{ group: ['highs/*'], message: 'highs は振り分けの Worker（apps/web/workers/）の中だけで読み込む' }] : [],
  },
];

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
  // apps/web は型だけの import を許すため typescript-eslint の版を使う（後の設定ほど優先されるので、狭い順に並べる）
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': webImports(),
      // ログに CSV・申請の中身・メールを出さない。warn・error だけ許す
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: WEB_WORKERS, rules: { '@typescript-eslint/no-restricted-imports': webImports({ highs: false }) } },
  { files: WEB_TESTS, ignores: WEB_WORKERS, rules: { '@typescript-eslint/no-restricted-imports': webImports({ exporter: false }) } },
  {
    files: WEB_WORKERS.map((w) => `${w}/*.test.{ts,tsx}`),
    rules: { '@typescript-eslint/no-restricted-imports': webImports({ highs: false, exporter: false }) },
  },
  { files: WEB_ROUTER_EXEMPT, rules: { '@typescript-eslint/no-restricted-imports': webImports({ router: false }) } },
);
