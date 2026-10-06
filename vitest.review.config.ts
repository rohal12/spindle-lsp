import { defineConfig } from 'vitest/config';

// The retained cross-consumer matrix (test/review/support/shards.ts). It is
// part of `npm test`: every cell must pass, and a failing cell is a defect, not
// an expected failure. The matrix is split over the shard files
// (test/review/shard-*.review.ts) so vitest runs them in parallel workers;
// test/review/global-setup.ts builds the executable once for the entrypoint
// cells and checks the merged results against the committed results file.
export default defineConfig({
  test: {
    include: ['test/review/**/*.review.ts'],
    globalSetup: ['test/review/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
