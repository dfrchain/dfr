import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'adapters/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'sdk/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Coverage is a **regression guardrail**, not a target game: thresholds
      // leave headroom above current measured values, so that the goal is
      // "the light turns red when new code drops coverage sharply", not
      // forcing tests to be written for existing lockfile-style code.
      //
      // Two deliberate exclusions (neither is "for looks"):
      //   1. `packages/storage-postgres/src/**`: the real coverage of the
      //      PostgreSQL implementation comes from `pnpm test:db` (a separate
      //      gate that needs Docker); in the offline gate it would always
      //      be single digits, dragging the overall threshold down to a
      //      meaningless level. It is covered by the DB gate, not faked here.
      //   2. The tests' own support directories and test files: testing
      //      "test tooling" is pointless.
      exclude: [
        'packages/storage-postgres/src/**',
        'tests/**/support/**',
        '**/*.d.ts',
        '**/test/**',
      ],
      // Thresholds come from the **per-object** bars in testing-strategy §8,
      // not a single global number:
      // the spec explicitly says "no single global bar" (a single number
      // invites meaningless assertions); critical paths use a hard 100%
      // requirement instead. This turns the bars already written in the
      // spec into executable checks.
      thresholds: {
        // Table: Adapter implementation | 80% line coverage
        'adapters/evm/src/**': { lines: 80 },
        // Table: Domain model validation | 90% line coverage
        'packages/types/src/**': { lines: 90 },
        // Table: The state machine is a "critical path", with a hard 100%
        // requirement (see the last sentence of the same section)
        'packages/transaction/src/state-machine.ts': { lines: 100, functions: 100 },
        // Table: Error mapping | 100% (at least one case per error code).
        // The per-code HTTP range decisions and 4xx/5xx classification are
        // covered by packages/errors/test/errors.test.ts.
        'packages/errors/src/**': { functions: 100 },
        // The capability-routing "two paths per capability, supported /
        // unsupported" is a **behavioral** requirement, not expressible as
        // line coverage:
        // guaranteed jointly by packages/core/test/capability-routing.test.ts
        // (three method_missing cases) and the 422 cases of each endpoint.
      },
    },
  },
});
