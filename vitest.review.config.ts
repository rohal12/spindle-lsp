import { defineConfig } from 'vitest/config';

// Desired-behavior checks for the open review backlog. Failures remain visible;
// this command is separate from the normal suite until the backlog is resolved.
export default defineConfig({
  test: {
    include: ['test/review/**/*.review.ts'],
    testTimeout: 10_000,
    hookTimeout: 20_000,
  },
});
