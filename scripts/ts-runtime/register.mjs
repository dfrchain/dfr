// 注册 DFR 运行时解析钩子（M1-E02）。
//
// 用法：
//   node --experimental-strip-types --experimental-transform-types \
//     --import ./scripts/ts-runtime/register.mjs apps/gateway/src/main.ts
//
// 为什么需要 `--experimental-transform-types`：仓库使用了 TS 参数属性
// （`constructor(private readonly pool: Pool) {}`），剥离模式不支持，必须变换。
import { register } from 'node:module';
register('./resolve-hooks.mjs', import.meta.url);
