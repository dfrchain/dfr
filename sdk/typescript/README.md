# @dfr/sdk-typescript

DFR TypeScript client, depending only on the public HTTP contract and `@dfr/types`.

- API Key goes only in the `X-DFR-Key` header;
- Every request carries an SDK-generated `X-Request-Id` (`req_<ULID>`), which the Gateway writes back unchanged,
  so timeouts and transport failures can still provide a correlatable requestId;
- Cancellation is separate from failure: when the caller's signal fires, the caller's abort reason is **rethrown as-is**;
  SDK timeouts throw `DfrApiError{ code: 'DFR_PROVIDER_TIMEOUT', status: 504 }`;
  Transport failures throw `DfrApiError{ code: 'DFR_PROVIDER_UNAVAILABLE', status: 503 }`;
- Non-2xx responses map to `DfrApiError`, keeping code/retryable/safeToRetry/requestId;
- No copying of the server-side state machine, nonce, or retry policy;
- `buildTransaction` generates an Idempotency-Key by default (8–128 characters); **retries must explicitly reuse
  the same key**, because the default key is regenerated on every call;
- `simulateTransaction` locates the record by `transactionId` and generates no idempotency key;
- `safeToRetry` after a timeout: `true` for reads and simulate, `false` for build;
- Broadcast is never retried automatically.

## Developer-product additions (task 03)

- **Opt-in retry policy** (`new DFR({ retry })`): retries only when the server says
  `retryable && safe_to_retry`; reuses the same `X-Request-Id` and `Idempotency-Key`; honors
  `Retry-After` on 429; never retries caller cancellation or unsafe writes. Off by default.
- **Usage**: `getUsage()` — request counts per route/chain/error code plus effective limits.
  Counts are per Gateway process and reset on restart; not a billing ledger.
- **Log pagination**: `getLogsPage({ chain, fromBlock, toBlock, limit })` returns
  `{ logs, hasMore, nextCursor }` from the server's stateless cursor (continue with
  `{ chain, cursor, limit }`). `getLogsPaged({ ..., windowBlocks })` remains available for older
  deployments and splits a wide range into adapter-safe windows.
- **Installable build**: `pnpm --filter @dfr/sdk-typescript build` emits `dist/`; `pnpm pack`
  applies `publishConfig` so a tarball install resolves `dist`, while workspace tests keep using
  `src`. `pnpm test:sdk-pack` verifies build → pack → clean `node_modules` → runtime + `tsc`.

Usage example:

```ts
const dfr = new DFR({ apiKey, retry: { maxRetries: 2 } });
const usage = await dfr.getUsage();
let page = await dfr.getLogsPage({ chain: 'base-sepolia', fromBlock: '0', toBlock: '4500', limit: 500 });
while (page.hasMore && page.nextCursor) {
  page = await dfr.getLogsPage({ chain: 'base-sepolia', cursor: page.nextCursor, limit: 500 });
}
```

Every SDK method must have a Gateway E2E test, not only fetch-mock unit tests.

Current status (2026-11-19, developer-product branch):

- Read methods: `test/read.test.ts` asserts the request contract item by item (path, query string, envelope unpacking,
  `getReceipt` returning `null` when the field is missing, error mapping);
- Write methods: `test/write.test.ts` covers the request bodies for build/simulate/broadcast/confirm,
  default idempotency keys, timeout/cancel/transport-failure normalization, and the idempotency-key length contract;
- Usage/retry/pagination: `test/usage.test.ts`, `test/retry.test.ts`, `test/logs-pagination.test.ts`;
- Installability: `scripts/sdk-pack-smoke.mjs` (`pnpm test:sdk-pack`);
- End to end: `tests/e2e/m1-write.e2e.test.ts` and others drive a real Gateway + Core + EVM Adapter
  through the full chain; `chains.yaml` already declares build/simulate/broadcast for ethereum-sepolia;
- Developer quickstart examples: `examples/quickstart/`, verified by
  `tests/e2e/developer-quickstart.e2e.test.ts`.
