import { describe, expect, it } from "vitest"

import { HARNESS_EVENT_TYPES, assertSafeEventPayload, createHarnessEvent } from "./event-types"
import { createRootTraceContext } from "./trace-context"

describe("Harness event taxonomy and emission", () => {
  it("contains exactly the 21 locked event types", () => {
    expect(HARNESS_EVENT_TYPES).toHaveLength(21)
    expect(new Set(HARNESS_EVENT_TYPES).size).toBe(21)
  })

  it.each(HARNESS_EVENT_TYPES)("emits %s with complete trace context", (eventType) => {
    const event = createHarnessEvent({
      eventType,
      sessionId: "session-1",
      userId: "user-opaque-1",
      trace: { traceId: "trace-1", spanId: `span-${eventType}`, parentSpanId: "parent-1" },
      payload: { model: "MiniMax-M3", inputTokens: 10, outputTokens: 4, costMicros: 1 },
      occurredAt: "2026-01-01T00:00:00.000Z",
      eventId: `event-${eventType}`,
    })
    expect(event.eventType).toBe(eventType)
    expect(event.traceId).toBe("trace-1")
    expect(event.parentSpanId).toBe("parent-1")
    expect((event.payload as { email?: unknown }).email).toBeUndefined()
    expect((event.payload as { text?: unknown }).text).toBeUndefined()
    expect((event.payload as { ip?: unknown }).ip).toBeUndefined()
  })

  it("rejects sensitive and unknown payload keys at runtime", () => {
    expect(() => assertSafeEventPayload({ email: "candidate@example.com" })).toThrow()
    expect(() => assertSafeEventPayload({ text: "raw user prompt" })).toThrow()
    expect(() => assertSafeEventPayload({ ip: "192.0.2.1" })).toThrow()
    expect(() => assertSafeEventPayload({ arbitrary: "value" })).toThrow()
  })

  it("does not serialize user content through the event factory", () => {
    const event = createHarnessEvent({
      eventType: "session.started",
      sessionId: "session-1",
      trace: createRootTraceContext(() => "fixed"),
      payload: { operation: "chat" },
      eventId: "event-1",
    })
    expect(JSON.stringify(event)).not.toMatch(/email|text|ip/i)
  })
})
