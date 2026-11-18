# DFR Onboarding

> DFR is a developer-facing access layer for multiple blockchains. It
> currently supports the Base Sepolia, Arbitrum Sepolia, and Ethereum Sepolia
> testnets, and Solana devnet.
>
> DFR is a multi-chain developer access layer, currently supporting the
> Base Sepolia, Arbitrum Sepolia, and Ethereum Sepolia testnets, and
> Solana devnet.

This guide is assembled from the repository's own documentation
(`docs/api/README.md`, the root `README.md`, and `AGENTS.md`). Commands below
are taken from those documents and from `package.json`; **none of them were
run to verify this staging snapshot** (no build or test run was performed
while preparing it) — treat every command as not yet tested here
(not yet verified in practice) until you run it yourself.

## Prerequisites

- Node.js >= 22
- pnpm 9.4.0 (the repository pins `"packageManager": "pnpm@9.4.0"`)
- Git
- For the Postgres-backed transaction store: PostgreSQL 17 (see
  `infrastructure/docker/`); for live-chain tests: network access to the
  Sepolia testnets / Solana devnet and a chain registry configuration

## Clone, install, build, test

```bash
git clone https://github.com/dfrchain/dfr.git
cd dfr
pnpm install

pnpm typecheck     # per-package typecheck (not yet tested in this snapshot)
pnpm test          # vitest run (not yet tested in this snapshot)
pnpm test:coverage # suite with coverage (not yet tested in this snapshot)
```

Before running the gateway, supply a chain registry configuration: this
snapshot intentionally omits `packages/registry/config/chains.yaml` (operator
configuration). The schema is at
`packages/registry/config/chains.schema.json`. Copy
`infrastructure/docker/.env.example` to a `.env` file **outside** the
repository and fill in real values there; never commit it.

```bash
pnpm start:gateway # start the HTTP gateway (not yet tested in this snapshot)
```

## Minimal integration example

Point at a deployed DFR gateway. All endpoints authenticate with an API key
header; ask your operator for a key and a base URL.

```bash
export DFR_BASE="https://dfr-staging.example"   # replace with your deployment
export DFR_API_KEY="dfr_<keyId>_<secret>"       # replace with your key

# List the chains this deployment serves
curl -s -H "x-dfr-key: $DFR_API_KEY" "$DFR_BASE/v1/chains"

# Read an account balance (example shape; see docs/api/README.md)
curl -s -H "x-dfr-key: $DFR_API_KEY" "$DFR_BASE/v1/accounts/<address>"
```

The write path is `preflight` (read-only precheck) → `build` → `simulate` →
`broadcast` → `confirm` (`POST /v1/transactions/{build,simulate,broadcast}`,
`POST /v1/transactions/{txHash}/confirm`). `preflight` reserves no nonce and
stores no record; a revert comes back as HTTP 200 with
`simulation.success: false`. See `docs/api/README.md` for the worked
end-to-end example, including the `TransactionRequest` body shape (`from` /
`to` / `value` are objects — passing strings returns 400
`DFR_VALIDATION_FAILED`).

The TypeScript SDK (`sdk/typescript`) offers the same surface (read + write +
events, including `POST /v1/events/tickets` and SSE subscribe at
`GET /v1/events/subscribe`).

## FAQ

**Which chains are supported?**
Base Sepolia, Arbitrum Sepolia, and Ethereum Sepolia testnets, and Solana
devnet.

**Does DFR hold my private keys?**
No. DFR never holds user private keys. Signing is done by an external signer;
the gateway broadcasts once, without automatic retry. Signed payloads and
credentials never enter logs, errors, or snapshots.

**Where do I get an API key?**
From the operator of the DFR deployment you connect to. Keys use the
`dfr_<keyId>_<secret>` format and are sent as the `x-dfr-key` header.
Operators can issue one with `pnpm api-key:issue` (it prints the plaintext key
once and the configuration hash); see `docs/api/quickstart.md`.

**How do I report a secret that leaked into the repository?**
Run `pnpm check:secrets` (read-only scan, `scripts/check-secrets.sh`) and
contact the repository maintainers through the channels listed on
https://dfrchain.com. Do not post the secret itself in a public issue.

**Why is there no `packages/registry/config/chains.yaml` here?**
It carries operator configuration and is intentionally left out of this
snapshot. Supply your own file matching
`packages/registry/config/chains.schema.json`.

**What are `services/indexer`, `services/monitor`, and `services/relayer`?**
Placeholders: each currently contains only a README and is not yet
implemented.
