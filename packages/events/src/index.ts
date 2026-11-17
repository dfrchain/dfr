/**
 * @dfr/events —— 进程内事件总线（M2，ADR-006 / ADR-026）。
 *
 * 明确边界：不持久化、不跨重启；事件类型权威来源仍是 `@dfr/types`。
 * SSE 传输不在本包（见 ADR-029 与 Gateway 侧实现）。
 */
export {
  EventBus,
  DEFAULT_REPLAY_CAPACITY,
  type EventBusOptions,
  type PublishInput,
  type Subscription,
  type ReplayResult,
} from './bus.js';
