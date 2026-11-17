# @dfr/sdk-typescript

DFR TypeScript 客户端，只依赖公开 HTTP 契约与 `@dfr/types`。

- API Key 只放 `X-DFR-Key` header；
- 每个请求都带 SDK 生成的 `X-Request-Id`（`req_<ULID>`），Gateway 会回写同一个值，
  因此超时与传输失败也能给出可关联的 requestId；
- 取消与失败分开：调用方 signal 触发时**原样抛出调用方的 abort 原因**；
  SDK 超时抛 `DfrApiError{ code: 'DFR_PROVIDER_TIMEOUT', status: 504 }`；
  传输失败抛 `DfrApiError{ code: 'DFR_PROVIDER_UNAVAILABLE', status: 503 }`；
- 非 2xx 映射为 `DfrApiError`，保留 code/retryable/safeToRetry/requestId；
- 不复制服务端状态机、nonce 或重试策略；
- `buildTransaction` 默认生成 Idempotency-Key（8–128 字符）；**重试必须显式复用
  同一个键**，因为默认键每次调用都会重新生成；
- `simulateTransaction` 以 `transactionId` 定位记录，不生成幂等键；
- 超时后的 `safeToRetry`：只读与 simulate 为 `true`，build 为 `false`；
- 不自动重试 broadcast。

任何 SDK 方法必须有 Gateway E2E，不只做 fetch mock 单元测试。

当前状态（2026-10-06）：

- 只读方法：`test/read.test.ts` 逐条断言请求契约（路径、查询串、封套解包、
  `getReceipt` 缺字段返回 `null`、错误映射）；
- 写方法：`test/write.test.ts` 覆盖 build/simulate/broadcast/confirm 的请求体、
  默认幂等键、超时/取消/传输失败归一化与幂等键长度契约；
- 端到端：`tests/e2e/m1-write.e2e.test.ts` 等驱动真实 Gateway + Core + EVM Adapter
  走完整链路，`chains.yaml` 已为 ethereum-sepolia 声明 build/simulate/broadcast。
