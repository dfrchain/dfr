# @dfr/registry

加载、校验并投影 Chain/Provider 注册表。

- 配置事实：`config/chains.yaml`。
- 结构事实：`config/chains.schema.json`。
- 凭证/端点只允许引用；解析规则见 `config/README.md`。
- 启动约束：`registry capabilities ⊆ adapter capabilities`，不满足时 fail-closed。
- `milestone` 是部署元数据，投影到领域 `Chain` 时移除。

新增链/Provider 时必须同时更新配置、schema（如字段变化）、Adapter 注册和契约测试。

验证：`pnpm vitest run packages/registry/test/registry.test.ts tests/contract/spec-consistency.test.ts`。
