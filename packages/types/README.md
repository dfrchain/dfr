# @dfr/types

DFR 的纯领域契约包，不执行 I/O，不依赖其他 workspace 包。

- 权威规范：`docs/architecture/domain-model.md`。
- 公开入口：`src/index.ts`。
- 主要域：primitives、chain、account/asset、block/finality、transaction、event、provider、adapter、API、errors。
- 规则：整数用十进制字符串；网络由 chain 推导；状态只有一个事实来源；类型中不得出现私钥/凭证。
- 变更门：Capability、错误码、状态、schemaVersion 变化必须同步 OpenAPI/Schema/规范与契约测试；破坏性变化先 ADR。

验证：`pnpm --filter @dfr/types typecheck` 与 `tests/contract/spec-consistency.test.ts`。
