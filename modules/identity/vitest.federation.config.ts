import { defineConfig } from 'vitest/config';

// Dex federation e2e (WP-014): requires the pinned dex from compose.yaml (or
// the CI-started container) on 127.0.0.1:5556. Sequential — the suite drives
// one OIDC code flow end to end.
export default defineConfig({
  test: {
    include: ['src/**/*.federation.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
