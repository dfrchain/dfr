// 运维探针契约测试（DFR-M1-E02）。
//
// 权威来源：docs/architecture/observability-spec-v0.1.md 第 9 章——
//   GET /healthz  进程存活（不检查依赖）
//   GET /readyz   就绪：Registry 已加载、至少一个 Provider 可用、无配置错误
// 并要求两者**必须分离**：依赖故障时进程保持存活但不接流量。
//
// 本测试只关心 Gateway 的职责：把 Core 的就绪报告与可选的依赖探针（DB）
// 聚合成 200/503，并且不泄漏端点、凭证或高基数字段。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'ReadyKey';
const SECRET = 'readinessProbeSecret0123456789abc';
const PEPPER = 'readiness-pepper';

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'readiness',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };
}

interface FakeReadiness {
  ready: boolean;
  chains: { chain: string; providers: number; available: number }[];
}

/** 只实现探针用得到的表面：listChains / readiness / 健康检查开关。 */
function fakeCore(readiness: FakeReadiness): DfrCore {
  return {
    listChains: () => [],
    readiness: () => readiness,
    startHealthChecks: () => ({ started: [], skipped: [] }),
    stopHealthChecks: () => undefined,
  } as unknown as DfrCore;
}

let server: Server | undefined;
let baseUrl = '';

async function start(options: {
  readiness: FakeReadiness;
  readyCheck?: () => Promise<void>;
}): Promise<void> {
  server = createGatewayServer({
    core: fakeCore(options.readiness),
    auth: auth(),
    ...(options.readyCheck !== undefined ? { readyCheck: options.readyCheck } : {}),
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

const READY: FakeReadiness = {
  ready: true,
  chains: [{ chain: 'ethereum-sepolia', providers: 2, available: 2 }],
};
const NOT_READY: FakeReadiness = {
  ready: false,
  chains: [{ chain: 'ethereum-sepolia', providers: 2, available: 0 }],
};

describe('GET /readyz（DFR-M1-E02）', () => {
  it('就绪时返回 200 ready，且不需要 API Key（探针不能被鉴权挡住）', async () => {
    await start({ readiness: READY });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ready');
    expect(body['chains']).toEqual([{ chain: 'ethereum-sepolia', providers: 2, available: 2 }]);
  });

  it('没有任何可用 Provider 时返回 503 not_ready', async () => {
    await start({ readiness: NOT_READY });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
    expect(body['chains']).toEqual([{ chain: 'ethereum-sepolia', providers: 2, available: 0 }]);
  });

  it('依赖探针失败（如数据库不可达）时返回 503，即使 Registry 与 Provider 正常', async () => {
    await start({
      readiness: READY,
      readyCheck: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.9:5432?password=do-not-leak');
      },
    });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({ status: 'not_ready', stores: 'unavailable' });
    // 依赖错误的原文不得回显（可能含 DSN / 口令）。
    expect(raw).not.toContain('do-not-leak');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('10.0.0.9');
  });

  it('健康检查与就绪检查必须分离：未就绪时 /healthz 仍为 200', async () => {
    await start({ readiness: NOT_READY });

    const live = await fetch(`${baseUrl}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'ok' });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(503);
  });

  it('未配置事务存储时 stores=not_configured，且不影响 M0 只读就绪', async () => {
    await start({ readiness: READY });
    const response = await fetch(`${baseUrl}/readyz`);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['stores']).toBe('not_configured');
    expect(response.status).toBe(200);
  });

  it('就绪探针不泄漏凭证，也不把探针结果写进日志字段', async () => {
    const info = vi.fn();
    server = createGatewayServer({
      core: fakeCore(NOT_READY),
      auth: auth(),
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PEPPER);
  });
});
