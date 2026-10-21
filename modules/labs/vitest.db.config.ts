import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Cluster roles are transactional but shared: serialize every proof case.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['src/labs-migrations.db.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
