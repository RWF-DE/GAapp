import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'exporter', include: ['src/**/*.test.ts'] },
});
