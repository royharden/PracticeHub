import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.db.test.ts', 'src/**/*.blocked.test.ts', 'dist/**', 'node_modules/**'],
  },
});
