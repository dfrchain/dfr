# @dfr/gateway

DFR's only public HTTP process. The Gateway is a thin cross-cutting layer; it implements no chain semantics and no transaction state machine.

Current routes: healthz, chains, balance, block, transaction/receipt. For the M1 write routes, see
`docs/architecture/m1-api-contract.md`.

Fixed processing order: requestId → auth/scope → body limit → route/rate → idempotency → validation → Core → response.

When changing routes, update the OpenAPI spec, SDK, Gateway tests, E2E tests, and the requestId envelope together.
Do not introduce a web framework unless the existing node:http pipeline proves unmaintainable and an ADR rules for it.

See `docs/runbooks/m0-local.md` for local runs.
