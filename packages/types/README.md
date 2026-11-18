# @dfr/types

DFR's pure domain-contract package: it performs no I/O and depends on no
other workspace package.

- Authoritative spec: `docs/architecture/domain-model.md`.
- Public entry: `src/index.ts`.
- Main domains: primitives, chain, account/asset, block/finality,
  transaction, event, provider, adapter, API, errors.
- Rules: integers use decimal strings; the network is derived from the
  chain; state has a single source of truth; types must not contain private
  keys or credentials.
- Change gate: changes to Capability, error codes, state, or schemaVersion
  must sync OpenAPI/Schema, the spec, and contract tests; breaking changes
  need an ADR first.

Verify with: `pnpm --filter @dfr/types typecheck` and
`tests/contract/spec-consistency.test.ts`.
