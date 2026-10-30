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
//   AppShell の外にある (auth) のページだけ（AppShell の強制の移動は useGuardedRouter の forceReplace。段 C）。
const WEB_GUARDED_ROUTER_FILES = ['apps/web/lib/navigation.ts', 'apps/web/lib/navigation/**'];
const WEB_ROUTER_EXEMPT = [...WEB_GUARDED_ROUTER_FILES, 'apps/web/app/(auth)/**'];
// - 年度の切り替え（AuthProvider の setYear）は、未保存の入力を確かめる useGuardedSetYear（lib/auth/guarded.ts）だけで呼ぶ。
//   components/layout と lib/auth の外（とテスト）から setYear を直接読むことを止める（画面の設計 1.3.1。段 C）。
const NO_DIRECT_SET_YEAR = [
  'error',
  {
    selector: "ObjectPattern > Property[key.name='setYear']",
    message: '年度の切り替えは useGuardedSetYear（lib/auth/guarded）を使う（未保存の入力を確かめるため）',
  },
  {
    selector: "MemberExpression[property.name='setYear']",
    message: '年度の切り替えは useGuardedSetYear（lib/auth/guarded）を使う（未保存の入力を確かめるため）',
  },
];
// apps/web/lib/testing/ はテスト専用の補助（偽の Supabase・合成データの DB の行）。テストと同じ扱いにし、アプリからは読ませない
const WEB_TESTS = ['apps/web/**/*.test.{ts,tsx}', 'apps/web/lib/testing/**'];
const NO_WEB_TESTING = {
  group: ['@/lib/testing', '@/lib/testing/*', '../testing/*', './testing/*', '../../lib/testing/*'],
  message: 'apps/web/lib/testing/ はテスト専用。アプリのコードから import しない',
};
const WEB_WORKERS = ['apps/web/workers/**'];
const webImports = ({ highs = true, exporter = true, router = true, testing = true } = {}) => [
  'error',
  {
    paths: [
      ...(testing ? [NO_TESTING] : []),
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
    patterns: [
      ...(highs ? [{ group: ['highs/*'], message: 'highs は振り分けの Worker（apps/web/workers/）の中だけで読み込む' }] : []),
      ...(testing ? [NO_WEB_TESTING] : []),
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/out-basepath/**',
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
  // テストは合成データ（@gaapp/shared/testing）と比べてよい（toYearData の突き合わせ。段 B）
  {
    files: WEB_TESTS,
    ignores: WEB_WORKERS,
    rules: { '@typescript-eslint/no-restricted-imports': webImports({ exporter: false, testing: false }) },
  },
  {
    files: WEB_WORKERS.map((w) => `${w}/*.test.{ts,tsx}`),
    rules: { '@typescript-eslint/no-restricted-imports': webImports({ highs: false, exporter: false, testing: false }) },
  },
  { files: WEB_ROUTER_EXEMPT, rules: { '@typescript-eslint/no-restricted-imports': webImports({ router: false }) } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/components/layout/**', 'apps/web/lib/auth/**', ...WEB_TESTS],
    rules: { 'no-restricted-syntax': NO_DIRECT_SET_YEAR },
  },
);
