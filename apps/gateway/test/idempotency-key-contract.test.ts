// `Idempotency-Key` 头长度契约测试（TODO-007 收口）。
//
// 权威来源：docs/api/openapi.yaml 的 `IdempotencyKey`（必填，broadcast）与
// `IdempotencyKeyOptional`（可选，build / simulate），两者 schema 均为
// `minLength: 8, maxLength: 128`。
//
// 修复前的漂移（本测试的 RED）：
//   - `maxLength: 128` **从未**被强制——129 字符的键会被接受；
//   - `minLength: 8` 只在 broadcast 生效，build / simulate 完全不校验（3 字符也被接受）。
// 后果：SDK 与网关对"合法幂等键"的理解不一致，客户端可能在本地校验通过、服务端行为不同；
// 且超长键会进入幂等记录主键，属可被滥用的输入面。
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import type { TransactionEngine } from '@dfr/transaction';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'IdemKey1';
const SECRET = 'idempotencyKeySecret0123456789ab';
const PEPPER = 'idem-pepper';

const core = {
  listChains: () => [],
  readiness: () => ({ ready: false, chains: [] }),
  startHealthChecks: () => ({ started: [], skipped: [] }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'idem',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED = {
  schemaVersion: '1',
  chain: 'ethereum-sepolia',
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' },
};

/** 记录透传到引擎的键，用于断言"合法键原样透传"。 */
let seenKeys: (string | undefined)[] = [];

function engine(): TransactionEngine {
  seenKeys = [];
  return {
    build: async (input: { idempotencyKey?: string }) => {
      seenKeys.push(input.idempotencyKey);
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'built',
        nonce: '42',
        unsignedTransaction: UNSIGNED,
        replayed: false,
        replayable: true,
      };
    },
    simulate: async (input: { requestId?: string }) => {
      void input;
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'simulated',
        simulation: { success: true, gasUsed: '21000' },
      };
    },
  } as unknown as TransactionEngine;
}

let server: Server | undefined;
let baseUrl = '';

async function start(): Promise<void> {
  server = createGatewayServer({
    core,
    auth: auth(),
    allowWrite: true,
    transactions: engine(),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

const BUILD_BODY = {
  chain: 'ethereum-sepolia',
  from: { chain: 'ethereum-sepolia', address: '0x1111111111111111111111111111111111111111' },
  to: { chain: 'ethereum-sepolia', address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: 'ethereum-sepolia' }, amount: '1000' },
};

const SIMULATE_BODY = {
  transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
  unsignedTransaction: UNSIGNED,
};

async function post(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
    'content-type': 'application/json',
  };
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('Idempotency-Key 长度契约（TODO-007）', () => {
  it('build：短于 8 字符 → 400 DFR_VALIDATION_FAILED（此前被接受）', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY, 'short');
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
    // 引擎不得被调用：结构校验先于业务编排。
    expect(seenKeys).toEqual([]);
  });

  it('build：边界 8 字符通过、边界 128 字符通过（闭区间）', async () => {
    await start();
    const eight = 'a'.repeat(8);
    expect((await post('/v1/transactions/build', BUILD_BODY, eight)).status).toBe(200);
    const max = 'b'.repeat(128);
    expect((await post('/v1/transactions/build', BUILD_BODY, max)).status).toBe(200);
    expect(seenKeys).toEqual([eight, max]);
  });

  it('build：129 字符 → 400（此前无上界）', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY, 'c'.repeat(129));
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
    expect(seenKeys).toEqual([]);
  });

  it('build：不带幂等键仍成功（可选头，不得因新校验被误伤）', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY);
    expect(response.status).toBe(200);
    expect(seenKeys).toEqual([undefined]);
  });

  it('simulate：短键与超长键都被拒绝，合法键放行', async () => {
    await start();
    expect((await post('/v1/transactions/simulate', SIMULATE_BODY, 'tiny')).status).toBe(400);
    expect(
      (await post('/v1/transactions/simulate', SIMULATE_BODY, 'd'.repeat(129))).status,
    ).toBe(400);
    expect((await post('/v1/transactions/simulate', SIMULATE_BODY, 'e'.repeat(8))).status).toBe(200);
  });

  it('broadcast：129 字符被拒绝（此前只校验了下界）', async () => {
    await start();
    const response = await post(
      '/v1/transactions/broadcast',
      { transactionId: 'txn_1', signedTransaction: {} },
      'f'.repeat(129),
    );
    // 键长度校验先于 body 解析：即便 body 不完整也应先报键错误。
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
  });
});
