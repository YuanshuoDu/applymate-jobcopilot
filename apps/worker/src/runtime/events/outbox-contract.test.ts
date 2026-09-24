import { describe, expect, it } from "vitest"

import {
  matchesCanonicalAgentEvent,
  parseAgentEventOutboxPayload,
  toCanonicalAgentEvent,
  type AgentEventRow,
} from "./outbox-contract.js"

const canonicalRow: AgentEventRow = {
  id: "event-1", sessionId: "session-1", turnId: "turn-1", itemId: "item-1", taskId: "task-1", sequence: 7n,
  type: "item.completed", actor: "tool", correlationId: "turn-1", causationId: "step-1",
  idempotencyKey: "activity:event-1", payload: { operation: "list_subagents", status: "completed" },
  createdAt: "2026-09-22T10:00:00.000Z",
}

const mailboxEnvelope = {
  eventId: canonicalRow.id, sessionId: canonicalRow.sessionId, turnId: canonicalRow.turnId,
  itemId: canonicalRow.itemId, taskId: canonicalRow.taskId, type: canonicalRow.type,
}

const gmailEnvelope = {
  eventId: canonicalRow.id, sessionId: canonicalRow.sessionId, turnId: canonicalRow.turnId,
  type: canonicalRow.type, actor: canonicalRow.actor, idempotencyKey: canonicalRow.idempotencyKey,
  payload: canonicalRow.payload,
}

describe("agent event outbox contract", () => {
  it("accepts the sparse mailbox and Gmail envelopes while preserving provided fields", () => {
    expect(parseAgentEventOutboxPayload(mailboxEnvelope)).toEqual(mailboxEnvelope)
    expect(parseAgentEventOutboxPayload(gmailEnvelope)).toEqual(gmailEnvelope)
  })

  it("allows omitted turn scope in sparse envelopes but rejects an explicit null turn ID", () => {
    const withoutTurnId = { eventId: canonicalRow.id, sessionId: canonicalRow.sessionId }
    expect(parseAgentEventOutboxPayload(withoutTurnId)).toEqual(withoutTurnId)
    expect(parseAgentEventOutboxPayload({ ...mailboxEnvelope, turnId: null })).toBeNull()
  })

  it("rejects canonical event rows without a turn ID", () => {
    const row = { ...canonicalRow, turnId: null } as unknown as AgentEventRow
    expect(toCanonicalAgentEvent(row)).toBeNull()
  })

  it.each([
    ["unknown field", { ...mailboxEnvelope, extra: true }],
    ["missing event id", { sessionId: canonicalRow.sessionId }],
    ["empty session id", { eventId: canonicalRow.id, sessionId: "  " }],
    ["invalid actor", { ...gmailEnvelope, actor: "browser" }],
    ["invalid sequence", { ...mailboxEnvelope, sequence: "-1" }],
    ["invalid payload", { ...gmailEnvelope, payload: { unsupported: undefined } }],
  ])("rejects %s", (_label, value) => {
    expect(parseAgentEventOutboxPayload(value)).toBeNull()
  })

  it("rejects a canonical field mismatch while allowing omitted fields", () => {
    const canonical = toCanonicalAgentEvent(canonicalRow)
    if (!canonical) throw new Error("canonical event fixture should be valid")

    const sparse = parseAgentEventOutboxPayload(mailboxEnvelope)
    if (!sparse) throw new Error("mailbox envelope fixture should be valid")
    expect(matchesCanonicalAgentEvent(canonical, sparse)).toBe(true)
    expect(matchesCanonicalAgentEvent(canonical, { ...sparse, type: "item.failed" })).toBe(false)
    expect(matchesCanonicalAgentEvent(canonical, { ...sparse, sequence: "8" })).toBe(false)
  })
})
