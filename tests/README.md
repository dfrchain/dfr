# DFR 跨包测试

- `contract/`：规范一致性与 Adapter Contract Test，无公网依赖。
- `integration/`：组件组合与显式真实网络测试。
- `e2e/`：SDK → HTTP Gateway → Core → Adapter → Provider 全链路。

包内单元测试放 `<package>/test/`；不要把所有测试集中到这里。

默认 `pnpm test` 必须离线、快速、确定性。公网用例由 `DFR_RUN_TESTNET=1` 显式开启；
并发、超时、熔断、重组必须用可编程替身或本地依赖验证，不能依赖公网偶发行为。

M1 完整矩阵见 `docs/development/test-plan.md`。
