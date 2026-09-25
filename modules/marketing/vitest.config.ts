import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const consent = fileURLToPath(new URL('../consent/dist/index.js', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@practicehub/consent': consent,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
