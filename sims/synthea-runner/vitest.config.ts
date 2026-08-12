import { defineConfig } from 'vitest/config';

// Source suite only — never the compiled mirror under dist/ (WP-024 fax-sim lesson).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
