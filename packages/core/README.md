# @dfr/core

Core is the modular monolith's orchestration and Capability Router.

Current responsibilities: assembling Registry + Adapter + Provider Manager,
M0 query routing, unified context, and error normalization. After M1 it
delegates transaction state to `@dfr/transaction`; Core owns no database
semantics.

Forbidden:

- importing a concrete `@dfr/adapter-evm`; Adapters are registered by the
  composition root;
- `if (chain === ...)` chain branches;
- executing SQL directly;
- bypassing capability checks.

The in-memory implementation in `src/stores.ts` is for M0/test
compatibility; after the M1 migration it keeps only a re-export.

Verify with: `tests/e2e/gateway.e2e.test.ts`, the Adapter contracts, and
workspace typecheck.
