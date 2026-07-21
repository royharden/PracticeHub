import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.db.test.ts', '**/*.federation.test.ts', 'dist/**', 'node_modules/**'],
  },
});
