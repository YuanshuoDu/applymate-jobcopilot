import { describe, expect, it } from "vitest"

import { validRootAcceptedInputPayload, validatedPayloadFields, type AgentEventPayloadGuards } from "./agent-redaction-event-payloads"
import type { AgentEventRoutingContext } from "./agent-event-routing"

const guards: AgentEventPayloadGuards = {
  record: (value): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null,
  opaqueId: (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value,
  nullableId: (value): value is string | null => value === null || typeof value === "string" && value.length > 0 && value.trim() === value,
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

describe("approval cancellation redaction contracts", () => {
  const approvalId = "approval_1"
  const itemId = `agent-wait:approval:${approvalId}`
  const cancellationRoute: AgentEventRoutingContext = {
    ...route,
    itemId,
    taskId: null,
    actor: "system",
    correlationId: approvalId,
    causationId: "interrupt_1",
    outboxTopic: "agent.session.event",
  }
  const cancellation = {
    waitKind: "approval",
    waitId: approvalId,
    itemId,
    turnId,
    toolCallId: null,
    outcome: "cancelled",
    reason: "interrupt",
  }

  it("preserves canonical cancellation IDs for null and task-bound routes", () => {
    for (const taskId of [null, "task_1"]) {
      expect(validatedPayloadFields("approval.resolved", cancellation, { ...cancellationRoute, taskId }, guards))
        .toEqual(["waitId", "itemId", "turnId", "toolCallId"])
    }
  })

  it("rejects malformed, extra, and route-mismatched cancellation fields", () => {
    const cases: Array<{ payload: Record<string, unknown>; route: AgentEventRoutingContext }> = [
      { payload: { ...cancellation, extra: true }, route: cancellationRoute },
      { payload: { ...cancellation, turnId: "foreign_turn" }, route: cancellationRoute },
      { payload: { ...cancellation, itemId: "agent-wait:approval:foreign_approval" }, route: cancellationRoute },
      { payload: { ...cancellation, outcome: "rejected" }, route: cancellationRoute },
      { payload: { ...cancellation, reason: "user" }, route: cancellationRoute },
      { payload: cancellation, route: { ...cancellationRoute, turnId: "foreign_turn" } },
      { payload: cancellation, route: { ...cancellationRoute, itemId: "agent-wait:approval:foreign_approval" } },
      { payload: cancellation, route: { ...cancellationRoute, correlationId: "foreign_approval" } },
      { payload: cancellation, route: { ...cancellationRoute, causationId: null } },
      { payload: cancellation, route: { ...cancellationRoute, actor: "user" } },
      { payload: cancellation, route: { ...cancellationRoute, outboxTopic: "agent.turn.wakeup" } },
      { payload: cancellation, route: { ...cancellationRoute, taskId: "" } },
    ]

    for (const entry of cases) {
      expect(validatedPayloadFields("approval.resolved", entry.payload, entry.route, guards)).toBeNull()
    }
    expect(validatedPayloadFields("task.updated", cancellation, cancellationRoute, guards)).toBeNull()
  })
})

describe("question cancellation redaction contracts", () => {
  const questionId = "question_1"
  const itemId = `agent-wait:question:${questionId}`
  const questionRoute: AgentEventRoutingContext = {
    ...route,
    itemId,
    taskId: null,
    actor: "system",
    correlationId: questionId,
    causationId: "interrupt_1",
    outboxTopic: "agent.session.event",
  }
  const cancellation = {
    waitKind: "question",
    waitId: questionId,
    itemId,
    toolCallId: null,
    outcome: "cancelled",
    reason: "interrupt",
  }

  it("preserves only canonical question cancellation identifiers", () => {
    expect(validatedPayloadFields("question.cancelled", cancellation, questionRoute, guards))
      .toEqual(["waitId", "itemId", "toolCallId"])
  })

  it("rejects extra, malformed, and route-mismatched question cancellation fields", () => {
    const cases: Array<{ payload: Record<string, unknown>; route: AgentEventRoutingContext }> = [
      { payload: { ...cancellation, turnId }, route: questionRoute },
      { payload: { ...cancellation, question: "private question" }, route: questionRoute },
      { payload: { ...cancellation, options: ["private option"] }, route: questionRoute },
      { payload: { ...cancellation, answer: "private answer" }, route: questionRoute },
      { payload: { ...cancellation, itemId: "agent-wait:question:foreign_question" }, route: questionRoute },
      { payload: { ...cancellation, outcome: "answered" }, route: questionRoute },
      { payload: cancellation, route: { ...questionRoute, taskId: "task_1" } },
      { payload: cancellation, route: { ...questionRoute, correlationId: "foreign_question" } },
      { payload: cancellation, route: { ...questionRoute, actor: "user" } },
      { payload: cancellation, route: { ...questionRoute, causationId: null } },
      { payload: cancellation, route: { ...questionRoute, outboxTopic: "agent.turn.wakeup" } },
    ]

    for (const entry of cases) {
      expect(validatedPayloadFields("question.cancelled", entry.payload, entry.route, guards)).toBeNull()
    }
  })
})
