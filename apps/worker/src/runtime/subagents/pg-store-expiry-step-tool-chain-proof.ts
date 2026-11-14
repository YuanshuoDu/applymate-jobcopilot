import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import { cognitiveAgendaReceiptIdempotencyKey, parseCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"

export const MAX_STEP_TOOL_CALLS = 32
export const MAX_STEP_CHAIN_EVENTS = MAX_STEP_TOOL_CALLS * 6 + 9
const MAX_STEP_ITEMS = MAX_STEP_TOOL_CALLS * 2 + 1
const MAX_PERSISTED_EVENT_ID_LENGTH = 1024
const MAX_PERSISTED_ITEM_ID_LENGTH = 512
type JsonRecord = Record<string, unknown>
type Scope = Readonly<{ id: string; sessionId: string; turnId: string }>
type ProofEvent = JsonRecord & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown }
type ProofItem = JsonRecord & { id: string; sessionId: string; turnId: string; taskId: string; stepId: string;
  type: string; status: string; revision: number; phase: string | null; content: unknown }
type CallProof = Readonly<{ callItemId: string; toolCallId: string; toolName: string; resultItemId: string;
  itemStartedEventId: string; callStartedEventId: string; callCompletedEventId: string; callTerminalEventId: string;
  resultStartedEventId: string; resultCompletedEventId: string }>
type EventSignature = Readonly<{ id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string }>
export type StepToolChainProof = Readonly<{ stepId: string; attempt: number; waitCallItemId: string; waitCallId: string; waitResultItemId: string;
  stepStartedEventId: string; stepStartedPayload: unknown; agendaEventId: string; agendaReceipt: unknown;
  modelStartedEventId: string; modelCompletedEventId: string;
  modelUsageEventId: string; stepCompletedEventId: string;
  nextEventId: string; events: readonly EventSignature[]; calls: readonly CallProof[];
  commentary?: Readonly<{ itemId: string; startedEventId: string; deltaEventId: string; completedEventId: string }> }>

export const STEP_TOOL_CHAIN_AGENDA_JOIN_SQL = `"agent_events" AS stepStarted
  JOIN "agent_events" AS agenda ON agenda."id" = proof.value->'stepToolChain'->>'agendaEventId'
    AND agenda."causationId" = stepStarted."id" AND agenda."payload" = proof.value->'stepToolChain'->'agendaReceipt'`
export const STEP_TOOL_CHAIN_AGENDA_WHERE_SQL = `stepStarted."id" = proof.value->'stepToolChain'->>'stepStartedEventId'
  AND stepStarted."payload" = proof.value->'stepToolChain'->'stepStartedPayload'`
export const STEP_TOOL_CHAIN_MODEL_START_JOIN_SQL = `JOIN "agent_events" AS modelStart ON modelStart."id" = proof.value->'stepToolChain'->>'modelStartedEventId'
  AND modelStart."sessionId" = agenda."sessionId" AND modelStart."turnId" = agenda."turnId" AND modelStart."taskId" = agenda."taskId"
  AND modelStart."causationId" = agenda."id"`
export const STEP_TOOL_CHAIN_MODEL_START_WHERE_SQL = `modelStart."id" = proof.value->'stepToolChain'->>'modelStartedEventId'
  AND modelStart."sessionId" = callItem."sessionId" AND modelStart."turnId" = callItem."turnId" AND modelStart."taskId" = callItem."taskId"
  AND modelStart."type" = 'model.started' AND modelStart."actor" = 'subagent' AND modelStart."itemId" IS NULL
  AND modelStart."correlationId" = proof.value->'stepToolChain'->>'stepId'
  AND modelStart."idempotencyKey" = 'task:' || callItem."taskId" || ':event:model-started:' || (proof.value->'stepToolChain'->>'stepId')`

export function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {} }
export function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function validText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function validEventId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_PERSISTED_EVENT_ID_LENGTH && value.trim() === value }
function validItemId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_PERSISTED_ITEM_ID_LENGTH && value.trim() === value }
function sequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
function validUsage(value: unknown): boolean {
  if (value === null) return true
  const usage = record(value)
  return exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
    && [usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd].every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)
}
function signature(event: ProofEvent): EventSignature {
  return { id: event.id, sequence: event.sequence, type: event.type, actor: event.actor, itemId: event.itemId,
    correlationId: event.correlationId, causationId: event.causationId, idempotencyKey: event.idempotencyKey }
}

/** Proves a complete bounded model step before a historical wait result can settle its claim. */
export async function readCanonicalWaitStepToolChain(client: pg.PoolClient, task: Scope, input: {
  readonly stepId: string; readonly attempt: number; readonly callItemId: string; readonly callId: string; readonly resultItemId: string
}): Promise<StepToolChainProof | null> {
  if (![task.id, task.sessionId, task.turnId, input.stepId, input.callId].every(validText)
    || !validItemId(input.callItemId) || !validItemId(input.resultItemId)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1) return null
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(input.stepId)
  if (!agendaKey) return null
  const keys = [`task:${task.id}:event:step-started:${input.stepId}`, `task:${task.id}:event:${agendaKey}`,
    `task:${task.id}:event:model-started:${input.stepId}`, `task:${task.id}:event:model-completed:${input.stepId}`,
    `task:${task.id}:event:model-usage:${input.stepId}`, `task:${task.id}:event:step-completed:${input.stepId}`]
  const anchors = await client.query<ProofEvent>(`SELECT "id", "sessionId", "turnId", "taskId", "sequence"::text AS "sequence",
      "type", "actor", "itemId", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[]) LIMIT 7`,
  [task.sessionId, task.turnId, task.id, keys])
  if (anchors.rows.length !== 6) return null
  const byKey = new Map(anchors.rows.map(event => [event.idempotencyKey, event]))
  const stepStarted = byKey.get(keys[0]!), agenda = byKey.get(keys[1]!), started = byKey.get(keys[2]!), completed = byKey.get(keys[3]!)
  const usage = byKey.get(keys[4]!), stepDone = byKey.get(keys[5]!)
  if (!stepStarted || !agenda || !started || !completed || !usage || !stepDone) return null
  const from = sequence(stepStarted.sequence), through = sequence(stepDone.sequence)
  if (!from || !through || from >= through) return null
  const [eventRows, itemRows] = await Promise.all([
    client.query<ProofEvent>(`SELECT "id", "sessionId", "turnId", "taskId", "sequence"::text AS "sequence", "type", "actor",
        "itemId", "correlationId", "causationId", "idempotencyKey", "payload" FROM "agent_events" AS chainEvent
      WHERE chainEvent."sessionId" = $1 AND chainEvent."turnId" = $2 AND chainEvent."taskId" = $3
        AND chainEvent."sequence" BETWEEN $4::bigint AND $5::bigint
      ORDER BY chainEvent."sequence" LIMIT ${MAX_STEP_CHAIN_EVENTS + 1}`,
    [task.sessionId, task.turnId, task.id, from.toString(), through.toString()]),
    client.query<ProofItem>(`SELECT "id", "sessionId", "turnId", "taskId", "stepId", "type", "status", "revision", "phase", "content"
      FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
      ORDER BY "createdAt", "id" LIMIT ${MAX_STEP_ITEMS + 1}`,
    [task.sessionId, task.turnId, task.id, input.stepId]),
  ])
  if (eventRows.rows.length > MAX_STEP_CHAIN_EVENTS || itemRows.rows.length > MAX_STEP_ITEMS) return null
  return proveWaitStepToolChain(task, input, eventRows.rows, itemRows.rows, keys, agenda.payload)
}

function proveWaitStepToolChain(task: Scope, input: { stepId: string; attempt: number; callItemId: string; callId: string; resultItemId: string },
  events: readonly ProofEvent[], items: readonly ProofItem[], keys: readonly string[], agendaReceipt: unknown): StepToolChainProof | null {
  if (events.length < 12 || events.length > MAX_STEP_CHAIN_EVENTS) return null
  const itemMap = new Map(items.map(item => [item.id, item]))
  if (itemMap.size !== items.length || items.some(item => !validItemId(item.id) || item.sessionId !== task.sessionId || item.turnId !== task.turnId
    || item.taskId !== task.id || item.stepId !== input.stepId)) return null
  const calls = items.filter(item => item.type === "tool_call").sort((a, b) => eventOrder(events, a.id, b.id))
  const results = items.filter(item => item.type === "tool_result")
  const comments = items.filter(item => item.type === "agent_message")
  if (!calls.length || calls.length > MAX_STEP_TOOL_CALLS || results.length !== calls.length || comments.length > 1
    || items.length !== calls.length * 2 + comments.length || items.some(item => item.type !== "tool_call" && item.type !== "tool_result" && item.type !== "agent_message")) return null
  const byEventKey = new Map(events.map(event => [event.idempotencyKey, event]))
  if (byEventKey.size !== events.length) return null
  const stepStarted = byEventKey.get(keys[0]!), agenda = byEventKey.get(keys[1]!), started = byEventKey.get(keys[2]!)
  const completed = byEventKey.get(keys[3]!), usage = byEventKey.get(keys[4]!), stepDone = byEventKey.get(keys[5]!)
  const stepStartedPayload = record(stepStarted?.payload)
  const modelStartPayload = record(started?.payload), modelDonePayload = record(completed?.payload), usagePayload = record(usage?.payload)
  const count = modelDonePayload.toolCallCount
  const parsedAgenda = parseCognitiveAgendaReceipt(agendaReceipt, { sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId: input.stepId })
  if (!stepStarted || !agenda || !started || !completed || !usage || !stepDone || !validEventId(stepStarted.id) || !validEventId(agenda.id)
    || !validEventId(started.id) || !validEventId(completed.id) || !validEventId(usage.id)
    || !validEventId(stepDone.id) || started.type !== "model.started" || completed.type !== "model.completed" || usage.type !== "model.usage"
    || stepStarted.type !== "step.started" || agenda.type !== COGNITIVE_AGENDA_EVENT_TYPE || stepDone.type !== "step.completed"
    || [stepStarted, agenda, started, completed, usage, stepDone].some(event => event.actor !== "subagent")
    || [stepStarted, agenda, started, completed, usage, stepDone].some(event => event.itemId !== null)
    || [stepStarted, agenda, started, completed, usage, stepDone].some(event => event.correlationId !== input.stepId)
    || stepStarted.idempotencyKey !== keys[0] || agenda.idempotencyKey !== keys[1] || !parsedAgenda
    || !exactKeys(stepStartedPayload, ["stepId", "ordinal", "taskId"]) || stepStartedPayload.stepId !== input.stepId
    || stepStartedPayload.taskId !== task.id || typeof stepStartedPayload.ordinal !== "number"
    || !Number.isSafeInteger(stepStartedPayload.ordinal) || stepStartedPayload.ordinal < 0
    || agenda.causationId !== stepStarted.id || started.causationId !== agenda.id || completed.causationId !== started.id || usage.causationId !== completed.id
    || !exactKeys(modelStartPayload, ["taskId", "provider", "model"]) || modelStartPayload.taskId !== task.id
    || !validText(modelStartPayload.provider) || !validText(modelStartPayload.model)
    || !exactKeys(modelDonePayload, ["taskId", "provider", "model", "toolCallCount"]) || modelDonePayload.taskId !== task.id
    || modelDonePayload.provider !== modelStartPayload.provider || modelDonePayload.model !== modelStartPayload.model
    || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > MAX_STEP_TOOL_CALLS || count !== calls.length
    || !exactKeys(usagePayload, ["taskId", "provider", "model", "usage"]) || usagePayload.taskId !== task.id
    || usagePayload.provider !== modelDonePayload.provider || usagePayload.model !== modelDonePayload.model || !validUsage(usagePayload.usage)
    || !exactKeys(record(stepDone.payload), ["stepId", "status", "toolCallCount", "taskId"])
    || !sameJson(stepDone.payload, { stepId: input.stepId, status: "completed", toolCallCount: count, taskId: task.id })) return null
  const eventIds = new Set(events.map(event => event.id))
  if (eventIds.size !== events.length || events[0]?.id !== stepStarted.id || events[events.length - 1]?.id !== stepDone.id) return null
  let cursor = 0
  const proofEvents: EventSignature[] = []
  let previous: ProofEvent | undefined
  const take = (type: string, key: string, correlationId: string, itemId: string | null, payload: unknown, cause?: string): ProofEvent | null => {
    const event = events[cursor++]
    const sequenceValue = sequence(event?.sequence), previousSequence = sequence(previous?.sequence)
    if (!event || event.type !== type || event.actor !== "subagent" || event.idempotencyKey !== key
      || event.correlationId !== correlationId || event.itemId !== itemId || !validEventId(event.id)
      || !sequenceValue || previousSequence !== null && previousSequence !== undefined && sequenceValue <= previousSequence
      || previous && event.causationId !== previous.id || cause !== undefined && event.causationId !== cause
      || payload !== undefined && !sameJson(event.payload, payload)) return null
    proofEvents.push(signature(event)); previous = event
    return event
  }
  const stepStart = take("step.started", keys[0]!, input.stepId, null, stepStartedPayload)
  const agendaEvent = take(COGNITIVE_AGENDA_EVENT_TYPE, keys[1]!, input.stepId, null, parsedAgenda, stepStart?.id)
  const first = take("model.started", keys[2]!, input.stepId, null, modelStartPayload, agendaEvent?.id)
  const done = take("model.completed", keys[3]!, input.stepId, null, modelDonePayload, first?.id)
  const modelUsage = take("model.usage", keys[4]!, input.stepId, null, usagePayload, done?.id)
  if (!stepStart || !agendaEvent || !first || !done || !modelUsage) return null
  let commentary: StepToolChainProof["commentary"]
  if (comments.length) {
    const item = comments[0]!, content = record(item.content)
    if (item.status !== "completed" || item.revision !== 2 || item.phase !== "commentary" || !exactKeys(content, ["text"])
      || typeof content.text !== "string" || content.text.length === 0) return null
    const startedComment = take("item.started", `task:${task.id}:event:item-started:${item.id}`, input.stepId, item.id,
      { itemId: item.id, type: "agent_message", phase: "commentary" })
    const delta = take("item.delta", `task:${task.id}:event:commentary-delta:${item.id}:1`, item.id, item.id,
      { itemId: item.id, status: "streaming", content })
    const finished = take("item.completed", `task:${task.id}:event:commentary-completed:${item.id}:2`, item.id, item.id,
      { itemId: item.id, status: "completed", content })
    if (!startedComment || !delta || !finished) return null
    commentary = { itemId: item.id, startedEventId: startedComment.id, deltaEventId: delta.id, completedEventId: finished.id }
  }
  const usedCallIds = new Set<string>(), usedResultIds = new Set<string>(), callProofs: CallProof[] = []
  for (const call of calls) {
    const content = record(call.content), callId = content.toolCallId, name = content.toolName
    const result = results.find(item => record(item.content).toolCallId === callId)
    const resultContent = record(result?.content)
    if (!result || !validItemId(result.id) || usedCallIds.has(String(callId)) || usedResultIds.has(result.id) || !validItemId(call.id) || !validText(callId)
      || !validText(name) || !exactKeys(content, ["toolCallId", "toolName", "toolVersion", "status", "errorCode", "input"])
      || content.toolVersion !== "1" || content.status !== "completed" || content.errorCode !== null
      || !content.input || typeof content.input !== "object" || Array.isArray(content.input)
      || !exactKeys(resultContent, ["toolCallId", "output", "errorCode"])
      || resultContent.toolCallId !== callId || resultContent.errorCode !== null || call.status !== "completed"
      || call.revision !== 1 || call.phase !== null || result.status !== "completed" || result.revision !== 1 || result.phase !== null
      || name === "wait_subagents" && (call.id !== input.callItemId || callId !== input.callId)
      || name === "agent.wait" || name === "wait_subagents" && call.id !== input.callItemId) return null
    const isClaim = call.id === input.callItemId
    if (isClaim && (callId !== input.callId || name !== "wait_subagents" || result.id !== input.resultItemId)) return null
    if (!isClaim && name === "wait_subagents") return null
    const itemStarted = take("item.started", `task:${task.id}:event:item-started:${call.id}`, input.stepId, call.id,
      { itemId: call.id, type: "tool_call", phase: null })
    const callStarted = take("tool_call.started", isClaim ? `task:${task.id}:event:child-wait-claim:${input.attempt}:${input.stepId}`
      : `task:${task.id}:event:tool-started:${callId}`, callId, call.id,
    { toolCallId: callId, toolName: name, taskId: task.id })
    const rawCallCompletion = { itemId: call.id, status: "completed", content }
    const projectedCallCompletion = projectWaitCallCompletionPayload(rawCallCompletion, call.id)
    const callCompleted = take("item.completed", `task:${task.id}:event:tool-call-completed:${callId}:${call.id}:1`, call.id, call.id,
      undefined, callStarted?.id)
    if (!itemStarted || !callStarted || !callCompleted
      || ![projectedCallCompletion, rawCallCompletion].some(payload => sameJson(callCompleted.payload, payload))) return null
    const terminal = take("tool_call.completed", `task:${task.id}:event:tool-finished:${callId}`, callId, call.id,
      { toolCallId: callId, toolName: name, status: "completed", errorCode: null, taskId: task.id }, callCompleted.id)
    const resultStarted = take("item.started", `task:${task.id}:event:item-started:${result.id}`, input.stepId, result.id,
      { itemId: result.id, type: "tool_result", phase: null }, terminal?.id)
    const resultCompleted = take("item.completed", `task:${task.id}:event:tool-result-completed:${callId}:${result.id}:1`, result.id, result.id,
      { itemId: result.id, status: "completed", content: resultContent }, resultStarted?.id)
    if (!terminal || !resultStarted || !resultCompleted) return null
    usedCallIds.add(callId as string); usedResultIds.add(result.id)
    callProofs.push({ callItemId: call.id, toolCallId: callId as string, toolName: name, resultItemId: result.id,
      itemStartedEventId: itemStarted.id, callStartedEventId: callStarted.id, callCompletedEventId: callCompleted.id,
      callTerminalEventId: terminal.id, resultStartedEventId: resultStarted.id, resultCompletedEventId: resultCompleted.id })
  }
  const step = take("step.completed", keys[5]!, input.stepId, null, stepDone.payload)
  if (!step || cursor !== events.length || callProofs.length !== count) return null
  const waitIndex = callProofs.findIndex(call => call.callItemId === input.callItemId && call.toolCallId === input.callId
    && call.resultItemId === input.resultItemId)
  if (waitIndex < 0) return null
  const waitResultEvent = callProofs[waitIndex]!.resultCompletedEventId
  const waitDoneIndex = proofEvents.findIndex(event => event.id === waitResultEvent)
  const nextEventId = proofEvents[waitDoneIndex + 1]?.id
  if (!nextEventId) return null
  return { stepId: input.stepId, attempt: input.attempt, waitCallItemId: input.callItemId, waitCallId: input.callId, waitResultItemId: input.resultItemId,
    stepStartedEventId: stepStart.id, stepStartedPayload, agendaEventId: agendaEvent.id, agendaReceipt: parsedAgenda,
    modelStartedEventId: first.id, modelCompletedEventId: done.id, modelUsageEventId: modelUsage.id, stepCompletedEventId: step.id,
    nextEventId, events: proofEvents, calls: callProofs, ...(commentary ? { commentary } : {}) }
}

function eventOrder(events: readonly ProofEvent[], leftItemId: string, rightItemId: string): number {
  const sequenceOf = (itemId: string) => sequence(events.find(event => event.type === "tool_call.started" && event.itemId === itemId)?.sequence) ?? 0n
  const a = sequenceOf(leftItemId), b = sequenceOf(rightItemId)
  return a < b ? -1 : a > b ? 1 : 0
}
