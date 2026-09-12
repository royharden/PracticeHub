import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.blocked.test.ts'],
  },
});
