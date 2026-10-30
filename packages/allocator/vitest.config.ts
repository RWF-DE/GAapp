import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'allocator', include: ['src/**/*.test.ts'] },
});
