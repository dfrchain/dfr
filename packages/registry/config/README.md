# Chain Registry 配置说明

规范来源：[ADR-003](../../../docs/adr/ADR-003-chain-registry.md)、[provider-spec-v0.1.md](../../../docs/architecture/provider-spec-v0.1.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `chains.yaml` | 链与 Provider 清单（唯一配置事实来源） |
| `chains.schema.json` | JSON Schema 2020-12；启动校验与 CI 校验**共用同一文件** |
| `README.md` | 本说明（环境变量名、校验规则） |

## 安全约束

1. `chains.yaml` 中**不允许**出现任何私钥、助记词、API Key、Token 明文。
2. 只允许引用形式：`env:VAR`、`file:/path`、`vault:path`。
3. 公开端点必须写 `credentialRef: "none"`。
4. 解析后的凭证只存在于内存，不得写入日志、指标、错误详情。
5. `.env` 文件权限必须为 `600`，且必须被 `.gitignore` 忽略。

### `vault:` 引用（M5 生产加固 E4）

`vault:` 表示"由秘密管理器解析"，与 `env:`（进程环境）、`file:`（本地文件）区分。
默认实现是**文件型 vault**：`DFR_VAULT_DIR` 指向根目录，`vault:` 后是根目录内的相对路径。

```text
DFR_VAULT_DIR=/run/secrets/dfr

# chains.yaml 中：
credentialRef: "vault:providers/base-sepolia.key"
# 实际读取 /run/secrets/dfr/providers/base-sepolia.key
```

行为：

- **未设置 `DFR_VAULT_DIR`** 且未注入 `VaultReader` 时，解析 `vault:` 引用**抛配置错误**
  （fail-closed）——绝不静默降级为"未认证"，否则需要密钥的端点会变成匿名访问；
- **路径逃逸被拒绝**（`..`、绝对路径）；越界与"条目不存在"在日志里**不可区分**；
- 接真实 Vault / KMS 时注入自定义 `VaultReader`，**不改注册表格式**。

## 所需环境变量（只列变量名，不含任何值）

Provider 端点（M0 打通 Sepolia 至少需要前两个）：

```text
DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL
DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY      # 公开端点可不设置
DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL
DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY    # 公开端点可不设置
DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL
DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL
```

注册表与 Gateway：

```text
DFR_REGISTRY_FILE                 # 可选；指向本地覆盖配置，默认用本目录 chains.yaml
DFR_GATEWAY_PORT                  # 可选；默认 8787
DFR_M0_API_KEY_ID                 # 必填；8 位 base62，非秘密，可进审计日志
DFR_M0_API_KEY_HASH               # 必填；sha256(secret+pepper) 的 hex
DFR_M0_API_KEY_ID_PREVIOUS        # 可选；轮换期旧 keyId
DFR_M0_API_KEY_HASH_PREVIOUS      # 可选；轮换期旧哈希
DFR_M0_API_KEY_PEPPER             # 可选；哈希加盐，强烈建议设置
DFR_M0_PROJECT_ID                 # 可选；默认 default
DFR_RUN_TESTNET                   # 可选；=1 时才运行真实测试网联调
DFR_TESTNET_TX_HASH               # 可选；真实交易查询验证用
```

### 端点解析语义（M0）

- `endpointRef` 引用的环境变量**缺失即配置错误**：构造 Provider 时抛 `DFR_CONFIGURATION_ERROR`，
  不会把请求发往未定义地址。
- `credentialRef` 引用的环境变量缺失，视为**未认证访问公开端点**（返回 undefined）。
  需要强制凭证时应改用 `file:` 引用。
- `vault:` 在 M0 未实现，遇到即抛配置错误。

> 本阶段不提供 `.env.example`（DFR-001 落地）。原因是环境变量模板容易演变成"顺手填真 Key"的地方；
> 需要配置时请直接创建本地 `.env` 并设置 `chmod 600`。

## 校验规则

**结构化规则由 `chains.schema.json` 定义**，不在本文件重复描述（避免规则漂移，评审修正 R-13）。
启动校验器（DFR-005）与 CI 必须对同一份 schema 求值。

schema 之外，还需校验以下**跨字段引用完整性**（JSON Schema 无法表达）：

1. 每个 `providers[].chain` 必须能在 `chains` 中找到。
2. 每个 `chains[].adapter.id` 必须有对应已注册 Adapter。
3. 每个 `chains[].capabilities[]` 必须是该 Adapter 实际声明的能力子集（`registry ⊆ adapter`，见评审修正 R-03）；违反 → `DFR_CONFIGURATION_ERROR` fail-closed。
4. 出现疑似密钥的模式（`0x` 64 位十六进制、`sk-`、`AKIA` 前缀）→ 拒绝加载并告警。

## 事实来源规则（评审修正 R-03）

```text
Registry.capabilities   = 允许清单（我们对外启用了什么能力）
Adapter.capabilities()  = 能力真相（这条链实际能做什么）
```

启动时校验 `registry ⊆ adapter`；运行时以 **Adapter** 为准。二者不一致属于配置错误，必须拒绝启动而不是降级。

## 最终性事实的验证状态（评审修正 R-22）

每条链带 `finalityStatus`：

- `unverified`：最终性参数是初始假设，**尚未用真实 RPC 验证**；
- `verified`：已在 DFR-014 用真实数据验证，证据记录在 `docs/reviews/`。

`ethereum-sepolia` 已由 DFR-014 用两个独立 RPC 验证并标记 `verified`
（证据：`docs/reviews/2026-10-03-dfr-014-testnet-evidence.md`）；
`base-sepolia` 与 `solana-devnet` 仍为 `unverified`。
特别地，`base-sepolia` 的 `confirmations: 12` 目前没有依据——L2 最终性取决于其在 L1 的数据可用性，
不能靠拍一个确认数解决；DFR-014 必须给出有据可查的 FinalityPolicy。

## 能力启用状态

`capabilities` 必须滞后于实现，**不得提前声明 Adapter 尚未实现的能力**（否则 M1 启动即
`DFR_CONFIGURATION_ERROR`）。当前：

- `ethereum-sepolia`（M1）：`account.balance` / `block.read` / `transaction.read` +
  `transaction.build` / `transaction.simulate`（DFR-M1-B10 启用）；
- `base-sepolia`（M1）：同上，但 `transaction.broadcast` 已在 DFR-M1-B10 移除——
  EVM Adapter 尚未实现广播，待 DFR-M1-C02 后再加回；
- `solana-devnet`（M2）：只读 + `event.subscribe`，M2 任务书重新规划。
