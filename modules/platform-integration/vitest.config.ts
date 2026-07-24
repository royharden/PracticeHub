import { defineConfig } from 'vitest/config';

// Unit + fixture suite: pure domain over caller-supplied state (no database).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.db.test.ts', 'dist/**', 'node_modules/**'],
  },
});
