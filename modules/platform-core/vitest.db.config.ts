import { defineConfig } from 'vitest/config';

// DB-level suite: requires the local synthetic app-postgres (or the CI
// service container) on 127.0.0.1:55432. Single-file, sequential — the suite
// provisions schema state and must not race itself.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
