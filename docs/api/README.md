# DFR HTTP API

`openapi.yaml` 是 HTTP 机器契约的单一事实来源。实现顺序固定为：契约测试先失败 → 更新 OpenAPI/types → Gateway → SDK → E2E。

Connecting to an **already deployed** DFR: start with the
quickstart “connect to an existing deployment” (not included in this
public snapshot); for the key authorization model (why a chain-supported
call still returns 403), see “API keys and scopes” (not included in this
public snapshot).

当前已实现的端点（与 `openapi.yaml` 的 `paths` 一一对应）：

- 只读：`GET /v1/chains`、`GET /v1/chains/{chainId}`、`GET /v1/balances`、
  `GET /v1/blocks/{blockRef}`、`GET /v1/transactions/{txHash}`、
  `GET /v1/accounts/{address}`（ADR-036）；
- Write path: `POST /v1/transactions/preflight` (read-only precheck, ADR-037),
  `POST /v1/transactions/{build,simulate,broadcast}`,
  `POST /v1/transactions/{transactionId}/abandon` (void an unbroadcast transaction, ADR-037),
  `POST /v1/transactions/{txHash}/confirm`;
- 合约只读：`POST /v1/contracts/read`（ADR-035）、`POST /v1/logs`（ADR-034）；
- 事件：`POST /v1/events/tickets`、`GET /v1/events/subscribe`（SSE，M2）。

M0 只读端点、M1 写端点、M2 SSE 与 M4 只读能力均已实现；registry 未启用的能力
在运行时按 `DFR_UNSUPPORTED_CAPABILITY`（HTTP 422）fail-closed。

All endpoints authenticate with the `x-dfr-key: dfr_<keyId>_<secret>` header.
The examples below omit the header; `$DFR_BASE` denotes the target
deployment's base URL (use the value your operator gave you — see
[Ports and base URLs](#ports-and-base-urls)).

## Worked example: the write path end to end

A copy-pasteable set of requests and responses (shapes follow the current
`openapi.yaml` schemas; `from` / `to` / `value` are **objects** — passing
strings returns 400 `DFR_VALIDATION_FAILED`, and the error envelope's
`details.fields` names the offending fields).

**preflight and build share one request body** (`TransactionRequest`).
preflight is a read-only check — it reserves no nonce and stores no record,
and a revert comes back as 200 with `simulation.success: false` instead of
an HTTP error. build assigns a nonce and stores a transaction record
(**never use build as a repeated precheck** — see ADR-037).

```bash
# Request body (shared by preflight and build)
{
  "chain": "ethereum-sepolia",
  "from": { "chain": "ethereum-sepolia", "address": "0x1111111111111111111111111111111111111111" },
  "to":   { "chain": "ethereum-sepolia", "address": "0x2222222222222222222222222222222222222222" },
  "value": { "asset": { "kind": "native", "chain": "ethereum-sepolia" }, "amount": "1000" }
}

curl -s -X POST "$DFR_BASE/v1/transactions/preflight" \
  -H 'x-dfr-key: <key>' -H 'content-type: application/json' -d '<the request body above>'
curl -s -X POST "$DFR_BASE/v1/transactions/build" \
  -H 'x-dfr-key: <key>' -H 'content-type: application/json' \
  -H 'Idempotency-Key: example-build-0001' -d '<the request body above>'
```

The preflight 200 response (the `unsignedTransaction` is a preview only —
not usable for signing or broadcast):

```json
{
  "unsignedTransaction": {
    "schemaVersion": "1",
    "chain": "ethereum-sepolia",
    "payload": "0x...",
    "meta": { "requiresNonce": "42", "chainIdForSigning": "11155111" }
  },
  "simulation": { "success": true },
  "observedNonce": "42",
  "requestId": "req_..."
}
```

The build 200 response:

```json
{
  "transactionId": "txn_...",
  "unsignedTransaction": {
    "schemaVersion": "1",
    "chain": "ethereum-sepolia",
    "payload": "0x...",
    "meta": { "requiresNonce": "42", "chainIdForSigning": "11155111" }
  },
  "requestId": "req_..."
}
```

simulate: send the `transactionId` and `unsignedTransaction` from the build
response back **unchanged** (the payload is checked byte-for-byte against
the stored record; changing any field returns 400). A simulation that
reverts on-chain returns 422 `DFR_TRANSACTION_REVERTED` and marks the
record `reverted`:

```bash
curl -s -X POST "$DFR_BASE/v1/transactions/simulate" \
  -H 'x-dfr-key: <key>' -H 'content-type: application/json' \
  -d '{ "transactionId": "txn_...", "unsignedTransaction": { "...": "the build response, copied byte-for-byte" } }'
```

```json
{
  "transactionId": "txn_...",
  "simulation": { "success": true, "estimatedFee": { "asset": { "kind": "native", "chain": "ethereum-sepolia" }, "amount": "21000000000000" } },
  "requestId": "req_..."
}
```

confirm (after broadcast; addressed by the **on-chain txHash**, not the
transactionId). It is a long-poll: the request blocks until `minFinality`
is reached or `timeoutMs` elapses; on timeout it returns 200 with
`reached: false` (not an error — tracking continues in the background):

```bash
curl -s -X POST "$DFR_BASE/v1/transactions/<txHash>/confirm" \
  -H 'x-dfr-key: <key>' -H 'content-type: application/json' \
  -d '{ "chain": "ethereum-sepolia", "minFinality": "finalized", "timeoutMs": 60000 }'
```

```json
{
  "confirmation": {
    "ref": { "kind": "hash", "hash": "0x..." },
    "status": "included",
    "finality": "included",
    "requiredFinality": "finalized",
    "confirmations": "234",
    "reached": false
  },
  "requestId": "req_..."
}
```

Signing and broadcast are not part of this example set (signing happens
outside DFR). For the full flow, see §5 of the
quickstart §5 and m1-local §6 (both not included in this public snapshot).

## transactionId is a write-only handle

The `transactionId` (`txn_...`) returned by build is DFR's internal
execution identifier. It serves only as an input handle for simulate /
abandon / broadcast:

- There is **no endpoint that reads transaction status by
  `transactionId`**; passing one to `GET /v1/transactions/{id}` returns
  400 — that endpoint accepts **on-chain transaction hashes** only.
- After broadcast, read status exclusively by txHash:
  `GET /v1/transactions/{txHash}` and
  `POST /v1/transactions/{txHash}/confirm`.
- To give up on a transaction before broadcast, void it explicitly with
  `POST /v1/transactions/{transactionId}/abandon`, which releases the
  nonce lease.

The record lifecycle, step by step:

| Step | Call | What happens | What you can do next |
|---|---|---|---|
| build | `POST /v1/transactions/build` | Creates a transaction record and reserves a nonce; returns `transactionId` + `unsignedTransaction` | Simulate it, abandon it, or sign the payload externally and broadcast |
| simulate | `POST /v1/transactions/simulate` | Read-only execution check against the record; the payload must match the record byte-for-byte | If it reverts (422), fix the request and build anew — a `reverted` record cannot be broadcast; otherwise sign + broadcast, or abandon |
| broadcast | `POST /v1/transactions/broadcast` | Submits the signed payload exactly once (no automatic retries); returns the on-chain `txHash` | Track status by txHash (GET / confirm); the `transactionId` has no further use |
| confirm | `POST /v1/transactions/{txHash}/confirm` | Long-poll until `minFinality` is reached or `timeoutMs` elapses; 200 with `reached: false` on timeout | Call again to keep waiting, or poll `GET /v1/transactions/{txHash}` |
| abandon | `POST /v1/transactions/{transactionId}/abandon` | Voids a `built` / `simulated` (not yet broadcast) record and releases its nonce lease; idempotent | Nothing further — the record is terminal (`abandoned`) |

## Ports and base URLs

The port numbers across the documents are not the same thing; match them
to your setup:

| Port / base URL | Which setup it belongs to | Source |
|---|---|---|
| `8787` | Gateway process default port (the `DFR_GATEWAY_PORT` default); the TypeScript SDK's default `baseUrl` is also `http://localhost:8787` | Configuration reference, m0-local |
| `18787` | Default **host-side mapped** port of the m1-local container setup (`DFR_GATEWAY_HOST_PORT`, `docker-compose.m1.yml`) | m1-local §8b |
| Any other port (e.g. staging's `18087`) | A specific deployment's mapping | **Use the base URL your operator gave you** |

When connecting to a deployed instance, always use the operator-provided
base URL; never infer a production address from a runbook's local default.
