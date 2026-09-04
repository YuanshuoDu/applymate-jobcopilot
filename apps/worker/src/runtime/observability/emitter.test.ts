import { describe, expect, it, vi } from "vitest"

import { createWorkerObservabilityEmitter } from "./emitter.js"
import { createTraceContext } from "./trace-context.js"
import { HARNESS_EVENT_TYPES, ObservabilityValidationError, type WorkerObservabilityEvent } from "./types.js"

describe("Worker observability emitter", () => {
  it("emits every AH2-050 event with trace lineage, persistence, and metric sync", async () => {
    const stored: WorkerObservabilityEvent[] = []
    const store = { write: vi.fn(async (event: WorkerObservabilityEvent) => { stored.push(event) }) }
    const synchronizeMetric = vi.fn()
    const emitter = createWorkerObservabilityEmitter({
      store,
      synchronizeMetric,
      clock: () => new Date("2026-09-04T12:00:00.000Z"),
      idFactory: (() => { let count = 0; return () => `event-${++count}` })(),
    })
    const trace = createTraceContext({ traceId: "trace-1", spanId: "span-1" })

    for (const eventType of HARNESS_EVENT_TYPES) {
      const result = await emitter.emit({
        eventType,
        trace,
        userId: "user-1",
        sessionId: "session-1",
        turnId: "turn-1",
        taskId: "task-1",
        model: "MiniMax-M3",
        toolName: eventType.startsWith("tool.") ? "job_search" : null,
        status: "completed",
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.001,
        latencyMs: 120,
        queueDepth: eventType === "queue.depth" ? 3 : undefined,
        payload: {},
      })
      expect(result.persisted).toBe(true)
      expect(result.metricSynchronized).toBe(true)
    }

    expect(stored).toHaveLength(HARNESS_EVENT_TYPES.length)
    expect(synchronizeMetric).toHaveBeenCalledTimes(HARNESS_EVENT_TYPES.length)
    expect(stored.every(event => event.traceId === "trace-1" && event.parentSpanId === null)).toBe(true)
    expect(JSON.stringify(stored)).not.toContain("email")
    expect(JSON.stringify(stored)).not.toContain("text")
    expect(JSON.stringify(stored)).not.toContain("clientIp")
  })

  it("continues after best-effort sink failures and reports them", async () => {
    const onError = vi.fn()
    const emitter = createWorkerObservabilityEmitter({
      store: { write: vi.fn().mockRejectedValue(new Error("database unavailable")) },
      synchronizeMetric: vi.fn().mockRejectedValue(new Error("metric unavailable")),
      onError,
    })
    const result = await emitter.emit({ eventType: "turn.failed", trace: createTraceContext(), payload: { failureCode: "provider_error" } })
    expect(result).toMatchObject({ persisted: false, metricSynchronized: false })
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it("does not send malformed or PII-bearing input to either sink", async () => {
    const store = { write: vi.fn() }
    const synchronizeMetric = vi.fn()
    const emitter = createWorkerObservabilityEmitter({ store, synchronizeMetric })
    await expect(emitter.emit({ eventType: "turn.started", trace: createTraceContext(), payload: { email: "candidate@example.com" } })).rejects.toThrow(ObservabilityValidationError)
    await expect(emitter.emit({ eventType: "turn.started", trace: createTraceContext(), latencyMs: -1 })).rejects.toThrow(ObservabilityValidationError)
    expect(store.write).not.toHaveBeenCalled()
    expect(synchronizeMetric).not.toHaveBeenCalled()
  })
})
