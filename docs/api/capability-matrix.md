# DFR Developer Product — Capability Matrix

> Evidence date: 2026-11-19
> Branch: `agent/dfr-developer-product`
> Purpose: state plainly what a first integration team can buy today, and what they cannot.
> This file is a commercial honesty document, not a roadmap promise.

## How to read this

- **Sellable** = implemented, exercised by the offline gate, and a developer can use it without
  operator involvement beyond receiving a key and a base URL.
- **Sellable with caveat** = the capability works, but a documented limitation changes how it may
  be used.
- **Not sellable yet** = the interface or the operational guarantee does not exist. Do not put it
  in a proposal.

All claims below were verified with `pnpm verify` on this branch; the counts are in
`docs/api/developer-product-delivery.md`.

## 1. Sellable today

| Capability | Contract | Evidence | Caveat |
|---|---|---|---|
| Static API key auth (`x-dfr-key`) | `docs/api/openapi.yaml` `securitySchemes.ApiKeyAuth` | `apps/gateway/test/gateway.test.ts`, `api-key-issuance.test.ts` | One project per deployment + one previous key for rotation |
| Key issuance (operator CLI) | `pnpm api-key:issue` | `apps/gateway/test/api-key-issuance.test.ts` | Operator-run; no self-serve portal |
| Key scopes: chains / capabilities / write / IP allowlist | `ApiKeyScope` | `apps/gateway/test/ip-allowlist.test.ts`, `write-pipeline.test.ts`, `body-chain-scope.test.ts` | Configured per deployment, not per key pool |
| Chain discovery | `GET /v1/chains`, `GET /v1/chains/{chainId}` | `tests/e2e/gateway.e2e.test.ts` | Registry decides what is enabled |
| Native balance | `GET /v1/balances` | e2e | EVM + Solana |
| Block read (tag/number/hash/slot) | `GET /v1/blocks/{blockRef}` | e2e, contract tests | Reorg-aware reads are best-effort unless `consistency=finalized` |
| Transaction + receipt read | `GET /v1/transactions/{txHash}` | e2e | By on-chain hash only; `transactionId` is write-only by design |
| Account existence / contract detection | `GET /v1/accounts/{address}` | `tests/e2e/m4-bex-http-smoke.e2e.test.ts` (opt-in) | Only chains declaring `account.code` |
| Read-only contract call | `POST /v1/contracts/read` | same | Only chains declaring `contract.read` |
| Event logs by block range | `POST /v1/logs` | `logs-pagination-endpoint.test.ts`, SDK tests | Range must fit the chain's `maxBlockRange`; `limit` is a real page size with `hasMore`/`nextCursor` |
| Transaction build / preflight / simulate | `POST /v1/transactions/{build,preflight,simulate}` | `tests/e2e/m1-write.e2e.test.ts`, `preflight.test.ts` | EVM: 3 Sepolia chains; Solana: build/simulate on devnet |
| Single broadcast (no auto retry) | `POST /v1/transactions/broadcast` | `tests/e2e/m1-broadcast.e2e.test.ts` | Requires persistent Store; exactly one provider send |
| Confirmation long-poll | `POST /v1/transactions/{txHash}/confirm` | `m1-write` e2e | Returns `reached:false` on timeout, which is not an error |
| Abandon unbroadcast tx | `POST /v1/transactions/{transactionId}/abandon` | `abandon.test.ts` | Terminal state; releases nonce lease |
| SSE events + one-time tickets | `GET /v1/events/subscribe`, `POST /v1/events/tickets` | `tests/e2e/sdk-events.e2e.test.ts` | At-least-once; dedupe by `eventId` |
| Unified error model | RFC 9457 + `dfr_code` | `docs/architecture/error-spec-v0.1.md`, all e2e | `type` URL prefix is a placeholder domain |
| `Retry-After` on 429 | Gateway header | `apps/gateway/test/retry-after.test.ts` | Only on 429 (not 503/504) |
| Usage view | `GET /v1/usage` | `apps/gateway/test/usage-endpoint.test.ts`, developer e2e | **Per process**; not a billing ledger (see §3) |
| SDK read/write/events/usage | `@dfr/sdk-typescript` | `sdk/typescript/test/*` | See caveats in §2 |
| SDK retry policy | opt-in `retry` | `sdk/typescript/test/retry.test.ts` | Never retries unsafe writes |
| Log cursor pagination | `POST /v1/logs` `{cursor}` + SDK `getLogsPage` | `apps/gateway/test/logs-pagination-endpoint.test.ts`, `sdk/typescript/test/logs-cursor.test.ts` | Cursor is opaque/stateless and not signed; one range/filter per cursor |
| SDK block-range windowing | `getLogsPaged` | `sdk/typescript/test/logs-pagination.test.ts` | Kept for older deployments; prefer `getLogsPage` |
| Installable SDK artifact | `pnpm test:sdk-pack` | `scripts/sdk-pack-smoke.mjs` | Tarball install verified; registry publish not performed |
| Health / readiness / metrics | `/healthz`, `/readyz`, `/metrics` | `readiness*.test.ts`, metrics tests | `/metrics` needs a key; Prometheus is operator-facing |
| Quickstart examples | `examples/quickstart/*` | `tests/e2e/developer-quickstart.e2e.test.ts` | Run against a deployment with SSE/write enabled as needed |

## 2. Sellable with caveats

| Item | Caveat the sales engineer must state |
|---|---|
| Multi-chain | Live chains are **testnets/devnet only** (Ethereum/Base/Arbitrum Sepolia, Solana devnet). No mainnet registry entry exists. |
| Finality | `finalityStatus: verified` is verified **on testnets**, as tag semantics, not an economic-security claim. Solana devnet `finalized == confirmed`. |
| Events | The event bus is in-process: `afterCursor` does not survive a restart. Reconcile with `/v1/logs` + `confirm` for money-critical flows. |
| Usage | Counts reset on Gateway restart and are not aggregated across replicas. |
| Rate limits | Process-local token bucket (per project+key+route class). No distributed limiter, so N replicas multiply the effective burst. |
| SDK distribution | Install from tarball (`pnpm pack`) or workspace. No npm registry publication or semver release process yet. |
| Solana | Balance/block/tx/build/simulate/broadcast on devnet; no `contract.read`, `contract.logs`, `account.code`. |
| Errors | `retryable` / `safe_to_retry` are stable; the `type` URL is not resolvable yet (docs site TODO). |
| SDK cancellation | `AbortSignal` is supported on write/event calls; simple read helpers (`listChains`, `getBalance`, …) do not take a signal. |
| Request counts | Usage numbers are request counts; no priced units, no invoices. |

## 3. Not sellable yet (do not promise)

| Missing capability | Why it is missing | What exists instead |
|---|---|---|
| Billing / invoicing | No priced plans, no ledger, no tax/currency model. `DFR_QUOTA_EXCEEDED` exists as a code but **no quota is enforced**. | `GET /v1/usage` request counts + Prometheus; set commercial terms outside the product |
| Durable usage aggregation | Meter is in-memory per Gateway process. | Restart-scoped numbers; export `/metrics` to a TSDB for history |
| Self-serve key management | No control-plane API/UI, no per-project key pools, no revoke API. | Operator CLI `pnpm api-key:issue` + dual-active env rotation |
| Multi-tenant control plane | Explicitly out of scope (AGENTS.md); one static project per deployment. | Run one deployment per customer if isolation is required |
| Published SDK release | `private: true`; no registry credentials/release pipeline. | Verified tarball install path (`pnpm test:sdk-pack`) |
| Persistent event replay | In-process `EventBus` only. | At-least-once live delivery; reconcile from logs |
| Mainnet | No registry entries, no mainnet RPC credentials, no economic finality validation. | Testnet/devnet only |
| Distributed rate limiting / HA | Single-process limiter and in-memory usage. | Deploy behind a proxy with its own limits; accept per-replica buckets |
| Hosted status/SLA surface | No public status page or SLA reporting. | `/healthz`, `/readyz`, `/metrics` |
| Console UI | Developer console is out of scope for this task (and not modified). | HTTP API + SDK only |
| BEX-specific objects | DFR must not carry BEX business objects (AGENTS.md). | `docs/api/bex-integration.md` describes the integration pattern |

## 4. First-team minimum integration package

Deliver these five artifacts together; anything less is not a product handoff:

1. Base URL + issued key (`pnpm api-key:issue`), with the deployment's chain/scope list.
2. `docs/api/quickstart.md` (this branch) — key → SDK install → first call → errors → usage.
3. SDK tarball (`pnpm pack`, verified by `pnpm test:sdk-pack`) and the version/SHA in the delivery note.
4. `examples/quickstart/*` runnable against the deployment.
5. This matrix, so the team knows exactly what is and is not contracted.
