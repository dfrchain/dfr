# @dfr/provider

The Provider transport and endpoint management layer; it does not
understand EVM/Solana business semantics.

```text
Adapter acquire(requirements)
  → filter capability/kind/archive
  → circuit/health/score
  → ProviderHandle.request(call)
  → retry/failover only when idempotency permits
```

- safe-read may fail over to a different endpoint; the same endpoint is
  never retried.
- non-idempotent-write (broadcast) is never automatically retried.
- Circuit breaking is isolated per provider + method class; half-open uses
  a single probe.
- Logs record providerId, never endpoint or credential.

Verify with: `pnpm vitest run packages/provider/test/provider.test.ts`.
