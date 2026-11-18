// Span context and parent/child derivation (M5 E6).
// This is the core of E6: a child span's parent is **decided by the execution structure**, not guessed from timestamps or call order.
import { describe, expect, it } from 'vitest';
import {
  activeTraceId,
  childSpanContext,
  currentSpan,
  parentSpanId,
  runInSpan,
} from '../src/context.js';

  describe('With no context', () => {
    it('currentSpan / parentSpanId / activeTraceId are all undefined', () => {
    expect(currentSpan()).toBeUndefined();
    expect(parentSpanId()).toBeUndefined();
    expect(activeTraceId()).toBeUndefined();
  });

    it('childSpanContext starts a new trace, with no parent', () => {
    const { context, parentSpanId: parent } = childSpanContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(parent).toBeUndefined();
  });
});

  describe('Inside a span', () => {
    it('a child span inherits the trace, parent is the current span', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      expect(activeTraceId()).toBe(root.traceId);
      expect(parentSpanId()).toBe(root.spanId);
      const { context, parentSpanId: parent } = childSpanContext();
      expect(context.traceId).toBe(root.traceId);
      expect(context.spanId).not.toBe(root.spanId); // Independent spanId
      expect(parent).toBe(root.spanId);
    });
  });

    it('a two-level nesting\'s parent is the direct parent, not the root', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      const mid = childSpanContext().context;
      runInSpan(mid, () => {
        expect(parentSpanId()).toBe(mid.spanId);
        expect(parentSpanId()).not.toBe(root.spanId);
      });
    });
  });

    it('context is restored after leaving the span (no leak)', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      /* Leaving the scope */
    });
    expect(currentSpan()).toBeUndefined();
  });
});
