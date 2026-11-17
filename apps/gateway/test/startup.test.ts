import { describe, expect, it, vi } from 'vitest';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore, type TransactionStores } from '@dfr/core';
import { ChainRegistry } from '@dfr/registry';
import type { Chain } from '@dfr/types';
import {
  GatewayStartupError,
  resolveGatewayRuntime,
  gatewayApiKeyScopeFromEnv,
  startGateway,
  type GatewayPersistence,
} from '../src/main.js';

function persistence(overrides: Partial<GatewayPersistence['stores']> = {}): GatewayPersistence {
  return {
    stores: {
      transaction: {} as TransactionStores['transaction'],
      idempotency: {} as TransactionStores['idempotency'],
      nonce: {} as TransactionStores['nonce'],
      tracker: {} as TransactionStores['tracker'],
      ...overrides,
    },
    healthCheck: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const m0Registry = ChainRegistry.fromObject({
  schemaVersion: '1',
  updatedAt: '2026-10-04T00:00:00Z',
  chains: {
    'test-chain': {
      displayName: 'Test Chain',
      family: 'evm',
      network: 'testnet',
      externalChainId: '1',
      adapter: { id: 'evm', version: '^0.1.0' },
      finality: { kind: 'confirmations', confirmations: 1 },
      finalityStatus: 'unverified',
      capabilities: ['block.read'],
      milestone: 'M0',
    },
  },
  providers: {
    'test-chain-primary': {
      chain: 'test-chain',
      kind: 'json-rpc-http',
      endpointRef: 'env:DFR_TEST_PROVIDER_URL',
      credentialRef: 'none',
      priority: 1,
      weight: 1,
      timeoutMs: 1000,
      cost: { unit: 'request', priceUsd: '0' },
    },
  },
});

const adapters = [
  { id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) },
];

describe('B30: production Gateway API Key scope composition (NEW-01 / NEW-02)', () => {
  it('maps configured chain, capability and IP allowlist to real scope', () => {
    expect(gatewayApiKeyScopeFromEnv({
      DFR_M0_SCOPE_CHAINS: 'test-chain',
      DFR_M0_SCOPE_CAPABILITIES: 'block.read,transaction.read',
      DFR_M0_IP_ALLOWLIST: '127.0.0.1,2001:db8::1',
    }, m0Registry, true)).toEqual({
      chains: ['test-chain'],
      capabilities: ['block.read', 'transaction.read'],
      ipAllowlist: ['127.0.0.1', '2001:db8::1'],
      allowWrite: true,
    });
  });

  it.each([
    [{ DFR_M0_SCOPE_CHAINS: 'unknown-chain' }, 'DFR_M0_SCOPE_CHAINS'],
    [{ DFR_M0_SCOPE_CHAINS: 'test-chain,*' }, 'DFR_M0_SCOPE_CHAINS'],
    [{ DFR_M0_SCOPE_CHAINS: '' }, 'DFR_M0_SCOPE_CHAINS'],
    [{ DFR_M0_SCOPE_CAPABILITIES: 'transaction.pay-anything' }, 'DFR_M0_SCOPE_CAPABILITIES'],
    [{ DFR_M0_SCOPE_CAPABILITIES: 'block.read,block.read' }, 'DFR_M0_SCOPE_CAPABILITIES'],
    [{ DFR_M0_IP_ALLOWLIST: 'not-an-ip' }, 'DFR_M0_IP_ALLOWLIST'],
    [{ DFR_M0_IP_ALLOWLIST: '' }, 'DFR_M0_IP_ALLOWLIST'],
    [{ DFR_M0_IP_ALLOWLIST: '127.0.0.1,127.0.0.1' }, 'DFR_M0_IP_ALLOWLIST'],
  ] as const)('rejects invalid config %j instead of broadening scope', (env, name) => {
    expect(() => gatewayApiKeyScopeFromEnv(env, m0Registry, false)).toThrow(name);
  });

  it('write-enabled Gateway refuses implicit wildcard permissions without explicit configuration', () => {
    expect(() => gatewayApiKeyScopeFromEnv({}, m0Registry, true)).toThrow('DFR_M0_SCOPE_CHAINS');
    expect(() => gatewayApiKeyScopeFromEnv({ DFR_M0_SCOPE_CHAINS: 'test-chain' }, m0Registry, true))
      .toThrow('DFR_M0_SCOPE_CAPABILITIES');
    expect(gatewayApiKeyScopeFromEnv({ DFR_M0_SCOPE_CHAINS: '*', DFR_M0_SCOPE_CAPABILITIES: '*' }, m0Registry, true))
      .toMatchObject({ chains: '*', capabilities: '*' });
  });

  it('actual startGateway refuses unknown configured chain before serving requests', async () => {
    await expect(startGateway({
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M0_SCOPE_CHAINS: 'nonexistent-chain',
      DFR_GATEWAY_PORT: '0',
    })).rejects.toThrow('DFR_M0_SCOPE_CHAINS');
  });
});

describe('B35: stale-abandon window must fail at Gateway startup', () => {
  it.each(['1', '59999', '999999999', '-1', '1.5'])(
    'refuses invalid DFR_ABANDON_BUILT_AFTER_MS=%s before listening', async (invalid) => {
      await expect(startGateway({
        DFR_M0_API_KEY_ID: 'TestKey1',
        DFR_M0_API_KEY_HASH: '0'.repeat(64),
        DFR_GATEWAY_PORT: '0',
        DFR_ABANDON_BUILT_AFTER_MS: invalid,
      })).rejects.toThrow('DFR_ABANDON_BUILT_AFTER_MS');
    },
  );

  it.each(['0', '60000'])(
    'accepts DFR_ABANDON_BUILT_AFTER_MS=%s at Gateway startup', async (valid) => {
      const app = await startGateway({
        DFR_M0_API_KEY_ID: 'TestKey1',
        DFR_M0_API_KEY_HASH: '0'.repeat(64),
        DFR_GATEWAY_PORT: '0',
        DFR_ABANDON_BUILT_AFTER_MS: valid,
      });
      await expect(app.close()).resolves.toBeUndefined();
    },
  );
});

describe('M1 Gateway composition root fail-closed（DFR-M1-A13）', () => {
  it('M0 默认不需要数据库，也不创建持久化连接', async () => {
    const createPersistence = vi.fn(async () => persistence());

    const runtime = await resolveGatewayRuntime({}, createPersistence);

    expect(runtime).toEqual({ milestone: 'M0', allowWrite: false });
    expect(createPersistence).not.toHaveBeenCalled();
  });

  it('M0 无数据库 URL 可完整监听并关闭 HTTP 运行时', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const app = await startGateway({
        DFR_M0_API_KEY_ID: 'TestKey1',
        DFR_M0_API_KEY_HASH: '0'.repeat(64),
        DFR_GATEWAY_PORT: '0',
      });
      await expect(app.close()).resolves.toBeUndefined();
    } finally {
      stdout.mockRestore();
    }
  });

  it('M1 缺少 DFR_TRANSACTION_DATABASE_URL 时拒绝启动', async () => {
    await expect(
      resolveGatewayRuntime({ DFR_M1_ALLOW_WRITE: 'true' }, async () => persistence()),
    ).rejects.toMatchObject({
      name: 'GatewayStartupError',
      message: expect.stringContaining('DFR_TRANSACTION_DATABASE_URL'),
    });
  });

  it('非法写开关不得被默认当成 M0', async () => {
    await expect(resolveGatewayRuntime({ DFR_M1_ALLOW_WRITE: 'yes' })).rejects.toThrow(
      'DFR_M1_ALLOW_WRITE',
    );
  });

  it('API Key 轮换变量必须成对：只配 previous keyId 或只配 hash 都 fail-closed', async () => {
    const base = {
      DFR_M0_API_KEY_ID: 'CurrKey1',
      DFR_M0_API_KEY_HASH: 'a'.repeat(64),
      DFR_GATEWAY_PORT: '0',
    };
    await expect(
      startGateway({ ...base, DFR_M0_API_KEY_ID_PREVIOUS: 'PrevKey1' }),
    ).rejects.toThrow(/DFR_M0_API_KEY_ID_PREVIOUS.*DFR_M0_API_KEY_HASH_PREVIOUS|成对/);
    await expect(
      startGateway({ ...base, DFR_M0_API_KEY_HASH_PREVIOUS: 'b'.repeat(64) }),
    ).rejects.toThrow(/DFR_M0_API_KEY_ID_PREVIOUS.*DFR_M0_API_KEY_HASH_PREVIOUS|成对/);
  });

  it('API Key keyId / hash 格式非法时拒绝启动（配置参考承诺，不允许运行到鉴权时才发现）', async () => {
    const base = {
      DFR_M0_API_KEY_ID: 'CurrKey1',
      DFR_M0_API_KEY_HASH: 'a'.repeat(64),
      DFR_GATEWAY_PORT: '0',
    };
    // keyId 必须恰好 8 位 alnum：7 位、9 位、含短横线都拒绝。
    for (const badKeyId of ['Short', 'TooLong01', 'Bad-Key1']) {
      await expect(
        startGateway({ ...base, DFR_M0_API_KEY_ID: badKeyId }),
        badKeyId,
      ).rejects.toThrow(/DFR_M0_API_KEY_ID/);
    }
    // hash 必须是 64 位 hex：长度不足、非 hex、带 0x 前缀都拒绝。
    for (const badHash of ['a'.repeat(63), 'g'.repeat(64), `0x${'a'.repeat(64)}`]) {
      await expect(
        startGateway({ ...base, DFR_M0_API_KEY_HASH: badHash }),
        badHash.slice(0, 8),
      ).rejects.toThrow(/DFR_M0_API_KEY_HASH/);
    }
  });

  it('DFR_GATEWAY_PORT 非法时 fail-closed，不静默用 NaN/越界端口', async () => {
    const base = {
      DFR_M0_API_KEY_ID: 'CurrKey1',
      DFR_M0_API_KEY_HASH: 'a'.repeat(64),
    };
    for (const badPort of ['abc', '-1', '70000', '0x50', '1.5']) {
      await expect(startGateway({ ...base, DFR_GATEWAY_PORT: badPort }), badPort).rejects.toThrow(
        /DFR_GATEWAY_PORT/,
      );
    }
  });

  it('M1 数据库不可达时错误与序列化日志均不泄漏 URL 或凭证', async () => {
    const databaseUrl = 'postgres://runtime:do-not-log@example.invalid:5432/dfr?ssl=true';
    const createPersistence = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${databaseUrl}`);
    });

    let caught: unknown;
    try {
      await resolveGatewayRuntime(
        { DFR_M1_ALLOW_WRITE: 'true', DFR_TRANSACTION_DATABASE_URL: databaseUrl },
        createPersistence,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GatewayStartupError);
    const exposed = JSON.stringify(caught);
    expect(exposed).not.toContain(databaseUrl);
    expect(exposed).not.toContain('runtime');
    expect(exposed).not.toContain('do-not-log');
    expect((caught as Error).message).toBe('M1 transaction database is unavailable');
  });

  it('M1 数据库就绪时返回四个 Store 与关闭句柄', async () => {
    const stores = persistence();
    const runtime = await resolveGatewayRuntime(
      {
        DFR_M1_ALLOW_WRITE: 'true',
        DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
      },
      async () => stores,
    );

    expect(runtime.milestone).toBe('M1');
    expect(runtime.allowWrite).toBe(true);
    expect(runtime.persistence).toBe(stores);
  });

  // ADR-038 / issue #1：显式里程碑开关必须能真正加载 M4 的链。
  it('DFR_DEPLOY_MILESTONE=M4 在持久化就绪时返回 M4', async () => {
    const stores = persistence();
    const runtime = await resolveGatewayRuntime(
      {
        DFR_M1_ALLOW_WRITE: 'true',
        DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
        DFR_DEPLOY_MILESTONE: 'M4',
      },
      async () => stores,
    );

    expect(runtime.milestone).toBe('M4');
    expect(runtime.allowWrite).toBe(true);
  });

  it('缺省 DFR_DEPLOY_MILESTONE 时保持历史行为（M0/M1）', async () => {
    await expect(resolveGatewayRuntime({}, async () => persistence())).resolves.toEqual({
      milestone: 'M0',
      allowWrite: false,
    });
    const runtime = await resolveGatewayRuntime(
      {
        DFR_M1_ALLOW_WRITE: 'true',
        DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
      },
      async () => persistence(),
    );
    expect(runtime.milestone).toBe('M1');
  });

  it('非法 DFR_DEPLOY_MILESTONE 不得被当成缺省值', async () => {
    await expect(
      resolveGatewayRuntime({ DFR_DEPLOY_MILESTONE: 'M9' }),
    ).rejects.toThrow('DFR_DEPLOY_MILESTONE');
  });

  it('未开放写路径时请求高于 M0 的里程碑 → 拒绝启动（fail-closed）', async () => {
    await expect(
      resolveGatewayRuntime({ DFR_DEPLOY_MILESTONE: 'M4' }),
    ).rejects.toThrow('requires DFR_M1_ALLOW_WRITE=true');
  });
});

describe('Core 的 M1 Store 端口集合', () => {
  it('M0 允许不配置 M1 Store', () => {
    expect(
      () => new DfrCore({ registry: m0Registry, adapters, milestone: 'M0' }),
    ).not.toThrow();
  });

  it('M1 缺少 Store 集合或任一 Store 时拒绝构造', () => {
    expect(
      () => new DfrCore({ registry: m0Registry, adapters, milestone: 'M1' }),
    ).toThrow(/persistent transaction stores/i);

    const incomplete = persistence().stores as unknown as Record<string, unknown>;
    delete incomplete.tracker;
    expect(
      () =>
        new DfrCore({
          registry: m0Registry,
          adapters,
          milestone: 'M1',
          transactionStores: incomplete as never,
        }),
    ).toThrow(/persistent transaction stores/i);
  });

  it('M1 四个 Store 完整时 Core 保留端口引用', () => {
    const stores = persistence().stores;
    const core = new DfrCore({
      registry: m0Registry,
      adapters,
      milestone: 'M1',
      transactionStores: stores,
    });

    expect(core.transactionStores).toBe(stores);
  });
});
