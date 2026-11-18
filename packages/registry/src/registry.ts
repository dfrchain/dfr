/**
 * Chain Registry (see docs/adr/ADR-003-chain-registry.md and packages/registry/config/README.md).
 *
 * Responsibilities:
 * - Load and validate chains.yaml (JSON Schema 2020-12, sharing the same schema with CI);
 * - Run cross-field integrity checks that JSON Schema cannot express;
 * - Project registry entries into domain models (Chain / ChainRegistryEntry / ProviderDescriptor);
 * - At startup, validate `registry.capabilities ⊆ adapter.capabilities()` (fail-closed).
 *
 * Security: this class only stores **references** (env: / file: / vault:). Endpoints and credentials are only
 * resolved inside `resolve*`, and callers must never write them to logs.
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
/* Raw (parsed YAML) structure                                             */
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
  /** Registry file path; defaults to packages/registry/config/chains.yaml. */
  file?: string;
  /** Environment variable source; defaults to process.env. Injectable in tests. */
  env?: NodeJS.ProcessEnv;
  /** File-reading function; injectable in tests. */
  readFile?: (path: string) => string;
  /**
   * Resolver for `vault:` references; by default a file-based vault under `DFR_VAULT_DIR`.
   * Explicit injection is for tests and as the replacement point for "connecting a real Vault" (see `vault.ts`).
   */
  vault?: VaultReader;
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
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

/** Cross-field rules JSON Schema cannot express (README validation rules 1–4). */
function validateCrossField(raw: RawRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chainIds = new Set(Object.keys(raw.chains));

  for (const [id, provider] of Object.entries(raw.providers)) {
    if (!chainIds.has(provider.chain)) {
      issues.push({
        path: `providers.${id}.chain`,
        message: `points to a nonexistent chain "${provider.chain}" (orphaned Provider)`,
      });
    }
  }

  // Precondition for registry ⊆ adapter: capabilities must be known capabilities.
  // The **single source of truth** for the known-capability set is `@dfr/types`' `CAPABILITY_IDS` (before ADR-034 this was
  // a hardcoded copy that drifted whenever a capability was added — now referenced directly, eliminating the duplicate source).
  const known = new Set<string>(CAPABILITY_IDS);
  for (const [id, chain] of Object.entries(raw.chains)) {
    for (const cap of chain.capabilities) {
      if (!known.has(cap)) {
        issues.push({ path: `chains.${id}.capabilities`, message: `unknown capability "${cap}"` });
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
   * `vault:` resolver. When not explicitly injected, it is built from `DFR_VAULT_DIR` (undefined when unset).
   * It stays undefined rather than a "throwing placeholder": it is only needed when a `vault:` reference is actually encountered,
   * and a deployment that does not use a vault should not fail startup over this optional configuration.
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
      if (chain === undefined) continue; // Already reported during validation; skipped defensively here.
      descriptors.set(id, projectProvider(id, provider, chain));
    }
    this.descriptors = descriptors;
  }

  /**
   * Load from a file and validate.
   *
   * Any failing step throws `DFR_CONFIGURATION_ERROR` (fail-closed; never start degraded).
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
      throw configError(`cannot read registry file: ${file}`, cause);
    }
    return ChainRegistry.fromText(text, { env, source: file, ...(vault !== undefined ? { vault } : {}) });
  }

  /** Load from YAML text and validate. */
  static fromText(
    text: string,
    options: { env?: NodeJS.ProcessEnv; source?: string; vault?: VaultReader } = {},
  ): ChainRegistry {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (cause) {
      throw configError('registry is not valid YAML', cause);
    }
    return ChainRegistry.fromObject(parsed, options);
  }

  /** Load from an already-parsed object and validate. */
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
        .map((f) => `${f.path} (${f.pattern})`)
        .join(', ');
      throw configError(`registry ${source} hit a suspected secret: ${summary}`);
    }

    const issues = validateWithSchema(parsed);
    if (issues.length > 0) {
      throw configError(
        `registry ${source} failed schema validation: ${issues
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}`,
      );
    }

    const raw = parsed as RawRegistry;
    const crossIssues = validateCrossField(raw);
    if (crossIssues.length > 0) {
      throw configError(
        `registry ${source} failed integrity validation: ${crossIssues
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}`,
      );
    }

    return new ChainRegistry(raw, env, vault);
  }

  /* ---------------- Queries ---------------- */

  /** All chains (domain models, without milestone). Order matches the config file. */
  listChains(): readonly Chain[] {
    return [...this.entries.values()].map(projectChain);
  }

  /** All registry entries (including milestone deployment metadata). */
  listEntries(): readonly ChainRegistryEntry[] {
    return [...this.entries.values()];
  }

  hasChain(id: string): boolean {
    return this.entries.has(id);
  }

  /** Get a registry entry; missing → DFR_NOT_FOUND. */
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
      throw configError(`unknown Provider "${id}"`);
    }
    return descriptor;
  }

  /** Number of Providers for a chain; used by M0 acceptance (at least 2 EVM Providers). */
  providerCount(chainId: string): number {
    return this.listProviders(chainId).length;
  }

  /**
   * Resolve an endpoint reference.
   *
   * A missing reference is a configuration error: sending a request to an undefined address is more dangerous than failing startup.
   */
  resolveEndpoint(descriptor: ProviderDescriptor): string {
    const value = this.resolveRef(descriptor.endpointRef, `provider ${descriptor.id} endpointRef`);
    if (value === undefined) {
      throw configError(`provider ${descriptor.id} endpointRef resolved to empty`);
    }
    return value;
  }

  /**
   * Resolve a credential reference.
   *
   * Both `'none'` (public endpoint) and "the referenced environment variable is unset" return undefined — the latter means
   * the endpoint is accessed unauthenticated. Configuration errors (e.g. unimplemented `vault:`) throw.
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
          throw configError(`${where}: environment variable ${target} is not set`);
        }
        return value;
      }
      case 'file': {
        try {
          return readFileSync(target, 'utf8').trim();
        } catch (cause) {
          if (options.missingIsUndefined === true) return undefined;
          throw configError(`${where}: cannot read file ${target}`, cause);
        }
      }
      case 'vault':
        return this.resolveVault(target, where, options);
      default:
        throw configError(`${where}: unrecognized reference format "${ref}"`);
    }
  }

  /**
   * Resolve `vault:path`.
   *
   * Three failures must be distinguished (this is security semantics, not style):
   * - **Vault not configured**: `DFR_VAULT_DIR` missing and no reader injected → throw a configuration error.
   *   It must never silently degrade to "unauthenticated", or an endpoint needing a key would be accessed anonymously on a configuration error.
   * - **Path escape**: the reader treats it as not found → handled the same as "not provided", but the log text must **not distinguish** it,
   *   so that "out-of-bounds probing" cannot become a distinguishable probe.
   * - **Not found**: `missingIsUndefined` decides the semantics (credentials may be missing, endpoints may not).
   */
  private resolveVault(
    path: string,
    where: string,
    options: { missingIsUndefined?: boolean },
  ): string | undefined {
    if (this.vault === undefined) {
      throw configError(
        `${where}: a vault: reference requires DFR_VAULT_DIR to be configured (or a VaultReader to be injected)`,
      );
    }
    const value = this.vault.read(path);
    if (value === undefined) {
      if (options.missingIsUndefined === true) return undefined;
      throw configError(`${where}: entry not found in vault`);
    }
    return value;
  }

  /* ---------------- Adapter capability validation ---------------- */

  /**
   * Validate `registry ⊆ adapter` at startup (review fix R-03).
   *
   * A violation → `DFR_CONFIGURATION_ERROR`, refuse to start; no silent degradation.
   */
  assertAdapterCapabilities(chainId: string, adapterCapabilities: readonly CapabilityId[]): void {
    const entry = this.entries.get(chainId);
    if (entry === undefined) throw configError(`unknown chain "${chainId}"`);
    const declared = new Set<string>(adapterCapabilities);
    const missing = entry.capabilities.filter((cap) => !declared.has(cap));
    if (missing.length > 0) {
      throw configError(
        `chain ${chainId} declares registry capabilities beyond those declared by the Adapter: ${missing.join(', ')}`,
      );
    }
  }

  /** Registry update time, used for auditing and cache invalidation. */
  get updatedAt(): string {
    return this.raw.updatedAt;
  }
}

/* ------------------------------------------------------------------ */
/* Projection                                                           */
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
 * Project into domain models: explicitly drop milestone.
 *
 * Audit fix A-01: milestone is deployment metadata and does not enter runtime domain objects.
 * Fields are constructed one by one here instead of spreading after destructuring, to avoid silently leaking a forgotten deployment field.
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
