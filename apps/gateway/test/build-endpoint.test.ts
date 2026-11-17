/**
 * build HTTP 端点契约测试（DFR-M1-B07）。
 *
 * 权威来源：docs/api/openapi.yaml `/v1/transactions/build`、
 * docs/architecture/m1-api-contract.md 第 1/2 节。
 *
 * 用假引擎（`TransactionEngine` 替身）测 Gateway 的职责：
 *   - 契约封套 `{ transactionId, unsignedTransaction, requestId }`（成功码 200）；
 *   - `Idempotency-Key` 头透传给引擎（可选，缺失也要能工作）；
 *   - 结构校验在 Gateway（领域校验在 Adapter / 引擎）；
 *   - 引擎错误按错误码映射状态码，不被包装成 500。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import type { BuildTransactionInput, BuiltTransactionResult, TransactionEngine } from '@dfr/transaction';
import { createDfrError } from '@dfr/errors';
import type { TransactionId, UnsignedTransaction } from '@dfr/types';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';
import { TransactionMetrics } from '@dfr/transaction';

const CHAIN = 'ethereum-sepolia';
const SECRET = 'buildEndpointSecret0123456789abcd';
const PEPPER = 'build-endpoint-pepper';
const KEY_ID = 'BdKey001';

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'build-endpoint',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: 'ethereum-sepolia' as never,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' as never },
};

function fakeEngine(
  build: (input: BuildTransactionInput) => Promise<BuiltTransactionResult>,
): TransactionEngine {
  return { build } as unknown as TransactionEngine;
}

let server: Server | undefined;
let baseUrl = '';

async function start(engine: TransactionEngine): Promise<void> {
  server = createGatewayServer({ core, auth: auth(), allowWrite: true, transactions: engine, transactionMetrics: new TransactionMetrics() });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function post(body: string | Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/v1/transactions/build`, {
    method: 'POST',
    headers: {
      'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const VALID_BODY = {
  chain: CHAIN,
  from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
  to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' },
};

const OK_RESULT: BuiltTransactionResult = {
  transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as TransactionId,
  status: 'built',
  nonce: '42' as never,
  unsignedTransaction: UNSIGNED,
  replayed: false,
  replayable: true,
};

describe('POST /v1/transactions/build（DFR-M1-B07）', () => {
  it('接受有效 traceparent，响应创建本地 span，并把关联字段传给引擎', async () => {
    let received: BuildTransactionInput | undefined;
    await start(fakeEngine(async (input) => { received = input; return OK_RESULT; }));
    const response = await fetch(`${baseUrl}/v1/transactions/build`, {
      method: 'POST',
      headers: {
        'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
        'content-type': 'application/json',
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(200);
    const outgoing = response.headers.get('traceparent');
    expect(outgoing).toMatch(new RegExp(`^00-${'a'.repeat(32)}-[0-9a-f]{16}-01$`, 'u'));
    expect(received?.traceId).toBe('a'.repeat(32));
    expect(received?.spanId).toBe(outgoing?.split('-')[2]);
  });

  it('/metrics 需要有效 API Key，且只输出 Prometheus 指标', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    expect(await response.text()).toBe('');
  });

  it('成功返回 200 + 契约封套（transactionId / unsignedTransaction / requestId）', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const response = await post(VALID_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: OK_RESULT.transactionId,
      unsignedTransaction: { payload: '0x02f8' },
    });
    expect(response.body['requestId']).toMatch(/^req_/u);
    expect(JSON.stringify(response.body)).not.toContain('signedPayload');
  });

  it('把 Idempotency-Key 头透传给引擎；缺失时传 undefined（可选）', async () => {
    const seen: (string | undefined)[] = [];
    await start(
      fakeEngine(async (input) => {
        seen.push(input.idempotencyKey);
        return OK_RESULT;
      }),
    );

    // 键必须满足 OpenAPI 的 8..128 长度契约（TODO-007 起由 Gateway 强制）。
    // 本用例只关心"合法键原样透传 + 缺失时为 undefined"，故用一个合规键。
    await post(VALID_BODY, { 'idempotency-key': 'key-abcdef' });
    await post(VALID_BODY);
    expect(seen).toEqual(['key-abcdef', undefined]);
  });

  it('结构校验在 Gateway：缺少 from → 400，且不调用引擎', async () => {
    const build = vi.fn(async () => OK_RESULT);
    await start(fakeEngine(build));

    const response = await post({ chain: CHAIN, to: VALID_BODY.to });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    expect(build).not.toHaveBeenCalled();
  });

  it('chain 缺失 / 非字符串 → 400', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    for (const body of [{ from: VALID_BODY.from }, { chain: 42, from: VALID_BODY.from }]) {
      const response = await post(body as Record<string, unknown>);
      expect(response.status).toBe(400);
    }
  });

  it('请求体带 nonce → 引擎拒绝并映射为 400（nonce 由服务端分配）', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN as never,
          message: 'nonce 由服务端分配',
          details: { fields: ['nonce'] },
        });
      }),
    );
    const response = await post({ ...VALID_BODY, nonce: '7' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('引擎的幂等冲突 / nonce 冲突按错误码映射（409），不被包装成 500', async () => {
    for (const code of ['DFR_IDEMPOTENCY_CONFLICT', 'DFR_NONCE_CONFLICT'] as const) {
      await start(
        fakeEngine(async () => {
          throw createDfrError(code, {
            requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
            chain: CHAIN as never,
            message: '冲突',
          });
        }),
      );
      const response = await post(VALID_BODY);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ dfr_code: code });
    }
  });

  it('未装配引擎 → 422（写路径未启用，不是 500）', async () => {
    server = createGatewayServer({ core, auth: auth(), allowWrite: true });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await post(VALID_BODY);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('沿用客户端 X-Request-Id（合法时），并在响应封套中回写同一个值', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const rid = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    const response = await post(VALID_BODY, { 'x-request-id': rid });
    expect(response.body['requestId']).toBe(rid);
  });
});
