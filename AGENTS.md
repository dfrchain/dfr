# DFR 模型开发协议

本文件适用于所有在本仓库工作的 AI 模型与人工开发者。它是执行规则，不替代架构规范。

## 1. 当前事实

- 当前分支基线：M0 只读链路已完成。
- 当前实现：TypeScript SDK → Gateway → Core → EVM Adapter → Provider Manager。
- 当前下一目标：M1 EVM 安全写路径，不是多租户平台。
- 权威任务书：[docs/development/m1-taskbook.md](./docs/development/m1-taskbook.md)。
- 权威架构索引：[docs/architecture/README.md](./docs/architecture/README.md)。

不得使用历史测试数量代替本次验证。接手任务前必须运行相应基线命令。

## 2. 必读顺序

执行任何代码任务前，按顺序读取：

1. 本文件；
2. [design.md](./design.md)；
3. [plan.md](./plan.md)；
4. [docs/development/handoff-protocol.md](./docs/development/handoff-protocol.md)；
5. 当前任务卡列出的架构规范、ADR 与源文件；
6. 当前任务的直接依赖任务交付记录。

不要为了“了解更多”一次加载全部文档；任务卡已经列出最小上下文。

## 3. 不可破坏的架构边界

```text
Gateway       横切关注点；不实现链语义、不直接访问交易表
Core          编排与能力路由；不出现 chain === 'ethereum' 之类分支
Transaction   状态机、幂等、nonce、确认协调；拥有 Store 接口
Adapter       链语义与编解码；不选择 Provider、不访问数据库
Provider      传输、健康、评分、熔断、失败切换；不理解链业务语义
Storage       实现 Store 接口；不反向调用 Core 或 Adapter
```

依赖方向与运行时拓扑见
[docs/architecture/development-plan.md](./docs/architecture/development-plan.md)。

## 4. 安全红线

- 不得把私钥、助记词、API Key、Token、Cookie、完整 `signedPayload` 写入代码、配置、日志、错误、测试快照或提交记录。
- 广播属于 `non-idempotent-write`，Provider 层自动调用次数必须严格为 1。
- M1 启用广播时必须配置持久化 Store；不得静默回退到内存 Store。
- 模拟失败不得广播；签名结果必须绑定原 unsigned transaction。
- 链、Capability、Provider 或凭证配置异常必须 fail-closed。
- 金额、nonce、区块高度、gas 一律使用十进制字符串，不使用 JS `number` 或浮点。

发现疑似 Secret 时只报告文件、行号、类型和轮换建议，不输出 Secret 内容。

## 5. 任务执行协议

1. 只领取状态为 `READY` 且所有依赖为 `DONE` 的一个任务。
2. 执行 `git status --short --branch`，不得覆盖不属于本任务的现有改动。
3. 在任务卡指定的测试文件中先写失败测试并实际看到失败（RED）。
4. 写最小实现使测试通过（GREEN）。
5. 重构但不扩大任务范围（REFACTOR）。
6. 运行任务卡的局部门禁，再运行 `pnpm verify`。
7. 按 [Definition of Done](./docs/development/definition-of-done.md) 自审。
8. 输出交付记录：改动、证据、未做项、风险、下一可领取任务。

一个任务只允许一个行为目标。发现旁支问题时记录到交付报告，不顺手扩展实现。

## 6. 停止条件

遇到以下任一情况必须停止实现并报告，不得自行发明：

- 需要改变 Adapter / Provider / Core / Transaction 的依赖方向；
- 需要新增、删除或改变交易状态语义；
- 需要改变签名信任边界或持久化 `signedPayload`；
- 需要给广播增加自动重试；
- 需要修改既有 Adapter Contract Test 才能让新链通过；
- 需要把 BEX 业务对象放入 DFR；
- OpenAPI、TypeScript 类型与规范无法同时满足；
- 任务依赖未完成、基线测试失败或工作区存在重叠改动；
- 需要引入 Redis、消息队列、微服务、Kubernetes、KMS/HSM 或多租户控制面。

这类变更必须新增或复审 ADR，经明确裁决后再继续。

## 7. 验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm lint:openapi
pnpm test
pnpm check:secrets
pnpm verify
```

真实网络测试必须显式开启，不能进入默认离线门禁。不得把 testnet 偶发成功当作并发、重试或重组正确性的证据。

## 8. Git 与协作

- 正常使用 GitHub，但控制 API 与轮询频率；禁止高频请求或无意义轮询。
- 不使用 `git add -A`；只暂存任务明确涉及的路径。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令覆盖他人改动。
- 并行模型必须使用独立 branch/worktree；一个任务同一时间只允许一个 owner。
- 提交信息建议：`[DFR-M1-XXX] type(scope): summary`。
- 不得为了让 CI 变绿而删除、跳过或放宽安全负对照测试。

## 9. 文档同步

以下变更必须在同一任务中同步文档与契约测试：

| 变更 | 必须同步 |
|---|---|
| API 路由/字段 | OpenAPI、SDK、Gateway、契约测试 |
| Capability | types、Adapter map、Registry schema/config、OpenAPI、契约测试 |
| 错误码 | types、metadata、error spec、OpenAPI、契约测试 |
| 状态转移 | transaction lifecycle、状态机测试、事件映射 |
| 数据表/Store | storage model、migration、Store contract tests、runbook |
| 环境变量 | configuration reference、runbook、启动校验测试 |

过时图比没有图更危险；修改带 ASCII 图的流程时必须同步更新图。
