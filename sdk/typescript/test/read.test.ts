/**
 * SDK 读路径契约测试（DFR-M1-E02 补强）。
 *
 * 为什么单独成文件：`write.test.ts` 只覆盖 build/simulate/broadcast/confirm。
 * 读方法此前仅在 `tests/e2e/*` 里被**间接**驱动（真实 Gateway + 替身 RPC），
 * 一旦查询串构造写错（例如把 `consistency` 拼成 `consistent`），E2E 会整体失败
 * 但不会指出是哪条 URL 契约破了；这里对每条读方法做点对点的请求断言。
 *
 * 权威来源：docs/api/openapi.yaml 的 GET /v1/chains、/v1/chains/{chainId}、
 * /v1/balances、/v1/blocks/{blockRef}、/v1/transactions/{txHash}。
 */
import { describe, expect, it } from 'vitest';
import { DFR, isDfrApiError, type DfrApiError } from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_ReadKey_secret0123456789abcdefgh';
const CHAIN = 'ethereum-sepolia';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capture(
  handler: (call: Captured) => Response | Promise<Response>,
  seen: Captured[],
): typeof fetch {
  return async (input, init) => {
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    seen.push(call);
    return handler(call);
  };
}

function client(fetchImpl: typeof fetch): DFR {
  return new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });
}

const BLOCK = {
  chain: CHAIN,
  number: '16',
  hash: `0x${'aa'.repeat(32)}`,
  observedAt: '2026-10-06T00:00:00.000Z',
};

describe('SDK 读路径请求契约', () => {
  it('listChains：GET /v1/chains，解包 items', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { items: [], requestId: 'req_x' }), seen));
    await expect(dfr.listChains()).resolves.toEqual([]);
    expect(seen[0]!.url).toBe(`${BASE}/v1/chains`);
    expect(seen[0]!.method).toBe('GET');
  });

  it('getChain：链 ID 做 URL 编码，返回封套（含 requestId）', async () => {
    const seen: Captured[] = [];
    const dfr = client(
      capture(
        () => jsonResponse(200, { id: CHAIN, displayName: 'Sepolia', requestId: 'req_y' }),
        seen,
      ),
    );
    const info = await dfr.getChain(CHAIN);
    expect(seen[0]!.url).toBe(`${BASE}/v1/chains/${CHAIN}`);
    expect(info.requestId).toBe('req_y');
  });

  it('getBalance：chain 与 account 必填，解包 balance（不返回封套）', async () => {
    const seen: Captured[] = [];
    const dfr = client(
      capture(
        () =>
          jsonResponse(200, {
            balance: { chain: CHAIN, account: '0xabc', asset: { kind: 'native', chain: CHAIN }, amount: '1' },
            requestId: 'req_z',
          }),
        seen,
      ),
    );
    const balance = await dfr.getBalance({ chain: CHAIN, account: '0xabc' });
    expect(seen[0]!.url).toBe(`${BASE}/v1/balances?chain=${CHAIN}&account=0xabc`);
    expect(balance.amount).toBe('1');
  });

  it('getBalance：可选 assetId / consistency / blockRef 都进入查询串', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { balance: { amount: '0' } }), seen));
    await dfr.getBalance({
      chain: CHAIN,
      account: '0xabc',
      assetId: 'usdc',
      consistency: 'finalized',
      blockRef: 'tag:finalized',
    });
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get('assetId')).toBe('usdc');
    expect(url.searchParams.get('consistency')).toBe('finalized');
    expect(url.searchParams.get('blockRef')).toBe('tag:finalized');
  });

  it('getBlock：blockRef 作为路径段并编码冒号', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { block: BLOCK }), seen));
    const block = await dfr.getBlock({ chain: CHAIN, blockRef: 'tag:finalized' });
    expect(seen[0]!.url).toBe(`${BASE}/v1/blocks/${encodeURIComponent('tag:finalized')}?chain=${CHAIN}`);
    expect(block.hash).toBe(BLOCK.hash);
  });

  it('getTransaction：默认不带 includeReceipt；显式 true 才带上', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { transaction: { chain: CHAIN } }), seen));
    const txHash = `0x${'b'.repeat(64)}`;
    await dfr.getTransaction({ chain: CHAIN, txHash });
    await dfr.getTransaction({ chain: CHAIN, txHash, includeReceipt: true });
    expect(seen[0]!.url).toBe(`${BASE}/v1/transactions/${txHash}?chain=${CHAIN}`);
    expect(new URL(seen[1]!.url).searchParams.get('includeReceipt')).toBe('true');
  });

  it('getReceipt：始终请求 includeReceipt=true，缺 receipt 时返回 null（不是 undefined）', async () => {
    const seen: Captured[] = [];
    const txHash = `0x${'c'.repeat(64)}`;
    const dfr = client(capture(() => jsonResponse(200, { transaction: { chain: CHAIN } }), seen));
    await expect(dfr.getReceipt({ chain: CHAIN, txHash })).resolves.toBeNull();
    expect(new URL(seen[0]!.url).searchParams.get('includeReceipt')).toBe('true');
  });

  it('getReceipt：有 receipt 时返回该对象', async () => {
    const receipt = { txHash: `0x${'c'.repeat(64)}`, status: 'success' };
    const dfr = client(capture(() => jsonResponse(200, { receipt }), []));
    await expect(dfr.getReceipt({ chain: CHAIN, txHash: receipt.txHash })).resolves.toEqual(receipt);
  });

  it('读路径的错误同样映射为 DfrApiError，并保留 requestId 与 retryable', async () => {
    // wire 格式是 snake_case（RFC 9457 + DFR 扩展），不是 TS 侧的 camelCase。
    const dfr = client(
      capture(
        () =>
          jsonResponse(404, {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            dfr_code: 'DFR_NOT_FOUND',
            detail: '链不存在',
            request_id: 'req_notfound',
            retryable: false,
            safe_to_retry: false,
          }),
        [],
      ),
    );
    const error = await dfr.getChain(CHAIN).then(
      () => undefined,
      (err: unknown) => err as DfrApiError,
    );
    expect(isDfrApiError(error)).toBe(true);
    if (error === undefined) throw new Error('expected the call to reject');
    expect(error.code).toBe('DFR_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.requestId).toBe('req_notfound');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('链不存在');
  });
});

describe('SDK getLogs（ADR-034）', () => {
  it('POST /v1/logs?chain=，带 fromBlock/toBlock，解包 logs', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(
      () => jsonResponse(200, { logs: [{ address: '0xabc', index: '1', blockRef: { kind: 'number', number: '100' } }], requestId: 'req_1' }),
      seen,
    ));
    const logs = await dfr.getLogs({ chain: CHAIN, fromBlock: '90', toBlock: '100', address: '0xabc' });
    expect(logs).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe(`${BASE}/v1/logs?chain=${CHAIN}`);
    expect(seen[0]!.body).toBe(JSON.stringify({ fromBlock: '90', toBlock: '100', address: '0xabc' }));
  });
});

describe('SDK readContract / getAccount（ADR-035/036）', () => {
  it('readContract：POST /v1/contracts/read?chain=，解包 result', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(
      () => jsonResponse(200, { result: { data: '0x2a', decoded: '42' }, requestId: 'req_1' }),
      seen,
    ));
    const result = await dfr.readContract({ chain: CHAIN, contract: '0xabc', data: '0xdeadbeef' });
    expect(result.data).toBe('0x2a');
    expect(result.decoded).toBe('42');
    expect(seen[0]!.url).toBe(`${BASE}/v1/contracts/read?chain=${CHAIN}`);
    expect(seen[0]!.method).toBe('POST');
  });

  it('getAccount：GET /v1/accounts/{addr}?chain=，解包 account', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(
      () => jsonResponse(200, { account: { ref: { chain: CHAIN, address: '0xabc' }, kind: 'contract', exists: true }, requestId: 'req_1' }),
      seen,
    ));
    const account = await dfr.getAccount({ chain: CHAIN, address: '0xabc' });
    expect(account.kind).toBe('contract');
    expect(account.exists).toBe(true);
    expect(seen[0]!.url).toBe(`${BASE}/v1/accounts/0xabc?chain=${CHAIN}`);
    expect(seen[0]!.method).toBe('GET');
  });
});
