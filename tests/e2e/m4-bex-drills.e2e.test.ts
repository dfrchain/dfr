/**
 * M4 fault / fallback drills (reproducible offline).
 *
 * Authoritative sources: the M4 taskbook completion gates "fault drills, fallback drills", ADR-008, `docs/runbooks/m4-bex-integration.md`.
 *
 * All driven by stub providers + the real Gateway/Core/engine, **no public network, no funds needed**,
 * so it can run in the default offline gate. It covers the four scenarios BEX most needs confirmed before integration:
 *   1. Provider goes down → switch to the backup endpoint (once BEX uses DFR it no longer builds its own failover);
 *   2. ticket invalid/mismatched → `DFR_INVALID_TICKET` (without enumerating the reason);
 *   3. confirmation timeout → 200 + `reached:false` (not an error, the record is not rewritten);
 *   4. fallback drill: one settlement is broadcast **only** once by DFR (never broadcast on two paths).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { createGatewayServer, hashSecret, TokenBucketLimiter, createCoreTransactionChainPort } from '@dfr/gateway';
import { SseTicketStore } from '../../apps/gateway/src/sse-ticket.js';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const SECRET = 'm4DrillsSecret0123456789abcdef';
const PEPPER = 'm4-drills-pepper';
const KEY_ID = 'M4Drill1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

interface HarnessOptions {
  /** Response behavior of the primary Provider (normal by default). */
  primary?: 'ok' | 'http-503';
  /** Whether the transaction is visible while confirm polls. */
  confirmVisible?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const called: Array<{ providerId: string; method: string }> = [];
  const rawSends: string[] = [];
  const primaryBehavior = options.primary ?? 'ok';

  const stub = createStubFetch({
    onCall: (call) => called.push({ providerId: call.providerId, method: call.method }),
    resolve: (call) => {
      const isPrimary = call.providerId.includes('primary');
      if (isPrimary && primaryBehavior === 'http-503') return { kind: 'http', status: 503 };
      switch (call.method) {
        case 'eth_chainId': return { kind: 'result', value: '0xaa36a7' };
        case 'eth_blockNumber': return { kind: 'result', value: '0x112a880' };
        case 'eth_getTransactionCount': return { kind: 'result', value: '0x2a' };
        case 'eth_estimateGas': return { kind: 'result', value: '0x5208' };
        case 'eth_maxPriorityFeePerGas': return { kind: 'result', value: '0x3b9aca00' };
        case 'eth_getBlockByNumber': return { kind: 'result', value: BLOCK };
        case 'eth_call': return { kind: 'result', value: '0x' };
        case 'eth_getTransactionByHash':
          return { kind: 'result', value: options.confirmVisible === false ? null : {
            hash: `0x${'ab'.repeat(32)}`, blockNumber: '0x1', blockHash: `0x${'11'.repeat(32)}`,
            from: FROM.address, to: FROM.address, value: '0x0', nonce: '0x2a', input: '0x',
            transactionIndex: '0x0', gasPrice: '0x3b9aca00', gas: '0x5208',
          } };
        case 'eth_getLogs': return { kind: 'result', value: [{ address: FROM.address, topics: ['0xaa'], data: '0x', blockNumber: '0x1', logIndex: '0x0', transactionHash: `0x${'ab'.repeat(32)}` }] };
        case 'eth_sendRawTransaction': {
          rawSends.push(String(call.params[0]));
          return { kind: 'result', value: `0x${'cd'.repeat(32)}` };
        }
        default: return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
      }
    },
  });

  const registry = ChainRegistry.load({
    file: resolve(repoRoot, 'packages/registry/config/chains.yaml'),
    env: {
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
    },
  });
  const stores = createInMemoryTransactionStores();
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    random: () => 0, // Always pick the primary Provider first, otherwise "failover" degrades into "direct success"
    fetchImpl: stub,
    transactionStores: stores,
  });
  let n = 1;
  const engine = new TransactionEngine({
    stores: {
      transaction: stores.transaction,
      idempotency: stores.idempotency,
      nonce: stores.nonce,
      tracker: stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
    newTransactionId: () => `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(n++).padStart(2, '0')}` as TransactionId,
  });
  const bus = new EventBus();
  const tickets = new SseTicketStore();
  const server = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm4-drills',
      scope: { chains: '*', capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
    eventBus: bus,
    sseTickets: tickets,
    limiter: new TokenBucketLimiter({
      read: { capacity: 1000, refillPerSecond: 1000 },
      write: { capacity: 1000, refillPerSecond: 1000 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  servers.push(server);
  return { core, engine, stores, bus, tickets, server, called, rawSends };
}

async function baseUrl(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, { headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('M4 fault/fallback drills (offline)', () => {
  it('Provider down: when the primary endpoint returns 5xx, switch to the backup and return a result', async () => {
    const h = harness({ primary: 'http-503' });
    const base = await baseUrl(h.server);
    const { status, body } = await json(`${base}/v1/chains/${CHAIN}`);
    // Primary Provider 5xx → managed failover → backup returns eth_chainId/eth_blockNumber → 200.
    expect(status).toBe(200);
    expect(h.called.some((c) => c.providerId.includes('primary'))).toBe(true);
    expect(h.called.some((c) => c.providerId.includes('secondary'))).toBe(true);
    expect(body['chain']).toBe(CHAIN);
  }, 20_000);

  it('ticket invalid: consuming the ticket with a different filter set → DFR_INVALID_TICKET (without enumerating the reason)', async () => {
    const h = harness();
    const base = await baseUrl(h.server);
    const issued = h.tickets.issue({ projectId: 'm4-drills', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: CHAIN as never } })!;
    // Consume with a **different** filter (one extra types): digest mismatch → 401.
    const res = await fetch(
      `${base}/v1/events/subscribe?chain=${CHAIN}&types=tx.finalized&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { dfr_code?: string }).dfr_code).toBe('DFR_INVALID_TICKET');
  }, 20_000);

  it('transaction not yet visible: calling confirm for an unknown hash → 200 pending (polls internally until timeoutMs, without fabricating a final outcome)', async () => {
    const h = harness({ confirmVisible: false });
    const base = await baseUrl(h.server);
    const { status, body } = await json(`${base}/v1/transactions/0x${'ab'.repeat(32)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ chain: CHAIN, minFinality: 'finalized', timeoutMs: 1000 }),
    });
    // The transaction is not yet visible on-chain: confirm polls internally within the caller-supplied timeoutMs (F-2),
    // and if it is still not visible at the deadline, honestly returns pending / reached=false and hands over to background tracking,
    // **without** fabricating confirmed/failed, and without fail-fast throwing 404.
    // Per the runbook, the BEX side treats pending as "not yet visible": bounded polling is enough, do not retry the broadcast as if it were an error.
    expect(status).toBe(200);
    const confirmation = body['confirmation'] as { status?: string; finality?: string; reached?: boolean };
    expect(confirmation.status).toBe('pending');
    expect(confirmation.finality).toBe('unknown');
    expect(confirmation.reached).toBe(false);
  }, 20_000);

  it('fallback drill: one settlement is broadcast only once, never on two paths', async () => {
    const h = harness();
    const base = await baseUrl(h.server);
    const built = await json(`${base}/v1/transactions/build`, {
      method: 'POST',
      body: JSON.stringify({ chain: CHAIN, from: FROM, to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' }, value: { asset: { kind: 'native', chain: CHAIN }, amount: '1' } }),
    });
    const txid = built.body['transactionId'] as string;
    const unsigned = built.body['unsignedTransaction'] as Record<string, unknown>;
    // Use a stub signature (EIP-1559 shape) -- binding validation requires the payload to match the record, so use the payload from the record directly.
    const payload = unsigned['payload'] as string;
    const signed = {
      schemaVersion: '1', chain: CHAIN, unsigned,
      signedPayload: payload, expectedHash: `0x${'cd'.repeat(32)}`, signerRef: 'external:drill',
    };
    const res = await json(`${base}/v1/transactions/broadcast`, {
      method: 'POST',
      headers: { 'x-dfr-key': KEY, 'content-type': 'application/json', 'idempotency-key': 'drill-idem-0001' },
      body: JSON.stringify({ transactionId: txid, signedTransaction: signed }),
    });
    expect([200, 422]).toContain(res.status); // the stub signature may fail binding → 422, and nothing is broadcast
    // **Core assertion**: whether it succeeds or not, the broadcast is called at most once (never retried / sent on two paths).
    expect(h.rawSends.length).toBeLessThanOrEqual(1);
    if (res.status === 200) {
      expect((res.body['broadcast'] as { accepted: boolean }).accepted).toBe(true);
    }
  }, 20_000);
});
