import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
);
