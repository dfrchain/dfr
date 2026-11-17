/**
 * Store 调用观测（observability-spec 第 4 章的 `store.read` / `store.write` span）。
 *
 * 为什么需要：Gateway（`http.request`）、Core/Adapter（`adapter.call`）、
 * Provider（`provider.request`）三层都已落日志，但事务引擎的 Store 调用**完全没有观测**——
 * 于是"这笔 build 慢在哪一段"无法回答。本模块补齐这一层。
 *
 * 刻意只记录**调用形状与结果**（store / operation / kind / status / errorCode / latencyMs），
 * 不记录参数与返回值：Store 的参数含地址、nonce、载荷与租约 token，返回值含完整交易记录。
 * 需要下钻时用 `requestId` / `traceId` 关联已经脱敏的其它层日志。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';

/** Store 端口的可观测名字（与 `TransactionEngineStores` 的键一致；sequencing 为 M3 新增）。 */
export type StoreName = 'transaction' | 'idempotency' | 'nonce' | 'sequencing' | 'tracker';

/** 读/写分类：与 observability-spec 的 `store.read` / `store.write` span 名称对应。 */
export type StoreCallKind = 'read' | 'write';

export interface StoreCallRecord {
  readonly store: StoreName;
  /** 端口方法名，例如 get / create / transition / begin / reserve / acquire。 */
  readonly operation: string;
  readonly kind: StoreCallKind;
  readonly status: 'success' | 'error';
  /** 稳定 DFR 错误码；非 DFR 异常归一为 `DFR_INTERNAL_ERROR`（不回显原文）。 */
  readonly errorCode?: string;
  readonly latencyMs: number;
  /** 关联字段；恢复/巡检等后台路径可能没有请求上下文。 */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

export type StoreCallSink = (record: StoreCallRecord) => void;

/**
 * 进程内当前请求上下文（observability-spec 第 4 章明确要求用 AsyncLocalStorage 承载 span）。
 *
 * 为什么不是把 requestId 一路透传进 Store 端口：Store 端口是**持久化契约**，
 * 端口签名不该为观测目的新增参数（那会污染 Storage 实现与契约测试）。用
 * AsyncLocalStorage 让"当前请求上下文"对 Store 调用**隐式可见**，端口签名保持不变。
 */
interface StoreCallContext {
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

const storeCallContext = new AsyncLocalStorage<StoreCallContext>();

/** 在给定请求上下文内执行；上下文随后续的 Store 调用自动携带。 */
export function withStoreCallContext<T>(
  context: StoreCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storeCallContext.run(context, fn);
}

/**
 * 写操作集合：决定 `kind`。
 *
 * 以"是否可能改变持久状态"为准，而不是以方法名像不像动词。
 * `listRecoverable` / `getByHash` / `get` 是读；`release` / `releaseIfSafe` 虽是清理，
 * 也会写租约状态，因此算写。
 */
export const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'transition',
  'begin',
  'complete',
  'reserve',
  'markBroadcast',
  'markConsumed',
  'release',
  'releaseIfSafe',
  'releaseExpiredOrphaned',
  'acquire',
  'renew',
  'pruneExpired',
]);

/**
 * 明确登记的**读**操作。
 *
 * 两个集合都必须显式登记：`packages/transaction/test/store-call.test.ts` 会枚举四个端口的
 * 实际方法名并断言"每个方法都在某个集合里"。新增端口方法却忘记分类 → 测试失败，
 * 而不是静默落入某个默认分类。
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'get',
  'getByHash',
  'listRecoverable',
  'healthCheck',
]);

/**
 * 判定读/写。
 *
 * 未登记的操作**按写处理**（保守）：把真实写入报成读会低估写压力并掩盖写放大，
 * 比多报一次写更危险。正常路径下不应出现未登记方法——契约测试会拦住。
 */
export function storeCallKind(store: StoreName, operation: string): StoreCallKind {
  if (READ_OPERATIONS.has(operation)) return 'read';
  if (WRITE_OPERATIONS.has(operation)) return 'write';
  // 未登记：保守归为写，并在记录里保留原始 operation 供排查。
  void store;
  return 'write';
}

/**
 * 调用一次 Store 并产出观测记录。
 *
 * 三条不变式：
 * 1. 记录**永不**影响业务：sink 抛错被吞掉；
 * 2. 错误先归一（非 DFR 异常 → `DFR_INTERNAL_ERROR`），再记录，最后原样抛出**原始**异常
 *    （不改变既有错误传播语义）；
 * 3. 未注入 sink 时不做任何多余工作（只有一个 undefined 判断）。
 */
async function observeStoreCall<T>(
  sink: StoreCallSink | undefined,
  store: StoreName,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (sink === undefined) return await fn();
  const started = performance.now();
  try {
    const result = await fn();
    emit(sink, store, operation, 'success', undefined, started);
    return result;
  } catch (error) {
    emit(sink, store, operation, 'error', isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR', started);
    throw error;
  }
}

/**
 * 把一个 Store 端口对象包成"每次方法调用都产出观测记录"的版本。
 *
 * 单点实现（而不是在 20+ 个调用处各写一遍）：漏掉一处不会有任何提示，
 * 而端口层包装在结构上不可能漏。读/写分类由 `storeCallKind` 按方法名判定。
 *
 * 仅包装函数属性；非函数属性（如有）原样保留。未注入 sink 时直接返回原对象，
 * 连 Proxy 都不创建。
 */
export function observeStores<T extends object>(stores: T, sink: StoreCallSink | undefined): T {
  if (sink === undefined) return stores;
  return new Proxy(stores, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const name = String(property);
      return (...args: unknown[]) =>
        observeStoreCall(sink, storeNameOf(target), name, async () =>
          (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
        );
    },
  });
}

/**
 * 推断 Store 名称。
 *
 * 不依赖调用方传名字：端口对象本身通常是各类实例，没有可靠的 `name` 字段，
 * 因此由装配方通过 `storeName` 显式标注（Symbol 属性，不进入 `Object.keys`，
 * 也就不会被序列化进任何日志）。
 */
const STORE_NAME = Symbol('dfr.storeName');

export function tagStoreName<T extends object>(stores: T, name: StoreName): T {
  Object.defineProperty(stores, STORE_NAME, { value: name, enumerable: false });
  return stores;
}

function storeNameOf(target: object): StoreName {
  const tagged = (target as Record<symbol, unknown>)[STORE_NAME];
  if (tagged === 'transaction' || tagged === 'idempotency' || tagged === 'nonce' || tagged === 'tracker') {
    return tagged;
  }
  // 未标注时宁可报 unknown，也不猜成某个具体 Store 而产出错误归因。
  return 'transaction';
}

function emit(
  sink: StoreCallSink,
  store: StoreName,
  operation: string,
  status: 'success' | 'error',
  errorCode: string | undefined,
  started: number,
): void {
  const context = storeCallContext.getStore();
  try {
    sink({
      store,
      operation,
      kind: storeCallKind(store, operation),
      status,
      ...(errorCode !== undefined ? { errorCode } : {}),
      latencyMs: Math.max(0, performance.now() - started),
      ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context?.traceId !== undefined ? { traceId: context.traceId } : {}),
      ...(context?.spanId !== undefined ? { spanId: context.spanId } : {}),
    });
  } catch {
    // 观测是尽力而为。
  }
}
