/**
 * @dfr/types —— DFR 领域模型的机器可读契约。
 *
 * 规范来源：docs/architecture/*.md、docs/api/openapi.yaml
 * 状态：Draft v0.1（规范冻结阶段）
 *
 * 注意：本包为纯类型契约，编译与校验工具链在 DFR-001 落地。
 */
export * from './primitives.js';
export * from './capability.js';
export * from './chain.js';
export * from './account.js';
export * from './asset.js';
export * from './block.js';
export * from './transaction.js';
export * from './event.js';
export * from './errors.js';
export * from './provider.js';
export * from './adapter.js';
export * from './api.js';
export * from './sequencing.js';
