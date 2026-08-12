import { defineConfig } from 'vitest/config';

// Source suite only — never the compiled mirror under dist/ (the WP-024 fax-sim
// lesson: a build emits dist/*.test.js that would otherwise run as a stale
// duplicate and inflate the tally).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
