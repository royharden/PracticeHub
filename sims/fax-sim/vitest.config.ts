import { defineConfig } from 'vitest/config';

// Source suite only — never the compiled mirror under dist/ (the build emits a
// dist/index.test.js that would otherwise run as a stale duplicate).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
