import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // The RLS suites share one database. They run serially so a mutation test (for
    // example suspending a membership) cannot race another file's assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    coverage: {
      reporter: ['text'],
    },
  },
});
