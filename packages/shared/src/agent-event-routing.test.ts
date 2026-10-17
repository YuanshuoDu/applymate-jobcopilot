import { describe, expect, it } from "vitest"

import { redactAgentEvent, type AgentEventRoutingContext } from "./agent-redaction"

const sessionId = "70463535-1444-4bba-ae3b-b80578d2dd0b"
const turnId = "70463535-1444-4bba-ae3b-b80578d2dd0c"
const taskId = "task-70463535-1444-4bba-ae3b-b80578d2dd0a"
const intentId = "70463535-1444-4bba-ae3b-b80578d2dd0e"
const eventType = "task.interrupt.accepted"

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "agent-harness.v2", id: "70463535-1444-4bba-ae3b-b80578d2dd10", sessionId, turnId,
    itemId: null, taskId, sequence: "7046353541445", type: eventType, actor: "user", correlationId: turnId,
    causationId: null, idempotencyKey: `agent-task-interrupt-accepted:${sessionId}:interrupt_1`,
    payload: { intentId, taskId, status: "accepted" }, ...overrides,
  }
}

function redact(data: unknown): Record<string, unknown> {
  return redactAgentEvent({ type: eventType, body: "", data }).data as Record<string, unknown>
}

describe("task interrupt event routing projection", () => {
  it("preserves only the actual accepted event references through repeated full-envelope redaction", () => {
    const raw = envelope()
    const once = redact(raw)
    const twice = redact(once)

    expect(once).toMatchObject({ id: raw.id, sessionId, turnId, itemId: null, taskId, sequence: raw.sequence,
      type: eventType, actor: "user", correlationId: turnId, causationId: null, idempotencyKey: raw.idempotencyKey })
    expect(once.payload).toEqual({ intentId, taskId, status: "accepted" })
    expect(twice).toEqual(once)
  })

  it("preserves the same typed payload on the trusted fact-store writer path", () => {
    const routing: AgentEventRoutingContext = { sessionId, turnId, itemId: null, taskId, actor: "user",
      correlationId: turnId, causationId: null, outboxTopic: "agent.session.event" }
    const payload = { intentId, taskId, status: "accepted" }

    expect(redactAgentEvent({ type: eventType, body: "", data: payload, routing }).data).toEqual(payload)
  })

  it.each([
    ["actor", { actor: "orchestrator" }],
    ["task", { taskId: null }],
    ["item", { itemId: "task-item-70463535-1444-4bba-ae3b-b80578d2dd01" }],
    ["correlation", { correlationId: "70463535-1444-4bba-ae3b-b80578d2dd01" }],
    ["causation", { causationId: "70463535-1444-4bba-ae3b-b80578d2dd01" }],
  ])("does not restore accepted payload references when the outer %s tuple is wrong", (_name, override) => {
    const result = redact(envelope(override))
    expect(result.taskId).not.toBe(taskId)
    expect(result.payload).not.toEqual({ intentId, taskId, status: "accepted" })
  })

  it.each([
    ["unknown key", { intentId, taskId, status: "accepted", extra: "do not preserve" }],
    ["wrong status", { intentId, taskId, status: "failed" }],
    ["mismatched task binding", { intentId, taskId: "task-70463535-1444-4bba-ae3b-b80578d2dd11", status: "accepted" }],
    ["invalid intent", { intentId: "sk_test_private_secret_value", taskId, status: "accepted" }],
    ["invalid task", { intentId, taskId: "task-1234567890123", status: "accepted" }],
  ])("fails closed for an accepted payload with %s", (_name, payload) => {
    const result = redact(envelope({ payload }))
    expect(result.taskId).not.toBe(taskId)
    expect(result.payload).not.toEqual({ intentId, taskId, status: "accepted" })
    expect(JSON.stringify(result)).not.toContain("sk_test_private_secret_value")
  })

  it("does not preserve an unsafe caller idempotency key or an unknown event", () => {
    const privateKey = `agent-task-interrupt-accepted:${sessionId}:candidate@example.com`
    const result = redact(envelope({ idempotencyKey: privateKey }))
    expect(result.payload).toEqual({ intentId, taskId, status: "accepted" })
    expect(result.idempotencyKey).not.toBe(privateKey)
    expect(JSON.stringify(result)).not.toContain("candidate@example.com")

    const unknown = redactAgentEvent({ type: "task.interrupt.unknown", body: "", data: envelope() }).data as Record<string, unknown>
    expect((unknown.payload as Record<string, unknown>).taskId).not.toBe(taskId)
  })

  it("requires the trusted task-event topic for direct writer context", () => {
    const routing: AgentEventRoutingContext = { sessionId, turnId, itemId: null, taskId, actor: "user",
      correlationId: turnId, causationId: null, outboxTopic: "agent.turn.wakeup" }
    const payload = { intentId, taskId, status: "accepted" }

    const result = redactAgentEvent({ type: eventType, body: "", data: payload, routing }).data as Record<string, unknown>
    expect(result.taskId).not.toBe(taskId)
    expect(result.intentId).not.toBe(intentId)
  })
})
