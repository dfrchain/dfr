# @dfr/adapter-evm

EVM family Adapter: maps the DFR domain model onto JSON-RPC.

Current implementation: M0 read-only (getInfo, native balance, block, transaction, receipt) + M1-B01 transaction codec
(legacy / EIP-2930 / EIP-1559) + M1-B02 `build` (pending nonce, gas,
EIP-1559 fees, a single `acquire()` pins one Provider endpoint, explicit nonce supported) +
M1-B03 `simulate` (`eth_call` + `eth_estimateGas`; reverts normalized to
`{ success:false, revertReason }`, without throwing 5xx).
`contract.read` (ADR-035, `eth_call` + ABI codec, caller provides the ABI),
`account.code` (ADR-036, `eth_getCode` + nonce + balance),
`contract.logs` (ADR-034, `eth_getLogs`) and `broadcast` (M1-C02) are implemented.
Not implemented: `event.subscribe` (deployment-level event stream, see M6).

`capabilities()` returns `EVM_IMPLEMENTED_CAPABILITIES` (the capability ground truth); `chains.yaml`
is an "allowlist" and must be a subset of it, so capabilities can be implemented before the registry enables them.

- Address/hash/hex validation lives in this package;
- Providers are obtained via `ctx.providers.acquire()`;
- When one logical operation needs a consistent endpoint, acquire once or use a stickyKey;
- Every RPC call declares an idempotency class;
- No access to environment variables, databases, or the HTTP Gateway;
- Alpha does not handle ABI encoding for contract writes.

Verify: `pnpm vitest run tests/contract/evm-adapter.contract.test.ts`.
