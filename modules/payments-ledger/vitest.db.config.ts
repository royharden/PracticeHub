import { defineConfig } from 'vitest/config';

// Each suite owns a fresh synthetic database; serialize cluster-wide role bootstrap.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
