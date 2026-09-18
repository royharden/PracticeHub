import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@practicehub/platform-core': fileURLToPath(
        new URL('../platform-core/dist/index.js', import.meta.url),
      ),
    },
  },
  test: { include: ['src/**/*.test.ts'], exclude: ['**/*.db.test.ts'] },
});
