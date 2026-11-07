import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { readCanonicalHistoricalSourceStepContinuationPrefix } from "./pg-store-expiry-historical-source-step-continuation-prefix.js"

const task = { id: "task-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", userId: "user-1",
  leaseOwner: "lease-1", attemptCount: 2, leaseExpiresAt: new Date("2026-11-07T00:00:00.000Z") }
const sourceStepId = "task:task-1:step:0:attempt:1", sourceCallId = "source-call", sourceCallItemId = "source-item"
const callInput = { idempotencyKey: "source-key", taskIds: ["child-1"], mode: "any", timeoutMs: 30_000 }
const continuationStepId = "task:task-1:step:1:attempt:2", continuationCallId = "claim-call"
const continuationItemId = `task:${task.id}:item:tool-call:${continuationCallId}:attempt:2`
type Event = Record<string, unknown> & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown; payloadDigest: string }

function fixture() {
  const events: Event[] = []
  let sequence = 0, previous: string | null = null
  const add = (type: string, key: string, correlationId: string, itemId: string | null, payload: unknown, cause: string | null = previous): Event => {
    const id = `event-${++sequence}`, row: Event = { id, sequence: String(sequence + 1), type, actor: "subagent", itemId,
      correlationId, causationId: cause, idempotencyKey: `task:${task.id}:event:${key}`, payload, payloadDigest: "a".repeat(64) }
    events.push(row); previous = id; return row
  }
  const sourceStart = { id: "source-start", sequence: "1", type: "step.started", actor: "subagent", itemId: null,
    correlationId: sourceStepId, causationId: null, idempotencyKey: `task:${task.id}:event:step-started:${sourceStepId}`,
    payload: { stepId: sourceStepId, ordinal: 0, taskId: task.id }, payloadDigest: "b".repeat(64) }
  const parent: Event & { sessionId: string; turnId: string; taskId: string } = { id: "turn-started", sequence: "1", type: "task.started",
    actor: "subagent", itemId: null, correlationId: task.turnId, causationId: null,
    idempotencyKey: `task:${task.id}:event:turn-started`, payload: { goal: "find work", taskId: task.id, rootTaskId: task.rootTaskId },
    payloadDigest: "d".repeat(64), sessionId: task.sessionId, turnId: task.turnId, taskId: task.id }
  const parentRows = [parent]
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: task.sessionId, turnId: task.turnId,
    stepId: continuationStepId, inputThroughSequence: 1n, consumedInputIds: [], blocks: [], canonicalJson: "{}" }
  const agenda = buildCognitiveAgendaReceipt({ sessionId: task.sessionId, turnId: task.turnId, taskId: task.id,
    stepId: continuationStepId, agenda: buildCognitiveActionAgenda(context) })
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(continuationStepId)
  if (!agenda || !agendaKey) throw new Error("fixture_agenda_invalid")
  const started = add("step.started", `step-started:${continuationStepId}`, continuationStepId, null,
    { stepId: continuationStepId, ordinal: 1, taskId: task.id }, parent.id)
  const agendaEvent = add("cognitive.agenda", agendaKey, continuationStepId, null, agenda, started.id)
  const modelStarted = add("model.started", `model-started:${continuationStepId}`, continuationStepId, null,
    { taskId: task.id, provider: "fixture", model: "test-model" }, agendaEvent.id)
  const modelCompleted = add("model.completed", `model-completed:${continuationStepId}`, continuationStepId, null,
    { taskId: task.id, provider: "fixture", model: "test-model", toolCallCount: 2 }, modelStarted.id)
  const usage = add("model.usage", `model-usage:${continuationStepId}`, continuationStepId, null,
    { taskId: task.id, provider: "fixture", model: "test-model", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } }, modelCompleted.id)
  const itemContent = { toolCallId: continuationCallId, toolName: "wait_subagents", toolVersion: "1", input: callInput }
  const itemStarted = add("item.started", `item-started:${continuationItemId}`, continuationStepId, continuationItemId,
    { itemId: continuationItemId, type: "tool_call", phase: null }, usage.id)
  const callStarted = add("tool_call.started", `child-wait-claim:2:${continuationStepId}`, continuationCallId, continuationItemId,
    { toolCallId: continuationCallId, toolName: "wait_subagents", taskId: task.id }, itemStarted.id)
  const sourceEnd = { id: "source-end", sequence: "9", type: "item.completed", actor: "subagent", itemId: "source-result",
    correlationId: "source-result", causationId: null, idempotencyKey: `task:${task.id}:event:tool-result-completed:source-call:source-result:1`,
    payload: {}, payloadDigest: "c".repeat(64) }
  const item = { id: continuationItemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: continuationStepId,
    type: "tool_call", status: "started", revision: 0, phase: null, content: itemContent,
    contentDigest: createHash("sha256").update(JSON.stringify(itemContent)).digest("hex") }
  const windowEvents = [sourceStart, started, agendaEvent, modelStarted, modelCompleted, usage, itemStarted, callStarted, sourceEnd]
  windowEvents.forEach((event, index) => { event.sequence = String(index + 2) })
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ sourceStepId, sourceOrdinal: 0, sourceAttempt: 1,
      sourceStatus: "waiting_for_tool", stepId: continuationStepId, ordinal: 1, attempt: 2, stepStatus: "streaming",
      sourceSessionId: task.sessionId, sourceTurnId: task.turnId, sourceTaskId: task.id,
      sessionId: task.sessionId, turnId: task.turnId, taskId: task.id }] }
    if (sql.includes('FROM "agent_items"')) return { rows: [item] }
    if (sql.includes("parent.\"idempotencyKey\" = $4")) return { rows: parentRows.filter(event => event.sessionId === task.sessionId
      && event.turnId === task.turnId && event.taskId === task.id && event.idempotencyKey === `task:${task.id}:event:turn-started`) }
    if (sql.includes("'step.completed'")) return { rows: [] }
    return { rows: [] }
  } } as never
  return { client, windowEvents, item, itemContent, parent, parentRows, started, agendaEvent, modelStarted, modelCompleted, usage, itemStarted, callStarted }
}

function input(value: ReturnType<typeof fixture>) {
  return { sourceStepId, sourceAttempt: 1, sourceCallItemId, sourceCallId, sourceCallInput: callInput,
    windowEvents: value.windowEvents as never, windowStartEventId: "source-start", windowEndEventId: "source-end" }
}

describe("historical source step continuation prefix", () => {
  it("accepts only the canonical seven-event current-attempt preclaim chain", async () => {
    const value = fixture(), proof = await readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))
    expect(proof).toMatchObject({ stepId: continuationStepId, attempt: 2, ordinal: 1, callItemId: continuationItemId,
      callId: continuationCallId, events: Array.from({ length: 7 }, () => expect.any(Object)),
      parent: { id: "turn-started", sequence: "1", payloadDigest: "d".repeat(64) },
      item: { id: continuationItemId, type: "tool_call", status: "started", revision: 0, phase: null } })
    expect(proof?.events.map(event => event.type)).toEqual([
      "step.started", "cognitive.agenda", "model.started", "model.completed", "model.usage", "item.started", "tool_call.started",
    ])
  })

  it.each([
    ["a repeated continuation candidate", (value: ReturnType<typeof fixture>) => {
      value.windowEvents.splice(value.windowEvents.length - 1, 0, { ...value.callStarted, id: "extra-call" })
      value.windowEvents.forEach((event, index) => { event.sequence = String(index + 1) })
    }],
    ["a mismatched causal edge", (value: ReturnType<typeof fixture>) => { value.itemStarted.causationId = "detached" }],
    ["an invalid canonical claim key", (value: ReturnType<typeof fixture>) => { value.callStarted.idempotencyKey = "task:task-1:event:tool-started:claim-call" }],
    ["an extra commentary event", (value: ReturnType<typeof fixture>) => {
      value.windowEvents.splice(2, 0, { ...value.agendaEvent, id: "extra-comment", type: "item.started",
        idempotencyKey: "task:task-1:event:item-started:comment" })
      value.windowEvents.forEach((event, index) => { event.sequence = String(index + 1) })
    }],
    ["a model request beyond the safe bound", (value: ReturnType<typeof fixture>) => { value.modelCompleted.payload = { ...value.modelCompleted.payload as object, toolCallCount: 33 } }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture(); corrupt(value)
    await expect(readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))).resolves.toBeNull()
  })

  it.each([
    ["a missing task-start parent", (value: ReturnType<typeof fixture>) => { value.parentRows.splice(0) }],
    ["a task-start parent from another scope", (value: ReturnType<typeof fixture>) => { value.parent.sessionId = "foreign-session" }],
    ["a continuation edge detached from its task-start parent", (value: ReturnType<typeof fixture>) => { value.started.causationId = "foreign-parent" }],
    ["a noncanonical parent event type", (value: ReturnType<typeof fixture>) => { value.parent.type = "turn.started" }],
    ["a parent with a wrong root task", (value: ReturnType<typeof fixture>) => { value.parent.payload = { ...value.parent.payload as object, rootTaskId: "foreign-root" } }],
    ["a parent that does not precede the continuation step", (value: ReturnType<typeof fixture>) => { value.parent.sequence = "3" }],
    ["duplicate task-start parent candidates", (value: ReturnType<typeof fixture>) => { value.parentRows.push({ ...value.parent, id: "duplicate-parent" }) }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture(); corrupt(value)
    await expect(readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))).resolves.toBeNull()
  })

  it("keeps requested but not persisted calls unexecuted", async () => {
    const value = fixture()
    value.modelCompleted.payload = { ...value.modelCompleted.payload as object, toolCallCount: 4 }
    const proof = await readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))
    expect(proof?.events).toHaveLength(7)
    expect(proof?.item.id).toBe(continuationItemId)
  })
})
