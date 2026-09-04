import { describe, expect, it, vi } from "vitest"

import { persistHarnessEvent, type HarnessEventPersistenceClient } from "./event-store"
import { createHarnessEvent } from "./event-types"

function costEvent() {
  return createHarnessEvent({
    eventType: "cost.charged",
    sessionId: "session-1",
    turnId: "turn-1",
    toolName: "jobs.search",
    provider: "minimax",
    model: "MiniMax-M3",
    userId: "user-1",
    trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: "turn-span" },
    payload: { costMicros: 20, inputTokens: 10, outputTokens: 5, unit: "request", chargeType: "platform" },
    occurredAt: "2026-01-01T00:01:00.000Z",
    eventId: "event-1",
  })
}

function client(): HarnessEventPersistenceClient {
  return {
    harnessMetricEvent: { create: vi.fn().mockResolvedValue({}) },
    usageEvent: { upsert: vi.fn().mockResolvedValue({}) },
  }
}

describe("Harness event persistence", () => {
  it("persists a cost leaf and synchronizes one five-minute rollup", async () => {
    const fake = client()
    const result = await persistHarnessEvent(costEvent(), fake)
    expect(result).toEqual({ inserted: true, usageRolledUp: true })
    expect(fake.harnessMetricEvent.create).toHaveBeenCalledOnce()
    expect(fake.usageEvent.upsert).toHaveBeenCalledOnce()
    expect(fake.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ aggregationKey: expect.any(String), eventCount: 1, costMicros: 20 }),
    }))
  })

  it("does not roll up a duplicate raw event", async () => {
    const fake = client()
    vi.mocked(fake.harnessMetricEvent.create).mockRejectedValueOnce({ code: "P2002" })
    const result = await persistHarnessEvent(costEvent(), fake)
    expect(result).toEqual({ inserted: false, usageRolledUp: false })
    expect(fake.usageEvent.upsert).not.toHaveBeenCalled()
  })

  it("stores non-cost lifecycle events without creating usage", async () => {
    const fake = client()
    const event = createHarnessEvent({
      eventType: "turn.completed",
      sessionId: "session-1",
      trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: null },
      payload: { status: "completed", durationMs: 120, stepCount: 2 },
      eventId: "event-turn-1",
    })
    await expect(persistHarnessEvent(event, fake)).resolves.toEqual({ inserted: true, usageRolledUp: false })
    expect(fake.usageEvent.upsert).not.toHaveBeenCalled()
  })
})
