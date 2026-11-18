import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'adapters/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'sdk/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // 覆盖率是**回归护栏**，不是达标游戏：阈值按当前实测值留出余量，
      // 目的是"新代码让覆盖率骤降时红灯"，而不是逼着为已有的锁文件式代码补测试。
      //
      // 两个刻意排除项（都不是"为了好看"）：
      //   1. `packages/storage-postgres/src/**`：PostgreSQL 实现的真实覆盖来自
      //      `pnpm test:db`（独立门禁，需要 Docker）；在离线门禁里它会恒为个位数，
      //      把总阈值拖到无意义的低位。它由 DB 门禁覆盖，不在这里假装。
      //   2. 测试自身的 support 目录与测试文件：测"测试工具"没有意义。
      exclude: [
        'packages/storage-postgres/src/**',
        'tests/**/support/**',
        '**/*.d.ts',
        '**/test/**',
      ],
      // 阈值来自 testing-strategy §8 的**分对象**门槛，而不是一个全局数字：
      // 规范明确写"全局不设统一门槛"（统一数字会诱导写无意义断言），
      // 关键路径用 100% 硬要求替代。这里把规范里已写下的门槛变成可执行检查。
      thresholds: {
        // 表：Adapter 实现 | 80% 行覆盖
        'adapters/evm/src/**': { lines: 80 },
        // 表：领域模型校验 | 90% 行覆盖
        'packages/types/src/**': { lines: 90 },
        // 表：状态机是"关键路径"，用 100% 硬要求（见同一节末句）
        'packages/transaction/src/state-machine.ts': { lines: 100, functions: 100 },
        // 表：错误映射 | 100%（每个错误码至少一条用例）。
        // 逐码的 HTTP 区间判定与 4xx/5xx 分类由 packages/errors/test/errors.test.ts 覆盖。
        'packages/errors/src/**': { functions: 100 },
        // 能力路由的"每个能力支持/不支持两条路径"是**行为**要求，不用行覆盖率表达：
        // 由 packages/core/test/capability-routing.test.ts（method_missing 三条）
        // 与各端点 422 用例共同保证。
      },
    },
  },
});
