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

Every SDK method must have a Gateway E2E test, not only fetch-mock unit tests.

Current status (2026-10-06):

- Read methods: `test/read.test.ts` asserts the request contract item by item (path, query string, envelope unpacking,
  `getReceipt` returning `null` when the field is missing, error mapping);
- Write methods: `test/write.test.ts` covers the request bodies for build/simulate/broadcast/confirm,
  default idempotency keys, timeout/cancel/transport-failure normalization, and the idempotency-key length contract;
- End to end: `tests/e2e/m1-write.e2e.test.ts` and others drive a real Gateway + Core + EVM Adapter
  through the full chain; `chains.yaml` already declares build/simulate/broadcast for ethereum-sepolia.
