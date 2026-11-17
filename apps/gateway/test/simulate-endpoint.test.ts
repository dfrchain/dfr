/**
 * simulate HTTP 端点契约测试（DFR-M1-B08）。
 *
 * 权威来源：docs/api/openapi.yaml `/v1/transactions/simulate`、
 * docs/architecture/m1-api-contract.md 第 1/2/5 节。
 *
 * 请求体 = `SimulateTransactionRequest`：`transactionId` + build 返回的
 * `UnsignedTransaction`（不接受"另带一个载荷"：引擎会与落库记录逐字节比对）。
 *
 * 用假引擎测 Gateway 的职责：
 *   - 契约封套 `{ transactionId, simulation, requestId }`（成功码 200）；
 *   - 结构校验在 Gateway，领域绑定校验在引擎；
 *   - **回滚（DFR_TRANSACTION_REVERTED）必须映射为 422，绝不能被包装成 500**；
 *   - 未装配引擎 → 422，不是 500。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import type { SimulateTransactionInput, TransactionEngine } from '@dfr/transaction';
import { createDfrError } from '@dfr/errors';
import type { TransactionId, UnsignedTransaction } from '@dfr/types';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const CHAIN = 'ethereum-sepolia';
const SECRET = 'simulateEndpointSecret0123456789ab';
const PEPPER = 'simulate-endpoint-pepper';
const KEY_ID = 'SmKey001';
const TXN_ID = 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN';

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
    projectId: 'simulate-endpoint',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN as never,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' as never },
};

function fakeEngine(
  simulate: (input: SimulateTransactionInput) => Promise<{
    transactionId: TransactionId;
    status: 'simulated';
    simulation: { success: boolean };
  }>,
): TransactionEngine {
  return { simulate } as unknown as TransactionEngine;
}

const OK_RESULT = {
  transactionId: TXN_ID as TransactionId,
  status: 'simulated' as const,
  simulation: { success: true },
};

const VALID_BODY = { transactionId: TXN_ID, unsignedTransaction: UNSIGNED };

let server: Server | undefined;
let baseUrl = '';

async function start(engine: TransactionEngine): Promise<void> {
  server = createGatewayServer({ core, auth: auth(), allowWrite: true, transactions: engine });
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
  const response = await fetch(`${baseUrl}/v1/transactions/simulate`, {
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

describe('POST /v1/transactions/simulate（DFR-M1-B08）', () => {
  it('成功返回 200 + 契约封套（transactionId / simulation / requestId）', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const response = await post(VALID_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: TXN_ID,
      simulation: { success: true },
    });
    expect(response.body['requestId']).toMatch(/^req_/u);
    expect(JSON.stringify(response.body)).not.toContain('signedPayload');
  });

  it('把 transactionId / unsignedTransaction / requestId / signal 透传给引擎', async () => {
    const seen: SimulateTransactionInput[] = [];
    await start(
      fakeEngine(async (input) => {
        seen.push(input);
        return OK_RESULT;
      }),
    );

    // 可选 Idempotency-Key 必须被接受（OpenAPI 声明 optional），但引擎的
    // simulate 输入没有该字段：它不参与幂等判断（simulate 以 transactionId 定位）。
    await post(VALID_BODY, { 'idempotency-key': 'simulate-key-1' });
    await post(VALID_BODY);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.transactionId).toBe(TXN_ID);
    expect(seen[0]?.unsignedTransaction).toEqual(UNSIGNED);
    // 请求 ID 与取消信号必须一路带到引擎（否则重试/超时无法归因）。
    expect(seen[0]?.requestId).toMatch(/^req_/u);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('沿用合法 X-Request-Id，并在响应封套中回写同一个值', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const rid = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    const response = await post(VALID_BODY, { 'x-request-id': rid });
    expect(response.body['requestId']).toBe(rid);
  });

  it('结构校验在 Gateway：缺 transactionId / 缺 unsignedTransaction / 类型错 → 400 且不调用引擎', async () => {
    const simulate = vi.fn(async () => OK_RESULT);
    await start(fakeEngine(simulate));

    const badBodies: Record<string, unknown>[] = [
      { unsignedTransaction: UNSIGNED },
      { transactionId: '' , unsignedTransaction: UNSIGNED },
      { transactionId: TXN_ID },
      { transactionId: TXN_ID, unsignedTransaction: '0x02f8' },
      { transactionId: TXN_ID, unsignedTransaction: [] },
    ];
    for (const body of badBodies) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it('缺 unsignedTransaction.meta → 400，绝不泄漏 500（2026-10-06 真实链验收发现）', async () => {
    // 真实缺陷：OpenAPI 的 UnsignedTransaction 把 `meta` 列为必填，但 Gateway 的结构校验
    // 只查了 chain/payload。缺 meta 的请求会一路进入引擎，在
    // `unsigned.meta.requiresNonce` 抛 TypeError，被归一化成 500 DFR_INTERNAL_ERROR。
    // 那是**调用方输入错误**，必须是 400；500 会把"少传字段"误导成"服务端故障"。
    const simulate = vi.fn(async () => OK_RESULT);
    await start(fakeEngine(simulate));

    const invalid: Record<string, unknown>[] = [
      // 缺 meta
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8' } },
      // meta 类型错
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: 'x' } },
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: [] } },
      // schemaVersion 不是 "1"
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '2', chain: CHAIN, payload: '0x02f8', meta: {} } },
      { transactionId: TXN_ID, unsignedTransaction: { chain: CHAIN, payload: '0x02f8', meta: {} } },
    ];
    for (const body of invalid) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it('模拟回滚（DFR_TRANSACTION_REVERTED）映射为 422，不被包装成 500', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_TRANSACTION_REVERTED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN as never,
          message: 'execution reverted',
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_TRANSACTION_REVERTED' });
  });

  it('载荷绑定失败 / 状态不允许（引擎 DFR_VALIDATION_FAILED）映射为 400', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN as never,
          message: 'unsigned payload 与已保存记录不一致',
          details: { fields: ['unsignedTransaction'] },
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('未知 transactionId（DFR_NOT_FOUND）映射为 404', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_NOT_FOUND', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: '找不到交易',
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_NOT_FOUND' });
  });

  it('未装配引擎 → 422（写路径未启用，不是 500）', async () => {
    server = createGatewayServer({ core, auth: auth(), allowWrite: true });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await post(VALID_BODY);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
