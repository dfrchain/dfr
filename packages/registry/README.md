# @dfr/registry

Loads, validates, and projects the Chain/Provider registry.

- Configuration facts: `config/chains.yaml`.
- Structural facts: `config/chains.schema.json`.
- Credentials/endpoints are references only; see `config/README.md` for the resolution rules.
- Startup constraint: `registry capabilities ⊆ adapter capabilities`; fail-closed when violated.
- `milestone` is deployment metadata, removed when projecting to the domain `Chain`.

When adding a chain/Provider, update the config, the schema (if fields change), the Adapter registration, and the contract tests together.

Verify with: `pnpm vitest run packages/registry/test/registry.test.ts tests/contract/spec-consistency.test.ts`.
