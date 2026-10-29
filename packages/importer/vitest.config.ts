import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'importer', include: ['src/**/*.test.ts'] },
});
