# @dfr/adapter-evm

EVM 链族 Adapter：把 DFR 领域模型映射到 JSON-RPC。

当前实现：M0 只读（getInfo、原生余额、区块、交易、receipt）+ M1-B01 交易编解码
（legacy / EIP-2930 / EIP-1559）+ M1-B02 `build`（pending nonce、gas、
EIP-1559 费用，单次 `acquire()` 保证同一 Provider 端点，支持显式 nonce）+
M1-B03 `simulate`（`eth_call` + `eth_estimateGas`；回滚归一化为
`{ success:false, revertReason }`，不抛 5xx）。
`contract.read`（ADR-035，`eth_call` + ABI 编解码，调用方提供 ABI）、
`account.code`（ADR-036，`eth_getCode` + nonce + balance）、
`contract.logs`（ADR-034，`eth_getLogs`）与 `broadcast`（M1-C02）均已实现。
未实现：`event.subscribe`（部署级事件流，见 M6）。

`capabilities()` 返回 `EVM_IMPLEMENTED_CAPABILITIES`（能力真相）；`chains.yaml`
是"允许清单"，必须是它的子集，因此可以在注册表启用前先实现能力。

- 地址/hash/hex 校验在本包；
- Provider 由 `ctx.providers.acquire()` 获取；
- 单次逻辑操作需要一致端点时只 acquire 一次或使用 stickyKey；
- 每个 RPC 调用声明 idempotency class；
- 不访问环境变量、数据库、HTTP Gateway；
- Alpha 不负责 ABI 合约写编码。

验证：`pnpm vitest run tests/contract/evm-adapter.contract.test.ts`。
