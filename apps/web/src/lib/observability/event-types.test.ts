import { describe, expect, it } from "vitest"

import { HARNESS_EVENT_TYPES, assertSafeEventPayload, createHarnessEvent } from "./event-types"
import { createRootTraceContext } from "./trace-context"

function payloadFor(eventType: (typeof HARNESS_EVENT_TYPES)[number]) {
  if (eventType === "session.started") return { entryPoint: "chat" as const, harnessVersion: "2.0" as const }
  if (eventType === "session.completed") return { status: "completed" as const, durationMs: 120, finalTurnCount: 1 }
  if (eventType === "turn.queued") return { queueName: "agent" as const, queueWaitMs: 10 }
  if (eventType === "turn.started") return { turnIndex: 0, mode: "normal" as const }
  if (eventType === "turn.completed") return { status: "completed" as const, durationMs: 120, stepCount: 2 }
  if (eventType === "turn.failed") return { failureCode: "provider_timeout" as const, retryable: true, durationMs: 120 }
  if (eventType === "turn.recovered") return { recoveryCode: "retry" as const, attempt: 1, durationMs: 120 }
  if (eventType === "tool.invoked") return { toolName: "jobs.search" as const, toolVersion: "1", approvalRequired: false }
  if (eventType === "tool.completed") return { toolName: "jobs.search" as const, toolVersion: "1", durationMs: 120, status: "completed" as const }
  if (eventType === "tool.failed") return { toolName: "jobs.search" as const, toolVersion: "1", failureCode: "provider_timeout" as const, retryable: true, durationMs: 120 }
  if (eventType === "approval.requested") return { approvalScope: "submission" as const, toolName: "browser.submit", expiresAt: "2026-01-01T00:00:00.000Z" }
  if (eventType === "approval.granted") return { approvalScope: "submission" as const, toolName: "browser.submit", decisionAgeMs: 10 }
  if (eventType === "approval.denied") return { approvalScope: "submission" as const, toolName: "browser.submit", decisionAgeMs: 10, reasonCode: "policy_denied" as const }
  if (eventType === "approval.expired") return { approvalScope: "submission" as const, toolName: "browser.submit", ageMs: 300_000 }
  if (eventType === "artifact.created") return { artifactType: "resume" as const, artifactVersion: 1, contentHash: "a".repeat(64) }
  if (eventType === "artifact.updated") return { artifactType: "resume" as const, artifactVersion: 2, contentHash: "b".repeat(64), previousHash: "a".repeat(64) }
  if (eventType === "submission.attempted") return { atsType: "greenhouse" as const, flowVersion: "1", preflightStatus: "pass" as const }
  if (eventType === "submission.completed") return { atsType: "greenhouse" as const, flowVersion: "1", durationMs: 120, resultCode: "accepted" as const }
  if (eventType === "submission.failed") return { atsType: "greenhouse" as const, flowVersion: "1", failureCode: "captcha_detected" as const, retryable: false, durationMs: 120 }
  if (eventType === "cost.charged") return { costMicros: 20, inputTokens: 10, outputTokens: 5, unit: "request" as const, chargeType: "platform" as const }
  return { queueName: "agent" as const, depth: 3, oldestAgeMs: 100, sampledAt: "2026-01-01T00:00:00.000Z" }
}

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
      payload: payloadFor(eventType),
      occurredAt: "2026-01-01T00:00:00.000Z",
      eventId: `event-${eventType}`,
    })
    expect(event.eventType).toBe(eventType)
    expect(event.traceId).toBe("trace-1")
    expect(event.parentSpanId).toBe("parent-1")
    expect(event.schemaVersion).toBe("harness-event.v1")
    expect(event.correlationId).toBe(`${eventType}:trace-1`)
    expect((event.payload as { email?: unknown }).email).toBeUndefined()
    expect((event.payload as { text?: unknown }).text).toBeUndefined()
    expect((event.payload as { ip?: unknown }).ip).toBeUndefined()
  })

  it("rejects sensitive and unknown payload keys at runtime", () => {
    expect(() => assertSafeEventPayload({ email: "candidate@example.com" })).toThrow()
    expect(() => assertSafeEventPayload({ text: "raw user prompt" })).toThrow()
    expect(() => assertSafeEventPayload({ ip: "192.0.2.1" })).toThrow()
    expect(() => assertSafeEventPayload({ arbitrary: "value" })).toThrow()
    expect(() => createHarnessEvent({ eventType: "session.started", sessionId: "session-1", trace: createRootTraceContext(), payload: { costMicros: 1 } })).toThrow()
  })

  it("does not serialize user content through the event factory", () => {
    const event = createHarnessEvent({
      eventType: "session.started",
      sessionId: "session-1",
      trace: createRootTraceContext(() => "fixed"),
      payload: { entryPoint: "chat" },
      eventId: "event-1",
    })
    expect(JSON.stringify(event)).not.toMatch(/email|text|ip/i)
  })
})
