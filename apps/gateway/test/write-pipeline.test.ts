/**
 * Gateway general write-pipeline contract test (DFR-M1-B06).
 *
 * Authoritative sources: gateway-spec chapter 3 (request lifecycle), section 5.2 (route classes).
 *
 * This task verifies four things:
 *   1. bounded JSON body parsing: both the declared and actual size caps must take effect;
 *   2. route metadata: read/write route classes are decided by metadata, not by an if inside the handler;
 *   3. allowWrite: the Key scope and the Gateway switch are two independent gates;
 *   4. cross-cutting order: auth precedes rate limiting and size validation, and write-permission checks precede reading the body.
 *
 * B07/B08 already implement the build/simulate business logic, so proving "passes through all cross-cutting gates" becomes:
 * a structurally illegal request body gets 400 in the handler (not 403/422 at the gates).
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

/** Minimal Core stand-in: this file triggers no Core calls. */
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

describe('bounded JSON body parsing (gateway-spec chapter 3 step 7)', () => {
  it('a valid JSON object parses successfully', async () => {
    const parsed = await readJsonBody(fakeRequest(['{"chain":"ethereum-sepolia"}']), {
      maxBytes: 1024,
      requestId: REQ,
    });
    expect(parsed).toEqual({ chain: 'ethereum-sepolia' });
  });

  it('an invalid request-body size config cannot turn off the byte cap', async () => {
    for (const maxBytes of [NaN, Infinity, -1, 0, 1.5]) {
      await expect(
        readJsonBody(fakeRequest(['{"value":"sensitive"}']), { maxBytes, requestId: REQ }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('illegal JSON returns DFR_VALIDATION_FAILED', async () => {
    await expect(
      readJsonBody(fakeRequest(['{not json']), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED', details: { fields: ['body'] } });
  });

  it('arrays / null are not valid request bodies', async () => {
    for (const raw of ['[]', 'null', '"str"', '42']) {
      await expect(
        readJsonBody(fakeRequest([raw]), { maxBytes: 1024, requestId: REQ }),
      ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    }
  });

  it('an empty body returns DFR_VALIDATION_FAILED', async () => {
    await expect(
      readJsonBody(fakeRequest([]), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('declared content-length over the cap: rejected before reading', async () => {
    await expect(
      readJsonBody(fakeRequest(['{}'], { 'content-length': '999999' }), {
        maxBytes: 1024,
        requestId: REQ,
      }),
    ).rejects.toMatchObject({ code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('no declared content-length but actually over the cap: the streaming count also rejects (headers not trusted)', async () => {
    const chunks = ['{"a":"', 'x'.repeat(4096), '"}'];
    await expect(
      readJsonBody(fakeRequest(chunks), { maxBytes: 1024, requestId: REQ }),
    ).rejects.toMatchObject({ code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('a body exactly at the cap parses normally (boundaries are not false-killed)', async () => {
    const raw = '{"a":1}';
    const parsed = await readJsonBody(fakeRequest([raw]), {
      maxBytes: Buffer.byteLength(raw),
      requestId: REQ,
    });
    expect(parsed).toEqual({ a: 1 });
  });
});

describe('route metadata (gateway-spec section 5.2 route classes)', () => {
  it('read-only routes belong to the read class', () => {
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

  it('build / simulate belong to the write class and declare their own capabilities', () => {
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

  it('a mismatched method or unknown path returns null (mapped to 404 by the caller)', () => {
    expect(matchRoute('POST', '/v1/chains')).toBeNull();
    expect(matchRoute('POST', '/v1/balances')).toBeNull();
    expect(matchRoute('GET', '/v1/nope')).toBeNull();
    expect(matchRoute('DELETE', '/v1/transactions/build')).toBeNull();
  });
});

describe('allowWrite two gates and cross-cutting order (DFR-M1-B06)', () => {
  it('Key without write permission → 403 DFR_PROJECT_SCOPE_DENIED', async () => {
    await start(false, false);
    const response = await post('/v1/transactions/build', '{}');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
  });

  it('a read-only Key for broadcast is still rejected, without entering body/engine', async () => {
    await start(false, true);
    const response = await post('/v1/transactions/broadcast', '{not json');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(JSON.stringify(response.body)).not.toContain('signedPayload');
  });

  it('Key allows writes but the Gateway has not enabled them → 422 DFR_UNSUPPORTED_CAPABILITY', async () => {
    await start(true, false);
    const response = await post('/v1/transactions/build', '{}');
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('both gates pass → passes through all cross-cutting steps to the handler (B07: structural validation takes effect here)', async () => {
    await start(true, true);
    // A body missing from can only get 400 if it reaches the handler's structural validation:
    // the gates only give 403 (Key scope) or 422 (deployment switch), never 400.
    const response = await post('/v1/transactions/build', JSON.stringify({ chain: 'ethereum-sepolia' }));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    // The error envelope uses snake_case request_id (error-spec chapter 2).
    expect(response.body['request_id']).toMatch(/^req_/u);
  });

  it('simulate likewise passes through all cross-cutting steps to the handler (B08: structural validation takes effect)', async () => {
    await start(true, true);
    // Missing transactionId: only reaching the handler's structural validation yields 400.
    const response = await post(
      '/v1/transactions/simulate',
      JSON.stringify({ chain: 'ethereum-sepolia' }),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('auth precedes size validation: an unauthenticated oversized package returns 401, not 413', async () => {
    await start(true, true);
    // Do not send a fake content-length (the client would reject it directly); use a really oversized body + an invalid Key,
    // asserting 401 rather than 413, i.e. "auth precedes contract validation".
    const response = await post('/v1/transactions/build', JSON.stringify({ pad: 'x'.repeat(300_000) }), {
      'x-dfr-key': 'dfr_BadKey01_badbadbadbadbadbadbadbad',
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNAUTHENTICATED' });
  });

  it('write-permission checks precede body parsing: illegal JSON without write permission returns 403, not 400', async () => {
    await start(false, false);
    const response = await post('/v1/transactions/build', '{not json');
    expect(response.status).toBe(403);
  });

  it('after write permission passes, illegal JSON → 400 DFR_VALIDATION_FAILED (not 500)', async () => {
    await start(true, true);
    const response = await post('/v1/transactions/build', '{not json');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('after write permission passes, an oversized body → 413 DFR_PAYLOAD_TOO_LARGE', async () => {
    await start(true, true);
    const response = await post('/v1/transactions/build', JSON.stringify({ pad: 'x'.repeat(300_000) }));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PAYLOAD_TOO_LARGE' });
  });

  it('read routes are unaffected by the write gate (still readable with allowWrite=false)', async () => {
    await start(false, false);
    const response = await fetch(`${baseUrl}/v1/chains`, { headers: KEY_HEADER });
    expect(response.status).toBe(200);
  });
});

describe('AUTH-01: body chain scope for write requests and POST read requests', () => {
  it('a restricted Key may not use the body chain to bypass validation (even when the URL has no chain)', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);

    // Every response should be rejected before calling the handler / transaction engine, not return 400/422.
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

  it('allowed chains still enter the original structural validation, without changing the 400 semantics', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);
    const response = await post('/v1/transactions/build', JSON.stringify({ chain: 'ethereum-sepolia' }));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('a URL-declared allowed chain cannot mask a rejected chain in the body', async () => {
    await start(true, true, ['ethereum-sepolia' as never]);
    const response = await post(
      '/v1/transactions/build?chain=ethereum-sepolia',
      JSON.stringify({ chain: 'solana-devnet' }),
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
  });
});

describe('readJsonBody error classification (no internal details leaked)', () => {
  it('everything thrown is a DFR error (directly mappable by the HTTP layer)', async () => {
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
