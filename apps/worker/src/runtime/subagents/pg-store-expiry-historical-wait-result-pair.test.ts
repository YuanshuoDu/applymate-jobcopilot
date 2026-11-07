import { describe, expect, it } from "vitest"
import {
  CHILD_WAIT_RESULT_EVENTS_QUERY_SQL,
  diagnoseWaitResultPair,
  isCanonicalWaitResultPair,
  partitionWaitResultEvents,
} from "./pg-store-expiry-historical-wait-result-pair.js"

const resultItemId = "task:task-1:item:tool-result:call-1:attempt:2"
const stepId = "task:task-1:step:4:attempt:2"
const content = { toolCallId: "call-1", output: { status: "waiting" }, errorCode: null }
const terminal = { id: "call-finished", sequence: "10", type: "tool_call.completed" }
const started = { id: "result-started", sequence: "11", type: "item.started", actor: "subagent", itemId: resultItemId,
  correlationId: stepId, causationId: terminal.id, idempotencyKey: `task:task-1:event:item-started:${resultItemId}`,
  payload: { itemId: resultItemId, type: "tool_result", phase: null } }
const completed = { id: "result-completed", sequence: "12", type: "item.completed", actor: "subagent", itemId: resultItemId,
  correlationId: resultItemId, causationId: started.id,
  idempotencyKey: `task:task-1:event:tool-result-completed:call-1:${resultItemId}:1`,
  payload: { itemId: resultItemId, status: "completed", content } }
const keys = [started.idempotencyKey, completed.idempotencyKey]

describe("historical wait result-pair diagnostics", () => {
  it("shares the bounded production event filter", () => {
    expect(CHILD_WAIT_RESULT_EVENTS_QUERY_SQL).toContain('("itemId" = $4 OR "correlationId" = $4 OR "idempotencyKey" = ANY($5::text[])')
    expect(CHILD_WAIT_RESULT_EVENTS_QUERY_SQL).toContain('"causationId" IN (SELECT anchor."id" FROM "agent_events" AS anchor')
    expect(CHILD_WAIT_RESULT_EVENTS_QUERY_SQL).toContain('ORDER BY "sequence" LIMIT 4')
  })

  it("accepts the same unique canonical pair and returns only bounded checks", () => {
    const extra = { id: "step-completed", idempotencyKey: "step-completed-key" }
    const rows = [started, completed, extra]
    expect(partitionWaitResultEvents(rows, keys)).toEqual({ started, completed, extra })
    const diagnostic = diagnoseWaitResultPair(rows, keys, terminal, resultItemId, stepId, content)
    expect(diagnostic).toEqual({ eventCount: 3, startedKeyMatches: 1, completedKeyMatches: 1,
      otherKeyMatches: 1, partitionValid: true, canonicalPairValid: true, eventIdsValid: true, startedIdentity: true, completedIdentity: true,
      startedPayload: true, completedPayload: true, startedCausation: true, completedCausation: true, numericOrder: true })
    expect(isCanonicalWaitResultPair(terminal, started, completed, resultItemId, stepId, content)).toBe(true)
    expect(JSON.stringify(diagnostic)).not.toContain(resultItemId)
    expect(JSON.stringify(diagnostic)).not.toContain("waiting")
  })

  it("accepts event IDs composed by the child writer beyond the protocol text bound", () => {
    const taskId = "subagent-12345678-1234-4234-9234-123456789abc"
    const callId = "c".repeat(256), attempt = 2_147_483_647, revision = 1
    const itemId = `task:${taskId}:item:tool-result:${callId}:attempt:${attempt}`
    const sourceStepId = `task:${taskId}:step:0:attempt:${attempt}`
    const terminalEvent = { id: `task:${taskId}:event:tool-finished:${callId}:attempt:${attempt}`,
      sequence: "10", type: "tool_call.completed" }
    const startedEvent = { ...started, id: `task:${taskId}:event:item-started:${itemId}:attempt:${attempt}`,
      itemId, correlationId: sourceStepId, causationId: terminalEvent.id,
      idempotencyKey: `task:${taskId}:event:item-started:${itemId}`,
      payload: { itemId, type: "tool_result", phase: null } }
    const completedEvent = { ...completed,
      id: `task:${taskId}:event:tool-result-completed:${callId}:${itemId}:${revision}:attempt:${attempt}`,
      itemId, correlationId: itemId, causationId: startedEvent.id,
      idempotencyKey: `task:${taskId}:event:tool-result-completed:${callId}:${itemId}:${revision}`,
      payload: { itemId, status: "completed", content: { toolCallId: callId, output: { status: "waiting" }, errorCode: null } } }
    const longContent = { toolCallId: callId, output: { status: "waiting" }, errorCode: null }
    expect(completedEvent.id.length).toBe(700)
    expect(itemId.length).toBe(343)
    expect(isCanonicalWaitResultPair(terminalEvent, startedEvent, completedEvent, itemId, sourceStepId, longContent)).toBe(true)
  })

  it("rejects over-limit and duplicate persisted event IDs", () => {
    const overLimit = { ...completed, id: "e".repeat(1025) }
    const duplicate = { ...completed, id: started.id }
    expect(diagnoseWaitResultPair([started, overLimit], keys, terminal, resultItemId, stepId, content).eventIdsValid).toBe(false)
    expect(isCanonicalWaitResultPair(terminal, started, overLimit, resultItemId, stepId, content)).toBe(false)
    expect(isCanonicalWaitResultPair(terminal, started, duplicate, resultItemId, stepId, content)).toBe(false)
    expect(isCanonicalWaitResultPair(terminal, started, { ...completed, id: " padded " }, resultItemId, stepId, content)).toBe(false)
    expect(isCanonicalWaitResultPair(terminal, started, { ...completed, id: "" }, resultItemId, stepId, content)).toBe(false)
  })

  it("distinguishes an event partition count/uniqueness failure", () => {
    const result = diagnoseWaitResultPair([started, { ...started, id: "duplicate-start" }, completed], keys,
      terminal, resultItemId, stepId, content)
    expect(result).toMatchObject({ eventCount: 3, startedKeyMatches: 2,
      completedKeyMatches: 1, otherKeyMatches: 0, partitionValid: false, canonicalPairValid: false })
    expect(partitionWaitResultEvents([started, { ...started, id: "duplicate-start" }, completed], keys)).toBeNull()
  })

  it("short-circuits canonical validation after an early malformed identity", () => {
    let readLaterField = false
    const malformedStarted = { id: started.id, type: started.type, actor: "user", itemId: resultItemId, correlationId: stepId,
      get causationId() { readLaterField = true; throw new Error("unexpected_late_field_read") },
      get payload() { readLaterField = true; throw new Error("unexpected_late_field_read") },
      get sequence() { readLaterField = true; throw new Error("unexpected_late_field_read") } }
    expect(isCanonicalWaitResultPair(terminal, malformedStarted, completed, resultItemId, stepId, content)).toBe(false)
    expect(readLaterField).toBe(false)
  })

  it.each([
    ["started identity", { ...started, actor: "user" }, completed, { startedIdentity: false }],
    ["completed identity", started, { ...completed, correlationId: "other-result" }, { completedIdentity: false }],
    ["started payload", { ...started, payload: { ...started.payload, phase: "commentary" } }, completed, { startedPayload: false }],
    ["completed payload", started, { ...completed, payload: { ...completed.payload, status: "failed" } }, { completedPayload: false }],
    ["started causation", { ...started, causationId: "detached" }, completed, { startedCausation: false }],
    ["completed causation", started, { ...completed, causationId: "detached" }, { completedCausation: false }],
    ["numeric order", { ...started, sequence: "13" }, completed, { numericOrder: false }],
  ])("reports only the failed %s check", (_label, changedStart, changedComplete, expected) => {
    const result = diagnoseWaitResultPair([changedStart, changedComplete], keys, terminal, resultItemId, stepId, content)
    expect(result).toMatchObject({ partitionValid: true, canonicalPairValid: false, ...expected })
  })
})
