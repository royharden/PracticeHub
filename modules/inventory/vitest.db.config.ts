import { defineConfig } from 'vitest/config';

// Explicit disposable target/grant required by the harness; no shared DB defaults.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
