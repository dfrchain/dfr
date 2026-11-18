/**
 * Spec-consistency contract test.
 *
 * Purpose: turn "spec and contract must agree" from manual checking into regressable automated assertions.
 * Covers the conventions in docs/adr/ADR-009-api-contract.md and docs/adr/ADR-003-chain-registry.md.
 *
 * Note: if these assertions fail, the **spec and contract have already drifted apart**; fix one side or the
 * other — working around it by editing the test is not allowed.
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
 * ajv-formats is a CJS package (`__esModule` + `exports.default`).
 * Under verbatimModuleSyntax + NodeNext a default import would resolve to the module namespace,
 * so load it explicitly with createRequire — the standard escape hatch for CJS dependencies.
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
  /** Used to bind the "registry ⊆ adapter" assertion to a concrete Adapter. */
  adapter: { id: string; version: string };
}
interface Registry {
  chains: Record<string, RegistryChain>;
  providers: Record<string, RegistryProvider>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- YAML/OpenAPI parse results are structured documents;
   explicitly annotated as any here to avoid bringing full OpenAPI type definitions into the test. */
const openapi: any = parseYaml(read('docs/api/openapi.yaml'));
const registry = parseYaml(read('packages/registry/config/chains.yaml')) as Registry;
const registrySchema = JSON.parse(read('packages/registry/config/chains.schema.json'));
const errorSpec = read('docs/architecture/error-spec-v0.1.md');
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('Chain Registry', () => {
  it('chains.yaml evaluates against the JSON Schema (not manual comparison)', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(registrySchema);
    const valid = validate(registry);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(valid).toBe(true);
  });

  it('every Provider points at an existing Chain, with no orphan Providers', () => {
    const chainIds = new Set(Object.keys(registry.chains));
    const orphans = Object.values(registry.providers)
      .map((p) => p.chain)
      .filter((c) => !chainIds.has(c));
    expect(orphans).toEqual([]);
  });

  it('Provider priority falls in 0..10 (same scale as priorityBonus)', () => {
    for (const [id, p] of Object.entries(registry.providers)) {
      expect(p.priority, `provider ${id}`).toBeGreaterThanOrEqual(0);
      expect(p.priority, `provider ${id}`).toBeLessThanOrEqual(10);
    }
  });

  it('every chain declares finalityStatus; an unverified one is never silently treated as verified', () => {
    for (const [id, c] of Object.entries(registry.chains)) {
      expect(c.finalityStatus, `chain ${id}`).toMatch(/^(unverified|verified)$/);
    }
  });

  it('capabilities declared by the Registry must be known capabilities (precondition for registry ⊆ adapter)', () => {
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

describe('Registry ⊆ Adapter capabilities (guards against "registry declares unimplemented capabilities" drift)', () => {
  it('for every adapter: evm chain, registry capabilities are all within the EVM Adapter capabilities()', () => {
    // Fact-source rule R-03: the Registry is the allow-list; the Adapter is the capability truth.
    // If this fails, chains.yaml declared a capability the Adapter has not implemented yet —
    // the consequence is that DfrCore fails closed at M1 startup (DFR_CONFIGURATION_ERROR);
    // e.g. M1-B10 once found base-sepolia declaring transaction.broadcast while the Adapter did not implement it.
    // The fix is always to remove the registry declaration (or implement the Adapter first); this assertion
    // must never be relaxed.
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

  it('ethereum-sepolia has transaction.build / transaction.simulate enabled since M1-B', () => {
    const sepolia = registry.chains['ethereum-sepolia'];
    expect(sepolia).toBeDefined();
    expect(sepolia!.capabilities).toContain('transaction.build');
    expect(sepolia!.capabilities).toContain('transaction.simulate');
  });

  it('base-sepolia is calibrated to real finality (checkpoint/finalizedTag) with transaction.broadcast enabled', () => {
    // Authoritative basis: docs/reviews/2026-10-06-base-sepolia-finality-evidence.md
    // (two independent endpoints returned consistent finalized height/hash, with no rollback).
    const base = registry.chains['base-sepolia'];
    expect(base).toBeDefined();
    expect(base!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
    expect(base!.finalityStatus).toBe('verified');
    expect(base!.capabilities).toContain('transaction.broadcast');
    // Reverse control: the Adapter must really implement it, or it conflicts with registry ⊆ adapter.
    expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has('transaction.broadcast')).toBe(true);
  });

  it('M4 both legs ready: arbitrum-sepolia is registered (checkpoint/verified, write capability) without changing earlier milestones', () => {
    // M4 = BEX's Base Sepolia → Arbitrum Sepolia link. arbitrum-sepolia is declared M4, so M0/M1/M2 deployments
    // do not load it (existing contracts unchanged); it becomes usable on entering M4.
    const arb = registry.chains['arbitrum-sepolia'];
    expect(arb).toBeDefined();
    expect(arb!.milestone).toBe('M4');
    expect(arb!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
    expect(arb!.finalityStatus).toBe('verified');
    expect(arb!.capabilities).toContain('transaction.broadcast');
    // Both legs are EVM, and the Adapter implements write capability.
    for (const id of ['base-sepolia', 'arbitrum-sepolia']) {
      expect(registry.chains[id]!.adapter.id).toBe('evm');
      for (const cap of registry.chains[id]!.capabilities) {
        expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has(cap), `${id}: ${cap}`).toBe(true);
      }
    }
  });

  it('M4 legs load by milestone: M2 excludes arbitrum-sepolia, M4 includes both base/arbitrum', () => {
    // Verifies the "enabled by milestone" behaviour with a real Core (no network), not just YAML shape.
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

  it('Gateway has an explicit milestone path (issue #1: prevents Core supporting M4 while the deployment layer cannot reach it)', () => {
    // Why this assertion exists: the earlier gap was exactly "Core could construct M4, Gateway had no switch",
    // and a contract test doing new DfrCore({ milestone: 'M4' }) directly would hide it. "The deployment layer
    // can express M4" is brought into the contract here: deleting the DFR_DEPLOY_MILESTONE path fails this test
    // immediately.
    const main = read('apps/gateway/src/main.ts');
    expect(main).toContain('DFR_DEPLOY_MILESTONE');
    expect(main).toContain('MILESTONE_ORDER');
    // The default must preserve historical behaviour: with the write path open it still lands on M1 (not forced
    // to M4 when no milestone is given).
    expect(main).toContain("requestedMilestone ?? 'M1'");
  });

  it('ethereum-sepolia has transaction.broadcast enabled before M1-E03 (C03/C07 prerequisites DONE)', () => {
    // Authoritative basis: chains.yaml once had this capability removed by M1-B10 (the Adapter did not implement
    // broadcast then), with a comment stating "before adding it back, confirm C03's state flow and C07's
    // write-permission/redaction negative controls are ready". C03a/C03b and C07 are now DONE, and the Adapter's
    // EVM_IMPLEMENTED_CAPABILITIES includes it.
    const sepolia = registry.chains['ethereum-sepolia'];
    expect(sepolia!.capabilities).toContain('transaction.broadcast');
    // Reverse control: the Adapter must really implement it, or this assertion conflicts with "registry ⊆ adapter".
    expect(new Set<string>(EVM_IMPLEMENTED_CAPABILITIES).has('transaction.broadcast')).toBe(true);
  });
});

describe('Capability contract consistency', () => {
  it('capability.ts / OpenAPI / JSON Schema agree on the enumeration in all three places', () => {
    const fromOpenApi = new Set<string>(
      openapi.components.schemas.CapabilityId.enum as string[],
    );
    const fromSchema = new Set<string>(registrySchema.$defs.capabilityId.enum as string[]);
    const fromTypes = new Set<string>(CAPABILITY_IDS);

    expect([...fromOpenApi].sort()).toEqual([...fromTypes].sort());
    expect([...fromSchema].sort()).toEqual([...fromTypes].sort());
  });

  it('Idempotency-Key length bounds: OpenAPI and Gateway enforced values agree (TODO-007)', () => {
    // This header is the write endpoints' structural contract. OpenAPI used to declare 8..128, but Gateway only
    // validated the lower bound for broadcast, never the upper bound, and build/simulate validated nothing —
    // spec and implementation disagreed. This assertion binds the "spec" to the "implementation constants";
    // changing either side alone fails.
    for (const name of ['IdempotencyKey', 'IdempotencyKeyOptional']) {
      const parameter = openapi.components.parameters[name];
      expect(parameter, `missing components.parameters.${name}`).toBeTruthy();
      expect(parameter.schema.minLength, `${name}.schema.minLength`).toBe(
        IDEMPOTENCY_KEY_MIN_LENGTH,
      );
      expect(parameter.schema.maxLength, `${name}.schema.maxLength`).toBe(
        IDEMPOTENCY_KEY_MAX_LENGTH,
      );
    }
    // Bounds must be a "closed, non-degenerate interval": lower <= upper, and neither is 0 (0 would make an empty key valid).
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBeGreaterThan(0);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
  });

  it('discriminated-union branches must reference named schemas via $ref (TODO-005 regression guard)', () => {
    // redocly's `no-illogical-composition-keywords` is only warn-level: inline branches cannot be selected by a
    // discriminator — a tool-interoperability problem that does not fail lint. This upgrades it to a **test
    // assertion**, preventing someone from re-inlining branches for convenience (which would make SDK generators
    // and some validators lose the discrimination info).
    const unions = ['FinalityPolicy', 'AssetRef', 'BlockRef', 'TransactionRef'];
    for (const name of unions) {
      const schema = openapi.components.schemas[name];
      expect(schema, `missing components.schemas.${name}`).toBeTruthy();
      expect(schema.discriminator?.propertyName, `${name} must declare a discriminator`).toBeDefined();
      const branches: unknown[] = schema.oneOf ?? [];
      expect(branches.length, `${name} must have at least two branches`).toBeGreaterThan(1);
      for (const branch of branches) {
        // Each branch must be a `$ref`, not an inline object.
        expect(branch, `${name}'s branches must be $ref, not inline: ${JSON.stringify(branch)}`).toEqual({
          $ref: expect.stringMatching(/^#\/components\/schemas\/[A-Za-z0-9]+$/u),
        });
      }
      // Referenced named schemas must really exist (guards against dangling references).
      for (const branch of branches) {
        const ref = (branch as { $ref: string }).$ref.split('/').pop()!;
        expect(openapi.components.schemas[ref], `${name} references a nonexistent schema ${ref}`).toBeTruthy();
      }
    }
  });

  it('chain.info and bare transaction.confirm are no longer capabilities (review fixes R-01 / R-02)', () => {
    const all = [
      ...CAPABILITY_IDS,
      ...(openapi.components.schemas.CapabilityId.enum as string[]),
      ...(registrySchema.$defs.capabilityId.enum as string[]),
    ];
    expect(all).not.toContain('chain.info');
    expect(all).not.toContain('transaction.confirm');
  });
});

describe('Error-code contract consistency', () => {
  it('errors.ts / error spec / OpenAPI agree on the error-code set in all three places', () => {
    const fromTypes = new Set<string>(DFR_ERROR_CODES);
    const fromOpenApi = new Set<string>(
      openapi.components.schemas.DfrError.properties.code.enum as string[],
    );
    const fromSpec = new Set<string>(errorSpec.match(/DFR_[A-Z_]+/g) ?? []);

    expect([...fromOpenApi].sort()).toEqual([...fromTypes].sort());
    expect([...fromSpec].sort()).toEqual([...fromTypes].sort());
  });

  it('error codes contain no duplicates', () => {
    expect(new Set(DFR_ERROR_CODES).size).toBe(DFR_ERROR_CODES.length);
  });
});

describe('OpenAPI structural integrity', () => {
  it('all $refs resolve', () => {
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

  it('Idempotency-Key is required only for broadcast (review fix R-19)', () => {
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

  it('the SSE endpoint supports ticket auth and works from a browser EventSource (review fix R-21)', () => {
    const sse = openapi.paths['/v1/events/subscribe'].get;
    const schemes = (sse.security as Record<string, unknown>[]).map((s) => Object.keys(s)[0]);
    expect(schemes).toContain('SseTicket');
    expect(schemes).toContain('ApiKeyAuth');
  });
});

/* ------------------------------------------------------------------ */
/* Second-round architecture-audit assertions (prevent A-01 / A-07 / A-08 / A-09 style drift from recurring)   */
/* ------------------------------------------------------------------ */

describe('Chain contract aligns with registry structure (audit fix A-01)', () => {
  it('every required schema field exists on Chain / ChainRegistryEntry', () => {
    // Guaranteed by the compiler: if Chain lacks a field, expectTypeOf errors
    expectTypeOf<Chain>().toHaveProperty('finalityStatus');
    expectTypeOf<ChainRegistryEntry>().toHaveProperty('milestone');
    expectTypeOf<ChainRegistryEntry>().toHaveProperty('finalityStatus');
    // milestone is deployment metadata; it must not enter the domain model Chain
    expectTypeOf<Chain>().not.toHaveProperty('milestone');
  });

  it('no registry entry field exceeds the schema-allowed set', () => {
    const allowed = new Set(Object.keys(registrySchema.$defs.chain.properties as object));
    const extra: string[] = [];
    for (const [id, c] of Object.entries(registry.chains as Record<string, object>)) {
      for (const k of Object.keys(c)) if (!allowed.has(k)) extra.push(`${id}.${k}`);
    }
    expect(extra).toEqual([]);
  });
});

describe('Network model (audit fixes A-07 / A-08)', () => {
  it('networkKind is removed from the registry, Schema, and OpenAPI entirely', () => {
    const raw = read('packages/registry/config/chains.yaml');
    expect(raw).not.toMatch(/^\s*networkKind:/m);
    expect(registrySchema.$defs.chain.properties).not.toHaveProperty('networkKind');

    // Structured check: no **field** named networkKind may exist in OpenAPI.
    // Note: do not use JSON.stringify().toContain() — mentioning the word in descriptive text is legitimate
    // (e.g. stating "networkKind was removed"), which would false-positive.
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

  it('network is only a descriptive property of a chain, never on user input or domain objects', () => {
    // Compile-time assertions: these types must not carry network
    expectTypeOf<AccountRef>().not.toHaveProperty('network');
    expectTypeOf<Transaction>().not.toHaveProperty('network');
    // The request model (TransactionRequest) is indirectly constrained by Transaction's sibling assertion;
    // if network is ever added back to AccountRef / Transaction, this test fails.
  });

  it('network field values are a closed set', () => {
    expect(new Set(openapi.components.schemas.NetworkId.enum)).toEqual(
      new Set(['mainnet', 'testnet', 'devnet', 'custom']),
    );
  });
});

describe('Single source of truth for state (audit fix A-09)', () => {
  it('Transaction no longer carries both status and finality', () => {
    expectTypeOf<Transaction>().toHaveProperty('status');
    expectTypeOf<Transaction>().not.toHaveProperty('finality');
  });

  it('OpenAPI Transaction likewise has only status', () => {
    const t = openapi.components.schemas.Transaction;
    expect(t.required).toContain('status');
    expect(t.properties).not.toHaveProperty('finality');
  });
});

describe('Finality levels are ordered and contain no abnormal values (audit fix A-10)', () => {
  it('FinalityLevel is a proper subset of FinalityState, excluding abnormal values', () => {
    const levels = Object.keys(FINALITY_ORDER);
    expect(levels).toEqual(['submitted', 'included', 'confirmed', 'finalized']);
    expect(levels).not.toContain('orphaned');
    expect(levels).not.toContain('unknown');
    expect(new Set(openapi.components.schemas.FinalityLevel.enum)).toEqual(new Set(levels));
  });

  it('level strength strictly increases', () => {
    const order = ['submitted', 'included', 'confirmed', 'finalized'] as const;
    for (let i = 1; i < order.length; i += 1) {
      expect(FINALITY_ORDER[order[i]!]).toBeGreaterThan(FINALITY_ORDER[order[i - 1]!]);
    }
  });

  it('abnormal observed states never satisfy any target level', () => {
    const abnormal: FinalityState[] = ['orphaned', 'unknown'];
    for (const observed of abnormal) {
      for (const required of ['submitted', 'included', 'confirmed', 'finalized'] as const) {
        expect(reachesFinalityLevel(observed, required), `${observed} vs ${required}`).toBe(false);
      }
    }
  });

  it('the reached / not-reached boundary is correct', () => {
    expect(reachesFinalityLevel('finalized', 'confirmed')).toBe(true);
    expect(reachesFinalityLevel('confirmed', 'confirmed')).toBe(true);
    expect(reachesFinalityLevel('included', 'confirmed')).toBe(false);
  });
});

describe('Response envelopes and receipts (audit fixes A-16 / A-25)', () => {
  it('list responses carry requestId', () => {
    const listSchema = openapi.paths['/v1/chains'].get.responses['200'].content['application/json'].schema;
    expect(listSchema.required).toContain('requestId');
  });

  it('endpoints declaring includeReceipt have receipt in their response structure', () => {
    const tx = openapi.components.schemas.TransactionResponse;
    expect(tx.properties).toHaveProperty('receipt');
    expect(openapi.components.schemas).toHaveProperty('Receipt');
  });
});

/**
 * M1 write-endpoint response envelopes (DFR-M1-A01, see docs/architecture/m1-api-contract.md §1).
 *
 * Write endpoints must not return bare domain objects directly: every success response must be a **named
 * envelope**, carrying `requestId` for cross-log/trace correlation and `transactionId` for the DFR-internal
 * execution identity (separate from the on-chain txHash, see ADR-015 §8).
 */
describe('M1 write-endpoint named response envelopes (DFR-M1-A01)', () => {
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
      // DFR-M1-E03 fix: the HTTP response carries the TransactionEngine's public result (with txHash, without
      // providerId/ref), not the Adapter capability's BroadcastResult.
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
    it(`${spec.schema} is a named envelope and must carry requestId`, () => {
      const response =
        openapi.paths[spec.path].post.responses[spec.status].content['application/json'].schema;

      // 1. The response must reference a named envelope, not a bare domain object.
      expect(response.$ref, `${spec.path} response schema`).toBe(
        `#/components/schemas/${spec.schema}`,
      );

      const schema = openapi.components.schemas[spec.schema];
      expect(schema, `missing components.schemas.${spec.schema}`).toBeTruthy();

      // 2. The envelope must explicitly require requestId; it cannot rely on caller convention.
      expect(schema.required, `${spec.schema}.required`).toContain('requestId');

      // 3. The envelope must carry the domain object, with field names matching the contract.
      expect(schema.required, `${spec.schema}.required`).toContain(spec.bodyField);
      expect(schema.properties[spec.bodyField].$ref).toBe(
        `#/components/schemas/${spec.bodyRef}`,
      );

      // 4. transactionId is the DFR-internal execution identity; build/simulate/broadcast must return it;
      //    confirm is located by path hash, so the envelope does not carry it twice.
      if (spec.requiresTransactionId) {
        expect(schema.required, `${spec.schema}.required`).toContain('transactionId');
        expect(schema.properties.transactionId.type).toBe('string');
      } else {
        expect(schema.required, `${spec.schema}.required`).not.toContain('transactionId');
      }
    });
  }

  it('TypeScript DTOs match OpenAPI envelope fields one-to-one', () => {
    // build / simulate / broadcast carry transactionId + domain object + requestId.
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('unsignedTransaction');
    expectTypeOf<BuildTransactionResponse>().toHaveProperty('requestId');

    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('simulation');
    expectTypeOf<SimulateTransactionResponse>().toHaveProperty('requestId');

    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('transactionId');
    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('broadcast');
    expectTypeOf<BroadcastTransactionResponse>().toHaveProperty('requestId');

    // confirm is located by path hash, so the envelope carries no transactionId.
    expectTypeOf<ConfirmTransactionResponse>().toHaveProperty('confirmation');
    expectTypeOf<ConfirmTransactionResponse>().toHaveProperty('requestId');
    expectTypeOf<ConfirmTransactionResponse>().not.toHaveProperty('transactionId');
  });

  it('broadcast result OpenAPI shape matches the TS DTO (DFR-M1-E03 contract fix)', () => {
    // The pre-fix drift: OpenAPI/SDK declared broadcast as the Adapter's BroadcastResult (with ref), while the
    // handler actually returned the TransactionEngine's result (with txHash). The drift went unnoticed for a long
    // time because no test asserted broadcast's **wire shape**.
    const outcome = openapi.components.schemas.BroadcastTransactionOutcome;
    expect(outcome, 'missing BroadcastTransactionOutcome schema').toBeDefined();
    for (const field of ['transactionId', 'status', 'txHash', 'accepted', 'observedAt']) {
      expect(outcome.required, `BroadcastTransactionOutcome.required is missing ${field}`).toContain(field);
    }
    // Reverse control: the old shape "describing the HTTP response with ref" must not reappear.
    expect(outcome.properties).not.toHaveProperty('ref');
    expect(openapi.components.schemas.BroadcastResult).toBeUndefined();

    const response = openapi.components.schemas.BroadcastTransactionResponse;
    expect(response.properties.broadcast.$ref).toBe(
      '#/components/schemas/BroadcastTransactionOutcome',
    );

    // The TS DTO must likewise carry txHash (same name and meaning as OpenAPI).
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().toHaveProperty('txHash');
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().toHaveProperty('accepted');
    expectTypeOf<BroadcastTransactionResponse['broadcast']>().not.toHaveProperty('ref');
  });
});

/**
 * M1 write request-body contract (DFR-M1-A02, see docs/architecture/m1-api-contract.md §2).
 *
 * confirm must carry minFinality / timeoutMs, and timeoutMs has an upper bound (no unbounded requests);
 * broadcast body must carry transactionId / signedTransaction / rebroadcast, with rebroadcast defaulting to false;
 * simulate body must carry transactionId + unsignedTransaction (DFR-M1-B08 fix: the old schema's
 * `oneOf: TransactionRequest | UnsignedTransaction` had no transactionId, so the engine could not locate the
 * record — conflicting with m1-api-contract §2).
 */
describe('M1 write request-body contract (DFR-M1-A02)', () => {
  interface OpenApiParameterRef {
    $ref?: string;
    name?: string;
    required?: boolean;
  }

  it('simulate request body carries transactionId + unsignedTransaction (DFR-M1-B08)', () => {
    const post = openapi.paths['/v1/transactions/simulate'].post;
    expect(post.requestBody, 'simulate must have a requestBody').toBeTruthy();
    expect(post.requestBody.required, 'simulate requestBody.required').toBe(true);

    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.$ref).toBe('#/components/schemas/SimulateTransactionRequest');

    const body = openapi.components.schemas.SimulateTransactionRequest;
    expect(body.required, 'SimulateTransactionRequest.required').toContain('transactionId');
    expect(body.required, 'SimulateTransactionRequest.required').toContain('unsignedTransaction');
    expect(body.properties.transactionId.type).toBe('string');
    expect(body.properties.unsignedTransaction.$ref).toBe('#/components/schemas/UnsignedTransaction');

    // TypeScript DTO matches schema one-to-one.
    expectTypeOf<SimulateTransactionRequest>().toHaveProperty('transactionId');
    expectTypeOf<SimulateTransactionRequest>().toHaveProperty('unsignedTransaction');
  });

  it('confirm request body carries chain and minFinality / timeoutMs', () => {
    const post = openapi.paths['/v1/transactions/{txHash}/confirm'].post;
    expect(post.requestBody, 'confirm must have a requestBody').toBeTruthy();
    expect(post.requestBody.required, 'confirm requestBody.required').toBe(true);

    const schema = post.requestBody.content['application/json'].schema;
    expect(schema.$ref).toBe('#/components/schemas/ConfirmTransactionRequest');

    const body = openapi.components.schemas.ConfirmTransactionRequest;
    expect(body.required, 'ConfirmTransactionRequest.required').toContain('chain');
    expect(body.properties).toHaveProperty('minFinality');
    expect(body.properties).toHaveProperty('timeoutMs');
    expect(body.properties.minFinality.$ref).toBe('#/components/schemas/FinalityLevel');
  });

  it('confirm timeoutMs has a positive-integer upper bound, with the default not exceeding it', () => {
    const timeout =
      openapi.components.schemas.ConfirmTransactionRequest.properties.timeoutMs;
    expect(timeout.type, 'timeoutMs.type').toBe('integer');
    expect(typeof timeout.maximum, 'timeoutMs.maximum').toBe('number');
    expect(timeout.maximum).toBeGreaterThan(0);
    expect(timeout.default).toBeGreaterThan(0);
    expect(timeout.default).toBeLessThanOrEqual(timeout.maximum);
    expect(timeout.minimum).toBeGreaterThan(0);
  });

  it('confirm no longer uses chain in both query and body', () => {
    const params = (openapi.paths['/v1/transactions/{txHash}/confirm'].post.parameters ??
      []) as OpenApiParameterRef[];
    const chainParams = params.filter(
      (p) => (p.$ref ?? '').endsWith('/ChainQuery') || p.name === 'chain',
    );
    expect(chainParams).toEqual([]);
  });

  it('broadcast request body carries transactionId / signedTransaction / rebroadcast', () => {
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
    // rebroadcast defaults to false: only a dropped state explicitly passing true replays.
    expect(body.properties.rebroadcast.type).toBe('boolean');
    expect(body.properties.rebroadcast.default).toBe(false);
  });

  it('broadcast Idempotency-Key is required', () => {
    const params = openapi.paths['/v1/transactions/broadcast'].post
      .parameters as OpenApiParameterRef[];
    const keyParam = params.find((p) => (p.$ref ?? '').endsWith('/IdempotencyKey'));
    expect(keyParam, 'broadcast must reference IdempotencyKey').toBeTruthy();
    expect(openapi.components.parameters.IdempotencyKey.required).toBe(true);
  });

  it('TypeScript request-body DTOs match OpenAPI schema fields', () => {
    // confirm: chain required, minFinality/timeoutMs optional (with server-side defaults).
    expectTypeOf<ConfirmTransactionRequest['chain']>().toEqualTypeOf<ChainId>();
    expectTypeOf<ConfirmTransactionRequest['minFinality']>().toEqualTypeOf<
      FinalityLevel | undefined
    >();
    expectTypeOf<ConfirmTransactionRequest['timeoutMs']>().toEqualTypeOf<number | undefined>();

    // broadcast: transactionId + signedTransaction required, rebroadcast optional (default false).
    expectTypeOf<BroadcastTransactionRequest['transactionId']>().toEqualTypeOf<TransactionId>();
    expectTypeOf<BroadcastTransactionRequest['signedTransaction']>().toEqualTypeOf<SignedTransaction>();
    expectTypeOf<BroadcastTransactionRequest['rebroadcast']>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});

describe('Commitment-to-FinalityState domain mapping (ADR-031, guards against drift recurring)', () => {
  it('every value of both enums has a clear home: a mapped value or "belongs to no tier"', () => {
    // These two enums once evolved separately with only two values sharing a name, causing the commitment
    // strategy to misjudge `included` as unsupported (TODO-015). This test pins "the mapping must be complete":
    // adding a value on either side fails here, forcing the author to explicitly decide its mapping.
    const commitments = ['processed', 'confirmed', 'finalized'] as const;
    const finalityStates = ['submitted', 'included', 'confirmed', 'finalized', 'orphaned', 'unknown'] as const;

    for (const c of commitments) {
      const mapped = COMMITMENT_TO_FINALITY_STATE[c];
      expect(finalityStates, `Commitment ${c}'s mapped value must belong to FinalityState`).toContain(mapped);
      // Reverse lookup must close: a state → the commitment it represents must map back to the original value.
      expect(commitmentOf(mapped), `${mapped} must reverse-lookup to ${c}`).toBe(c);
    }

    // Observed values belonging to no commitment must explicitly be undefined in reverse lookup,
    // not silently treated as some tier.
    for (const s of ['submitted', 'orphaned', 'unknown'] as const) {
      expect(commitmentOf(s), `${s} must not map to any commitment`).toBeUndefined();
    }
  });

  it('levels may only contain genuine Commitment values (registry-config-side consistency)', () => {
    const commitmentValues = new Set(['processed', 'confirmed', 'finalized']);
    for (const level of Object.keys(COMMITMENT_TO_FINALITY_STATE)) {
      expect(commitmentValues.has(level), `${level} must be a valid Commitment`).toBe(true);
    }
  });
});
