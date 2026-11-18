# DFR cross-package tests

- `contract/`: spec consistency and Adapter Contract Tests, with no public-network dependency.
- `integration/`: component composition and explicitly enabled real-network tests.
- `e2e/`: the full SDK → HTTP Gateway → Core → Adapter → Provider chain.

Unit tests inside a package live in `<package>/test/`; do not centralize
all tests here.

By default `pnpm test` must be offline, fast, and deterministic. Public-network
cases are explicitly enabled with `DFR_RUN_TESTNET=1`; concurrency, timeouts,
circuit breaking, and reorgs must be verified with programmable doubles or
local dependencies, never by relying on occasional public-network behavior.

See `docs/development/test-plan.md` for the full M1 matrix.
