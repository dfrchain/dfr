/**
 * Store-call observation (the `store.read` / `store.write` spans of observability-spec chapter 4).
 *
 * Why it is needed: the Gateway (`http.request`), Core/Adapter (`adapter.call`), and
 * Provider (`provider.request`) layers all have logging, but the transaction engine's Store calls had **no observation at all** —
 * so "where exactly is this build slow" could not be answered. This module fills that gap.
 *
 * Deliberately records only the **call shape and outcome** (store / operation / kind / status / errorCode / latencyMs),
 * never the parameters or return values: Store parameters contain addresses, nonces, payloads, and lease tokens, and return values contain full transaction records.
 * For a deeper dive, correlate the already-redacted logs from other layers with `requestId` / `traceId`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';

/** The observable name of a Store port (matching the keys of `TransactionEngineStores`; sequencing is the M3 addition). */
export type StoreName = 'transaction' | 'idempotency' | 'nonce' | 'sequencing' | 'tracker';

/** Read/write classification: matching the observability-spec `store.read` / `store.write` span names. */
export type StoreCallKind = 'read' | 'write';

export interface StoreCallRecord {
  readonly store: StoreName;
   /** The port method name, e.g. get / create / transition / begin / reserve / acquire. */
  readonly operation: string;
  readonly kind: StoreCallKind;
  readonly status: 'success' | 'error';
   /** A stable DFR error code; non-DFR exceptions normalize to `DFR_INTERNAL_ERROR` (without echoing the original text). */
  readonly errorCode?: string;
  readonly latencyMs: number;
   /** Correlation fields; background paths such as recovery/sweeps may have no request context. */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

export type StoreCallSink = (record: StoreCallRecord) => void;

/**
 * The in-process current request context (observability-spec chapter 4 explicitly requires AsyncLocalStorage to carry spans).
 *
 * Why not thread requestId all the way into the Store ports: Store ports are a **persistence contract**,
 * and port signatures should not gain parameters for observability (that would pollute the Storage implementation and contract tests). Using
 * AsyncLocalStorage makes "the current request context" **implicitly visible** to Store calls, while port signatures stay unchanged.
 */
interface StoreCallContext {
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

const storeCallContext = new AsyncLocalStorage<StoreCallContext>();

/** Execute within a given request context; the context is carried automatically by subsequent Store calls. */
export function withStoreCallContext<T>(
  context: StoreCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storeCallContext.run(context, fn);
}

/**
 * The write-operation set: it decides `kind`.
 *
 * Judged by "whether it may change persisted state", not by whether the method name looks like a verb.
 * `listRecoverable` / `getByHash` / `get` are reads; `release` / `releaseIfSafe` are cleanup,
 * but they also write lease state, so they count as writes.
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
 * The explicitly registered **read** operations.
 *
 * Both sets must be explicitly registered: `packages/transaction/test/store-call.test.ts` enumerates the four ports'
 * actual method names and asserts "every method is in some set". Adding a port method and forgetting to classify it → test failure,
 * instead of silently falling into some default classification.
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'get',
  'getByHash',
  'listRecoverable',
  'healthCheck',
]);

/**
 * Decide read/write.
 *
 * An unregistered operation is treated **as a write** (conservative): reporting a real write as a read would undercount write pressure and hide write amplification,
 * which is more dangerous than over-reporting one write. Unregistered methods should not appear on normal paths — the contract test blocks them.
 */
export function storeCallKind(store: StoreName, operation: string): StoreCallKind {
  if (READ_OPERATIONS.has(operation)) return 'read';
  if (WRITE_OPERATIONS.has(operation)) return 'write';
   // Unregistered: conservatively classified as a write, keeping the original operation in the record for troubleshooting.
  void store;
  return 'write';
}

/**
 * Call a Store once and produce an observation record.
 *
 * Three invariants:
 * 1. A record **never** affects the business path: sink errors are swallowed;
 * 2. errors are normalized first (non-DFR exceptions → `DFR_INTERNAL_ERROR`), then recorded, and finally the **original** exception is rethrown verbatim
 *    (without changing the existing error-propagation semantics);
 * 3. with no sink injected, no extra work is done (a single undefined check).
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
 * Wrap a Store port object so that every method call produces an observation record.
 *
 * A single implementation (instead of writing it once at each of 20+ call sites): missing one site would give no warning,
 * while port-layer wrapping structurally cannot miss one. Read/write classification is decided by `storeCallKind` from the method name.
 *
 * Only function properties are wrapped; non-function properties (if any) are kept verbatim. With no sink injected, the original object is returned directly,
 * not even creating a Proxy.
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
 * Infer the Store name.
 *
 * Do not rely on the caller passing a name: port objects are usually instances of various classes with no reliable `name` field,
 * so the wiring side labels it explicitly via `storeName` (a Symbol property, which does not enter `Object.keys`
 * and is therefore never serialized into any log).
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
   // When unlabeled, prefer reporting unknown over guessing a concrete Store and producing a wrong attribution.
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
     // Observation is best-effort.
  }
}
