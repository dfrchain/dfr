# DFR — Multi-Chain Developer Access Layer

> DFR is a developer-facing access layer for multiple blockchains. It unifies
> chain access, RPC abstraction, transaction lifecycle, and event and error
> models behind one interface, so applications do not have to maintain
> separate RPC, retry, failover, and confirmation logic per chain.
>
> DFR is a multi-chain developer access layer: it converges multi-chain
> access, RPC abstraction, transaction lifecycle, and event and error
> models into a unified interface, so upstream applications no longer
> maintain separate RPC, retry, failover, and confirmation logic per chain.

DFR currently supports the Base Sepolia, Arbitrum Sepolia, and Ethereum
Sepolia testnets, and Solana devnet.

## Repository structure

```text
packages/
  core               Transaction engine (build / simulate / broadcast / confirm state machine)
  provider           RPC abstraction, health scoring, circuit breaking, failover
  registry           Chain registry (schema + loader; chain config is supplied by the operator)
  transaction        Transaction encoding and lifecycle
  storage-postgres   Postgres transaction stores and migrations
  telemetry          Telemetry
  metrics            Metrics
  events             Event model (including SSE tickets)
  errors             Error model
  types              Shared types
adapters/
  evm                EVM chain adapter
  solana             Solana chain adapter
sdk/
  typescript         TypeScript SDK (read + write + events)
apps/
  gateway            HTTP API gateway (see docs/api/README.md for the contract)
services/
  indexer            Placeholder (README only; not yet implemented)
  monitor            Placeholder (README only; not yet implemented)
  relayer            Placeholder (README only; not yet implemented)
infrastructure/
  docker             Docker Compose files, gateway Dockerfile, .env.example (placeholders only)
  monitoring         Prometheus + Grafana samples
scripts/             Checks and drills (including scripts/check-secrets.sh)
tests/               Contract, integration, and end-to-end tests
docs/
  api/README.md      HTTP API guide (the public API document)
```

The chain registry configuration (`packages/registry/config/chains.yaml`) is
intentionally **not** included in this snapshot: it carries operator
configuration. Supply your own registry config before running the gateway.
See `packages/registry/config/chains.schema.json` for the schema.

## Quick start

Prerequisites: Node.js >= 22 and pnpm 9.4.0 (see `package.json`:
`"packageManager": "pnpm@9.4.0"`, `"engines": {"node": ">=22"}`).

```bash
pnpm install
```

The following commands are the scripts defined in the repository's
`package.json`. They were **not verified in this staging snapshot** — no build
or test run was performed while preparing it, and the snapshot does not
include the repository's root `tsconfig.base.json` / `vitest.config.ts`, so
confirm them on first use:

```bash
pnpm test          # vitest run (not verified in this snapshot)
pnpm typecheck     # per-package typecheck (not verified in this snapshot)
pnpm start:gateway # start the HTTP gateway (not verified in this snapshot)
```

To check this snapshot for secrets:

```bash
pnpm check:secrets   # runs scripts/check-secrets.sh (read-only scan)
```

Copy `infrastructure/docker/.env.example` to your own `.env` outside the
repository and fill in real values there. Never commit a real `.env` file:
`.gitignore` excludes `.env`, `.env.*`, `*.key`, `*.pem`, and `secrets/`.

## Tests

```bash
pnpm test            # full suite (not verified in this snapshot)
pnpm test:coverage   # suite with coverage (not verified in this snapshot)
```

`tests/` contains contract tests (including the EVM and Solana adapter
contracts), integration tests against Sepolia testnets and Solana devnet, and
end-to-end gateway tests. Tests that touch live testnets need network access
and a configured registry; see `docs/onboarding.md`.

## API

The HTTP contract is documented in `docs/api/README.md`. All endpoints
authenticate with an `x-dfr-key: dfr_<keyId>_<secret>` header. DFR never holds
user private keys: signing is done by an external signer, and the gateway
broadcasts once without automatic retry.

New to DFR: start with [docs/api/quickstart.md](docs/api/quickstart.md)
(key → SDK install → first call → errors → usage). Runnable examples are in
`examples/quickstart/` (`pnpm examples:quickstart`). What is and is not
sellable is stated in
[docs/api/capability-matrix.md](docs/api/capability-matrix.md).

## Links

- Website: https://dfrchain.com
- Research notes: https://news.dfrchain.com
- Engineering notes: https://blog.dfrchain.com
- GitHub: https://github.com/dfrchain

## License

Apache License 2.0 — see [LICENSE](LICENSE).
