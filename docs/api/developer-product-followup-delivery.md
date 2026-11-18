# DFR Developer Product — Follow-up Delivery: Log Cursor Pagination

> Predecessor: [developer-product-delivery.md](./developer-product-delivery.md) (task 03).
> Branch: `agent/dfr-developer-product`.
> Implementation commit: `ff3c695` — `[DFR-DEV-PRODUCT] feat(api): cursor pagination for /v1/logs with hasMore/nextCursor`.
> Report commit: the commit that adds this file.
> Date: 2026-11-19 (Asia/Singapore).

## 1. Why this was the next step

The task-03 delivery listed five follow-ups. The top item was **durable usage + quotas**, which
needs a new persistent Store table and an explicit ADR decision (AGENTS.md stop conditions), so it
was **not** silently started. The next self-contained, shippable item was **cursor pagination for
`/v1/logs`**: it removes a real reconciliation hazard for BEX (silent truncation, client-side
windowing), needs no new infrastructure, and is fully verifiable offline.

## 2. What changed

### API (`POST /v1/logs`)

Two mutually exclusive request forms:

```jsonc
// first page
{ "fromBlock": "0", "toBlock": "4500", "address": "0x…", "topics": ["0x…"], "limit": 500 }

// continuation (cursor already pins range + filter)
{ "cursor": "<opaque>", "limit": 500 }
```

Response now always includes `hasMore`, and `nextCursor` when `hasMore` is true:

```jsonc
{
  "logs": [ /* sorted by (blockNumber, logIndex) ascending */ ],
  "hasMore": true,
  "nextCursor": "eyJ2IjoxLCJjaGFpbiI6..." ,
  "requestId": "req_..."
}
```

Behavior guarantees:

- Logs are ordered by `(blockNumber, logIndex)` ascending, **including inside a single block**.
  A page boundary never splits a block incorrectly.
- `limit` is a real page size. `hasMore: true` always comes with `nextCursor`, so a page cannot be
  silently dropped.
- Omitting `limit` keeps the previous behavior (all logs in range, `hasMore: false`).
- The cursor is opaque and stateless: it carries chain, pinned range, filter, and the
  `(afterBlock, afterIndex)` position. A resume request must send **only** `{cursor, limit}`;
  combining it with `fromBlock`/`toBlock`/`address`/`topics` returns `400 DFR_VALIDATION_FAILED`.
- A cursor issued for another chain is rejected (`400`, `details.fields: ["cursor"]`).
- Tampered/unsupported cursors (bad base64url, wrong version, non-decimal positions, >8 KiB) are
  rejected before any chain call.
- The cursor is **not signed**. It is not an authorization token: chain/capability authorization
  is still enforced from `?chain=` and the Key scope. Constructing one can only change the
  caller's own query, never its permissions.

### Gateway implementation

- `apps/gateway/src/logs-cursor.ts` — encode/decode/validate, deterministic sort, position
  filtering, cursor minting.
- `apps/gateway/src/server.ts` — `getLogs` dispatch now fetches the `maxBlockRange`-bounded range
  **without** passing `limit` to the Adapter (the Adapter's `limit` truncated silently), then sorts,
  pages, and mints the continuation. Adapter/Core contracts are unchanged.
- Fail-closed: if a page would need a cursor but the last log has no addressable
  `(blockNumber, logIndex)`, the request returns `500 DFR_INTERNAL_ERROR` instead of dropping data.
  All chains currently declaring `contract.logs` are EVM and provide both fields.

### SDK

- `dfr.getLogsPage({ chain, fromBlock, toBlock, address?, topics?, limit? })`
  → `{ logs, hasMore, nextCursor?, requestId }`.
- Resume: `dfr.getLogsPage({ chain, cursor, limit? })`.
- Local `TypeError` for ambiguous/incomplete parameters (no wasted round trip).
- `getLogs` (array) and `getLogsPaged` (client block windows) are unchanged for compatibility;
  docs mark `getLogsPage` as preferred and `getLogsPaged` as the fallback for older deployments.
- New type: `LogsPageResponse` in `@dfr/types`.

### OpenAPI / docs

- `LogsQuery` gains `cursor`; `fromBlock`/`toBlock` are no longer unconditionally required
  (the description defines the two forms).
- `LogsResponse` requires `hasMore` and documents `nextCursor`.
- `docs/api/quickstart.md` §10 now shows the cursor loop and keeps the windowing fallback.
- `docs/api/capability-matrix.md`: cursor pagination moved into **sellable**; the old "no server
  cursor / silent truncation" caveats are removed.
- Task-03 delivery record annotates the resolved limitation and next-step item.

## 3. Verification (this branch)

`pnpm verify` → exit 0:

```
check:dependency-lock  OK
typecheck              all workspaces + tests + examples OK
lint                   OK
lint:openapi           valid; 1 pre-existing warning (info-license-strict)
test                   123 files passed | 20 skipped
                       1246 tests passed | 213 skipped
coverage               statements 90.39% | branches 82.94% | functions 91.83% | lines 92.15%
check:secrets          passed (371 files)
```

New tests (12):

- `apps/gateway/test/logs-pagination-endpoint.test.ts` (6): deterministic ordering from unsorted
  RPC data; in-block continuation; legacy no-limit behavior; cursor+range rejection; forged cursor;
  cross-chain cursor.
- `sdk/typescript/test/logs-cursor.test.ts` (4): request shapes, resume-only-cursor, local
  validation, 400 mapping.
- `tests/e2e/logs-cursor.e2e.test.ts` (2): real SDK → Gateway → Core → EVM Adapter walk with no
  gaps/duplicates; cross-chain cursor rejection over the wire.

`pnpm test:sdk-pack` → passed (build → pack → clean install layout → Node + `tsc` consumers).
The dist smoke run asserts that the packed SDK exposes `getUsage`, `getLogsPaged`, and
`getLogsPage`, and type-checks a consumer importing `UsageResponse`.

## 4. Compatibility and rollout notes

- **Additive HTTP fields** (`hasMore`, `nextCursor`) and an optional request field (`cursor`);
  existing clients are unaffected.
- Clients that sent `limit` to get a truncated sample and ignored the rest now get `hasMore: true`
  instead of silent truncation — that is the intended fix, but it is a visible behavior change for
  anyone relying on "limit caps the query". No such reliance exists in this repo's clients.
- Pagination fetches the full `maxBlockRange` window per page (bounded by the same cap as before)
  and pages in the Gateway. This trades a little repeated work for a stateless cursor and no
  Adapter contract change. If a range is repeatedly near the cap, callers should narrow windows.
- The cursor encodes its range; changing `toBlock` mid-pagination requires starting a new first
  page rather than editing the cursor (by design — "advancing head" cursors need a different
  contract, tracked below).

## 5. Remaining gaps after this follow-up

1. **Durable usage aggregation + quotas** — still not started; requires ADR + persistent Store.
   This is the blocker for usage-based pricing.
2. **SDK release pipeline** — tarball verified, no registry publication/provenance yet.
3. **Cursor follow-the-head** — current cursor pins `toBlock`; a long-running reconciler must open
   a new range as the chain advances. Documented, not implemented.
4. **Non-EVM logs** — `contract.logs` is only declared for EVM chains; Solana has no log cursor.
5. **Self-serve key management** and **persistent event replay** remain out of scope.

## 6. Reproduction

```bash
git checkout agent/dfr-developer-product
pnpm install --frozen-lockfile
pnpm verify
pnpm test:sdk-pack

# focused checks
pnpm vitest run apps/gateway/test/logs-pagination-endpoint.test.ts \
  sdk/typescript/test/logs-cursor.test.ts \
  tests/e2e/logs-cursor.e2e.test.ts
```
