import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    // Several differential suites run thousands of cases; a loaded machine
    // (CI, or the peer matrix) must not turn them into timeouts.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
