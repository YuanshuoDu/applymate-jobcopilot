import { describe, expect, it, vi } from "vitest"

import { queryHarnessTrace } from "./trace-query"

describe("Harness trace query", () => {
  it("returns ordered metadata without payload fields", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{
      eventId: "event-1", eventType: "turn.started", schemaVersion: "harness-event.v1",
      correlationId: "corr-1", traceId: "trace-1", spanId: "span-1", parentSpanId: null,
      sessionId: "session-1", turnId: "turn-1", taskId: null, itemId: null, toolCallId: null,
      applicationTaskId: null, jobId: null, automationId: null, queueJobId: null,
      toolName: null, provider: "minimax", model: "MiniMax-M3", occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    }])
    const result = await queryHarnessTrace({ traceId: "trace-1" }, { $queryRaw } as never)
    expect(result[0]).toMatchObject({ eventId: "event-1", traceId: "trace-1", occurredAt: "2026-01-01T00:00:00.000Z" })
    expect(result[0]).not.toHaveProperty("payload")
    expect($queryRaw).toHaveBeenCalledOnce()
  })

  it("rejects missing or PII-shaped identifiers before querying", async () => {
    const client = { $queryRaw: vi.fn() }
    await expect(queryHarnessTrace({}, client as never)).rejects.toThrow("traceId or sessionId is required")
    await expect(queryHarnessTrace({ traceId: "candidate@example.com" }, client as never)).rejects.toThrow()
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })
})
