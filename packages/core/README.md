# @dfr/core

Core 是模块化单体的编排与 Capability Router。

当前职责：Registry + Adapter + Provider Manager 装配、M0 查询路由、统一上下文与错误归一化。
M1 后委托 `@dfr/transaction` 处理交易状态；Core 不拥有数据库语义。

禁止：

- import 具体 `@dfr/adapter-evm`；Adapter 由 composition root 注册；
- `if (chain === ...)` 链分支；
- 直接执行 SQL；
- 绕过 capability 检查。

`src/stores.ts` 的内存实现是 M0/测试兼容，M1 迁移后只保留 re-export。

验证：`tests/e2e/gateway.e2e.test.ts`、Adapter contract 与 workspace typecheck。
