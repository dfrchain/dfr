/**
 * EVM Adapter 广播（DFR-M1-C02）。
 *
 * 权威来源：m1-api-contract.md 第 3/5 节、transaction-lifecycle.md §4.4、
 * error-spec §5.1、ADR-016。
 *
 * 本文件的重点是**资金安全**，不是功能覆盖：
 *   1. `eth_sendRawTransaction` 必须标记 `non-idempotent-write`，Provider 层因此绝不自动重试；
 *   2. 一次 broadcast 调用对传输层**恰好一次**，失败也不切换 Provider 重发；
 *   3. `already known` / `already exists` 是幂等成功，不是错误；
 *   4. 其它失败原样上抛（由 C03 决定状态回退），绝不假装 accepted；
 *   5. 本地校验（未签名 / 链不符 / expectedHash 不符 / 端点返回异常哈希）失败时
 *      **不得发出广播**。
 *
 * 真实签名用 viem 纯函数 + 运行时派生的测试私钥（仓库内无私钥字面量）。
 */
import { describe, expect, it } from 'vitest';
import { keccak256, serializeTransaction, toBytes, toRlp } from 'viem';
import { privateKeyToAddress, signTransaction } from 'viem/accounts';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  AdapterContext,
  Chain,
  ChainId,
  ProviderCall,
  ProviderContext,
  ProviderHandle,
  ProviderRouter,
  SignedTransaction,
  UnsignedTransaction,
} from '@dfr/types';

const SEPOLIA = 'ethereum-sepolia' as ChainId;
const OTHER_CHAIN = 'base-sepolia' as ChainId;
const CHAIN_ID = 11155111;
const TO = '0x2222222222222222222222222222222222222222' as const;
const VALUE = 1000n;

const chain: Chain = {
  id: SEPOLIA,
  displayName: 'Ethereum Sepolia',
  family: 'evm',
  network: 'testnet',
  externalChainId: '11155111',
  adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.broadcast'],
};

/** 运行时派生：仓库内不出现私钥字面量。 */
const TEST_KEY = keccak256(toBytes('dfr-m1-c02-signer'));

interface Recorded {
  method: string;
  idempotency: string;
  params: readonly unknown[];
}

interface StubRouterOptions {
  /** 对 eth_sendRawTransaction 的应答；缺省成功返回真实哈希。 */
  send?: (recorded: Recorded) => unknown;
  onSend?: (recorded: Recorded) => void;
  /** 对 eth_getTransactionByHash 的应答（观测路径）。 */
  observe?: () => unknown;
  /** 对 eth_getTransactionCount 的应答（观测路径用于区分 replaced / absent）。 */
  latestNonce?: () => unknown;
}

/** 记录全部调用，并允许对广播注入自定义应答（成功 / JSON-RPC 错误 / 网络错误）。 */
function createStubRouter(
  options: StubRouterOptions = {},
): { router: ProviderRouter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const handle: ProviderHandle = {
    id: 'stub-primary' as never,
    chain: SEPOLIA,
    async request<T>(call: ProviderCall, _ctx: ProviderContext): Promise<T> {
      const recorded: Recorded = {
        method: call.method,
        idempotency: call.idempotency,
        params: call.params,
      };
      calls.push(recorded);
      if (call.method === 'eth_chainId') return '0xaa36a7' as T;
      if (call.method === 'eth_getTransactionByHash') {
        if (options.observe !== undefined) return options.observe() as T;
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'stub 未配置观测应答',
          chain: SEPOLIA,
        });
      }
      if (call.method === 'eth_getTransactionCount') {
        if (options.latestNonce !== undefined) return options.latestNonce() as T;
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'stub 未配置 nonce 应答',
          chain: SEPOLIA,
        });
      }
      if (call.method === 'eth_sendRawTransaction') {
        options.onSend?.(recorded);
        if (options.send !== undefined) return options.send(recorded) as T;
        // 真实端点返回的是交易哈希 = keccak256(已签名载荷)。
        return keccak256(call.params[0] as `0x${string}`) as T;
      }
      throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
        message: `stub 未实现方法 ${call.method}`,
        chain: SEPOLIA,
      });
    },
  };
  return {
    router: {
      chain: SEPOLIA,
      async acquire(): Promise<ProviderHandle> {
        return handle;
      },
    },
    calls,
  };
}

function context(router: ProviderRouter): AdapterContext {
  return {
    chain: SEPOLIA,
    network: 'testnet',
    providers: router,
    signal: new AbortController().signal,
    requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
}

function unsignedStub(payload: string, chainId = SEPOLIA): UnsignedTransaction {
  return {
    schemaVersion: '1',
    chain: chainId,
    payload,
    meta: { encoding: 'hex', requiresNonce: '1' as never },
  };
}

/** 构造一笔真实签名交易，并返回 Adapter 需要的 SignedTransaction。 */
async function makeSigned(
  overrides: Partial<{ value: bigint; nonce: number; data: `0x${string}` }> = {},
  chainId = CHAIN_ID,
): Promise<SignedTransaction> {
  const signedPayload = await signTransaction({
    privateKey: TEST_KEY,
    transaction: {
      chainId,
      nonce: overrides.nonce ?? 1,
      to: TO,
      value: overrides.value ?? VALUE,
      data: overrides.data ?? '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    },
  });
  return {
    schemaVersion: '1',
    chain: SEPOLIA,
    unsigned: unsignedStub('0x02placeholder', SEPOLIA),
    signedPayload,
    expectedHash: keccak256(signedPayload as `0x${string}`),
    signerRef: 'external:test',
  };
}

describe('EVM Adapter broadcast（DFR-M1-C02）', () => {
  const adapter = new EvmAdapter({ chain });

  it('恰好一次 eth_sendRawTransaction，且标记 non-idempotent-write', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();

    const result = await adapter.broadcast(context(router), signed);

    const sends = calls.filter((c) => c.method === 'eth_sendRawTransaction');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.idempotency).toBe('non-idempotent-write');
    expect(sends[0]?.params).toEqual([signed.signedPayload]);
    expect(result.accepted).toBe(true);
    expect(result.status).toBe('broadcast');
    expect(result.ref).toEqual({ kind: 'hash', hash: signed.expectedHash });
    expect(result.providerId).toBe('stub-primary');
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('不发送任何 chainId 之外的探测调用（避免多余往返）', async () => {
    const { router, calls } = createStubRouter();
    await adapter.broadcast(context(router), await makeSigned());
    expect(calls.map((c) => c.method)).toEqual(['eth_sendRawTransaction']);
  });

  it('已签名载荷里的 chainId 与绑定链不一致 → DFR_CHAIN_MISMATCH，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned({}, 84532); // Base Sepolia

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_CHAIN_MISMATCH');
    expect(calls).toEqual([]);
  });

  it('SignedTransaction.chain 与 Adapter 绑定链不一致 → DFR_CHAIN_MISMATCH，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = { ...(await makeSigned()), chain: OTHER_CHAIN };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_CHAIN_MISMATCH');
    expect(calls).toEqual([]);
  });

  it('expectedHash 与载荷重算不一致 → DFR_TRANSACTION_REJECTED，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = { ...(await makeSigned()), expectedHash: `0x${'ab'.repeat(32)}` };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('expected_hash_mismatch');
    expect(calls).toEqual([]);
  });

  it('结构合法但未签名的载荷 → DFR_TRANSACTION_REJECTED(not_signed)，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    // 真实未签名载荷（不是畸形 RLP）：只有这样，拒绝才必然来自 not_signed 分支，
    // 而不会被 decode 失败或 expectedHash 分支顺带拦住。
    const unsignedPayload = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub(unsignedPayload),
      signedPayload: unsignedPayload,
      // 哈希正确：确保唯一可能的拒绝原因就是"未签名"。
      expectedHash: keccak256(unsignedPayload),
    };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('not_signed');
    expect(calls).toEqual([]);
  });

  it('无记录真值路径也必须拒绝无法恢复发送方的签名', async () => {
    const { router, calls } = createStubRouter();
    const payload = `0x02${toRlp([
      '0xaa36a7', '0x01', '0x01', '0x02', '0x5208', TO, '0x', '0x', [],
      '0x', `0x${'ff'.repeat(32)}`, '0x01',
    ]).slice(2)}`;
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub(payload),
      signedPayload: payload,
      expectedHash: keccak256(payload as `0x${string}`),
    };
    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(calls).toEqual([]);
  });

  it('畸形载荷 → DFR_TRANSACTION_REJECTED(invalid_payload)，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub('0x02f86b0180808080942222222222222222222222222222222222222280c0'),
      signedPayload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
      expectedHash: `0x${'ab'.repeat(32)}`,
    };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('invalid_payload');
    expect(calls).toEqual([]);
  });

  it('"already known" 是幂等成功（accepted=true），不是错误', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider 返回 JSON-RPC 错误',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'already known' },
        });
      },
    });
    const signed = await makeSigned();

    const result = await adapter.broadcast(context(router), signed);

    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: signed.expectedHash });
    // 幂等成功仍然只是一次调用：不因"已存在"再去查询或重发。
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('"already exists" 同样按幂等成功处理', async () => {
    const { router } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider 返回 JSON-RPC 错误',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'Transaction already exists' },
        });
      },
    });
    const result = await adapter.broadcast(context(router), await makeSigned());
    expect(result.accepted).toBe(true);
  });

  it('其它 JSON-RPC 失败原样上抛，且不重发（underpriced）', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider 返回 JSON-RPC 错误',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'replacement transaction underpriced' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_UNAVAILABLE');
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('nonce too low 保持 DFR_NONCE_CONFLICT（不吞成成功、不重发）', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_NONCE_CONFLICT', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'nonce 冲突（eth_sendRawTransaction）',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'nonce too low' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_NONCE_CONFLICT');
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('可重试类错误也不重发（non-idempotent-write 的分类才是不重发的根据）', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider 返回 HTTP 503',
          chain: SEPOLIA,
          details: { status: 503, method: 'eth_sendRawTransaction' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    // DFR_PROVIDER_UNAVAILABLE 对只读是"可重试"的；但广播绝不能因此重发。
    expect(isDfrError(error) && error.retryable).toBe(true);
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    // 与 packages/provider/test/provider.test.ts 的
    // "广播类（non-idempotent-write）绝不自动重试" 相互印证：
    // Adapter 声明类别 → Manager 依类别拒绝重试与失败切换。
  });

  it('记录真值一致（C03a）：expectedFrom 与签名者相符、unsigned 载荷逐字段一致 → 放行', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const unsigned = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const result = await adapter.broadcast(context(router), signed, {
      expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      expectedUnsignedPayload: unsigned,
    });

    expect(result.accepted).toBe(true);
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('签名者与记录里的 from 不符 → sender_mismatch，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const unsigned = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const error = await adapter
      .broadcast(context(router), signed, {
        // 另一个账户：即使字段完全一致也必须拒绝（nonce 是给前一个账户预留的）。
        expectedFrom: { chain: SEPOLIA, address: `0x${'9'.repeat(40)}` },
        expectedUnsignedPayload: unsigned,
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('sender_mismatch');
    expect(calls).toEqual([]);
  });

  it('记录里的 unsigned 载荷与签名载荷字段不符 → unsigned_payload_mismatch，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const tampered = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE + 1n, // 金额被改
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const error = await adapter
      .broadcast(context(router), signed, {
        expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
        expectedUnsignedPayload: tampered,
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.details?.['reason']).toBe('unsigned_payload_mismatch');
    expect(calls).toEqual([]);
  });

  it('只给半个记录真值 → invalid_expectation，且不发出广播', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();

    const error = await adapter
      .broadcast(context(router), signed, {
        expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
        // 故意不给 expectedUnsignedPayload：半个真值不得被当成"已校验"。
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.details?.['reason']).toBe('invalid_expectation');
    expect(calls).toEqual([]);
  });

  it('端点返回的 txHash 与载荷重算不一致 → DFR_PROVIDER_INVALID_RESPONSE（fail-closed）', async () => {
    const { router } = createStubRouter({ send: () => `0x${'cd'.repeat(32)}` });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_INVALID_RESPONSE');
  });

  it('观测：按 expectedHash 查到未上链交易 → pending', async () => {
    const { router } = createStubRouter({
      observe: () => ({
        hash: `0x${'ab'.repeat(32)}`,
        blockNumber: null,
        blockHash: null,
        from: privateKeyToAddress(TEST_KEY),
        to: TO,
        value: '0x3e8',
        nonce: '0x1',
        gasPrice: '0x1',
      }),
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '1' as never,
    });

    expect(observation).toEqual({ kind: 'pending', txHash: `0x${'ab'.repeat(32)}` });
  });

  it('观测：查到已上链交易 → included 且带区块引用', async () => {
    const { router } = createStubRouter({
      observe: () => ({
        hash: `0x${'ab'.repeat(32)}`,
        blockNumber: '0x112a880',
        blockHash: `0x${'11'.repeat(32)}`,
        from: privateKeyToAddress(TEST_KEY),
        to: TO,
        value: '0x3e8',
        nonce: '0x1',
        gasPrice: '0x1',
      }),
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '1' as never,
    });

    expect(observation.kind).toBe('included');
    expect(observation).toMatchObject({
      blockRef: { kind: 'number', number: '18000000' },
      canonicalBlockHash: `0x${'11'.repeat(32)}`,
    });
  });

  it('观测：查不到且链上 nonce 已越过 → replaced（不是 dropped）', async () => {
    const { router } = createStubRouter({
      observe: () => null,
      latestNonce: () => '0x2b', // 43 > 42：该 nonce 已被别人消耗
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(observation).toEqual({ kind: 'replaced', nonce: '42' });
  });

  it('观测：查不到且 nonce 未被占用 → absent（保持 unknown，不判 dropped）', async () => {
    const { router } = createStubRouter({ observe: () => null, latestNonce: () => '0x2a' });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(observation).toEqual({ kind: 'absent' });
  });

  it('观测是只读的：不发出 eth_sendRawTransaction', async () => {
    const { router, calls } = createStubRouter({ observe: () => null, latestNonce: () => '0x2a' });

    await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionCount']);
    expect(calls.every((c) => c.idempotency === 'safe-read')).toBe(true);
  });

  it('rebroadcast 选项透传到结果（dropped → broadcast 的回边标记）', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const result = await adapter.broadcast(context(router), signed, {
      rebroadcast: true,
      idempotencyKey: 'idem-key-12345678',
    });
    expect(result.rebroadcast).toBe(true);
    // 幂等键是上层语义：Adapter 不得把它塞进 JSON-RPC 参数（那会泄漏到链上请求）。
    const send = calls.find((c) => c.method === 'eth_sendRawTransaction');
    expect(send?.params).toEqual([signed.signedPayload]);
  });

  it('广播前后不改变 from 语义：载荷确实由该账户签出（C01 绑定同一真值）', async () => {
    const { parseSignedTransaction } = await import('@dfr/adapter-evm');
    const { privateKeyToAddress } = await import('viem/accounts');
    const signed = await makeSigned();
    const parsed = await parseSignedTransaction(SEPOLIA, signed.signedPayload);
    expect(parsed.from.address).toBe(privateKeyToAddress(TEST_KEY).toLowerCase());
    expect(parsed.txHash).toBe(signed.expectedHash);
  });
});
