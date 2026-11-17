/**
 * Gateway 通用写管线契约测试（DFR-M1-B06）。
 *
 * 权威来源：gateway-spec 第 3 章（请求生命周期）、第 5.2 节（路由类）。
 *
 * 本任务验证四件事：
 *   1. 有界 JSON body 解析：声明与实际两个方向的体积上限都必须生效；
 *   2. 路由元数据：读写路由类由元数据决定，不由 handler 里的 if 决定；
 *   3. allowWrite：Key 作用域与 Gateway 开关是两道彼此独立的闸门；
 *   4. 横切顺序：鉴权在限流与体积校验之前，写权限检查在读 body 之前。
 *
 * B07/B08 已实现 build/simulate 的业务逻辑，因此"穿过全部横切闸门"的证明改为：
 * 结构非法的请求体在 handler 里得到 400（而不是闸门处的 403/422）。
 */
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { isDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';
import { readJsonBody } from '../src/body.js';
import { matchRoute } from '../src/routes.js';

const REQ = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;
const SECRET = 'writePipelineSecret0123456789abcdef';
const PEPPER = 'write-pipeline-pepper';
const KEY_ID = 'WpKey001';

/** 最小 core 替身：本文件不触发任何 Core 调用。 */
const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function fakeRequest(
  chunks: readonly string[],
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk, 'utf8')));
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream as unknown as IncomingMessage;
}

function auth(
  allowWrite: boolean,
  chains: StaticApiKeyConfig['scope']['chains'] = '*',
): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'write-pipeline',
    scope: { chains, capabilities: '*', allowWrite },
  };
}

const KEY_HEADER = { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` };

let server: Server | undefined;
let baseUrl = '';

async function start(
  allowWrite: boolean,
  gatewayAllowWrite: boolean,
  chains: StaticApiKeyConfig['scope']['chains'] = '*',
): Promise<void> {
  server = createGatewayServer({
    core,
    auth: auth(allowWrite, chains),
    ...(gatewayAllowWrite ? { allowWrite: true } : {}),
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

async function post(path: string, body: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...KEY_HEADER, 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('有界 JSON body 解析（gateway-spec 第 3 章第 7 步）', () => {
  it('合法 JSON 对象解析成功', async () => {
    const parsed = await readJsonBody(fakeRequest(['{"chain":"ethereum-sepolia"}']), {
      maxBytes: 1024,
      requestId: REQ,
    });
    expect(parsed).toEqual({ chain: 'ethereum-sepolia' });
  });

  it('无效请求体大小配置不能关闭字节上限', async () => {
    for (const maxBytes of [NaN, Infinity, -1, 0, 1.5]) {
      await expect(
        readJsonBody(fakeRequest(['{"value":"sensitive"}']), { maxBytes, requestId: REQ }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('非法 JSON 返回 DFR_VALIDATION_FAILED', async () => {
    await expect(
      readJsonBody(fakeRequest(['{not json']), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED', details: { fields: ['body'] } });
  });

  it('数组 / null 不是合法请求体', async () => {
    for (const raw of ['[]', 'null', '"str"', '42']) {
      await expect(
        readJsonBody(fakeRequest([raw]), { maxBytes: 1024, requestId: REQ }),
      ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    }
  });

  it('空 body 返回 DFR_VALIDATION_FAILED', async () => {
    await expect(
      readJsonBody(fakeRequest([]), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('声明 content-length 超限：读取前即拒绝', async () => {
    await expect(
      readJsonBody(fakeRequest(['{}'], { 'content-length': '999999' }), {
        maxBytes: 1024,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({ code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('未声明 content-length 但实际超限：流式计数同样拒绝（不信任 header）', async () => {
    const chunks = ['{"a":"', 'x'.repeat(4096), '"}'];
    await expect(
      readJsonBody(fakeRequest(chunks), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('正好等于上限的 body 正常解析（边界不误杀）', async () => {
    const raw = '{"a":1}';
    const parsed = await readJsonBody(fakeRequest([raw]), {
      maxBytes: Buffer.byteLength(raw),
      requestId: REQ,
    });
    expect(parsed).toEqual({ a: 1 });
  });
});

describe('路由元数据（gateway-spec 第 5.2 节路由类）', () => {
  it('只读路由属于 read 类', () => {
    for (const path of ['/v1/chains', '/v1/chains/ethereum-sepolia', '/v1/balances']) {
      expect(matchRoute('GET', path)?.routeClass).toBe('read');
    }
    expect(matchRoute('GET', `/v1/transactions/0x${'ab'.repeat(32)}`)).toMatchObject({
      handler: 'getTransaction',
      routeClass: 'read',
      capability: 'transaction.read',
    });
    expect(matchRoute('GET', '/v1/blocks/number:123')).toMatchObject({
      handler: 'getBlock',
      routeClass: 'read',
      capability: 'block.read',
      blockRef: 'number:123',
    });
  });

  it('build / simulate 属于 write 类且声明各自能力', () => {
    expect(matchRoute('POST', '/v1/transactions/build')).toEqual({
      handler: 'buildTransaction',
      routeClass: 'write',
      capability: 'transaction.build',
    });
    expect(matchRoute('POST', '/v1/transactions/simulate')).toEqual({
      handler: 'simulateTransaction',
      routeClass: 'write',
      capability: 'transaction.simulate',
    });
  });

  it('方法不匹配或未知路径返回 null（由调用方映射为 404）', () => {
    expect(matchRoute('POST', '/v1/chains')).toBeNull();
    expect(matchRoute('POST', '/v1/balances')).toBeNull();
    expect(matchRoute('GET', '/v1/nope')).toBeNull();
    expect(matchRoute('DELETE', '/v1/transactions/build')).toBeNull();
  });
});

describe('allowWrite 两道闸门与横切顺序（DFR-M1-B06）', () => {
  it('Key 未开放写权限 → 403 DFR_PROJECT_SCOPE_DENIED', async () => {
    await start(false, false);
    const response = await post('/v1/transactions/build', '{}');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
  });

  it('broadcast 的只读 Key 仍被拒绝，且不进入 body/engine', async () => {
    await start(false, true);
    const response = await post('/v1/transactions/broadcast', '{not json');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(JSON.stringify(response.body)).not.toContain('signedPayload');
  });

  it('Key 开放但 Gateway 未启用写 → 422 DFR_UNSUPPORTED_CAPABILITY', async () => {
    await start(true, false);
    const response = await post('/v1/transactions/build', '{}');
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('两道闸门都通过 → 穿过全部横切步骤到达 handler（B07：结构校验在此生效）', async () => {
    await start(true, true);
    // 缺 from 的 body 能走到 handler 的结构校验才可能得到 400：
    // 闸门只会给 403（Key scope）或 422（部署开关），不会给 400。
    const response = await post('/v1/transactions/build', JSON.stringify({ chain: 'ethereum-sepolia' }));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    // 错误封套用 snake_case 的 request_id（error-spec 第 2 章）。
    expect(response.body['request_id']).toMatch(/^req_/u);
  });

  it('simulate 同样穿过全部横切步骤到达 handler（B08：结构校验生效）', async () => {
    await start(true, true);
    // 缺 transactionId：只有走到 handler 的结构校验才会得到 400。
    const response = await post(
      '/v1/transactions/simulate',
      JSON.stringify({ chain: 'ethereum-sepolia' }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('鉴权先于体积校验：未鉴权的大包返回 401 而不是 413', async () => {
    await start(true, true);
    // 不发假的 content-length（那会被客户端直接拒绝）；用真实超限体积 + 无效 Key，
    // 断言得到的是 401 而不是 413，即"鉴权先于契约校验"。
    const response = await post('/v1/transactions/build', JSON.stringify({ pad: 'x'.repeat(300_000) }), {
      'x-dfr-key': 'dfr_BadKey01_badbadbadbadbadbadbadbad',
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNAUTHENTICATED' });
  });

  it('写权限检查先于 body 解析：非法 JSON 在无写权限时返回 403 而非 400', async () => {
    await start(false, false);
    const response = await post('/v1/transactions/build', '{not json');
    expect(response.status).toBe(403);
  });

  it('写权限通过后非法 JSON → 400 DFR_VALIDATION_FAILED（不是 500）', async () => {
    await start(true, true);
    const response = await post('/v1/transactions/build', '{not json');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('写权限通过后超限 body → 413 DFR_PAYLOAD_TOO_LARGE', async () => {
    await start(true, true);
    const response = await post('/v1/transactions/build', JSON.stringify({ pad: 'x'.repeat(300_000) }));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('读路由不受写闸门影响（allowWrite=false 仍可读）', async () => {
    await start(false, false);
    const response = await fetch(`${baseUrl}/v1/chains`, { headers: KEY_HEADER });
    expect(response.status).toBe(200);
  });
});

describe('AUTH-01：写请求与 POST 读请求的 body chain scope', () => {
  it('受限 Key 不得利用 body chain 绕过校验（即使 URL 无 chain）', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);

    // 每条响应都应在调用 handler/交易引擎之前拒绝，而不是返回 400/422。
    const denied = [
      { path: '/v1/transactions/build', body: { chain: 'solana-devnet' } },
      { path: '/v1/transactions/preflight', body: { chain: 'solana-devnet' } },
      { path: '/v1/transactions/simulate', body: {
        transactionId: 'txn_fake', unsignedTransaction: {
          schemaVersion: '1', chain: 'solana-devnet', payload: '0x01', meta: {},
        },
      } },
      { path: '/v1/transactions/broadcast', body: {
        transactionId: 'txn_fake', signedTransaction: {
          chain: 'solana-devnet', unsigned: { chain: 'ethereum-sepolia' },
        },
      } },
      { path: '/v1/transactions/broadcast', body: {
        transactionId: 'txn_fake', signedTransaction: {
          chain: 'ethereum-sepolia', unsigned: { chain: 'solana-devnet' },
        },
      } },
      { path: '/v1/transactions/0xabc/confirm', body: { chain: 'solana-devnet' } },
      { path: '/v1/logs', body: { chain: 'solana-devnet' } },
      { path: '/v1/contracts/read', body: { chain: 'solana-devnet' } },
    ];
    for (const item of denied) {
      const response = await post(item.path, JSON.stringify(item.body));
      expect(response.status, item.path).toBe(403);
      expect(response.body, item.path).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    }
  });

  it('允许的链仍进入原有结构校验，不改变 400 语义', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);
    const response = await post('/v1/transactions/build', JSON.stringify({ chain: 'ethereum-sepolia' }));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('URL 申报允许的链不能掩盖 body 中被拒绝的链', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);
    const response = await post(
      '/v1/transactions/build?chain=ethereum-sepolia',
      JSON.stringify({ chain: 'solana-devnet' }),
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
  });
});

describe('readJsonBody 的错误分类（不泄漏内部细节）', () => {
  it('抛出的都是 DFR 错误（可被 HTTP 层直接映射）', async () => {
    try {
      await readJsonBody(fakeRequest(['{bad']), { maxBytes: 64, requestId: REQ });
      throw new Error('expected failure');
    } catch (err) {
      expect(isDfrError(err)).toBe(true);
      if (isDfrError(err)) {
        expect(err.requestId).toBe(REQ);
        expect(JSON.stringify(err.details ?? {})).not.toContain('{bad');
      }
    }
  });
});
