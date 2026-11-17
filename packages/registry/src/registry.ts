/**
 * Chain Registry（见 docs/adr/ADR-003-chain-registry.md、packages/registry/config/README.md）。
 *
 * 职责：
 * - 加载并校验 chains.yaml（JSON Schema 2020-12，与 CI 共用同一份 schema）；
 * - 执行 JSON Schema 无法表达的跨字段完整性检查；
 * - 把注册表条目投影为领域模型（Chain / ChainRegistryEntry / ProviderDescriptor）；
 * - 在启动时校验 `registry.capabilities ⊆ adapter.capabilities()`（fail-closed）。
 *
 * 安全：本类只保存**引用**（env: / file: / vault:）。端点与凭证在 `resolve*` 时
 * 才被解析，且调用方不得把它们写入日志。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { createDfrError, newRequestId } from '@dfr/errors';
import type {
  CapabilityId,
  Chain,
  ChainFamily,
  ChainId,
  ChainRegistryEntry,
  EndpointRef,
  CredentialRef,
  ProviderDescriptor,
  ProviderId,
  ProviderKind,
  FinalityPolicy,
  NetworkId,
  Milestone,
  FinalityStatus,
} from '@dfr/types';
import { CAPABILITY_IDS } from '@dfr/types';
import { compileSchema, DEFAULT_REGISTRY_FILE } from './schema.js';
import { scanForSecrets } from './secret-scan.js';
import { vaultFromEnv, type VaultReader } from './vault.js';

/* ------------------------------------------------------------------ */
/* 原始（已解析 YAML）结构                                             */
/* ------------------------------------------------------------------ */

export interface RawProvider {
  chain: string;
  kind: ProviderKind;
  endpointRef: string;
  credentialRef: string;
  archive?: boolean;
  priority: number;
  weight: number;
  timeoutMs: number;
  quota?: { requestsPerSecond?: number; requestsPerDay?: number };
  cost?: { unit: 'request' | 'compute-unit' | 'gb'; priceUsd: string };
}

export interface RawChain {
  displayName: string;
  family: ChainFamily;
  network: NetworkId;
  externalChainId?: string;
  adapter: { id: string; version: string };
  finality: FinalityPolicy;
  finalityStatus: FinalityStatus;
  capabilities: string[];
  milestone: Milestone;
  explorerUrl?: string;
}

export interface RawRegistry {
  schemaVersion: string;
  updatedAt: string;
  chains: Record<string, RawChain>;
  providers: Record<string, RawProvider>;
}

export interface LoadRegistryOptions {
  /** 注册表文件路径；默认 packages/registry/config/chains.yaml。 */
  file?: string;
  /** 环境变量来源；默认 process.env。测试可注入。 */
  env?: NodeJS.ProcessEnv;
  /** 文件读取函数；测试可注入。 */
  readFile?: (path: string) => string;
  /**
   * `vault:` 引用的解析器；默认按 `DFR_VAULT_DIR` 走文件型 vault。
   * 显式注入用于测试与"接真实 Vault"的替换点（见 `vault.ts`）。
   */
  vault?: VaultReader;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

interface ValidationIssue {
  path: string;
  message: string;
}

function validateWithSchema(raw: unknown): ValidationIssue[] {
  const validate = compileSchema();
  const ok = validate(raw);
  if (ok) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath === '' ? '$' : e.instancePath,
    message: e.message ?? 'schema violation',
  }));
}

/** JSON Schema 无法表达的跨字段规则（README 校验规则 1–4）。 */
function validateCrossField(raw: RawRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chainIds = new Set(Object.keys(raw.chains));

  for (const [id, provider] of Object.entries(raw.providers)) {
    if (!chainIds.has(provider.chain)) {
      issues.push({
        path: `providers.${id}.chain`,
        message: `指向不存在的 chain "${provider.chain}"（孤儿 Provider）`,
      });
    }
  }

  // registry ⊆ adapter 的前置条件：能力必须是已知能力。
  // 已知能力集合的**唯一事实来源**是 `@dfr/types` 的 `CAPABILITY_IDS`（ADR-034 前这里是
  // 一份硬编码副本，新增能力时会漂移——改为直接引用，消除重复来源）。
  const known = new Set<string>(CAPABILITY_IDS);
  for (const [id, chain] of Object.entries(raw.chains)) {
    for (const cap of chain.capabilities) {
      if (!known.has(cap)) {
        issues.push({ path: `chains.${id}.capabilities`, message: `未知能力 "${cap}"` });
      }
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export class ChainRegistry {
  private readonly raw: RawRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly entries: ReadonlyMap<string, ChainRegistryEntry>;
  private readonly descriptors: ReadonlyMap<string, ProviderDescriptor>;
  /**
   * `vault:` 解析器。未显式注入时按 `DFR_VAULT_DIR` 构造（未设置则为 undefined）。
   * 保持 undefined 而不是"抛错占位"：只有真正遇到 `vault:` 引用时才需要它，
   * 未使用 vault 的部署不应因为缺少这个可选配置而启动失败。
   */
  private readonly vault: VaultReader | undefined;

  private constructor(raw: RawRegistry, env: NodeJS.ProcessEnv, vault: VaultReader | undefined) {
    this.raw = raw;
    this.env = env;
    this.vault = vault;

    const entries = new Map<string, ChainRegistryEntry>();
    for (const [id, chain] of Object.entries(raw.chains)) {
      entries.set(id, projectRegistryEntry(id, chain));
    }
    this.entries = entries;

    const descriptors = new Map<string, ProviderDescriptor>();
    for (const [id, provider] of Object.entries(raw.providers)) {
      const chain = entries.get(provider.chain);
      if (chain === undefined) continue; // 已在校验阶段报错，这里防御性跳过。
      descriptors.set(id, projectProvider(id, provider, chain));
    }
    this.descriptors = descriptors;
  }

  /**
   * 从文件加载并校验。
   *
   * 任一步失败都抛 `DFR_CONFIGURATION_ERROR`（fail-closed，不降级启动）。
   */
  static load(options: LoadRegistryOptions = {}): ChainRegistry {
    const file = options.file ?? DEFAULT_REGISTRY_FILE;
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    const vault = options.vault ?? vaultFromEnv(env);
    let text: string;
    try {
      text = readFile(file);
    } catch (cause) {
      throw configError(`无法读取注册表文件：${file}`, cause);
    }
    return ChainRegistry.fromText(text, { env, source: file, ...(vault !== undefined ? { vault } : {}) });
  }

  /** 从 YAML 文本加载并校验。 */
  static fromText(
    text: string,
    options: { env?: NodeJS.ProcessEnv; source?: string; vault?: VaultReader } = {},
  ): ChainRegistry {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (cause) {
      throw configError('注册表不是合法 YAML', cause);
    }
    return ChainRegistry.fromObject(parsed, options);
  }

  /** 从已解析对象加载并校验。 */
  static fromObject(
    parsed: unknown,
    options: { env?: NodeJS.ProcessEnv; source?: string; vault?: VaultReader } = {},
  ): ChainRegistry {
    const source = options.source ?? '<memory>';
    const env = options.env ?? process.env;
    const vault = options.vault ?? vaultFromEnv(env);

    const findings = scanForSecrets(parsed);
    if (findings.length > 0) {
      const summary = findings
        .map((f) => `${f.path}（${f.pattern}）`)
        .join(', ');
      throw configError(`注册表 ${source} 命中疑似密钥：${summary}`);
    }

    const issues = validateWithSchema(parsed);
    if (issues.length > 0) {
      throw configError(
        `注册表 ${source} 未通过 schema 校验：${issues
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}`,
      );
    }

    const raw = parsed as RawRegistry;
    const crossIssues = validateCrossField(raw);
    if (crossIssues.length > 0) {
      throw configError(
        `注册表 ${source} 未通过完整性校验：${crossIssues
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}`,
      );
    }

    return new ChainRegistry(raw, env, vault);
  }

  /* ---------------- 查询 ---------------- */

  /** 全部链（领域模型，不含 milestone）。顺序与配置文件一致。 */
  listChains(): readonly Chain[] {
    return [...this.entries.values()].map(projectChain);
  }

  /** 全部注册表条目（含 milestone 部署元数据）。 */
  listEntries(): readonly ChainRegistryEntry[] {
    return [...this.entries.values()];
  }

  hasChain(id: string): boolean {
    return this.entries.has(id);
  }

  /** 取注册表条目；不存在 → DFR_NOT_FOUND。 */
  getEntry(id: string): ChainRegistryEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw createDfrError('DFR_NOT_FOUND', {
        requestId: newRequestId(),
        message: `unknown chain "${id}"`,
      });
    }
    return entry;
  }

  /* ---------------- Provider ---------------- */

  listProviders(chainId?: string): readonly ProviderDescriptor[] {
    const all = [...this.descriptors.values()];
    return chainId === undefined ? all : all.filter((p) => p.chain === chainId);
  }

  getProvider(id: string): ProviderDescriptor {
    const descriptor = this.descriptors.get(id);
    if (descriptor === undefined) {
      throw configError(`未知 Provider "${id}"`);
    }
    return descriptor;
  }

  /** 某条链的 Provider 数量；用于 M0 验收（至少 2 个 EVM Provider）。 */
  providerCount(chainId: string): number {
    return this.listProviders(chainId).length;
  }

  /**
   * 解析端点引用。
   *
   * 缺失即配置错误：把请求发到一个未定义的地址比启动失败更危险。
   */
  resolveEndpoint(descriptor: ProviderDescriptor): string {
    const value = this.resolveRef(descriptor.endpointRef, `provider ${descriptor.id} endpointRef`);
    if (value === undefined) {
      throw configError(`provider ${descriptor.id} endpointRef 解析为空`);
    }
    return value;
  }

  /**
   * 解析凭证引用。
   *
   * `'none'`（公开端点）与"引用的环境变量未设置"都返回 undefined —— 后者表示
   * 该端点以未认证方式访问。配置错误（如 `vault:` 未实现）会抛错。
   */
  resolveCredential(descriptor: ProviderDescriptor): string | undefined {
    if (descriptor.credentialRef === 'none') return undefined;
    return this.resolveRef(descriptor.credentialRef, `provider ${descriptor.id} credentialRef`, {
      missingIsUndefined: true,
    });
  }

  private resolveRef(
    ref: string,
    where: string,
    options: { missingIsUndefined?: boolean } = {},
  ): string | undefined {
    const colon = ref.indexOf(':');
    const scheme = colon === -1 ? '' : ref.slice(0, colon);
    const target = colon === -1 ? '' : ref.slice(colon + 1);

    switch (scheme) {
      case 'env': {
        const value = this.env[target];
        if (value === undefined || value === '') {
          if (options.missingIsUndefined === true) return undefined;
          throw configError(`${where}: 环境变量 ${target} 未设置`);
        }
        return value;
      }
      case 'file': {
        try {
          return readFileSync(target, 'utf8').trim();
        } catch (cause) {
          if (options.missingIsUndefined === true) return undefined;
          throw configError(`${where}: 无法读取文件 ${target}`, cause);
        }
      }
      case 'vault':
        return this.resolveVault(target, where, options);
      default:
        throw configError(`${where}: 无法识别的引用格式 "${ref}"`);
    }
  }

  /**
   * 解析 `vault:path`。
   *
   * 三种失败必须区分（这是安全语义，不是风格问题）：
   * - **未配置 vault**：`DFR_VAULT_DIR` 缺失且未注入 reader → 抛配置错误。
   *   绝不能当作"未认证"静默降级，否则一个需要密钥的端点在配置错误时会以匿名访问。
   * - **路径逃逸**：reader 视为未找到 → 同样按"未提供"处理，但**不区分**日志文本，
   *   避免把"越界探测"变成可区分的探针。
   * - **未找到**：交给 `missingIsUndefined` 决定语义（凭证可缺失，端点不可缺失）。
   */
  private resolveVault(
    path: string,
    where: string,
    options: { missingIsUndefined?: boolean },
  ): string | undefined {
    if (this.vault === undefined) {
      throw configError(
        `${where}: vault: 引用需要配置 DFR_VAULT_DIR（或注入 VaultReader）`,
      );
    }
    const value = this.vault.read(path);
    if (value === undefined) {
      if (options.missingIsUndefined === true) return undefined;
      throw configError(`${where}: vault 中未找到条目`);
    }
    return value;
  }

  /* ---------------- Adapter 能力校验 ---------------- */

  /**
   * 启动时校验 `registry ⊆ adapter`（评审修正 R-03）。
   *
   * 违反 → `DFR_CONFIGURATION_ERROR`，拒绝启动；不做静默降级。
   */
  assertAdapterCapabilities(chainId: string, adapterCapabilities: readonly CapabilityId[]): void {
    const entry = this.entries.get(chainId);
    if (entry === undefined) throw configError(`未知链 "${chainId}"`);
    const declared = new Set<string>(adapterCapabilities);
    const missing = entry.capabilities.filter((cap) => !declared.has(cap));
    if (missing.length > 0) {
      throw configError(
        `链 ${chainId} 的 registry 能力超出 Adapter 声明：${missing.join(', ')}`,
      );
    }
  }

  /** 注册表更新时间，用于审计与缓存失效。 */
  get updatedAt(): string {
    return this.raw.updatedAt;
  }
}

/* ------------------------------------------------------------------ */
/* 投影                                                                */
/* ------------------------------------------------------------------ */

function projectRegistryEntry(id: string, raw: RawChain): ChainRegistryEntry {
  const chain: Chain = {
    id: id as ChainId,
    displayName: raw.displayName,
    family: raw.family,
    network: raw.network,
    adapter: { id: raw.adapter.id, version: raw.adapter.version },
    finality: raw.finality,
    finalityStatus: raw.finalityStatus,
    capabilities: raw.capabilities as CapabilityId[],
  };
  if (raw.externalChainId !== undefined) chain.externalChainId = raw.externalChainId;
  if (raw.explorerUrl !== undefined) chain.explorerUrl = raw.explorerUrl;
  return { ...chain, milestone: raw.milestone };
}

/**
 * 投影为领域模型：显式丢弃 milestone。
 *
 * 审计修正 A-01：milestone 是部署元数据，不进运行时领域对象。
 * 这里逐字段构造而不是解构后展开，避免"忘记删除某个部署字段"的静默泄漏。
 */
export function projectChain(entry: ChainRegistryEntry): Chain {
  const chain: Chain = {
    id: entry.id,
    displayName: entry.displayName,
    family: entry.family,
    network: entry.network,
    adapter: entry.adapter,
    finality: entry.finality,
    finalityStatus: entry.finalityStatus,
    capabilities: entry.capabilities,
  };
  if (entry.externalChainId !== undefined) chain.externalChainId = entry.externalChainId;
  if (entry.explorerUrl !== undefined) chain.explorerUrl = entry.explorerUrl;
  return chain;
}

function projectProvider(
  id: string,
  raw: RawProvider,
  chain: ChainRegistryEntry,
): ProviderDescriptor {
  const descriptor: ProviderDescriptor = {
    id: id as ProviderId,
    chain: chain.id,
    network: chain.network,
    kind: raw.kind,
    endpointRef: raw.endpointRef as EndpointRef,
    credentialRef: raw.credentialRef as CredentialRef | 'none',
    capabilities: chain.capabilities,
    priority: raw.priority,
    weight: raw.weight,
    timeoutMs: raw.timeoutMs,
  };
  if (raw.archive !== undefined) descriptor.archive = raw.archive;
  if (raw.quota !== undefined) descriptor.quota = raw.quota;
  if (raw.cost !== undefined) descriptor.cost = raw.cost;
  return descriptor;
}

function configError(message: string, cause?: unknown): Error {
  return createDfrError('DFR_CONFIGURATION_ERROR', {
    requestId: newRequestId(),
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}
