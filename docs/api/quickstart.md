# DFR API Quickstart

> Audience: the first integration team.
> Time to first successful call: ~10 minutes once you have a base URL and a key.
> Every command here is exercised by `tests/e2e/developer-quickstart.e2e.test.ts`
> (offline, stand-in RPC) and `pnpm test:sdk-pack` (installable SDK).

DFR is a multi-chain access layer. You call one HTTP API and change only the `chain`
field; DFR handles RPC selection, failover, retries at the provider layer, and
normalizing chain responses.

## 0. What you need from the DFR operator

- `DFR_BASE_URL` — the Gateway URL (for a local deployment, `http://127.0.0.1:8787`).
- An API key in the form `dfr_<keyId>_<secret>`.
- The list of chains/scopes your key is allowed to use.
- Whether the write path and SSE are enabled on that deployment.

Never infer a production URL from a runbook default. Use the value the operator gave you.

## 1. Get an API key

If you operate the deployment, issue the key with the CLI (the plaintext key is printed
**once**; only the hash belongs in configuration):

```bash
# Issues a new key for the deployment pepper.
DFR_M0_API_KEY_PEPPER='<the deployment pepper>' pnpm api-key:issue --project my-team
```

Output (abridged):

```text
DFR_API_KEY=dfr_AbCd1234_<43-char secret>
export DFR_M0_API_KEY_ID=AbCd1234
export DFR_M0_API_KEY_HASH=<sha256 hex>
```

Put the plaintext key in your secret manager and use it as the `x-dfr-key` header.
The Gateway never stores or logs it. Rotation is zero-downtime: set the previous
`DFR_M0_API_KEY_ID_PREVIOUS` / `DFR_M0_API_KEY_HASH_PREVIOUS` while clients switch.

If you are a **consumer** team, the operator gives you the key; do not run issuance yourself.

## 2. Install the SDK

Until the package is published to a registry, install the verified tarball:

```bash
# In the DFR repository (operator or CI):
pnpm --filter @dfr/types build
pnpm --filter @dfr/sdk-typescript build
pnpm --filter @dfr/types pack --pack-destination ./dist-tarballs
pnpm --filter @dfr/sdk-typescript pack --pack-destination ./dist-tarballs
# then in your project:
pnpm add ./dist-tarballs/dfr-types-0.1.0.tgz ./dist-tarballs/dfr-sdk-typescript-0.1.0.tgz
```

`pnpm test:sdk-pack` builds, packs, extracts both tarballs into a clean `node_modules`,
runs a Node ESM consumer, and type-checks a TypeScript consumer. That script is the
definition of "the SDK is installable".

From inside the monorepo you can skip packaging: the examples import the workspace SDK.

## 3. First call (curl)

```bash
export DFR_BASE_URL='https://your-dfr-deployment'
export DFR_API_KEY='dfr_<keyId>_<secret>'

curl -s "$DFR_BASE_URL/v1/chains" -H "x-dfr-key: $DFR_API_KEY"
```

```json
{
  "items": [
    { "id": "ethereum-sepolia", "family": "evm", "network": "testnet", "capabilities": ["account.balance", "..."] }
  ],
  "requestId": "req_01J..."
}
```

Then a balance (decimal strings, never JSON numbers):

```bash
curl -s "$DFR_BASE_URL/v1/balances?chain=ethereum-sepolia&account=0x1111111111111111111111111111111111111111" \
  -H "x-dfr-key: $DFR_API_KEY"
```

## 4. First call (SDK)

```ts
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';

const dfr = new DFR({
  apiKey: process.env.DFR_API_KEY!,
  baseUrl: process.env.DFR_BASE_URL ?? 'http://127.0.0.1:8787',
  timeoutMs: 15_000,
});

const chains = await dfr.listChains();
const balance = await dfr.getBalance({
  chain: 'ethereum-sepolia',
  account: '0x1111111111111111111111111111111111111111',
});
const tx = await dfr.getTransaction({ chain: 'ethereum-sepolia', txHash: '0x…' });
```

Runnable versions of all snippets live in `examples/quickstart/`:

```bash
DFR_API_KEY=... DFR_BASE_URL=... pnpm examples:quickstart
# or individually
pnpm example:chains
pnpm example:balance
pnpm example:errors
pnpm example:usage
pnpm example:events
```

## 5. API surface at a glance

| Area | Endpoint | Class |
|---|---|---|
| Chains | `GET /v1/chains`, `GET /v1/chains/{chainId}` | read |
| Balance | `GET /v1/balances?chain=&account=` | read |
| Blocks | `GET /v1/blocks/{blockRef}?chain=` (`number:`, `hash:`, `slot:`, `tag:`) | read |
| Transactions | `GET /v1/transactions/{txHash}?chain=&includeReceipt=` | read |
| Accounts | `GET /v1/accounts/{address}?chain=` | read |
| Contract read | `POST /v1/contracts/read?chain=` | read |
| Event logs | `POST /v1/logs?chain=` (block range) | read |
| Build / preflight / simulate | `POST /v1/transactions/{build,preflight,simulate}` | write / read (preflight) |
| Broadcast | `POST /v1/transactions/broadcast` (`Idempotency-Key` required) | write |
| Confirm | `POST /v1/transactions/{txHash}/confirm` | write |
| Abandon | `POST /v1/transactions/{transactionId}/abandon` | write |
| Events | `POST /v1/events/tickets`, `GET /v1/events/subscribe` (SSE) | read / stream |
| Usage | `GET /v1/usage` | read |

The single source of truth is `docs/api/openapi.yaml`; `docs/api/README.md` has the
worked write-path example.

## 6. Handle errors correctly

Every failure is RFC 9457 + DFR fields. Branch on `dfr_code`, not on the HTTP status
text. Always log `requestId` (it is the same id in Gateway logs).

```ts
try {
  await dfr.getBlock({ chain: 'ethereum-sepolia', blockRef: '123' });
} catch (error) {
  if (isDfrApiError(error)) {
    error.code;        // 'DFR_VALIDATION_FAILED'
    error.requestId;   // correlate with support
    error.retryable;   // is the transport worth retrying?
    error.safeToRetry; // is it SAFE to execute again? (false for build/broadcast)
    error.attempts;    // how many attempts the SDK made
  }
}
```

Rules:

- Retry only when `retryable && safeToRetry`.
- Never blind-retry `broadcast`; `safeToRetry` is `false` for non-idempotent writes.
- On `DFR_TRANSACTION_REVERTED`, rebuild the transaction; do not rebroadcast.
- On `DFR_NONCE_CONFLICT`, do not reuse the transaction; rebuild.
- On `429`, use `Retry-After` (the SDK does this automatically).
- `requestId` is the support handle; never paste keys or signed payloads into tickets.

The full code table is `docs/architecture/error-spec-v0.1.md`.

### Opt-in retries in the SDK

```ts
const dfr = new DFR({
  apiKey,
  retry: { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 5_000 },
});
```

Retries are **off by default**. When enabled, the SDK reuses the same `X-Request-Id`
and the same `Idempotency-Key`, honors `Retry-After`, and never retries a caller
cancellation or an operation the server marked unsafe.

## 7. View usage

```ts
const usage = await dfr.getUsage();
console.log(usage.requests.total, usage.requests.byRoute, usage.limits.rateLimits);
```

`GET /v1/usage` reports:

- requests by route class (read/write/stream), status class, route, chain, capability,
  and error code;
- the effective token buckets (`limits.rateLimits`) and your key scope;
- `period.start` / `period.end` and `lastRequestAt`.

Important: counts are **per Gateway process** and reset on restart. The usage call
itself is excluded from the counts. There is no priced billing or invoice yet — see
`docs/api/capability-matrix.md` §3 before promising usage-based billing to a customer.

## 8. Transaction status

After broadcast, status is read **by on-chain txHash**:

```ts
const tx = await dfr.getTransaction({ chain, txHash, includeReceipt: true });
const confirmation = await dfr.confirmTransaction({
  chain,
  txHash,
  minFinality: 'finalized',
  timeoutMs: 60_000,
});
if (!confirmation.confirmation.reached) {
  // 200 + reached:false is NOT an error; keep polling or call confirm again.
}
```

`transactionId` (`txn_…`) from build is a write-only handle for simulate/abandon/
broadcast. It is not readable by `GET /v1/transactions/{id}` by design.

## 9. Events (SSE)

Server/desktop:

```ts
const { events, close } = dfr.subscribeEvents({ chain: 'ethereum-sepolia' });
for await (const event of events) {
  // at-least-once: dedupe by eventId
  console.log(event.type, event.cursor);
}
close();
```

Browser (`EventSource` cannot set headers): issue a one-time ticket first.

```ts
const ticket = await dfr.createEventTicket({ filter: { chain: 'ethereum-sepolia' } });
const stream = dfr.subscribeEventsWithTicket(ticket.ticket, { chain: 'ethereum-sepolia' });
```

Cursors are process-local in the current implementation; they are not a durable replay
log. For money-critical reconciliation use `/v1/logs` plus `confirm`.

## 10. Query logs over a wide range

The server caps each `/v1/logs` request at the chain's `maxBlockRange` (2000 blocks by
default for EVM) and `limit` truncates silently. Use the SDK's ranged helper:

```ts
const { logs, pages } = await dfr.getLogsPaged({
  chain: 'base-sepolia',
  fromBlock: '0',
  toBlock: '4500',
  address: '0x…',
  windowBlocks: 2000,
});
```

## 11. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `401 DFR_UNAUTHENTICATED` | missing/malformed/rotated key | check `x-dfr-key`; confirm key id is active |
| `403 DFR_PROJECT_SCOPE_DENIED` | chain/capability/write not in key scope | ask operator to widen scope; do not retry |
| `403 DFR_IP_NOT_ALLOWED` | key bound to an IP allowlist | call from the allowed network |
| `422 DFR_UNSUPPORTED_CAPABILITY` | chain does not declare that capability | check `GET /v1/chains/{id}` |
| `429 DFR_RATE_LIMITED` | bucket exhausted | back off by `Retry-After` |
| `503 DFR_PROVIDER_UNAVAILABLE` | provider/chain unavailable or dependency down | retry with backoff if safe |
| `504 DFR_PROVIDER_TIMEOUT` | read/provider timeout | retry if `safeToRetry` |
| stream never opens | SSE not enabled or ticket expired | header auth, or reissue ticket |

## 12. Where to go next

- Worked write path: `docs/api/README.md`.
- BEX (upper-layer product) integration: `docs/api/bex-integration.md`.
- Sellable vs not-sellable: `docs/api/capability-matrix.md`.
- Error contract: `docs/architecture/error-spec-v0.1.md`.
