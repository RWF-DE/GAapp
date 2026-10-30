import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'web', include: ['**/*.test.ts', '**/*.test.tsx'], exclude: ['node_modules', '.next', 'out'] },
});
