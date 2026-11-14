import type pg from "pg"
import { canonicalJson } from "@jobcopilot/shared"
import { cognitiveAgendaReceiptIdempotencyKey, parseCognitiveAgendaReceipt } from "../turns/cognitive-agenda-receipt.js"
import { markCanonicalSubagentWaitTargetIds, safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"
import { exactKeys, record, MAX_STEP_TOOL_CALLS } from "./pg-store-expiry-step-tool-chain-proof.js"

type Scope = Readonly<{ id: string; sessionId: string; turnId: string; rootTaskId?: string; userId?: string;
  leaseOwner?: string; attemptCount?: number; leaseExpiresAt?: Date }>
type Event = Readonly<Record<string, unknown> & { id: string; sequence: string; type: string; actor: string; itemId: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown; payloadDigest: string }>
type Item = Readonly<Record<string, unknown> & { id: string; sessionId: string; turnId: string; taskId: string; stepId: string;
  type: string; status: string; revision: number; phase: string | null; content: unknown; contentDigest: string }>
export type HistoricalContinuationEvent = Readonly<Pick<Event, "id" | "sequence" | "type" | "actor" | "itemId" | "correlationId"
  | "causationId" | "idempotencyKey" | "payloadDigest">>
export type HistoricalContinuationItem = Readonly<Pick<Item, "id" | "type" | "status" | "revision" | "phase" | "contentDigest">>
export type HistoricalContinuationParent = Readonly<Pick<Event, "id" | "sequence" | "payloadDigest">>
export type HistoricalSourceStepContinuationPrefix = Readonly<{ stepId: string; attempt: number; ordinal: number; callItemId: string;
  callId: string; parent: HistoricalContinuationParent; sourceCallContentDigest: string; sourceInputDigest: string;
  redactedInputDigest: string; events: readonly HistoricalContinuationEvent[]; item: HistoricalContinuationItem }>
export const HISTORICAL_CONTINUATION_PREFIX_EVENT_COUNT = 7

const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
const validId = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
const sequence = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
const same = (left: unknown, right: unknown): boolean => { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
const validWaitInput = (value: unknown): boolean => {
  const input = record(value), ids = input.taskIds
  return exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
    && validText(input.idempotencyKey) && input.idempotencyKey.length <= 256
    && (input.mode === "any" || input.mode === "all") && Number.isSafeInteger(input.timeoutMs)
    && Number(input.timeoutMs) >= 1 && Number(input.timeoutMs) <= 30_000 && Array.isArray(ids) && ids.length > 0 && ids.length <= 8
    && ids.every(id => validText(id)) && new Set(ids).size === ids.length
}
const usageValid = (value: unknown): boolean => {
  if (value === null) return true
  const usage = record(value)
  return exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
    && [usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd].every(number => typeof number === "number" && Number.isFinite(number) && number >= 0)
}
const signature = (event: Event): HistoricalContinuationEvent => ({ id: event.id, sequence: event.sequence, type: event.type,
  actor: event.actor, itemId: event.itemId, correlationId: event.correlationId, causationId: event.causationId,
  idempotencyKey: event.idempotencyKey, payloadDigest: event.payloadDigest })
const itemSignature = (item: Item): HistoricalContinuationItem => ({ id: item.id, type: item.type, status: item.status,
  revision: item.revision, phase: item.phase, contentDigest: item.contentDigest })
const parentSignature = (event: Event): HistoricalContinuationParent => ({ id: event.id, sequence: event.sequence, payloadDigest: event.payloadDigest })

/** Proves only the exact streaming successor preclaim cut; all other interleavings fail closed. */
export async function readCanonicalHistoricalSourceStepContinuationPrefix(client: pg.PoolClient, scope: Scope, input: {
  readonly sourceStepId: string; readonly sourceAttempt: number; readonly sourceCallItemId: string; readonly sourceCallId: string;
  readonly sourceCallInput: unknown; readonly windowEvents: readonly Event[]; readonly windowStartEventId: string;
  readonly windowEndEventId: string;
}): Promise<HistoricalSourceStepContinuationPrefix | null> {
  const currentAttempt = scope.attemptCount
  if (![scope.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, scope.leaseOwner, input.sourceStepId,
    input.sourceCallItemId, input.sourceCallId, input.windowStartEventId, input.windowEndEventId].every(validText)
    || !scope.leaseExpiresAt || !Number.isSafeInteger(currentAttempt) || currentAttempt! < 1
    || !Number.isSafeInteger(input.sourceAttempt) || input.sourceAttempt < 1 || input.sourceAttempt > currentAttempt!
    || !validId(input.sourceCallItemId, 512) || !validWaitInput(input.sourceCallInput)
    || input.windowEvents.length < HISTORICAL_CONTINUATION_PREFIX_EVENT_COUNT + 1) return null
  const stepRows = await client.query<Record<string, unknown>>(`SELECT source."id" AS "sourceStepId", source."ordinal" AS "sourceOrdinal",
      source."attempt" AS "sourceAttempt", source."status" AS "sourceStatus", continuation."id" AS "stepId",
      continuation."ordinal", continuation."attempt", continuation."status" AS "stepStatus",
      source."sessionId" AS "sourceSessionId", source."turnId" AS "sourceTurnId", source."taskId" AS "sourceTaskId",
      continuation."sessionId", continuation."turnId", continuation."taskId"
    FROM "sub_agent_tasks" AS owner JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $5
    JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
      AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
    JOIN "agent_steps" AS source ON source."sessionId" = owner."sessionId" AND source."turnId" = owner."turnId" AND source."taskId" = owner."id"
    JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId" AND continuation."turnId" = source."turnId"
      AND continuation."taskId" = source."taskId" AND continuation."attempt" = owner."attemptCount"
      AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId"
        AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = owner."attemptCount"
        AND later."ordinal" > source."ordinal")
    WHERE owner."id" = $1 AND owner."sessionId" = $2 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
      AND owner."status" = 'running' AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $6
      AND owner."attemptCount" = $7 AND owner."leaseExpiresAt" = $8 AND owner."interruptRequestedAt" IS NULL
      AND source."id" = $9 AND source."attempt" = $10 AND source."status" = 'waiting_for_tool'
      AND source."attempt" BETWEEN 1 AND owner."attemptCount" AND continuation."status" = 'streaming' LIMIT 2`,
  [scope.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, scope.leaseOwner, currentAttempt, scope.leaseExpiresAt,
    input.sourceStepId, input.sourceAttempt])
  if (stepRows.rows.length !== 1) return null
  const step = stepRows.rows[0]!, stepId = step.stepId, ordinal = step.ordinal, attempt = step.attempt, sourceOrdinal = step.sourceOrdinal
  if (step.sourceStepId !== input.sourceStepId || step.sourceAttempt !== input.sourceAttempt || step.sourceStatus !== "waiting_for_tool"
    || step.sourceSessionId !== scope.sessionId || step.sourceTurnId !== scope.turnId || step.sourceTaskId !== scope.id
    || step.sessionId !== scope.sessionId || step.turnId !== scope.turnId || step.taskId !== scope.id || typeof stepId !== "string"
    || !validText(stepId) || stepId === input.sourceStepId || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)
    || typeof sourceOrdinal !== "number" || !Number.isSafeInteger(sourceOrdinal) || ordinal <= sourceOrdinal
    || attempt !== currentAttempt || step.stepStatus !== "streaming") return null
  const sourceRows = await client.query<Item & { sourceInputDigest: string }>(`SELECT sourceCall."id", sourceCall."sessionId", sourceCall."turnId",
      sourceCall."taskId", sourceCall."stepId", sourceCall."type", sourceCall."status", sourceCall."revision", sourceCall."phase", sourceCall."content",
      encode(sha256(convert_to(sourceCall."content"::text, 'UTF8')), 'hex') AS "contentDigest",
      encode(sha256(convert_to((sourceCall."content"->'input')::text, 'UTF8')), 'hex') AS "sourceInputDigest"
    FROM "agent_items" AS sourceCall WHERE sourceCall."sessionId" = $1 AND sourceCall."turnId" = $2
      AND sourceCall."taskId" = $3 AND sourceCall."stepId" = $4 AND sourceCall."id" = $5 AND sourceCall."type" = 'tool_call' LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.id, input.sourceStepId, input.sourceCallItemId])
  if (sourceRows.rows.length !== 1) return null
  const sourceItem = sourceRows.rows[0]!, sourceContent = record(sourceItem.content), sourceInput = record(sourceContent.input)
  if (sourceItem.id !== input.sourceCallItemId || sourceItem.sessionId !== scope.sessionId || sourceItem.turnId !== scope.turnId
    || sourceItem.taskId !== scope.id || sourceItem.stepId !== input.sourceStepId || sourceItem.type !== "tool_call"
    || sourceContent.toolCallId !== input.sourceCallId || sourceContent.toolName !== "wait_subagents" || sourceContent.toolVersion !== "1"
    || !validWaitInput(sourceInput) || !same(sourceInput, input.sourceCallInput)
    || !/^[0-9a-f]{64}$/.test(sourceItem.contentDigest) || !/^[0-9a-f]{64}$/.test(sourceItem.sourceInputDigest)) return null
  const targetIds = sourceInput.taskIds as string[]
  const markedInput = { ...sourceInput, taskIds: [...targetIds] }
  const markedIds = markedInput.taskIds as string[]
  const markerOutcome = { taskIds: markedIds, matchedTaskIds: [] as string[], tasks: markedIds.map(taskId => ({ taskId })) }
  if (!markCanonicalSubagentWaitTargetIds({ targetTaskIds: markedIds }, markerOutcome, markedIds)) return null
  const expectedInput = safeSubagentWaitJson(markedInput, 8_192)
  if (!validWaitInput(expectedInput)) return null
  const itemRows = await client.query<Item & { inputDigest: string }>(`SELECT continuationItem."id", continuationItem."sessionId", continuationItem."turnId",
      continuationItem."taskId", continuationItem."stepId", continuationItem."type", continuationItem."status",
      continuationItem."revision", continuationItem."phase", continuationItem."content",
      encode(sha256(convert_to(continuationItem."content"::text, 'UTF8')), 'hex') AS "contentDigest",
      encode(sha256(convert_to((continuationItem."content"->'input')::text, 'UTF8')), 'hex') AS "inputDigest"
    FROM "agent_items" AS continuationItem WHERE continuationItem."sessionId" = $1 AND continuationItem."turnId" = $2
      AND continuationItem."taskId" = $3 AND continuationItem."stepId" = $4 ORDER BY continuationItem."createdAt", continuationItem."id" LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.id, stepId])
  if (itemRows.rows.length !== 1) return null
  const item = itemRows.rows[0]!, content = record(item.content), callId = content.toolCallId
  const callItemId = `task:${scope.id}:item:tool-call:${String(callId)}:attempt:${currentAttempt}`
  const startedItem = item.status === "started" && item.revision === 0 && exactKeys(content, ["toolCallId", "toolName", "toolVersion", "input"])
  const completedBeforeEvent = item.status === "completed" && item.revision === 1
    && exactKeys(content, ["toolCallId", "toolName", "toolVersion", "input", "status", "errorCode"])
    && content.status === "completed" && content.errorCode === null
  if (item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.id || item.stepId !== stepId
    || item.id !== callItemId || item.type !== "tool_call" || item.phase !== null || !(startedItem || completedBeforeEvent)
    || !validText(callId) || callId === input.sourceCallId
    || content.toolName !== "wait_subagents" || content.toolVersion !== "1" || !validWaitInput(content.input)
    || !same(content.input, expectedInput) || item.id === input.sourceCallItemId
    || !/^[0-9a-f]{64}$/.test(item.inputDigest)) return null
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  if (!agendaKey) return null
  const prefix = `task:${scope.id}:event:`, keys = [prefix + `step-started:${stepId}`, prefix + agendaKey,
    prefix + `model-started:${stepId}`, prefix + `model-completed:${stepId}`, prefix + `model-usage:${stepId}`,
    prefix + `item-started:${item.id}`, prefix + `child-wait-claim:${currentAttempt}:${stepId}`]
  const matching = input.windowEvents.filter(event => keys.includes(event.idempotencyKey))
  if (matching.length !== keys.length || new Set(matching.map(event => event.idempotencyKey)).size !== keys.length
    || new Set(matching.map(event => event.id)).size !== keys.length) return null
  const events = keys.map(key => matching.find(event => event.idempotencyKey === key)!)
  const [started, agenda, modelStarted, modelCompleted, usage, itemStarted, callStarted] = events
  const seq = events.map(event => sequence(event.sequence)), allSeq = input.windowEvents.map(event => sequence(event.sequence))
  const parentRows = await client.query<Event>(`SELECT parent."id", parent."sequence"::text AS "sequence", parent."type", parent."actor",
      parent."itemId", parent."correlationId", parent."causationId", parent."idempotencyKey", parent."payload",
      encode(sha256(convert_to(parent."payload"::text, 'UTF8')), 'hex') AS "payloadDigest",
      parent."sessionId", parent."turnId", parent."taskId"
    FROM "agent_events" AS parent WHERE parent."sessionId" = $1 AND parent."turnId" = $2 AND parent."taskId" = $3
      AND parent."idempotencyKey" = $4 LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.id, `task:${scope.id}:event:turn-started`])
  if (parentRows.rows.length !== 1) return null
  const parent = parentRows.rows[0]!, parentPayload = record(parent.payload), parentSequence = sequence(parent.sequence)
  if (input.windowEvents[0]?.id !== input.windowStartEventId || input.windowEvents.at(-1)?.id !== input.windowEndEventId
    || allSeq.some((value, index) => !value || index > 0 && value <= allSeq[index - 1]!)
    || new Set(input.windowEvents.map(event => event.id)).size !== input.windowEvents.length
    || new Set(input.windowEvents.map(event => event.idempotencyKey)).size !== input.windowEvents.length
    || seq.some((value, index) => !value || index > 0 && value <= seq[index - 1]!)
    || !validText(parent.id) || !parentSequence || parent.sessionId !== scope.sessionId || parent.turnId !== scope.turnId
    || parent.taskId !== scope.id || parent.type !== "task.started" || parent.actor !== "subagent" || parent.itemId !== null
    || parent.correlationId !== scope.turnId || parent.causationId !== null || parent.idempotencyKey !== `task:${scope.id}:event:turn-started`
    || !exactKeys(parentPayload, ["goal", "taskId", "rootTaskId"]) || typeof parentPayload.goal !== "string" || !parentPayload.goal.trim()
    || parentPayload.taskId !== scope.id || parentPayload.rootTaskId !== scope.rootTaskId
    || !/^[0-9a-f]{64}$/.test(parent.payloadDigest) || !seq[0] || parentSequence >= seq[0]
    || started.causationId !== parent.id) return null
  const startPayload = record(started?.payload), modelStartPayload = record(modelStarted?.payload)
  const modelDonePayload = record(modelCompleted?.payload), usagePayload = record(usage?.payload)
  const agendaReceipt = parseCognitiveAgendaReceipt(agenda?.payload, { sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.id, stepId })
  if (!started || !agenda || !modelStarted || !modelCompleted || !usage || !itemStarted || !callStarted
    || events.some(event => event.actor !== "subagent") || [started, agenda, modelStarted, modelCompleted, usage].some(event => event.itemId !== null)
    || [started, agenda, modelStarted, modelCompleted, usage, itemStarted].some(event => event.correlationId !== stepId)
    || started.type !== "step.started" || started.causationId !== parent.id || started.idempotencyKey !== keys[0]
    || !exactKeys(startPayload, ["stepId", "ordinal", "taskId"]) || !same(startPayload, { stepId, ordinal, taskId: scope.id })
    || agenda.type !== "cognitive.agenda" || agenda.causationId !== started.id || agenda.idempotencyKey !== keys[1] || !agendaReceipt
    || modelStarted.type !== "model.started" || modelStarted.causationId !== agenda.id || modelStarted.idempotencyKey !== keys[2]
    || !exactKeys(modelStartPayload, ["taskId", "provider", "model"]) || modelStartPayload.taskId !== scope.id
    || !validText(modelStartPayload.provider) || !validText(modelStartPayload.model)
    || modelCompleted.type !== "model.completed" || modelCompleted.causationId !== modelStarted.id || modelCompleted.idempotencyKey !== keys[3]
    || !exactKeys(modelDonePayload, ["taskId", "provider", "model", "toolCallCount"]) || modelDonePayload.taskId !== scope.id
    || modelDonePayload.provider !== modelStartPayload.provider || modelDonePayload.model !== modelStartPayload.model
    || typeof modelDonePayload.toolCallCount !== "number" || !Number.isSafeInteger(modelDonePayload.toolCallCount)
    || modelDonePayload.toolCallCount < 1 || modelDonePayload.toolCallCount > MAX_STEP_TOOL_CALLS
    || usage.type !== "model.usage" || usage.causationId !== modelCompleted.id || usage.idempotencyKey !== keys[4]
    || !exactKeys(usagePayload, ["taskId", "provider", "model", "usage"]) || usagePayload.taskId !== scope.id
    || usagePayload.provider !== modelStartPayload.provider || usagePayload.model !== modelStartPayload.model || !usageValid(usagePayload.usage)
    || itemStarted.type !== "item.started" || itemStarted.itemId !== item.id || itemStarted.causationId !== usage.id
    || itemStarted.idempotencyKey !== keys[5] || !same(itemStarted.payload, { itemId: item.id, type: "tool_call", phase: null })
    || callStarted.type !== "tool_call.started" || callStarted.actor !== "subagent" || callStarted.itemId !== item.id
    || callStarted.correlationId !== callId || callStarted.causationId !== itemStarted.id || callStarted.idempotencyKey !== keys[6]
    || !same(callStarted.payload, { toolCallId: callId, toolName: "wait_subagents", taskId: scope.id })) return null
  const selectedIds = new Set(events.map(event => event.id)), resultItemId = `task:${scope.id}:item:tool-result:${callId}:attempt:${currentAttempt}`
  if (input.windowEvents.some(event => (event.correlationId === stepId || event.itemId === item.id || event.itemId === resultItemId
    || event.correlationId === callId || event.correlationId === resultItemId || selectedIds.has(event.causationId ?? "")) && !selectedIds.has(event.id))) return null
  const terminalRows = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
    AND (("type" = 'step.completed' AND ("correlationId" = $4 OR "idempotencyKey" = $5))
      OR ("type" IN ('tool_call.completed','tool_call.failed','tool_call.interrupted') AND ("correlationId" = $6 OR "itemId" = $7 OR "idempotencyKey" = $8))
      OR ("type" IN ('item.completed','item.failed','item.interrupted') AND "itemId" IN ($7, $9)) OR "correlationId" = $9
      OR "idempotencyKey" IN ($10, $11, $12)) LIMIT 1`,
  [scope.sessionId, scope.turnId, scope.id, stepId, prefix + `step-completed:${stepId}`, callId, item.id,
    prefix + `tool-finished:${callId}`, resultItemId, prefix + `tool-call-completed:${callId}:${item.id}:1`,
    prefix + `item-started:${resultItemId}`, prefix + `tool-result-completed:${callId}:${resultItemId}:1`])
  if (terminalRows.rows.length) return null
  return { stepId, attempt: currentAttempt!, ordinal, callItemId: item.id, callId, parent: parentSignature(parent),
    sourceCallContentDigest: sourceItem.contentDigest, sourceInputDigest: sourceItem.sourceInputDigest,
    redactedInputDigest: item.inputDigest, events: events.map(signature), item: itemSignature(item) }
}
