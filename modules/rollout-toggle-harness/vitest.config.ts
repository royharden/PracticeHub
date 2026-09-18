import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@practicehub/platform-core': fileURLToPath(
        new URL('../platform-core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
