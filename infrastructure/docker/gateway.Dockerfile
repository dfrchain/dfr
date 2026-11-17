# DFR Gateway 运行镜像（DFR-M1-E02）。
#
# 设计约束：
#   - **非 root**：以镜像自带的 `node` 用户（uid 1000）运行，不新建特权账号；
#   - **零额外运行时依赖**：用仓库自带的解析钩子（scripts/ts-runtime）直接运行 TS 源码，
#     不引入 tsx / ts-node / esbuild；
#   - **不写入任何凭证**：凭证一律由运行时环境变量注入，见 docs/runbooks/m1-local.md；
#   - 固定 Node 主版本（alpine 变体），避免本地与 CI 行为漂移。
#
# 多阶段构建（M1-E02 供应链补充）。
#
# 为什么必须多阶段：pnpm/corepack 只用于**构建期**安装依赖，运行时完全不调用
# （入口是 `node --experimental-strip-types ...`）。若把它们留在最终镜像里，
# 漏洞扫描会报出 44 条 HIGH/CRITICAL——全部来自 pnpm 自带的依赖树
# （tar / minimatch / pacote / sigstore / glob …），与我们的运行时依赖零重叠。
# 删掉构建工具即同时消除这批漏洞、缩小镜像、减少供应链面。
#
# 构建（在仓库根目录，上下文必须是仓库根）：
#   docker build -f infrastructure/docker/gateway.Dockerfile -t dfr-gateway:m1 .

# ---------- 阶段 1：仅用于安装依赖 ----------
FROM node:22-alpine AS deps

WORKDIR /app

# pnpm 版本与 package.json 的 packageManager 保持一致。
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# 只装**生产**依赖（`--prod`）：本镜像用 Node 内置类型剥离直接运行 TS 源码，
# 因此不需要 typescript / eslint / vitest / redocly / @types/node 等开发工具链。
# 需要的运行时依赖只有各 workspace 包的 `dependencies`（viem / pg 等），`--prod` 会保留。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY adapters ./adapters
COPY apps ./apps
COPY sdk ./sdk

RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# ---------- 阶段 2：运行时（不含 pnpm / corepack） ----------
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# PostgreSQL 17 客户端：生产备份/恢复演练必须能在运行镜像内执行
# `pg_dump` / `pg_restore`，否则运维只能依赖宿主机碰巧装有相同主版本的客户端。
# Alpine 默认仓库的 `postgresql17-client` 与测试/生产 PostgreSQL 17 对齐。
# 只装客户端，不装 server；镜像仍以非 root 运行。
RUN apk add --no-cache postgresql17-client

# 只复制已装好的依赖与源码；**不**复制 corepack/pnpm。
# node_modules 内部是 pnpm 的相对符号链接，整体复制后仍可正确解析。
COPY --from=deps --chown=node:node /app /app

# 再移除官方基础镜像自带的包管理工具（npm / npx / corepack）。
#
# 依据来自 SBOM 扫描：`node:22-alpine` 自带 npm，其依赖树（brace-expansion /
# pacote / sigstore / ip-address / http-cache-semantics / picomatch）会带来
# 11 条 HIGH/CRITICAL。这些工具**在运行时完全不被调用**——入口是 `node` 本身。
# 移除后扫描为 0 条 HIGH/CRITICAL。
#
# 代价（有意接受）：容器内不再有 npm/npx 可用于临时排查。生产网关镜像本就不该
# 依赖在容器内安装东西；需要交互式调试时请用构建阶段 `deps` 或本地复现。
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack

# 以非 root 运行；不额外授予任何 capability。
USER node

EXPOSE 8787

# 存活探针：只检查进程能响应 HTTP，不检查依赖（依赖检查属 /readyz）。
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DFR_GATEWAY_PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node","--experimental-strip-types","--experimental-transform-types","--import","./scripts/ts-runtime/register.mjs","apps/gateway/src/main.ts"]
