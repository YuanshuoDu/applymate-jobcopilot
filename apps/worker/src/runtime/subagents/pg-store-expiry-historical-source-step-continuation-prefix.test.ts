import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { markCanonicalSubagentWaitTargetIds, safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"
import { readCanonicalHistoricalSourceStepContinuationPrefix } from "./pg-store-expiry-historical-source-step-continuation-prefix.js"

const task = { id: "task-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", userId: "user-1",
  leaseOwner: "lease-1", attemptCount: 2, leaseExpiresAt: new Date("2026-11-07T00:00:00.000Z") }
const sourceStepId = "task:task-1:step:0:attempt:1", sourceCallId = "source-call"
const sourceCallItemId = `task:${task.id}:item:tool-call:${sourceCallId}:attempt:1`
const callInput = { idempotencyKey: "source-key", taskIds: ["child-1"], mode: "any", timeoutMs: 30_000 }
const continuationStepId = "task:task-1:step:1:attempt:2", continuationCallId = "claim-call"
const continuationItemId = `task:${task.id}:item:tool-call:${continuationCallId}:attempt:2`
type Event = Record<string, unknown> & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown; payloadDigest: string }
type TerminalRow = { id: string; sessionId: string; turnId: string; taskId: string; sequence: string; type: string;
  correlationId: string; itemId: string | null; idempotencyKey: string }

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function safeInput(value: Record<string, unknown>) {
  const ids = value.taskIds as string[], markerOutcome = { taskIds: ids, matchedTaskIds: [] as string[], tasks: ids.map(taskId => ({ taskId })) }
  if (!markCanonicalSubagentWaitTargetIds({ targetTaskIds: ids }, markerOutcome, ids)) throw new Error("fixture_wait_ids_invalid")
  return safeSubagentWaitJson(value, 8_192)
}

function fixture(options: { sourceInput?: Record<string, unknown>; continuationInput?: unknown } = {}) {
  const sourceInput = options.sourceInput ?? callInput, continuationInput = options.continuationInput ?? sourceInput
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
  const sourceContent = { toolCallId: sourceCallId, toolName: "wait_subagents", toolVersion: "1", input: sourceInput,
    status: "completed", errorCode: null }
  const sourceItem = { id: sourceCallItemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: sourceStepId,
    type: "tool_call", status: "completed", revision: 1, phase: null, content: sourceContent,
    contentDigest: digest(sourceContent), sourceInputDigest: digest(sourceInput) }
  const itemContent = { toolCallId: continuationCallId, toolName: "wait_subagents", toolVersion: "1", input: continuationInput }
  const itemStarted = add("item.started", `item-started:${continuationItemId}`, continuationStepId, continuationItemId,
    { itemId: continuationItemId, type: "tool_call", phase: null }, usage.id)
  const callStarted = add("tool_call.started", `child-wait-claim:2:${continuationStepId}`, continuationCallId, continuationItemId,
    { toolCallId: continuationCallId, toolName: "wait_subagents", taskId: task.id }, itemStarted.id)
  const sourceEnd = { id: "source-end", sequence: "9", type: "item.completed", actor: "subagent", itemId: "source-result",
    correlationId: "source-result", causationId: null, idempotencyKey: `task:${task.id}:event:tool-result-completed:source-call:source-result:1`,
    payload: {}, payloadDigest: "c".repeat(64) }
  const item: { id: string; sessionId: string; turnId: string; taskId: string; stepId: string; type: string; status: string;
    revision: number; phase: null; content: Record<string, unknown>; contentDigest: string; inputDigest: string } = {
    id: continuationItemId, sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: continuationStepId,
    type: "tool_call", status: "started", revision: 0, phase: null, content: itemContent,
    contentDigest: digest(itemContent), inputDigest: digest(continuationInput) }
  const sourceRows = [sourceItem]
  const itemRows = [item], terminalRows: TerminalRow[] = []
  const windowEvents = [sourceStart, started, agendaEvent, modelStarted, modelCompleted, usage, itemStarted, callStarted, sourceEnd]
  windowEvents.forEach((event, index) => { event.sequence = String(index + 2) })
  const client = { query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ sourceStepId, sourceOrdinal: 0, sourceAttempt: 1,
      sourceStatus: "waiting_for_tool", stepId: continuationStepId, ordinal: 1, attempt: 2, stepStatus: "streaming",
      sourceSessionId: task.sessionId, sourceTurnId: task.turnId, sourceTaskId: task.id,
      sessionId: task.sessionId, turnId: task.turnId, taskId: task.id }] }
    if (sql.includes('FROM "agent_items" AS sourceCall')) return { rows: sourceRows }
    if (sql.includes('FROM "agent_items" AS continuationItem')) return { rows: itemRows }
    if (sql.includes("parent.\"idempotencyKey\" = $4")) return { rows: parentRows.filter(event => event.sessionId === task.sessionId
      && event.turnId === task.turnId && event.taskId === task.id && event.idempotencyKey === `task:${task.id}:event:turn-started`) }
    if (sql.includes("'step.completed'")) {
      const [sessionId, turnId, taskId, stepId, stepKey, callId, itemId, finishKey, resultItemId, callCompletedKey, resultStartKey, resultCompleteKey] = values ?? []
      const callTerminals = ["tool_call.completed", "tool_call.failed", "tool_call.interrupted"]
      const itemTerminals = ["item.completed", "item.failed", "item.interrupted"]
      return { rows: terminalRows.filter(row => row.sessionId === sessionId && row.turnId === turnId && row.taskId === taskId
        && ((row.type === "step.completed" && (row.correlationId === stepId || row.idempotencyKey === stepKey))
          || (callTerminals.includes(row.type) && (row.correlationId === callId || row.itemId === itemId || row.idempotencyKey === finishKey))
          || (itemTerminals.includes(row.type) && [itemId, resultItemId].includes(row.itemId)) || row.correlationId === resultItemId
          || [callCompletedKey, resultStartKey, resultCompleteKey].includes(row.idempotencyKey))).map(({ id }) => ({ id })) }
    }
    return { rows: [] }
  } } as never
  return { client, windowEvents, item, itemRows, sourceItem, sourceRows, sourceInput, terminalRows, itemContent, parent, parentRows,
    started, agendaEvent, modelStarted, modelCompleted, usage, itemStarted, callStarted }
}

function terminalRow(patch: Partial<TerminalRow> = {}): TerminalRow {
  return { id: "terminal-event", sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, sequence: "1000",
    type: "item.completed", correlationId: "foreign-call", itemId: null, idempotencyKey: "foreign-key", ...patch }
}

function persistCompletedItemBeforeEvent(value: ReturnType<typeof fixture>, patch: Record<string, unknown> = {}) {
  value.item.status = "completed"
  value.item.revision = 1
  value.item.content = { ...value.itemContent, status: "completed", errorCode: null, ...patch }
  value.item.contentDigest = digest(value.item.content)
  value.item.inputDigest = digest(value.item.content.input)
}

function input(value: ReturnType<typeof fixture>) {
  return { sourceStepId, sourceAttempt: 1, sourceCallItemId, sourceCallId, sourceCallInput: value.sourceInput,
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

  it("proves the exact safe projection of a sensitive source key without exposing the raw value", async () => {
    const rawInput = { ...callInput, idempotencyKey: "api_key=fixture-secret-value" }
    const value = fixture({ sourceInput: rawInput, continuationInput: safeInput(rawInput) })
    const proof = await readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))
    expect(proof).toMatchObject({ sourceCallContentDigest: value.sourceItem.contentDigest,
      sourceInputDigest: value.sourceItem.sourceInputDigest, redactedInputDigest: value.item.inputDigest })
    expect(JSON.stringify(proof)).not.toContain(rawInput.idempotencyKey)
  })

  it.each([
    ["a changed redacted key", (raw: Record<string, unknown>) => ({ ...safeInput(raw) as object, idempotencyKey: "api_key=[REDACTED]-changed" })],
    ["changed target IDs", (raw: Record<string, unknown>) => ({ ...safeInput(raw) as object, taskIds: ["other-child"] })],
    ["a changed mode", (raw: Record<string, unknown>) => ({ ...safeInput(raw) as object, mode: "all" })],
    ["a changed timeout", (raw: Record<string, unknown>) => ({ ...safeInput(raw) as object, timeoutMs: 29_999 })],
    ["the unredacted source key", (raw: Record<string, unknown>) => raw],
  ])("rejects %s for a redacted source input", async (_label, continuationInput) => {
    const rawInput = { ...callInput, idempotencyKey: "api_key=fixture-secret-value" }
    const value = fixture({ sourceInput: rawInput, continuationInput: continuationInput(rawInput) })
    await expect(readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))).resolves.toBeNull()
  })

  it("accepts the exact completed-item-before-event crash cut", async () => {
    const value = fixture(); persistCompletedItemBeforeEvent(value)
    const proof = await readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))
    expect(proof?.item).toMatchObject({ id: continuationItemId, type: "tool_call", status: "completed", revision: 1, phase: null })
    expect(proof?.events.map(event => event.type)).toEqual([
      "step.started", "cognitive.agenda", "model.started", "model.completed", "model.usage", "item.started", "tool_call.started",
    ])
    expect(proof?.events.at(-1)).toMatchObject({ correlationId: continuationCallId,
      idempotencyKey: `task:${task.id}:event:child-wait-claim:2:${continuationStepId}` })
    expect(value.terminalRows).toHaveLength(0)
  })

  it.each([
    ["a mismatched item revision", (value: ReturnType<typeof fixture>) => { persistCompletedItemBeforeEvent(value); value.item.revision = 2 }],
    ["a non-completed call content status", (value: ReturnType<typeof fixture>) => { persistCompletedItemBeforeEvent(value, { status: "failed" }) }],
    ["a non-null call error", (value: ReturnType<typeof fixture>) => { persistCompletedItemBeforeEvent(value, { errorCode: "tool_execution_failed" }) }],
    ["an extra completion-content field", (value: ReturnType<typeof fixture>) => { persistCompletedItemBeforeEvent(value, { output: { ok: true } }) }],
    ["a persisted completion event", (value: ReturnType<typeof fixture>) => {
      persistCompletedItemBeforeEvent(value); value.terminalRows.push(terminalRow({ itemId: value.item.id }))
    }],
    ["a second continuation item", (value: ReturnType<typeof fixture>) => {
      persistCompletedItemBeforeEvent(value); value.itemRows.push({ ...value.item, id: "extra-item" })
    }],
  ])("rejects %s", async (_label, corrupt) => {
    const value = fixture(); corrupt(value)
    await expect(readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))).resolves.toBeNull()
  })

  it.each([
    ["a wrong-associated tool finish key", `task:${task.id}:event:tool-finished:${continuationCallId}`, "tool_call.completed"],
    ["a wrong-associated call completion key", `task:${task.id}:event:tool-call-completed:${continuationCallId}:${continuationItemId}:1`, "commentary"],
  ])("rejects %s even when it is outside the ordered proof window", async (_label, idempotencyKey, type) => {
    const value = fixture(); persistCompletedItemBeforeEvent(value)
    const row = terminalRow({ idempotencyKey, type })
    expect(BigInt(row.sequence)).toBeGreaterThan(BigInt(value.windowEvents.at(-1)!.sequence))
    value.terminalRows.push(row)
    await expect(readCanonicalHistoricalSourceStepContinuationPrefix(value.client, task, input(value))).resolves.toBeNull()
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
