# DFR Developer Product — Delivery Record (Task 03)

> Task: turn the existing infrastructure into a deliverable developer product.
> Branch: `agent/dfr-developer-product` (based on `main` @ `a7dd59f`).
> Implementation commit: `1283df7` — `[DFR-DEV-PRODUCT] feat(api): usage endpoint, key issuance, SDK retry/pagination/packaging, runnable quickstart`.
> Report commit: the commit that adds this file (see `git log -1 -- docs/api/developer-product-delivery.md`).
> Date: 2026-11-19 (Asia/Singapore).
> Follow-up delivered after this record: server-side cursor pagination for `/v1/logs` — see
> [developer-product-followup-delivery.md](./developer-product-followup-delivery.md).

## 1. What was actually delivered

| # | Task item | Delivery | Evidence |
|---|---|---|---|
| 1 | Verify actual API capability | Endpoint inventory, capability gating, per-chain capability matrix | `docs/api/capability-matrix.md`, `GET /v1/chains` |
| 2 | Gateway / auth / API key / usage | Scope + IP checks already present; **added** key issuance and `GET /v1/usage` | `api-key.ts`, `usage.ts`, `usage-endpoint.test.ts`, `api-key-issuance.test.ts` |
| 3 | TypeScript SDK completeness | Added `getUsage`, `getLogsPaged`, opt-in retry, build/pack, install verification | `sdk/typescript/test/{usage,retry,logs-pagination}.test.ts`, `scripts/sdk-pack-smoke.mjs` |
| 4 | Multi-chain events, tx status, errors | Verified against existing implementation; documented end-to-end patterns; added `Retry-After` | `developer-quickstart.e2e.test.ts`, `retry-after.test.ts` |
| 5 | API Quickstart | New `docs/api/quickstart.md` (key → install → call → errors → usage → events → troubleshooting) | linked from `README.md` and `docs/api/README.md` |
| 6 | Executable examples | Five runnable examples + `run-all`; executed by the offline E2E | `examples/quickstart/` |
| 7 | Timeout / retry / error codes / pagination DX | SDK retry policy, `attempts`/`retryAfterMs` on errors, `Retry-After` header, ranged log pagination | tests above |
| 8 | BEX as an upper-layer product | `docs/api/bex-integration.md`: reconciliation, withdrawal, idempotency, error decisions, boundaries | document |
| 9 | Usage/billing implemented vs pending | Usage endpoint implemented; billing/quotas explicitly not | `capability-matrix.md` §1/§3 |
| 10 | Minimum integration package | Key + quickstart + SDK tarball + examples + matrix checklist | `capability-matrix.md` §4 |

## 2. API contract changes

New endpoint:

```
GET /v1/usage
  auth:     x-dfr-key (required)
  class:    read
  response: {
    projectId, period: { start, end },
    requests: {
      total,
      byRouteClass, byStatusClass, byRoute, byChain, byCapability, byErrorCode
    },
    lastRequestAt?,
    limits: { rateLimits: { read, write, stream }, scope: { chains, capabilities, allowWrite } },
    requestId
  }
```

Semantics (also in OpenAPI descriptions and `docs/api/quickstart.md`):

- Counts **authenticated, route-matched** API calls in the current Gateway process.
- The `/v1/usage` call itself is excluded; `/healthz`, `/readyz`, `/metrics` are never counted.
- Labels are bounded: route ids/capabilities/error codes are enums, chain labels collapse to `other`
  after 32 distinct values (configurable on `UsageMeter`).
- Counts reset on restart and are not aggregated across replicas — **not** a billing ledger.

Changed behavior:

- `429` responses now carry `Retry-After` (seconds, rounded up) in addition to the existing
  `details.retryAfterMs`.
- SDK `DfrApiError` gained optional `retryAfterMs` and `attempts` fields.
- SDK retry is **opt-in** (`retry` option); default remains one attempt.

TypeScript exports added: `UsageRouteClass`, `UsageRateLimit`, `UsageLimits`, `UsageResponse`;
`RetryPolicy`, `GetLogsPagedParams`, `GetLogsPagedResult`; gateway exports `UsageMeter`,
`issueApiKey`, `IssueApiKeyOptions`, `IssuedApiKey`.

## 3. Security review of this change

- No secret was written to code, tests, docs, or git. `pnpm check:secrets` passes.
- The issuance CLI prints the plaintext key once to stdout by design, prints the configuration
  hash separately, and never prints the pepper. A test asserts the pepper is not echoed.
- Usage labels never include keys, tx hashes, or raw paths; cardinality is bounded.
- No dependency-direction change: usage lives in Gateway, issuance uses the existing hash
  function, and the SDK types are pure contracts. No BEX object entered DFR.
- Retry never applies to `build`/`broadcast` (server marks them `safe_to_retry: false`), and never
  to caller cancellation.

## 4. Verification (evidence, run on this branch)

Baseline before changes: `pnpm test` → **1207 passed / 213 skipped** (113 passed files).

Final `pnpm verify` (exit 0):

```
check:dependency-lock  package.json declarations match pnpm-lock.yaml importers
typecheck              all workspaces + tests + examples OK
lint                   OK (no findings)
lint:openapi           valid; 1 pre-existing warning (info-license-strict)
test                   120 files passed | 20 skipped
                       1234 tests passed | 213 skipped
coverage               statements 90.50% | branches 83.14% | functions 91.71% | lines 92.14%
check:secrets          passed (366 files, git tracked scope)
```

New tests (27): `usage-endpoint.test.ts` (6), `retry-after.test.ts` (1),
`api-key-issuance.test.ts` (6), SDK `usage.test.ts` (2), `retry.test.ts` (7),
`logs-pagination.test.ts` (3), `developer-quickstart.e2e.test.ts` (2).

Additional gate not part of `pnpm verify` (run manually):

```
pnpm test:sdk-pack
  build -> pack both tarballs -> extract into clean node_modules ->
  Node ESM consumer OK -> TypeScript consumer OK
```

The developer E2E boots a **real** Gateway + Core + EVM Adapter with a stand-in provider and runs
the five examples as child processes, asserting output and that neither the secret nor the full key
appears in it.

## 5. Known limitations and risks (carried forward, not silently dropped)

1. **Usage is process-local.** Restart and multi-replica aggregation are absent. Any pricing
   conversation must not rely on it yet.
2. **Billing/quota does not exist.** `DFR_QUOTA_EXCEEDED` is a defined code with no enforcement.
3. **Self-serve key management does not exist.** Issuance is an operator CLI; one project per
   deployment plus a rotation window.
4. **SDK is not published.** Tarball install is verified; registry release, semver policy, and
   provenance are future work.
5. ~~**No cursor pagination for logs.**~~ Fixed in the follow-up: `/v1/logs` now returns
   `hasMore` + `nextCursor` and the SDK exposes `getLogsPage`. `getLogsPaged` (block windowing)
   remains for older deployments.
6. **Events are not durable.** In-process bus; cursors do not survive restart.
7. **Testnet/devnet only.** No mainnet chain or economic finality evidence.
8. **Lockfile pruning:** regenerating `pnpm-lock.yaml` for the new `examples/quickstart` workspace
   also removed stale importers for `apps/console` and `apps/docs`, which do not exist in this
   snapshot. No dependency versions changed.
9. **E2E flakiness when the machine is loaded:** `staging-preflight.test.ts` can time out under
   heavy parallel load (observed once while builds ran concurrently; passes alone and in the final
   clean `pnpm verify`). Not introduced by this change, but worth a CI resource note.

## 6. Recommended next claimable work (in order)

1. **Durable usage aggregation + quotas** (ADR required; still not started — needs an explicit
   decision): persist per-project usage windows, add
   quota config/enforcement, then expose plan/invoice fields. This is the blocker for selling
   usage-based pricing.
2. ~~**Cursor pagination for `/v1/logs`**~~ Delivered in the follow-up
   (`developer-product-followup-delivery.md`); next claimable item is the SDK release pipeline.
3. **SDK release pipeline**: publish `@dfr/types` + `@dfr/sdk-typescript` to a registry with
   provenance and a semver policy; keep `pnpm test:sdk-pack` as the gate.
4. **Self-serve key API/portal** (control plane; requires an explicit scope decision).
5. **Persistent event log** so `afterCursor` survives restart.

## 7. Reproduction

```bash
git checkout agent/dfr-developer-product
pnpm install --frozen-lockfile
pnpm verify
pnpm test:sdk-pack

# Developer flow, against a deployment:
DFR_M0_API_KEY_PEPPER='<pepper>' pnpm api-key:issue --project my-team
DFR_API_KEY='dfr_…' DFR_BASE_URL='http://127.0.0.1:8787' pnpm examples:quickstart
```
