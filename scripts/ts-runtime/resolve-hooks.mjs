// DFR 运行时模块解析钩子（M1-E02）。
//
// 背景：本仓库是 `module: NodeNext` 的 ESM TypeScript 源码仓，导入一律写 `.js`
// 说明符（`./server.js`），磁盘上却是 `.ts`。Node 内置的类型剥离
// （`--experimental-strip-types` / `--experimental-transform-types`）**不会**
// 把 `.js` 说明符重映射到 `.ts`，所以
// `node --experimental-strip-types apps/gateway/src/main.ts` 会报
// `ERR_MODULE_NOT_FOUND: .../server.js`。
//
// 本钩子只做一件事：当正常的 `.js` 解析失败时，尝试同名的 `.ts`。
// 保持零运行时依赖（不使用 tsx / ts-node / esbuild），与仓库"少一个依赖就少一份
// 供应链风险"的取向一致。该行为在 tests/contract/ts-runtime.test.ts 中有真实进程级回归。

/**
 * @param {string} specifier
 * @param {unknown} context
 * @param {(s: string, c: unknown) => Promise<unknown>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // 只兜底 `.js` → `.ts`；其它说明符（包名、node:、data:）原样抛回，
    // 避免把真实的"模块不存在"错误掩盖成另一条路径。
    if (specifier.endsWith('.js')) {
      try {
        return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // 落回原始错误：此刻 `.ts` 也不存在，原始诊断更有用。
      }
    }
    throw error;
  }
}
