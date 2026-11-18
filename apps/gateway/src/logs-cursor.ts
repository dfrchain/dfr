/**
 * Log cursor pagination (developer-product follow-up).
 *
 * Why: `POST /v1/logs` used to truncate silently when `limit` was set, and the only workaround
 * was client-side block windowing. Reconciliation consumers need a server-issued continuation
 * that cannot skip or duplicate logs — including several logs in the same block.
 *
 * Design (deliberately small and stateless):
 * - The cursor is an opaque, base64url-encoded `{v, chain, range, filter, afterBlock, afterIndex}`.
 *   It is **not signed** and must not be constructed by clients; tampering can only change the
 *   caller's own query, never its scope (chain authorization is still enforced from `?chain=`).
 * - The Gateway fetches the (already maxBlockRange-bounded) range, sorts by
 *   `(blockNumber, logIndex)`, and returns the page plus a cursor positioned at the last returned
 *   log. This keeps the Adapter/Core contract unchanged.
 * - The cursor carries its own range and filter, so a resume request only sends `{cursor, limit?}`;
 *   mixing a cursor with range/filter fields is rejected to avoid ambiguity.
 */
import { createDfrError } from '@dfr/errors';
import type { ChainLog, ContractLogsRequest, DecimalUint, RequestId } from '@dfr/types';

export interface LogsCursorState {
  readonly chain: string;
  readonly fromBlock: DecimalUint;
  readonly toBlock: DecimalUint;
  readonly address?: string;
  readonly topics?: ContractLogsRequest['topics'];
  readonly afterBlock: DecimalUint;
  readonly afterIndex: DecimalUint;
}

export interface LogPosition {
  readonly block: bigint;
  readonly index: bigint;
}

const MAX_CURSOR_LENGTH = 8_192;
const DECIMAL_RE = /^[0-9]+$/u;

export function encodeLogsCursor(state: LogsCursorState): string {
  const payload: Record<string, unknown> = {
    v: 1,
    chain: state.chain,
    fromBlock: state.fromBlock,
    toBlock: state.toBlock,
    ...(state.address !== undefined ? { address: state.address } : {}),
    ...(state.topics !== undefined ? { topics: state.topics } : {}),
    afterBlock: state.afterBlock,
    afterIndex: state.afterIndex,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLogsCursor(value: string, requestId: RequestId): LogsCursorState {
  const invalid = (reason: string): never => {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: `Invalid logs cursor: ${reason}`,
      details: { fields: ['cursor'] },
    });
  };
  if (value === '' || value.length > MAX_CURSOR_LENGTH) invalid('length is out of range');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    invalid('not a base64url JSON payload');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('not an object');
  const raw = parsed as Record<string, unknown>;
  if (raw['v'] !== 1) invalid('unsupported version');
  const chain = raw['chain'];
  const fromBlock = raw['fromBlock'];
  const toBlock = raw['toBlock'];
  const afterBlock = raw['afterBlock'];
  const afterIndex = raw['afterIndex'];
  if (typeof chain !== 'string' || chain === '') invalid('missing chain');
  for (const [name, field] of [
    ['fromBlock', fromBlock],
    ['toBlock', toBlock],
    ['afterBlock', afterBlock],
    ['afterIndex', afterIndex],
  ] as const) {
    if (typeof field !== 'string' || !DECIMAL_RE.test(field)) invalid(`${name} must be a decimal string`);
  }
  const address = raw['address'];
  if (address !== undefined && typeof address !== 'string') invalid('address must be a string');
  const topics = raw['topics'];
  if (topics !== undefined && !Array.isArray(topics)) invalid('topics must be an array');
  return {
    chain: chain as string,
    fromBlock: fromBlock as DecimalUint,
    toBlock: toBlock as DecimalUint,
    ...(typeof address === 'string' ? { address } : {}),
    ...(Array.isArray(topics) ? { topics: topics as ContractLogsRequest['topics'] } : {}),
    afterBlock: afterBlock as DecimalUint,
    afterIndex: afterIndex as DecimalUint,
  };
}

/** Position of a log; `undefined` when the adapter did not supply an addressable block/index. */
export function logPosition(log: ChainLog): LogPosition | undefined {
  const ref = log.blockRef;
  if (ref === undefined || ref.kind !== 'number') return undefined;
  const index = log.index ?? '0';
  if (!DECIMAL_RE.test(ref.number) || !DECIMAL_RE.test(index)) return undefined;
  return { block: BigInt(ref.number), index: BigInt(index) };
}

function comparePositions(a: LogPosition | undefined, b: LogPosition | undefined): number {
  if (a === undefined || b === undefined) {
    if (a === b) return 0;
    return a === undefined ? 1 : -1;
  }
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  if (a.index !== b.index) return a.index < b.index ? -1 : 1;
  return 0;
}

/**
 * Sort ascending by `(blockNumber, logIndex)`. Unaddressable logs are kept last (and can never be
 * used to mint a cursor, so a paginated response fails closed instead of skipping them).
 */
export function sortChainLogs(logs: readonly ChainLog[]): readonly ChainLog[] {
  return [...logs].sort((left, right) => comparePositions(logPosition(left), logPosition(right)));
}

function isAfter(position: LogPosition, after: LogPosition): boolean {
  if (position.block !== after.block) return position.block > after.block;
  return position.index > after.index;
}

/** Drop logs at or before the cursor position (the cursor points at the last delivered log). */
export function logsAfter(logs: readonly ChainLog[], after: LogPosition): readonly ChainLog[] {
  return logs.filter((log) => {
    const position = logPosition(log);
    // Unaddressable logs cannot be ordered against a cursor; excluding them would silently lose
    // data, so fail closed instead.
    if (position === undefined) {
      throw new Error('log has no addressable position; cursor pagination cannot continue safely');
    }
    return isAfter(position, after);
  });
}

/** Build the cursor positioned at the last log of the just-returned page. */
export function cursorAfterPage(
  state: Omit<LogsCursorState, 'afterBlock' | 'afterIndex'>,
  lastLog: ChainLog,
  requestId: RequestId,
): string {
  const position = logPosition(lastLog);
  if (position === undefined) {
    throw createDfrError('DFR_INTERNAL_ERROR', {
      requestId,
      message: 'Cannot paginate logs: the last log has no addressable block/index',
    });
  }
  return encodeLogsCursor({
    ...state,
    afterBlock: position.block.toString(10) as DecimalUint,
    afterIndex: position.index.toString(10) as DecimalUint,
  });
}
