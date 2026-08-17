import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the top level. test/validation/ holds the adversarial batteries,
    // which deliberately contain RED tests pinning known gaps — run them with
    // `npm run test:validation`.
    include: ['test/*.test.ts'],
    // The whole point: every test file gets its own ledger, in its own worker,
    // with no shared network state and no sequence-number contention.
    pool: 'threads',
    testTimeout: 20_000,
  },
});
