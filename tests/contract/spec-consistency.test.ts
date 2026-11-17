/**
 * 规范一致性契约测试。
 *
 * 目的：把"规范与契约必须一致"从人工核对变成可回归的自动断言。
 * 覆盖 docs/adr/ADR-009-api-contract.md 与 docs/adr/ADR-003-chain-registry.md 的约定。
 *
 * 注意：这些断言失败意味着**规范与契约已经互相漂移**，必须修正其中一方，
 * 不允许通过修改测试来绕过。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

/**
 * ajv-formats 是 CJS 包（`__esModule` + `exports.default`）。
 * 在 verbatimModuleSyntax + NodeNext 下 default import 会被解析为模块命名空间，
 * 因此用 createRequire 显式加载——这是处理 CJS 依赖的标准逃生口。
 */
const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as FormatsPlugin;

import { CAPABILITY_IDS } from '../../packages/types/src/capability.ts';
import { COMMITMENT_TO_FINALITY_STATE, commitmentOf } from '../../packages/types/src/block.ts';
import { EVM_IMPLEMENTED_CAPABILITIES, EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { ChainRegistry } from '@dfr/registry';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
} from '../../apps/gateway/src/handlers/write.ts';
import { DFR_ERROR_CODES } from '../../packages/types/src/errors.ts';
import { FINALITY_ORDER, reachesFinalityLevel } from '../../packages/types/src/block.ts';
import type { FinalityLevel, FinalityState } from '../../packages/types/src/block.ts';
import type { AccountRef } from '../../packages/types/src/account.ts';
import type { SignedTransaction, Transaction } from '../../packages/types/src/transaction.ts';
import type { ChainId, TransactionId } from '../../packages/types/src/primitives.ts';
import type { Chain, ChainRegistryEntry } from '../../packages/types/src/chain.ts';
import type {
  BroadcastTransactionResponse,
  BroadcastTransactionRequest,
  BuildTransactionResponse,
  ConfirmTransactionRequest,
  ConfirmTransactionResponse,
  SimulateTransactionRequest,
  SimulateTransactionResponse,
} from '../../packages/types/src/api.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8');

interface RegistryProvider {
  chain: string;
  priority: number;
}
interface RegistryChain {
  capabilities: string[];
  finalityStatus?: string;
  milestone?: string;
  finality?: { kind: string; finalizedTag?: boolean; confirmations?: number };
  /** 用于把 "registry ⊆ adapter" 断言绑定到具体 Adapter。 */
  adapter: { id: string; version: string };
}
interface Registry {
  chains: Record<string, RegistryChain>;
  providers: Record<string, RegistryProvider>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- YAML/OpenAPI 解析结果是结构化文档，
   此处显式标注为 any 以避免为测试引入完整的 OpenAPI 类型定义。 */
const openapi: any = parseYaml(read('docs/api/openapi.yaml'));
const registry = parseYaml(read('packages/registry/config/chains.yaml')) as Registry;
const registrySchema = JSON.parse(read('packages/registry/config/chains.schema.json'));
const errorSpec = read('docs/architecture/error-spec-v0.1.md');
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('Chain Registry', () => {
  it('chains.yaml 通过 JSON Schema 求值（不是人工比对）', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(registrySchema);
    const valid = validate(registry);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(valid).toBe(true);
  });

  it('每个 Provider 指向存在的 Chain，且无孤儿 Provider', () => {
    const chainIds = new Set(Object.keys(registry.chains));
    const orphans = Object.values(registry.providers)
      .map((p) => p.chain)
      .filter((c) => !chainIds.has(c));
    expect(orphans).toEqual([]);
  });

  it('Provider priority 落在 0..10（与 priorityBonus 同量纲）', () => {
    for (const [id, p] of Object.entries(registry.providers)) {
      expect(p.priority, `provider ${id}`).toBeGreaterThanOrEqual(0);
      expect(p.priority, `provider ${id}`).toBeLessThanOrEqual(10);
    }
  });

  it('每条链声明了 finalityStatus，未验证的不会被静默当作已验证', () => {
    for (const [id, c] of Object.entries(registry.chains)) {
      expect(c.finalityStatus, `chain ${id}`).toMatch(/^(unverified|verified)$/);
    }
  });

  it('Registry 声明的能力必须是已知能力（registry ⊆ adapter 的前置条件）', () => {
    const known = new Set<string>(CAPABILITY_IDS);
    const unknown: string[] = [];
    for (const c of Object.values(registry.chains)) {
      for (const cap of c.capabilities) {
        if (!known.has(cap)) unknown.push(cap);
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe('Registry ⊆ Adapter 能力（防"注册表声明了未实现的能力"漂移）', () => {
  it('adapter: evm 的每条链，registry 能力都在 EVM Adapter 的 capabilities() 之内', () => {
    // 事实来源规则 R-03：Registry 是允许清单，Adapter 是能力真相。
    // 若这里失败，说明 chains.yaml 提前声明了 Adapter 尚未实现的能力——
    // 后果是 M1 启动时 DfrCore 直接 fail-closed（DFR_CONFIGURATION_ERROR），
    // 例如 M1-B10 曾发现 base-sepolia 声明 transaction.broadcast 但 Adapter 未实现。
    // 修复方式永远是移除注册表声明（或先实现 Adapter），不得放宽本断言。
    const implemented = new Set<string>(EVM_IMPLEMENTED_CAPABILITIES);
    const violations: string[] = [];
    for (const [id, chain] of Object.entries(registry.chains)) {
      if (chain.adapter.id !== 'evm') continue;
      for (const cap of chain.capabilities) {
        if (!implemented.has(cap)) violations.push(`${id}: ${cap}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('ethereum-sepolia 已在 M1-B 启用 transaction.build / transaction.simulate', () => {
    const sepolia = registry.chains['ethereum-sepolia'];
    expect(sepolia).toBeDefined();
    expect(sepolia!.capabilities).toContain('transaction.build');
    expect(sepolia!.capabilities).toContain('transaction.simulate');
  });

  it('base-sepolia 已按真实最终性标定（checkpoint/finalizedTag）并启用 transaction.broadcast', () => {
    // 权威依据：docs/reviews/2026-10-06-base-sepolia-finality-evidence.md
    // （两个独立端点返回一致的 finalized 高度/哈希，且不回退）。
    const base = registry.chains['base-sepolia'];
    expect(base).toBeDefined();
    expect(base!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
    expect(base!.finalityStatus).toBe('verified');
    expect(base!.capabilities).toContain('transaction.broadcast');
    // 反向对照：Adapter 必须真的实现它，否则与 registry ⊆ adapter 冲突。
    expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has('transaction.broadcast')).toBe(true);
  });

  it('M4 两腿就绪：arbitrum-sepolia 已注册（checkpoint/verified、写能力）且不改变早期里程碑', () => {
    // M4 = BEX 的 Base Sepolia → Arbitrum Sepolia 链路。arbitrum-sepolia 声明为 M4，
    // 因此 M0/M1/M2 部署不会加载它（既有契约不变）；进入 M4 时即可用。
    const arb = registry.chains['arbitrum-sepolia'];
    expect(arb).toBeDefined();
    expect(arb!.milestone).toBe('M4');
    expect(arb!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
    expect(arb!.finalityStatus).toBe('verified');
    expect(arb!.capabilities).toContain('transaction.broadcast');
    // 两腿都是 EVM，Adapter 已实现写能力。
    for (const id of ['base-sepolia', 'arbitrum-sepolia']) {
      expect(registry.chains[id]!.adapter.id).toBe('evm');
      for (const cap of registry.chains[id]!.capabilities) {
        expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has(cap), `${id}: ${cap}`).toBe(true);
      }
    }
  });

  it('M4 两腿按里程碑加载：M2 不含 arbitrum-sepolia，M4 同时含 base/arbitrum', () => {
    // 用真实 Core（不经网络）验证"按里程碑启用"这一行为，而不仅是 YAML 形状。
    const registry = ChainRegistry.load({
      env: {
        DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://x.invalid',
        DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://y.invalid',
        DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: 'https://b.invalid',
        DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL: 'https://a.invalid',
        DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://s.invalid',
      },
    });
    const stores = createInMemoryTransactionStores();
    const mk = (milestone: 'M2' | 'M4') =>
      new DfrCore({
        registry,
        adapters: [
          { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain: chain as never }) },
          { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain: chain as never }) },
        ],
        milestone,
        transactionStores: stores,
      }).listChains().map((c: { id: string }) => c.id);
    const m2 = mk('M2');
    expect(m2).toContain('base-sepolia');
    expect(m2).not.toContain('arbitrum-sepolia');
    const m4 = mk('M4');
    expect(m4).toContain('base-sepolia');
    expect(m4).toContain('arbitrum-sepolia');
  });

  it('Gateway 存在显式里程碑通路（issue #1：防止 Core 支持 M4 而部署层不可达）', () => {
    // 这条断言存在的理由：此前的缺口正是"Core 能构造 M4、Gateway 没有开关"，
    // 契约测试直接 new DfrCore({ milestone: 'M4' }) 会掩盖它。这里把"部署层能表达 M4"
    // 也纳入契约：只要有人删掉 DFR_DEPLOY_MILESTONE 通路，本测试立刻失败。
    const main = read('apps/gateway/src/main.ts');
    expect(main).toContain('DFR_DEPLOY_MILESTONE');
    expect(main).toContain('MILESTONE_ORDER');
    // 缺省必须保持历史行为：写路径打开时仍落到 M1（不是在缺省情况下强行 M4）。
    expect(main).toContain("requestedMilestone ?? 'M1'");
  });

  it('ethereum-sepolia 已在 M1-E03 前启用 transaction.broadcast（C03/C07 前置已 DONE）', () => {
    // 权威依据：chains.yaml 中该能力曾被 M1-B10 移除（当时 Adapter 未实现广播），
    // 注释写明"加回前必须确认 C03 的状态流与 C07 的写权限/脱敏负对照都已就绪"。
    // C03a/C03b 与 C07 现已 DONE，且 Adapter 的 EVM_IMPLEMENTED_CAPABILITIES 含该能力。
    const sepolia = registry.chains['ethereum-sepolia'];
    expect(sepolia!.capabilities).toContain('transaction.broadcast');
    // 反向对照：Adapter 必须真的实现它，否则本断言会与"registry ⊆ adapter"冲突。
    expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has('transaction.broadcast')).toBe(true);
  });
});

describe('Capability 契约一致性', () => {
  it('capability.ts / OpenAPI / JSON Schema 三处枚举完全相同', () => {
    const fromOpenApi = new Set<string>(
      openapi.components.schemas.CapabilityId.enum as string[],
    );
    const fromSchema = new Set<string>(registrySchema.$defs.capabilityId.enum as string[]);
    const fromTypes = new Set<string>(CAPABILITY_IDS);

    expect([...fromOpenApi].sort()).toEqual([...fromTypes].sort());
    expect([...fromSchema].sort()).toEqual([...fromTypes].sort());
  });

  it('Idempotency-Key 长度边界：OpenAPI 与 Gateway 强制值一致（TODO-007）', () => {
    // 该头是写端点的结构契约。此前 OpenAPI 声明 8..128，但 Gateway 只对 broadcast
    // 校验下界、从不校验上界，build/simulate 完全不校验——契约与实现分歧。
    // 本断言把"规格"与"实现常量"绑定，任何一侧单独改动都会失败。
    for (const name of ['IdempotencyKey', 'IdempotencyKeyOptional']) {
      const parameter = openapi.components.parameters[name];
      expect(parameter, `缺少 components.parameters.${name}`).toBeTruthy();
      expect(parameter.schema.minLength, `${name}.schema.minLength`).toBe(
        IDEMPOTENCY_KEY_MIN_LENGTH,
      );
      expect(parameter.schema.maxLength, `${name}.schema.maxLength`).toBe(
        IDEMPOTENCY_KEY_MAX_LENGTH,
      );
    }
    // 边界必须是"闭区间且非退化"：下界 <= 上界，且都不是 0（0 会让空键合法）。
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBeGreaterThan(0);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
  });

  it('判别联合的分支必须用 $ref 引用命名 schema（TODO-005 回归护栏）', () => {
    // redocly 的 `no-illogical-composition-keywords` 只是 warn 级：内联分支无法被
    // discriminator 选中，属工具互操作问题，不会让 lint 失败。这里把它升级为**测试断言**，
    // 防止有人图省事把分支重新内联（那样 SDK 生成器与部分校验器会失去判别信息）。
    const unions = ['FinalityPolicy', 'AssetRef', 'BlockRef', 'TransactionRef'];
    for (const name of unions) {
      const schema = openapi.components.schemas[name];
      expect(schema, `缺少 components.schemas.${name}`).toBeTruthy();
      expect(schema.discriminator?.propertyName, `${name} 应声明 discriminator`).toBeDefined();
      const branches: unknown[] = schema.oneOf ?? [];
      expect(branches.length, `${name} 应至少有两个分支`).toBeGreaterThan(1);
      for (const branch of branches) {
        // 每个分支必须是 `$ref`，不能是内联对象。
        expect(branch, `${name} 的分支必须是 $ref，不能内联：${JSON.stringify(branch)}`).toEqual({
          $ref: expect.stringMatching(/^#\/components\/schemas\/[A-Za-z0-9]+$/u),
        });
      }
      // 被引用的命名 schema 必须真实存在（防悬空引用）。
      for (const branch of branches) {
        const ref = (branch as { $ref: string }).$ref.split('/').pop()!;
        expect(openapi.components.schemas[ref], `${name} 引用了不存在的 schema ${ref}`).toBeTruthy();
      }
    }
  });

  it('chain.info 与裸 transaction.confirm 不再是能力（评审修正 R-01 / R-02）', () => {
    const all = [
      ...CAPABILITY_IDS,
      ...(openapi.components.schemas.CapabilityId.enum as string[]),
      ...(registrySchema.$defs.capabilityId.enum as string[]),
    ];
    expect(all).not.toContain('chain.info');
    expect(all).not.toContain('transaction.confirm');
  });
});

describe('错误码契约一致性', () => {
  it('errors.ts / 错误规范 / OpenAPI 三处错误码集合完全相同', () => {
    const fromTypes = new Set<string>(DFR_ERROR_CODES);
    const fromOpenApi = new Set<string>(
      openapi.components.schemas.DfrError.properties.code.enum as string[],
    );
    const fromSpec = new Set<string>(errorSpec.match(/DFR_[A-Z_]+/g) ?? []);

    expect([...fromOpenApi].sort()).toEqual([...fromTypes].sort());
    expect([...fromSpec].sort()).toEqual([...fromTypes].sort());
  });

  it('错误码不含重复项', () => {
    expect(new Set(DFR_ERROR_CODES).size).toBe(DFR_ERROR_CODES.length);
  });
});

describe('OpenAPI 结构完整性', () => {
  it('所有 $ref 均可解析', () => {
    const refs: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(openapi);

    const unresolved = refs.filter((r) => {
      let cur: unknown = openapi;
      for (const part of r.slice(2).split('/')) {
        if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[part];
        } else return true;
      }
      return false;
    });
    expect(unresolved).toEqual([]);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('Idempotency-Key 仅在 broadcast 为必填（评审修正 R-19）', () => {
    interface OperationLike {
      parameters?: { $ref?: string }[];
    }
    const required: string[] = [];
    for (const [path, item] of Object.entries(openapi.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, OperationLike>)) {
        for (const prm of op.parameters ?? []) {
          if (prm.$ref?.endsWith('/IdempotencyKey')) required.push(`${method} ${path}`);
        }
      }
    }
    expect(required).toEqual(['post /v1/transactions/broadcast']);
  });

  it('SSE 端点支持票据鉴权，浏览器 EventSource 可用（评审修正 R-21）', () => {
    const sse = openapi.paths['/v1/events/subscribe'].get;
    const schemes = (sse.security as Record<string, unknown>[]).map((s) => Object.keys(s)[0]);
    expect(schemes).toContain('SseTicket');
    expect(schemes).toContain('ApiKeyAuth');
  });
});

/* ------------------------------------------------------------------ */
/* 第二轮架构审计新增的断言（防止 A-01 / A-07 / A-08 / A-09 类漂移复发）   */
/* ------------------------------------------------------------------ */

describe('Chain 契约与注册表结构对齐（审计修正 A-01）', () => {
  it('schema 的必填字段都能在 Chain / ChainRegistryEntry 上找到', () => {
    // 由编译器保证：Chain 缺字段时 expectTypeOf 会报错
    expectTypeOf<Chain>().toHaveProperty('finalityStatus');
    expectTypeOf<ChainRegistryEntry>().toHaveProperty('milestone');
    expectTypeOf<ChainRegistryEntry>().toHaveProperty('finalityStatus');
    // milestone 是部署元数据，不得进入领域模型 Chain
    expectTypeOf<Chain>().not.toHaveProperty('milestone');
  });

  it('每条注册表条目的字段不超过 schema 允许集合', () => {
    const allowed = new Set(Object.keys(registrySchema.$defs.chain.properties as object));
    const extra: string[] = [];
    for (const [id, c] of Object.entries(registry.chains as Record<string, object>)) {
      for (const k of Object.keys(c)) if (!allowed.has(k)) extra.push(`${id}.${k}`);
    }
    expect(extra).toEqual([]);
  });
});

describe('网络模型（审计修正 A-07 / A-08）', () => {
  it('networkKind 已从注册表、Schema、OpenAPI 全部移除', () => {
    const raw = read('packages/registry/config/chains.yaml');
    expect(raw).not.toMatch(/^\s*networkKind:/m);
    expect(registrySchema.$defs.chain.properties).not.toHaveProperty('networkKind');

    // 结构化检查：OpenAPI 中不得存在名为 networkKind 的**字段**。
    // 注意不能用 JSON.stringify().toContain()：描述文字里提到该词是合理的
    // （例如说明"已删除 networkKind"），那样会误报。
    const offendingPaths: string[] = [];
    const walkKeys = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walkKeys(v, `${path}[${i}]`));
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === 'networkKind') offendingPaths.push(`${path}.${k}`);
          walkKeys(v, `${path}.${k}`);
        }
      }
    };
    walkKeys(openapi, '#');
    expect(offendingPaths).toEqual([]);
  });

  it('network 只作为链的描述属性，不出现在用户输入或领域对象上', () => {
    // 编译期断言：这些类型不得带 network
    expectTypeOf<AccountRef>().not.toHaveProperty('network');
    expectTypeOf<Transaction>().not.toHaveProperty('network');
    // 请求模型（TransactionRequest）通过 Transaction 的同类断言间接约束；
    // 若将来给 AccountRef / Transaction 加回 network，本测试会失败。
  });

  it('network 字段取值是闭集', () => {
    expect(new Set(openapi.components.schemas.NetworkId.enum)).toEqual(
      new Set(['mainnet', 'testnet', 'devnet', 'custom']),
    );
  });
});

describe('状态单一事实来源（审计修正 A-09）', () => {
  it('Transaction 不再同时携带 status 与 finality', () => {
    expectTypeOf<Transaction>().toHaveProperty('status');
    expectTypeOf<Transaction>().not.toHaveProperty('finality');
  });

  it('OpenAPI 的 Transaction 同样只有 status', () => {
    const t = openapi.components.schemas.Transaction;
    expect(t.required).toContain('status');
    expect(t.properties).not.toHaveProperty('finality');
  });
});

describe('最终性等级有序且不含异常值（审计修正 A-10）', () => {
  it('FinalityLevel 是 FinalityState 的真子集，且排除异常值', () => {
    const levels = Object.keys(FINALITY_ORDER);
    expect(levels).toEqual(['submitted', 'included', 'confirmed', 'finalized']);
    expect(levels).not.toContain('orphaned');
    expect(levels).not.toContain('unknown');
    expect(new Set(openapi.components.schemas.FinalityLevel.enum)).toEqual(new Set(levels));
  });

  it('等级强度严格递增', () => {
    const order = ['submitted', 'included', 'confirmed', 'finalized'] as const;
    for (let i = 1; i < order.length; i += 1) {
      expect(FINALITY_ORDER[order[i]!]).toBeGreaterThan(FINALITY_ORDER[order[i - 1]!]);
    }
  });

  it('异常观测状态永远不满足任何目标等级', () => {
    const abnormal: FinalityState[] = ['orphaned', 'unknown'];
    for (const observed of abnormal) {
      for (const required of ['submitted', 'included', 'confirmed', 'finalized'] as const) {
        expect(reachesFinalityLevel(observed, required), `${observed} vs ${required}`).toBe(false);
      }
    }
  });

  it('达到与未达到的边界正确', () => {
    expect(reachesFinalityLevel('finalized', 'confirmed')).toBe(true);
    expect(reachesFinalityLevel('confirmed', 'confirmed')).toBe(true);
    expect(reachesFinalityLevel('included', 'confirmed')).toBe(false);
  });
});

describe('响应封套与收据（审计修正 A-16 / A-25）', () => {
  it('列表响应携带 requestId', () => {
    const listSchema = openapi.paths['/v1/chains'].get.responses['200'].content['application/json'].schema;
    expect(listSchema.required).toContain('requestId');
  });

  it('声明了 includeReceipt 的端点其响应结构含 receipt', () => {
    const tx = openapi.components.schemas.TransactionResponse;
    expect(tx.properties).toHaveProperty('receipt');
    expect(openapi.components.schemas).toHaveProperty('Receipt');
  });
});

/**
 * M1 写端点响应封套（DFR-M1-A01，见 docs/architecture/m1-api-contract.md 第 1 节）。
 *
 * 写端点不得直接返回裸领域对象：每个成功响应都必须是**命名封套**，
 * 携带 `requestId` 以便跨日志/trace 关联，并用 `transactionId` 承载
 * DFR 内部执行标识（与链上 txHash 分离，见 ADR-015 第 8 条）。
 */
describe('M1 写端点命名响应封套（DFR-M1-A01）', () => {
  interface WriteEnvelopeSpec {
    readonly path: string;
    readonly status: string;
    readonly schema: string;
    readonly bodyField: string;
    readonly bodyRef: string;
    readonly requiresTransactionId: boolean;
  }

  const writeEnvelopes: readonly WriteEnvelopeSpec[] = [
    {
      path: '/v1/transactions/build',
      status: '200',
      schema: 'BuildTransactionResponse',
      bodyField: 'unsignedTransaction',
      bodyRef: 'UnsignedTransaction',
      requiresTransactionId: true,
    },
    {
      path: '/v1/transactions/simulate',
      status: '200',
      schema: 'SimulateTransactionResponse',
      bodyField: 'simulation',
      bodyRef: 'SimulationResult',
      requiresTransactionId: true,
    },
    {
      path: '/v1/transactions/broadcast',
      status: '202',
      schema: 'BroadcastTransactionResponse',
      bodyField: 'broadcast',
      // DFR-M1-E03 修正：HTTP 响应承载的是 TransactionEngine 的公开结果
      // （含 txHash，不含 providerId/ref），不是 Adapter 能力的 BroadcastResult。
      bodyRef: 'BroadcastTransactionOutcome',
      requiresTransactionId: true,
    },
    {
      path: '/v1/transactions/{txHash}/confirm',
      status: '200',
      schema: 'ConfirmTransactionResponse',
      bodyField: 'confirmation',
      bodyRef: 'ConfirmationResult',
      requiresTransactionId: false,
    },
  ];

  for (const spec of writeEnvelopes) {
    it(`${spec.schema} 是命名封套且必须携带 requestId`, () => {
      const response =
        openapi.paths[spec.path].post.responses[spec.status].content['application/json'].schema;

      // 1. 响应必须引用命名封套，而不是裸领域对象。
      expect(response.$ref, `${spec.path} 响应 schema`).toBe(
        `#/components/schemas/${spec.schema}`,
      );

      const schema = openapi.components.schemas[spec.schema];
      expect(schema, `缺失 components.schemas.${spec.schema}`).toBeTruthy();

      // 2. 封套必须显式 required requestId，不能靠调用方约定。
      expect(schema.required, `${spec.schema}.required`).toContain('requestId');

      // 3. 封套必须承载领域对象，且字段名与契约一致。
      expect(schema.required, `${spec.schema}.required`).toContain(spec.bodyField);
      expect(schema.properties[spec.bodyField].$ref).toBe(
        `#/components/schemas/${spec.bodyRef}`,
      );

      // 4. transactionId 是 DFR 内部执行标识，build/simulate/broadcast 必须返回；
      //    confirm 由 path hash 定位，封套内不重复携带。
      if (spec.requiresTransactionId) {
        expect(schema.required, `${spec.schema}.required`).toContain('transactionId');
        expect(schema.properties.transactionId.type).toBe('string');
      } else {
        expect(schema.required, `${spec.schema}.required`).not.toContain('transactionId');
      }
    });
  }

  it('TypeScript DTO 与 OpenAPI 封套字段一一对应', () => {
    // build / simulate / broadcast 携带 transactionId + 领域对象 + requestId。
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('unsignedTransaction');
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('requestId');

    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('simulation');
    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('requestId');

    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('broadcast');
    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('requestId');

    // confirm 由 path hash 定位，封套内不携带 transactionId。
    expectTypeOf<ConfirmTransactionResponse>().toHaveProperty('confirmation');
    expectTypeOf<ConfirmTransactionResponse>().toHaveProperty('requestId');
    expectTypeOf<ConfirmTransactionResponse>().not.toHaveProperty('transactionId');
  });

  it('broadcast 结果的 OpenAPI 形状与 TS DTO 一致（DFR-M1-E03 契约修正）', () => {
    // 修正前的漂移：OpenAPI/SDK 声明 broadcast 为 Adapter 的 BroadcastResult（含 ref），
    // 而 handler 实际返回 TransactionEngine 的结果（含 txHash）。漂移长期未被发现，
    // 因为当时没有任何测试断言 broadcast 的**线形状**。
    const outcome = openapi.components.schemas.BroadcastTransactionOutcome;
    expect(outcome, '缺少 BroadcastTransactionOutcome schema').toBeDefined();
    for (const field of ['transactionId', 'status', 'txHash', 'accepted', 'observedAt']) {
      expect(outcome.required, `BroadcastTransactionOutcome.required 缺少 ${field}`).toContain(field);
    }
    // 反向对照：不得再出现"用 ref 描述 HTTP 响应"的旧形状。
    expect(outcome.properties).not.toHaveProperty('ref');
    expect(openapi.components.schemas.BroadcastResult).toBeUndefined();

    const response = openapi.components.schemas.BroadcastTransactionResponse;
    expect(response.properties.broadcast.$ref).toBe(
      '#/components/schemas/BroadcastTransactionOutcome',
    );

    // TS DTO 必须同样携带 txHash（与 OpenAPI 同名同义）。
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().toHaveProperty('txHash');
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().toHaveProperty('accepted');
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().not.toHaveProperty('ref');
  });
});

/**
 * M1 写请求体契约（DFR-M1-A02，见 docs/architecture/m1-api-contract.md 第 2 节）。
 *
 * confirm 必须承载 minFinality / timeoutMs，且 timeoutMs 有上界（不能创建无限请求）；
 * broadcast body 必须承载 transactionId / signedTransaction / rebroadcast，
 * 且 rebroadcast 默认 false；
 * simulate body 必须承载 transactionId + unsignedTransaction（DFR-M1-B08 修正：
 * 旧 schema 的 `oneOf: TransactionRequest | UnsignedTransaction` 没有 transactionId，
 * 引擎无法定位记录，与 m1-api-contract 第 2 节冲突）。
 */
describe('M1 写请求体契约（DFR-M1-A02）', () => {
  interface OpenApiParameterRef {
    $ref?: string;
    name?: string;
    required?: boolean;
  }

  it('simulate 请求体承载 transactionId + unsignedTransaction（DFR-M1-B08）', () => {
    const post = openapi.paths['/v1/transactions/simulate'].post;
    expect(post.requestBody, 'simulate 必须有 requestBody').toBeTruthy();
    expect(post.requestBody.required, 'simulate requestBody.required').toBe(true);

    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.$ref).toBe('#/components/schemas/SimulateTransactionRequest');

    const body = openapi.components.schemas.SimulateTransactionRequest;
    expect(body.required, 'SimulateTransactionRequest.required').toContain('transactionId');
    expect(body.required, 'SimulateTransactionRequest.required').toContain('unsignedTransaction');
    expect(body.properties.transactionId.type).toBe('string');
    expect(body.properties.unsignedTransaction.$ref).toBe('#/components/schemas/UnsignedTransaction');

    // TypeScript DTO 与 schema 一一对应。
    expectTypeOf<SimulateTransactionRequest>().toHaveProperty('transactionId');
    expectTypeOf<SimulateTransactionRequest>().toHaveProperty('unsignedTransaction');
  });

  it('confirm 请求体承载 chain 与 minFinality / timeoutMs', () => {
    const post = openapi.paths['/v1/transactions/{txHash}/confirm'].post;
    expect(post.requestBody, 'confirm 必须有 requestBody').toBeTruthy();
    expect(post.requestBody.required, 'confirm requestBody.required').toBe(true);

    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.$ref).toBe('#/components/schemas/ConfirmTransactionRequest');

    const body = openapi.components.schemas.ConfirmTransactionRequest;
    expect(body.required, 'ConfirmTransactionRequest.required').toContain('chain');
    expect(body.properties).toHaveProperty('minFinality');
    expect(body.properties).toHaveProperty('timeoutMs');
    expect(body.properties.minFinality.$ref).toBe('#/components/schemas/FinalityLevel');
  });

  it('confirm 的 timeoutMs 有正整数上界，默认值不超过上界', () => {
    const timeout =
      openapi.components.schemas.ConfirmTransactionRequest.properties.timeoutMs;
    expect(timeout.type, 'timeoutMs.type').toBe('integer');
    expect(typeof timeout.maximum, 'timeoutMs.maximum').toBe('number');
    expect(timeout.maximum).toBeGreaterThan(0);
    expect(timeout.default).toBeGreaterThan(0);
    expect(timeout.default).toBeLessThanOrEqual(timeout.maximum);
    expect(timeout.minimum).toBeGreaterThan(0);
  });

  it('confirm 不再同时用 query 与 body 两份 chain', () => {
    const params = (openapi.paths['/v1/transactions/{txHash}/confirm'].post.parameters ??
      []) as OpenApiParameterRef[];
    const chainParams = params.filter(
      (p) => (p.$ref ?? '').endsWith('/ChainQuery') || p.name === 'chain',
    );
    expect(chainParams).toEqual([]);
  });

  it('broadcast 请求体承载 transactionId / signedTransaction / rebroadcast', () => {
    const post = openapi.paths['/v1/transactions/broadcast'].post;
    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.$ref).toBe('#/components/schemas/BroadcastTransactionRequest');

    const body = openapi.components.schemas.BroadcastTransactionRequest;
    expect(body.required, 'BroadcastTransactionRequest.required').toEqual(
      expect.arrayContaining(['transactionId', 'signedTransaction']),
    );
    expect(body.properties.signedTransaction.$ref).toBe(
      '#/components/schemas/SignedTransaction',
    );
    // rebroadcast 默认 false：只有 dropped 状态显式传 true 才重播。
    expect(body.properties.rebroadcast.type).toBe('boolean');
    expect(body.properties.rebroadcast.default).toBe(false);
  });

  it('broadcast 的 Idempotency-Key 必填', () => {
    const params = openapi.paths['/v1/transactions/broadcast'].post
      .parameters as OpenApiParameterRef[];
    const keyParam = params.find((p) => (p.$ref ?? '').endsWith('/IdempotencyKey'));
    expect(keyParam, 'broadcast 必须引用 IdempotencyKey').toBeTruthy();
    expect(openapi.components.parameters.IdempotencyKey.required).toBe(true);
  });

  it('TypeScript 请求体 DTO 与 OpenAPI schema 字段一致', () => {
    // confirm：chain 必填，minFinality/timeoutMs 可选（有服务端默认值）。
    expectTypeOf<ConfirmTransactionRequest['chain']>().toEqualTypeOf<ChainId>();
    expectTypeOf<ConfirmTransactionRequest['minFinality']>().toEqualTypeOf<
      FinalityLevel | undefined
    >();
    expectTypeOf<ConfirmTransactionRequest['timeoutMs']>().toEqualTypeOf<number | undefined>();

    // broadcast：transactionId + signedTransaction 必填，rebroadcast 可选（默认 false）。
    expectTypeOf<BroadcastTransactionRequest['transactionId']>().toEqualTypeOf<TransactionId>();
    expectTypeOf<BroadcastTransactionRequest['signedTransaction']>().toEqualTypeOf<SignedTransaction>();
    expectTypeOf<BroadcastTransactionRequest['rebroadcast']>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});

describe('Commitment 与 FinalityState 的域映射（ADR-031，防再次漂移）', () => {
  it('两个枚举的每个值都有明确归属：映射值或"不属于任何层级"', () => {
    // 这两个枚举曾各自演化、只有两个值同名，导致 commitment 策略把 `included`
    // 误判为不受支持（TODO-015）。本测试把"映射必须完整"固定下来：
    // 任何一边新增值都会在这里失败，强制作者显式决定它的映射。
    const commitments = ['processed', 'confirmed', 'finalized'] as const;
    const finalityStates = ['submitted', 'included', 'confirmed', 'finalized', 'orphaned', 'unknown'] as const;

    for (const c of commitments) {
      const mapped = COMMITMENT_TO_FINALITY_STATE[c];
      expect(finalityStates, `Commitment ${c} 的映射值必须属于 FinalityState`).toContain(mapped);
      // 反查必须闭合：状态 → 该状态代表的 commitment 应还原回原值。
      expect(commitmentOf(mapped), `${mapped} 应反查回 ${c}`).toBe(c);
    }

    // 不属于任何 commitment 的观察值必须在反查中明确为 undefined，
    // 而不是被静默当成某个层级。
    for (const s of ['submitted', 'orphaned', 'unknown'] as const) {
      expect(commitmentOf(s), `${s} 不应映射到任何 commitment`).toBeUndefined();
    }
  });

  it('levels 只能包含真正的 Commitment 取值（registry 配置面的一致性）', () => {
    const commitmentValues = new Set(['processed', 'confirmed', 'finalized']);
    for (const level of Object.keys(COMMITMENT_TO_FINALITY_STATE)) {
      expect(commitmentValues.has(level), `${level} 必须是合法 Commitment`).toBe(true);
    }
  });
});
