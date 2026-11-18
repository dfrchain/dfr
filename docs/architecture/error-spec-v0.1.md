# DFR Unified Error Specification v0.1

> Status: Draft
> Version: 0.1
> Date: 2026-10-03
> Related task: DFR-011
> Related ADR: [ADR-009](../adr/ADR-009-api-contract.md)

## 1. Purpose

So developers do not need to understand the error format of each chain or each RPC vendor:

```text
DFR Error (unified, stable, programmable)
  + chainError (raw chain/provider error, redacted, for troubleshooting only)
```

## 2. HTTP Mapping and Envelope

The HTTP response body follows RFC 9457 Problem Details, with additional DFR extension fields:

```json
{
  "type": "https://docs.dfr.example/errors/DFR_PROVIDER_TIMEOUT",
  "title": "Provider timeout",
  "status": 504,
  "detail": "Provider ethereum-sepolia-secondary timed out after 10000ms",
  "instance": "/v1/balances",
  "dfr_code": "DFR_PROVIDER_TIMEOUT",
  "category": "provider",
  "retryable": true,
  "safe_to_retry": true,
  "request_id": "req_01J8Z6W3Q2K9M4",
  "chain": "ethereum-sepolia",
  "provider": "ethereum-sepolia-secondary",
  "details": { "timeout_ms": 10000, "attempts": 3 },
  "chain_error": { "code": "-32000", "message": "gateway timeout" }
}
```

Conventions:

- `dfr_code` / `category` / `retryable` / `safe_to_retry` / `request_id` are always present;
- `chain_error` keeps only **code + redacted message** and never returns the raw JSON text;
- Error codes are a stable contract: **additive only, never change semantics**;
- `detail` is developer-facing and may be displayed directly; it must not contain credentials, keys, or full address lists.

## 3. Error Categories

| category | Meaning | HTTP range | Responsible party |
|---|---|---|---|
| `client` | The request itself is invalid | 400 / 404 / 422 | Caller |
| `auth` | Authentication or authorization failed | 401 / 403 | Caller |
| `policy` | Blocked by policy or limit | 403 / 409 / 429 | Caller + operations |
| `chain` | Failure caused by on-chain state | 409 / 422 / 502 | Chain |
| `provider` | Transport / RPC endpoint problem | 502 / 503 / 504 | DFR operations |
| `internal` | DFR's own defect | 500 | DFR |

## 4. Error Code Table (v0.1)

### 4.1 client

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_INVALID_REQUEST` | 400 | false | false | Request body is invalid |
| `DFR_VALIDATION_FAILED` | 400 | false | false | Field-level validation failed (see `details.fields`) |
| `DFR_INVALID_ACCOUNT` | 422 | false | false | Address format or type is invalid |
| `DFR_INVALID_ASSET` | 422 | false | false | Asset reference is invalid (e.g. a nonexistent contract) |
| `DFR_NOT_FOUND` | 404 | false | false | Block / transaction / resource does not exist |
| `DFR_UNSUPPORTED_CAPABILITY` | 422 | false | false | The chain does not support the requested capability |
| `DFR_UNSUPPORTED_VERSION` | 400 | false | false | API or adapter version is not supported |
| `DFR_IDEMPOTENCY_CONFLICT` | 409 | false | false | Same key, different request body |
| `DFR_PAYLOAD_TOO_LARGE` | 413 | false | false | Exceeds the size limit |

### 4.2 auth

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_UNAUTHENTICATED` | 401 | false | false | Missing or unparsable credentials |
| `DFR_INVALID_TICKET` | 401 | false | false | SSE ticket is invalid (expired / used / binding mismatch; reasons are not distinguished, ADR-029) |
| `DFR_UNAUTHORIZED` | 403 | false | false | Credentials are invalid, expired, or revoked |
| `DFR_PROJECT_SCOPE_DENIED` | 403 | false | false | Credentials lack permission for this chain / capability |
| `DFR_IP_NOT_ALLOWED` | 403 | false | false | Source IP is not on the allowlist |

### 4.3 policy

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_RATE_LIMITED` | 429 | true | true | Rate limit triggered (with `Retry-After`) |
| `DFR_QUOTA_EXCEEDED` | 429 | false | false | Quota exhausted (daily / monthly) |
| `DFR_POLICY_DENIED` | 403 | false | false | Rejected by the policy engine (amount, allowlist, approval) |
| `DFR_APPROVAL_REQUIRED` | 409 | false | false | Manual approval required (reserved for agent scenarios) |
| `DFR_SPENDING_LIMIT_EXCEEDED` | 403 | false | false | Spending limit exceeded (reserved for agent scenarios) |

### 4.4 chain

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_CHAIN_UNAVAILABLE` | 503 | true | true | All providers unavailable (fail-closed) |
| `DFR_CHAIN_MISMATCH` | 502 | false | false | Provider-returned chainId does not match the registry |
| `DFR_CHAIN_REORG` | 409 | false | true | A reorg occurred; re-confirmation required |
| `DFR_TRANSACTION_REVERTED` | 422 | false | false | Simulation or execution reverted |
| `DFR_TRANSACTION_REJECTED` | 422 | false | false | Node rejected the transaction |
| `DFR_TRANSACTION_NOT_FOUND` | 404 | false | true | Transaction not yet visible (possibly pending) |
| `DFR_TRANSACTION_DROPPED` | 409 | false | true | Not packaged for a long time |
| `DFR_TRANSACTION_REPLACED` | 409 | false | false | Replaced by a transaction with the same nonce |
| `DFR_FINALITY_NOT_REACHED` | 409 | true | true | Required finality not reached within the timeout |
| `DFR_INSUFFICIENT_FUNDS` | 422 | false | false | Insufficient balance to cover the amount or fees |
| `DFR_NONCE_CONFLICT` | 409 | false | true | Nonce already used (EVM) |
| `DFR_BLOCKHASH_EXPIRED` | 409 | false | true | Solana blockhash expired |

### 4.5 provider

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_PROVIDER_UNAVAILABLE` | 503 | true | true | A single provider is unavailable; failover was attempted |
| `DFR_PROVIDER_TIMEOUT` | 504 | true | true | Transport timeout |
| `DFR_PROVIDER_RATE_LIMITED` | 503 | true | true | Provider-side rate limit (not DFR-side) |
| `DFR_PROVIDER_INVALID_RESPONSE` | 502 | true | true | Response does not follow the protocol (including parse failures) |
| `DFR_PROVIDER_CIRCUIT_OPEN` | 503 | true | true | Circuit breaker open |

### 4.6 internal

| code | HTTP | retryable | safeToRetry | Description |
|---|---|---|---|---|
| `DFR_INTERNAL_ERROR` | 500 | false | false | Unclassified internal error |
| `DFR_NOT_IMPLEMENTED` | 501 | false | false | Defined but not implemented (may occur in the Alpha phase) |
| `DFR_CONFIGURATION_ERROR` | 500 | false | false | Registry / environment configuration error |
| `DFR_SIGNING_FAILED` | 500 | false | false | External signer failed (M1+) |

## 5. Error Mapping Rules

### 5.1 Provider → DFR

| Upstream behavior | DFR error |
|---|---|
| `ECONNRESET` / `ETIMEDOUT` / DNS failure | `DFR_PROVIDER_TIMEOUT` (connection class) or `DFR_PROVIDER_UNAVAILABLE` |
| HTTP 429 | `DFR_PROVIDER_RATE_LIMITED` |
| HTTP 5xx | `DFR_PROVIDER_UNAVAILABLE` |
| JSON-RPC `-32000` with message containing `nonce too low` | `DFR_NONCE_CONFLICT` |
| JSON-RPC containing `insufficient funds` | `DFR_INSUFFICIENT_FUNDS` |
| JSON-RPC containing `execution reverted` | `DFR_TRANSACTION_REVERTED` |
| JSON-RPC containing `already known` | Broadcast succeeded (not an error) |

### 5.2 Mandatory Constraints

1. **No raw string passthrough.** Upstream messages must be normalized before entering `detail`.
2. When the category is uncertain, fall back to `DFR_INTERNAL_ERROR` and keep `chain_error`; do not guess.
3. Every error must carry a `request_id` for cross-log lookup.
4. Errors must be constructed through the unified factory in `packages/errors`; `throw new Error('...')` must never reach an outward response.

## 6. Redaction Rules (Mandatory)

The following must never appear in any error field:

```text
Private keys, mnemonics, keystore contents
API Key / Token / JWT / Cookie
RPC endpoint query strings (e.g. ?apikey=<redacted>)
Full Authorization header
Raw signature (signedPayload)
User's full address list
```

Allowed: chain names, provider logical IDs (not URLs), error codes, method names, durations, retry counts, block numbers, transaction hashes (returnable depending on the scenario).

## 7. Client Handling Recommendations (to be included in the SDK docs)

```ts
try {
  await dfr.getBalance({ chain: 'ethereum-sepolia', account });
} catch (err) {
  if (isDfrError(err)) {
    if (err.code === 'DFR_PROVIDER_TIMEOUT' && err.retryable) return retryWithBackoff();
    if (err.code === 'DFR_UNSUPPORTED_CAPABILITY') return showUnsupported();
    if (err.code === 'DFR_RATE_LIMITED') return waitFor(err.details.retryAfterMs);
  }
  throw err;
}
```

## 8. Acceptance Checklist (DFR-011)

- [ ] Every error code in Chapter 4 has a unique constant and factory in `packages/errors`
- [ ] Every error code has unit tests (including HTTP mapping)
- [ ] Every row of the mapping table in Section 5.1 is covered by tests
- [ ] Automated tests assert that error responses contain no credential-like fields (redaction regression tests)
- [ ] All error response structures are registered in OpenAPI
