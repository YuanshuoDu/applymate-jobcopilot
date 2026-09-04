import { describe, expect, it, vi } from "vitest"

import { PgObservabilityStore } from "./pg-store.js"
import { createTraceContext } from "./trace-context.js"
import type { WorkerObservabilityEvent } from "./types.js"

function event(): WorkerObservabilityEvent {
  return {
    id: "event-1",
    eventType: "cost.charged",
    schemaVersion: "harness-event.v1",
    correlationId: "cost.charged:trace-1",
    traceId: "trace-1",
    spanId: "span-2",
    parentSpanId: "span-1",
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    taskId: "task-1",
    itemId: null,
    toolCallId: null,
    applicationTaskId: null,
    jobId: null,
    automationId: null,
    queueJobId: null,
    provider: "minimax",
    model: "MiniMax-M3",
    toolName: "job_search",
    source: "worker",
    environment: "unknown",
    status: "completed",
    errorCode: null,
    value: 0.001,
    durationMs: 120,
    inputTokens: 10,
    outputTokens: 4,
    costMicros: 1000,
    estimatedCostUsd: 0.001,
    latencyMs: 120,
    queueDepth: null,
    payload: { costMicros: 1000, inputTokens: 10, outputTokens: 4, unit: "request", chargeType: "platform" },
    idempotencyKey: "cost:session-1:span-2",
    occurredAt: new Date("2026-09-04T12:00:00.000Z"),
  }
}

describe("PgObservabilityStore", () => {
  it("uses parameterized SQL and writes only safe operational fields", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 })
    const store = new PgObservabilityStore({ query })
    await store.write(event())
    expect(query).toHaveBeenCalledTimes(2)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO "harness_metric_events"')
    expect(sql).toContain("$32::jsonb")
    expect(sql).toContain("ON CONFLICT DO NOTHING")
    expect(values).toEqual([
      "event-1", "cost.charged", "harness-event.v1", "cost.charged:trace-1", "trace-1", "span-2", "span-1", "user-1", "session-1", "turn-1", "task-1", null, null, null, null, null, null, "job_search", "minimax", "MiniMax-M3", "worker", "unknown", "cost:session-1:span-2", "completed", null, 0.001, 120, 10, 4, 1000, 0.001,
      JSON.stringify({ costMicros: 1000, inputTokens: 10, outputTokens: 4, unit: "request", chargeType: "platform" }), new Date("2026-09-04T12:00:00.000Z"),
    ])
    expect(query.mock.calls[1][0]).toContain('INSERT INTO "usage_event"')
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT ("aggregation_key") DO UPDATE')
    expect(JSON.stringify(values)).not.toContain("candidate@example.com")
    expect(JSON.stringify(values)).not.toContain("raw application text")
    expect(JSON.stringify(values)).not.toContain("192.0.2.10")
  })

  it("propagates database errors to the best-effort emitter boundary", async () => {
    const store = new PgObservabilityStore({ query: vi.fn().mockRejectedValue(new Error("connection refused")) })
    await expect(store.write(event())).rejects.toThrow("connection refused")
  })

  it("does not require a Prisma runtime", () => {
    expect(createTraceContext({ traceId: "trace-1", spanId: "span-1" }).parentSpanId).toBeNull()
  })
})
