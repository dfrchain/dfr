/**
 * @dfr/events — the in-process event bus (M2, ADR-006 / ADR-026).
 *
 * Explicit boundary: no persistence, no cross-restart; the authoritative source for event types is still `@dfr/types`.
 * SSE transport is not in this package (see ADR-029 and the Gateway-side implementation).
 */
export {
  EventBus,
  DEFAULT_REPLAY_CAPACITY,
  type EventBusOptions,
  type PublishInput,
  type Subscription,
  type ReplayResult,
} from './bus.js';
