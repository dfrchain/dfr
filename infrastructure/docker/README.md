# Docker 交付范围

M1-A 提供本地 PostgreSQL 测试依赖；M1-E02 提供 Gateway 运行镜像与 M1 一体化样例。

要求：固定镜像主版本、健康检查、资源上限、持久卷、非 root 应用容器、migration/runtime 身份分离。
禁止在镜像或 compose 中写真实凭证。

## 文件

| 文件 | 用途 |
|---|---|
| `docker-compose.test.yml` | **测试**用 PostgreSQL（固定 `container_name`、暴露 55432）。供 `pnpm test:db` |
| `gateway.Dockerfile` | Gateway 运行镜像：非 root、只读根文件系统、`HEALTHCHECK` → `/healthz` |
| `docker-compose.m1.yml` | M1 一体化**样例**（PostgreSQL + 迁移任务 + Gateway），**非生产部署文件** |
| `initdb/01-roles.sh` | 角色与口令初始化的唯一来源（两个 compose 共用） |
| `.env.example` | 变量形状（含样例 compose 额外需要的变量）；`.env` 不入库 |

## 实测属性（2026-10-05，M1-E02）

```text
镜像运行用户        uid=1000(node)          —— 非 root
根文件系统          read_only: true
提权                no-new-privileges:true
容器内 .env         不存在（.dockerignore 排除）
/healthz            200
/readyz             200（stores=ok，chains 明细）／503（依赖不可达时）
SIGTERM             优雅退出，退出码 0
```

注意：`docker-compose.m1.yml` 默认把主机端口映射到 **18787**（容器内固定 8787），
避免与本机既有服务冲突；可用 `DFR_GATEWAY_HOST_PORT` 覆盖。

### 备份 / 恢复客户端（E5，2026-10-08）

运行镜像内置 **PostgreSQL 17 客户端**（`postgresql17-client`），因此生产备份可用
同一镜像执行 `pg_dump` / `pg_restore` / `psql`，不依赖宿主机碰巧安装同主版本客户端。

实测（`dfr-gateway:e5-backup`）：

```text
运行用户       uid=1000(node)
pg_dump        PostgreSQL 17.11
pg_restore     PostgreSQL 17.11
psql           PostgreSQL 17.11
镜像大小       238,564,072 bytes（约 238 MB）
```

本地恢复演练入口：`pnpm test:db-backup-restore`（只使用隔离库，验证完成即删除）。
供应链扫描仍用 `pnpm supply-chain`。2026-10-09 对同一镜像（`dfr-gateway:e5-backup`）
完整复跑结果：**0 条 HIGH/CRITICAL**；Node 依赖许可证检查通过，无 copyleft；
CycloneDX SBOM 已写入 `infrastructure/docker/sbom/dfr-gateway.cdx.json`。

## 镜像供应链（2026-10-05 实测）

门禁命令：`pnpm supply-chain`（= `scripts/image-supply-chain.sh`）。
它构建镜像、生成 CycloneDX SBOM、并对 HIGH/CRITICAL 漏洞以非零退出码失败。
扫描需要 trivy 漏洞库与 Docker 守护进程，因此**不**进离线的 `pnpm verify`。

**它在 CI 里怎么跑**（`.github/workflows/security-scan.yml`）：

| 维度 | 取值 | 理由 |
|---|---|---|
| 触发 | **每周一定时** + 手动 `workflow_dispatch` | **刻意不挂到每次 push**：漏洞库每天更新，挂上去会让无关提交因上游新 CVE 变红——那是噪声不是信号，会训练团队忽略红灯 |
| trivy 安装 | 官方 release + **校验和验证**，固定版本 | 不引入第三方 action，也不执行"下载即运行"的脚本 |
| 入口 | `pnpm supply-chain` | 与本地**同一脚本**，避免 CI 与本地两套判定口径 |
| 产物 | SBOM 作为 artifact 保留 30 天 | 发布审计时可追溯"当时镜像里有什么" |

### 三步瘦身（每一步都由扫描驱动，而不是凭感觉）

| 步骤 | 变更 | 镜像体积 | HIGH/CRITICAL |
|---|---|---|---|
| 0 | 初始（`--prod=false`） | 316MB | 未扫描 |
| 1 | 只装生产依赖（`--prod`） | 253MB | 44 |
| 2 | 多阶段构建，移除 pnpm/corepack | 232MB | 11 |
| 3 | 移除基础镜像自带的 npm/npx/corepack | **232MB** | **0** |

关键发现：**44 条 HIGH/CRITICAL 全部来自构建/打包工具**（pnpm、npm 自带的
`tar` / `minimatch` / `pacote` / `sigstore` / `glob` / `brace-expansion` / `ip-address`
/ `http-cache-semantics` / `picomatch`），与运行时依赖（`viem` / `pg`）**零重叠**。
运行时入口是 `node --experimental-strip-types`，从不调用任何包管理器。

因此正确处置是**移除工具**，而不是加漏洞豁免。处置后全部严重级扫描为 0 条。

### 许可证检查

门禁同时扫描许可证（`--scanners license`），策略是**只对 Node 依赖拦截**：

| 范围 | 处置 | 理由 |
|---|---|---|
| Node 依赖（`node-pkg`） | 拦截 GPL / AGPL / SSPL / BUSL / Commons-Clause / Elastic / CC-BY-NC | 本项目是私有闭源产品，JS 依赖的 copyleft 会构成真实分发义务 |
| Alpine OS 包 | 仅报告，不拦截 | 基础镜像自带 GPL/LGPL（musl/busybox）是所有 Linux 镜像常态，不是本项目的分发决策 |
| 本项目自己的包 | 允许 `UNLICENSED` | 私有包属预期 |

当前实测：Node 依赖全部为宽松许可（MIT / ISC / Apache-2.0 / BSD / MPL-2.0 / Zlib）；
GPL/LGPL 命中全部来自 Alpine OS 包。反向对照已验证：注入 GPL-3.0 / AGPL-3.0 的
Node 依赖会让门禁以非零码失败。

### 已知保留项

- `/opt/yarn-v1.22.22/` 仍存在于基础镜像中。它**没有任何漏洞发现**，
  因此未移除（无安全依据的删除属于范围外改动）。若将来它出现发现，处置方式同上：移除。
- 移除 npm/npx/corepack 的代价：容器内不再能临时安装东西。生产网关镜像本就不该
  依赖在容器内安装；需要交互式调试时用构建阶段 `deps` 或本地复现。

### SBOM

`infrastructure/docker/sbom/dfr-gateway.cdx.json`（CycloneDX 1.7，约 367 个组件）。
属生成物，已被 `.gitignore` 排除；随时可用 `pnpm supply-chain` 复现。
