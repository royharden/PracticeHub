import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const clinicalContracts = fileURLToPath(
  new URL('../clinical-contracts/dist/index.js', import.meta.url),
);
const events = fileURLToPath(new URL('../events/dist/index.js', import.meta.url));
const platformCore = fileURLToPath(new URL('../platform-core/dist/index.js', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@practicehub/clinical-contracts': clinicalContracts,
      '@practicehub/events': events,
      '@practicehub/platform-core': platformCore,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
