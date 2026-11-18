/**
 * SDK read-path contract tests (DFR-M1-E02 reinforcement).
 *
 * Why a separate file: `write.test.ts` only covers build/simulate/broadcast/confirm.
 * Read methods were previously driven only **indirectly** in `tests/e2e/*` (real Gateway + stand-in RPC),
 * so a misbuilt query string (e.g. spelling `consistency` as `consistent`) would fail E2E as a whole
 * without saying which URL contract broke; here, each read method gets point-to-point request assertions.
 *
 * Authoritative source: docs/api/openapi.yaml GET /v1/chains, /v1/chains/{chainId},
 * /v1/balances, /v1/blocks/{blockRef}, /v1/transactions/{txHash}.
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

describe('SDK read-path request contract', () => {
  it('listChains: GET /v1/chains, unpacking items', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { items: [], requestId: 'req_x' }), seen));
    await expect(dfr.listChains()).resolves.toEqual([]);
    expect(seen[0]!.url).toBe(`${BASE}/v1/chains`);
    expect(seen[0]!.method).toBe('GET');
  });

  it('getChain: chain ID is URL-encoded, returning the envelope (with requestId)', async () => {
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

  it('getBalance: chain and account are required, unpacking balance (no envelope returned)', async () => {
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

  it('getBalance: optional assetId / consistency / blockRef all enter the query string', async () => {
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

  it('getBlock: blockRef is a path segment with the colon encoded', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { block: BLOCK }), seen));
    const block = await dfr.getBlock({ chain: CHAIN, blockRef: 'tag:finalized' });
    expect(seen[0]!.url).toBe(`${BASE}/v1/blocks/${encodeURIComponent('tag:finalized')}?chain=${CHAIN}`);
    expect(block.hash).toBe(BLOCK.hash);
  });

  it('getTransaction: includeReceipt omitted by default; only included when explicitly true', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, { transaction: { chain: CHAIN } }), seen));
    const txHash = `0x${'b'.repeat(64)}`;
    await dfr.getTransaction({ chain: CHAIN, txHash });
    await dfr.getTransaction({ chain: CHAIN, txHash, includeReceipt: true });
    expect(seen[0]!.url).toBe(`${BASE}/v1/transactions/${txHash}?chain=${CHAIN}`);
    expect(new URL(seen[1]!.url).searchParams.get('includeReceipt')).toBe('true');
  });

  it('getReceipt: always requests includeReceipt=true, returning null when receipt is missing (not undefined)', async () => {
    const seen: Captured[] = [];
    const txHash = `0x${'c'.repeat(64)}`;
    const dfr = client(capture(() => jsonResponse(200, { transaction: { chain: CHAIN } }), seen));
    await expect(dfr.getReceipt({ chain: CHAIN, txHash })).resolves.toBeNull();
    expect(new URL(seen[0]!.url).searchParams.get('includeReceipt')).toBe('true');
  });

  it('getReceipt: returns the receipt object when present', async () => {
    const receipt = { txHash: `0x${'c'.repeat(64)}`, status: 'success' };
    const dfr = client(capture(() => jsonResponse(200, { receipt }), []));
    await expect(dfr.getReceipt({ chain: CHAIN, txHash: receipt.txHash })).resolves.toEqual(receipt);
  });

  it('read-path errors likewise map to DfrApiError, keeping requestId and retryable', async () => {
    // The wire format is snake_case (RFC 9457 + DFR extensions), not the TS-side camelCase.
    const dfr = client(
      capture(
        () =>
          jsonResponse(404, {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            dfr_code: 'DFR_NOT_FOUND',
            detail: 'Chain not found',
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
    expect(error.message).toBe('Chain not found');
  });
});

describe('SDK getLogs (ADR-034)', () => {
  it('POST /v1/logs?chain=, with fromBlock/toBlock, unpacking logs', async () => {
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

describe('SDK readContract / getAccount (ADR-035/036)', () => {
  it('readContract: POST /v1/contracts/read?chain=, unpacking result', async () => {
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

  it('getAccount: GET /v1/accounts/{addr}?chain=, unpacking account', async () => {
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
