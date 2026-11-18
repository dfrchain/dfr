# BEX → DFR Integration

> BEX is the upper-layer product. DFR is the independent multi-chain developer access layer it
> consumes over HTTP. **No BEX business object belongs in DFR** (orders, balances ledgers, user
> identities, fee policy). DFR only sees chains, accounts, transactions, logs, and events.
>
> This document describes the integration pattern BEX should implement; it does not change any
> BEX contract.

## 1. Why BEX sits on DFR

BEX needs two things from chains: **payment reconciliation** (did the deposit really happen and
is it final?) and **withdrawal submission** (build → sign externally → broadcast once). Doing that
directly means integrating RPC vendors per chain, failover, reorg handling, and nonce management.
DFR owns exactly that layer and exposes it as one API.

DFR does **not** custody funds, sign, match orders, or keep a ledger. Signing stays in BEX's
external signer, and DFR never receives a private key.

## 2. Deployment prerequisites (operator checklist)

Enable the destination deployment with:

- The chain pair BEX trades (e.g. `base-sepolia` + `arbitrum-sepolia`) at milestone **M4** so
  `contract.logs`, `contract.read`, `account.code` are loaded.
- Write path on: `DFR_M1_ALLOW_WRITE=true`, a **persistent** transaction store
  (`DFR_TRANSACTION_DATABASE_URL`) — there is intentionally no in-memory production fallback.
- An API key whose scope covers **both** chains and the needed capabilities. With write enabled,
  `DFR_M0_SCOPE_CHAINS` / `DFR_M0_SCOPE_CAPABILITIES` must be set explicitly (wildcards only if
  deliberately spelled).
- SSE enabled if BEX wants push (`eventBus` + `sseTickets` assembled by the Gateway).
- Rate limits sized for reconciliation windows (bucket is process-local; see §8).

## 3. Key scope for BEX

| Scope | Value | Why |
|---|---|---|
| chains | `base-sepolia,arbitrum-sepolia` | deposit chain + withdrawal chain |
| capabilities | `account.code,contract.read,contract.logs,account.balance,block.read,transaction.read,transaction.build,transaction.simulate,transaction.broadcast` | reconciliation + withdrawal |
| allowWrite | `true` | build/simulate/broadcast |
| IP allowlist | BEX egress IPs | limits blast radius of a leaked key |

A missing capability is not a 500: it returns `422 DFR_UNSUPPORTED_CAPABILITY` (fail-closed).
A missing scope returns `403 DFR_PROJECT_SCOPE_DENIED`.

## 4. Deposit reconciliation (logs → finality → credit)

1. **Discover the range.** Keep your last scanned block.
2. **Fetch logs in windows.** `POST /v1/logs` rejects ranges beyond the chain's `maxBlockRange`
   (default 2000 blocks for EVM). Use the SDK windowing helper:
   ```ts
   const { logs } = await dfr.getLogsPaged({
     chain: 'base-sepolia',
     fromBlock: lastScanned,
     toBlock: latestFinalized,
     address: paymentContract,
     topics: [transferTopic],
   });
   ```
   `limit` truncates silently — do not use it as pagination. If a window may contain more logs
   than you can process, choose a smaller `windowBlocks`.
3. **Check finality, not just inclusion.** Before crediting, resolve the chain's certified head:
   ```ts
   const confirmation = await dfr.confirmTransaction({
     chain: 'base-sepolia',
     txHash,
     minFinality: 'finalized',
     timeoutMs: 60_000,
   });
   if (!confirmation.confirmation.reached) {
     // Not final yet. Persist progress and re-check; never treat 200/reached:false as failure.
   }
   ```
   `finalityStatus` and `finalizedTag` are exposed by `GET /v1/chains/{chainId}`; on testnets
   "verified" means tag semantics were verified, not economic security.
4. **Credit in the BEX ledger** with the `txHash` + `logIndex` as the idempotency key. Do not
   credit on `tx.pending` events.

Reorgs: a previously included transaction can vanish. Re-scan from the last **finalized** block
and treat `DFR_CHAIN_REORG` / missing receipts as "unconfirmed", not "failed". For money-critical
paths, reconcile from finality forward, not from the head.

## 5. Withdrawal submission (build → sign → broadcast once)

```ts
const built = await dfr.buildTransaction(request, { idempotencyKey: businessKey });
const simulation = await dfr.simulateTransaction({
  transactionId: built.transactionId,
  unsignedTransaction: built.unsignedTransaction, // byte-for-byte, do not edit
});
if (!simulation.simulation.success) {
  await dfr.abandonTransaction(built.transactionId); // release the nonce
  // rebuild with corrected parameters; never broadcast a reverted record
}
// BEX signs OUTSIDE DFR, then:
const sent = await dfr.broadcastTransaction(
  { transactionId: built.transactionId, signedTransaction },
  { idempotencyKey: `${businessKey}:broadcast` },
);
```

Rules that prevent money loss:

- **build occupies a nonce.** Use `POST /v1/transactions/preflight` for a read-only check; if you
  decide not to send, call `abandon` explicitly or the nonce gap stays on-chain.
- **broadcast is sent exactly once by the provider layer.** DFR never auto-retries broadcast.
  A timeout is ambiguous (`DFR_PROVIDER_TIMEOUT`); do **not** blindly resubmit. Reconcile by
  txHash / expectedHash first.
- **Idempotency-Key is required** for broadcast and must be stable per business operation.
  Reusing the same key with a different body returns `409 DFR_IDEMPOTENCY_CONFLICT`.
- `rebroadcast: true` is only for a transaction DFR has observed as `dropped`, and only after
  checking the chain.
- Simulate before every broadcast; a failed simulation must never be broadcast (DFR also blocks
  it server-side).

## 6. Error-driven decisions

| DFR code | BEX decision |
|---|---|
| `DFR_TRANSACTION_REVERTED` | do not send; rebuild with corrected calldata/amount |
| `DFR_TRANSACTION_REJECTED` | terminal for this signed payload; inspect chain error, do not rebroadcast as-is |
| `DFR_INSUFFICIENT_FUNDS` | hold the withdrawal; top up; rebuild (nonce may need abandonment) |
| `DFR_NONCE_CONFLICT` | rebuild; never reuse the transaction record |
| `DFR_IDEMPOTENCY_CONFLICT` | a bug or a key collision; treat as "operation already exists or body drifted" |
| `DFR_FINALITY_NOT_REACHED` / `confirm` returns `reached:false` | keep waiting; not a failure |
| `DFR_CHAIN_REORG` | mark affected credits unconfirmed; re-scan from finalized |
| `DFR_PROVIDER_TIMEOUT` on broadcast | **ambiguous**: reconcile by hash before any resubmission |
| `DFR_RATE_LIMITED` | back off by `Retry-After`; do not parallelize harder |
| `DFR_UNSUPPORTED_CAPABILITY` | configuration error; stop and fix the deployment, not the request |
| `DFR_PROJECT_SCOPE_DENIED` / `DFR_IP_NOT_ALLOWED` | auth/config problem; do not retry |

Full table: `docs/architecture/error-spec-v0.1.md`.

## 7. Events vs polling

- Subscribe for low-latency updates (`POST /v1/events/tickets` + `GET /v1/events/subscribe`) and
  dedupe by `eventId` (at-least-once delivery).
- The bus is in-process: cursors do not survive a Gateway restart. BEX must still reconcile with
  `/v1/logs` + `confirm`; events are an accelerator, not the source of truth.
- For withdrawal confirmation, prefer the long-poll `confirm` endpoint over event heuristics.

## 8. Throughput and limits

- Buckets are per **project + key + route class** and process-local: default read 40 burst / 20
  per second, write 10 burst / 2 per second, stream 5 burst / 1 per second. N replicas multiply
  the effective burst; do not build load-shedding assumptions on the bucket alone.
- `/v1/logs`: keep `toBlock - fromBlock + 1 ≤ maxBlockRange` (2000 EVM default). Prefer many
  small windows over one large one.
- `/v1/usage` reports your effective buckets and request counts (per process, not an invoice).

## 9. Security boundaries BEX must keep

- BEX holds private keys; DFR never does. Never send a private key, mnemonic, or signer
  credential to DFR.
- `signedPayload` is accepted only in broadcast and must not be logged by BEX either.
- Do not encode BEX user identifiers, order ids, or PII into on-chain fields or DFR request
  metadata; keep business identity in BEX.
- DFR's `provider` / `chain_error` fields are redacted; do not expect raw RPC credentials.
- If a real secret is suspected of leaking, rotate it and report the file/line — never paste the
  secret into an issue or a DFR request.

## 10. Integration checklist

- [ ] Deployment reaches M4 and declares the chain pair with `contract.logs` / `contract.read` /
      `account.code`.
- [ ] Write path enabled with persistent store; startup validation passes (`/readyz`).
- [ ] BEX key scope covers both chains and all needed capabilities; IP allowlist set.
- [ ] Reconciliation stores `(chain, txHash, logIndex)` as its idempotency key.
- [ ] Credits happen only after finalized confirmation; reorg path re-scans from finalized.
- [ ] Withdrawal flow uses preflight → build → simulate → external sign → broadcast (one key).
- [ ] Failed simulation always calls abandon; nonce gaps are monitored.
- [ ] Broadcast timeout leads to hash reconciliation, never automatic resubmission.
- [ ] SSE implemented with `eventId` dedupe and log-based backfill.
- [ ] Usage and 429 handling wired to `Retry-After`.
