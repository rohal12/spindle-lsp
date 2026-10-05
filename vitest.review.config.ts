import { defineConfig } from 'vitest/config';

// The retained cross-consumer matrix (test/review/convergence.review.ts). It is
// part of `npm test`: every cell must pass, and a failing cell is a defect, not
// an expected failure. Entry-point cells build the executable and talk to it
// over stdio, so the timeouts are generous.
export default defineConfig({
  test: {
    include: ['test/review/**/*.review.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
