import { defineConfig } from 'vitest/config';

/**
 * The adversarial validation batteries.
 *
 * These are EXPECTED to be partly red: each failing test pins a known gap
 * between this harness and real stellar-core / soroban-env-host, documented in
 * README.md under "Known gaps". Making them green is the roadmap, not a
 * prerequisite for using the harness.
 */
export default defineConfig({
  test: {
    include: ['test/validation/*.test.ts'],
    pool: 'threads',
    testTimeout: 60_000,
  },
});
