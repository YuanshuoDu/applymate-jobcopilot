import { describe, expect, it } from "vitest"

import { validRootAcceptedInputPayload, validatedPayloadFields, type AgentEventPayloadGuards } from "./agent-redaction-event-payloads"
import type { AgentEventRoutingContext } from "./agent-event-routing"

const guards: AgentEventPayloadGuards = {
  record: (value): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null,
  opaqueId: (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value,
  nullableId: (value): value is string | null => value === null || typeof value === "string",
  validTimestamp: (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
  jsonValue: (value): value is import("@jobcopilot/agent-protocol").RepositoryJsonValue => value !== undefined,
  isNestedAgentItem: () => true,
}

const inputId = "12345678-1234-4abc-8abc-123456789012"
const turnId = "23456789-2345-4bcd-9bcd-234567890123"
const route: AgentEventRoutingContext = {
  sessionId: "34567890-3456-4cde-acde-345678901234", turnId, itemId: "45678901-4567-4def-8def-456789012345",
  taskId: null, actor: "user", correlationId: turnId, causationId: null, outboxTopic: "agent.session.event",
}
const payload = {
  inputId, clientMessageId: "caller-415-555-0100@example.test", delivery: "steer", source: "user", disposition: "steered",
}

describe("accepted input redaction contracts", () => {
  it("authorizes only the server input UUID for an exact root accepted event", () => {
    expect(validRootAcceptedInputPayload("input.accepted", payload, route, guards)).toBe(true)
    expect(validatedPayloadFields("input.accepted", payload, route, guards)).toEqual(["inputId"])
    expect(validRootAcceptedInputPayload("input.accepted", { ...payload, source: "automation" }, { ...route, actor: "system" }, guards)).toBe(true)
  })

  it("rejects malformed or non-root envelopes without preserving any input identity", () => {
    const cases: Array<{ payload: unknown; route: AgentEventRoutingContext }> = [
      { payload: { ...payload, extra: true }, route },
      { payload: { ...payload, inputId: "[REDACTED_PHONE]" }, route },
      { payload, route: { ...route, taskId: "task_1" } },
      { payload, route: { ...route, itemId: null } },
      { payload, route: { ...route, causationId: "event_1" } },
      { payload, route: { ...route, actor: "system" } },
      { payload: { ...payload, source: "automation" }, route },
      { payload: { ...payload, disposition: "unknown" }, route },
    ]
    for (const entry of cases) {
      expect(validRootAcceptedInputPayload("input.accepted", entry.payload, entry.route, guards)).toBe(false)
      const row = guards.record(entry.payload)
      expect(row && validatedPayloadFields("input.accepted", row, entry.route, guards)).toBeNull()
    }
    expect(validRootAcceptedInputPayload("task.updated", payload, route, guards)).toBe(false)
  })

  it("keeps the separate task-message input contract distinct", () => {
    const taskRoute = { ...route, taskId: "task_1" }
    const taskPayload = { messageId: "56789012-5678-4abc-8abc-567890123456", clientMessageId: "client_1", delivery: "follow_up", source: "user",
      disposition: "queued_follow_up", targetAttemptCount: 2, item: {} }
    expect(validRootAcceptedInputPayload("input.accepted", taskPayload, taskRoute, guards)).toBe(false)
    expect(validatedPayloadFields("input.accepted", taskPayload, taskRoute, guards)).toEqual(["messageId"])
  })
})
