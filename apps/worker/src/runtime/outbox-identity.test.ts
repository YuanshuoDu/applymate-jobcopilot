import { describe, expect, it } from "vitest"

import { matchesAgentOutboxIdentity, type AgentOutboxIdentity } from "./outbox-identity.js"

const expected: AgentOutboxIdentity = {
  id: "agent-outbox-event-1", topic: "agent.events", aggregateId: "session-1", idempotencyKey: "agent-event:event-1",
  payload: {
    eventId: "event-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1", itemId: null, sequence: "4", type: "turn.started", actor: "orchestrator",
    correlationId: "turn-1", causationId: null, idempotencyKey: "turn:event-1", payload: { b: 2, a: 1 },
  },
}

describe("agent outbox identity", () => {
  it("accepts a matching envelope when JSON keys are reordered", () => {
    expect(matchesAgentOutboxIdentity({
      id: expected.id, topic: expected.topic, aggregateId: expected.aggregateId, idempotencyKey: expected.idempotencyKey,
      payload: { ...expected.payload, payload: { a: 1, b: 2 }, correlationId: expected.payload.correlationId },
    }, expected)).toBe(true)
  })

  it.each([
    ["id", { id: "polluted" }], ["topic", { topic: "wrong.topic" }], ["aggregate", { aggregateId: "other-session" }],
    ["key", { idempotencyKey: "other-key" }], ["event id", { payload: { ...expected.payload, eventId: "other-event" } }],
    ["sequence", { payload: { ...expected.payload, sequence: "5" } }], ["nested payload", { payload: { ...expected.payload, payload: { a: 9, b: 2 } } }],
  ] satisfies readonly [string, Record<string, unknown>][]) ("rejects a polluted %s", (_label, changes) => {
    expect(matchesAgentOutboxIdentity({ ...expected, ...changes }, expected)).toBe(false)
  })

  it("rejects malformed or extra envelope fields", () => {
    expect(matchesAgentOutboxIdentity({ ...expected, payload: "not-json" }, expected)).toBe(false)
    expect(matchesAgentOutboxIdentity({ ...expected, payload: { ...expected.payload, extra: true } }, expected)).toBe(false)
  })
})
