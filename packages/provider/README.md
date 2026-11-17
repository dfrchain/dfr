# @dfr/provider

Provider 传输与端点管理层；不理解 EVM/Solana 业务语义。

```text
Adapter acquire(requirements)
  → filter capability/kind/archive
  → circuit/health/score
  → ProviderHandle.request(call)
  → retry/failover only when idempotency permits
```

- safe-read 可在不同端点失败切换；同一端点不重复。
- non-idempotent-write（broadcast）绝不自动重试。
- 熔断按 provider + method class 隔离；half-open 单探针。
- 日志记录 providerId，不记录 endpoint 或 credential。

验证：`pnpm vitest run packages/provider/test/provider.test.ts`。
