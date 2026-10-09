import { createHash } from "node:crypto"

import { Prisma } from "@prisma/client"

import { parseCognitiveAgendaReceipt } from "../../../../components/agent-workspace/v2/cognitive-agenda-view"
import { AgentCommandError } from "./errors"
import type { CommandTransaction } from "./transaction"

export const MAX_UNRESOLVED_STEERING_INPUTS = 128
const MAX_SEQUENCE = BigInt("9223372036854775807")
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
const INPUT_STATUSES = new Set(["accepted", "queued", "consumed", "cancelled", "rejected"])
type Row = Record<string, unknown>
type Candidate = { id: string; acceptedSequence: bigint; status: "accepted" | "queued" | "consumed"; consumedByStepId: string | null; consumer: Step | null }
type Step = { id: string; taskId: string | null; ordinal: number; attempt: number; status: string; cursor: bigint; ids: string[] }
type Receipt = { sessionId: string; turnId: string; rootTaskId: string; stepId: string; decision: "keep" | "revise"; observedRevision: number; resultingRevision: number; steerInputIds: string[]; through: bigint }
type StoredReceipt = { receipt: Receipt; sequence: bigint; idempotencyKey: string }

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const proto = Object.getPrototypeOf(parsed)
  return proto === Object.prototype || proto === null ? parsed as Row : null
}
function exact(row: Row, keys: readonly string[]): boolean { return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= BigInt(0) && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function rootClientMessageId(value: unknown): string | null | undefined {
  const envelope = object(value), nested = object(envelope?.input), source = nested && Object.keys(nested).length ? nested : envelope
  if (!source || !Object.hasOwn(source, "clientMessageId")) return undefined
  return id(source.clientMessageId) ? source.clientMessageId : null
}
function failClosed(): never {
  throw new AgentCommandError("invalid_command", "The current Turn's steering history could not be validated", 409)
}
function parseReceipt(value: unknown, sessionId: string, turnId: string, rootTaskId: string): Receipt | null {
  const row = object(value)
  if (!row || !exact(row, ["schemaVersion", "sessionId", "turnId", "rootTaskId", "stepId", "decision", "observedRevision", "resultingRevision", "steerInputIds", "inputCheckpoint"])
    || row.schemaVersion !== "agent-harness.v2.plan-reconciliation.v1" || row.sessionId !== sessionId || row.turnId !== turnId || row.rootTaskId !== rootTaskId
    || !id(row.stepId) || row.decision !== "keep" && row.decision !== "revise" || !Number.isSafeInteger(row.observedRevision) || Number(row.observedRevision) < 0
    || !Number.isSafeInteger(row.resultingRevision) || Number(row.resultingRevision) < 0
    || row.resultingRevision !== (row.decision === "keep" ? row.observedRevision : Number(row.observedRevision) + 1)
    || !Array.isArray(row.steerInputIds)) return null
  const steerInputIds = row.steerInputIds
  if (steerInputIds.length === 0 || steerInputIds.length > MAX_UNRESOLVED_STEERING_INPUTS || !steerInputIds.every(id)
    || new Set(steerInputIds).size !== steerInputIds.length
    || steerInputIds.some((value, index) => index > 0 && String(steerInputIds[index - 1]) >= value)) return null
  const checkpoint = object(row.inputCheckpoint)
  const through = checkpoint && exact(checkpoint, ["throughSequence"]) ? sequence(checkpoint.throughSequence) : null
  if (through === null) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 16 * 1024) return null
  } catch { return null }
  return { sessionId, turnId, rootTaskId, stepId: row.stepId, decision: row.decision,
    observedRevision: Number(row.observedRevision), resultingRevision: Number(row.resultingRevision),
    steerInputIds: steerInputIds as string[], through }
}
function stepFrom(row: Row): Step | null {
  const cursor = sequence(row.inputThroughSequence), parsedIds = typeof row.consumedInputIds === "string"
    ? (() => { try { return JSON.parse(row.consumedInputIds) as unknown } catch { return null } })() : row.consumedInputIds
  if (!id(row.id) || !(row.taskId === null || id(row.taskId)) || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || typeof row.status !== "string" || !STEP_STATUSES.has(row.status)
    || cursor === null || !Array.isArray(parsedIds) || parsedIds.length > 256 || new Set(parsedIds).size !== parsedIds.length || !parsedIds.every(id)) return null
  return { id: row.id, taskId: row.taskId as string | null, ordinal: Number(row.ordinal), attempt: Number(row.attempt), status: row.status, cursor, ids: parsedIds as string[] }
}
function acceptedSource(row: Row, turnId: string): "user" | "automation" | "system" | null {
  const payload = object(row.acceptedPayload)
  if (!payload || !exact(payload, ["clientMessageId", "delivery", "disposition", "inputId", "source"]) || row.acceptedType !== "input.accepted"
    || row.acceptedTaskId !== null || row.acceptedEventSequence === null || row.acceptedCorrelationId !== turnId || !id(row.acceptedItemId)
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStatus !== "completed"
    || payload.inputId !== row.id || payload.clientMessageId !== row.clientMessageId || payload.delivery !== row.delivery
    || typeof payload.disposition !== "string" || !payload.disposition.trim()
    || payload.source !== "user" && payload.source !== "automation" && payload.source !== "system") return null
  const item = object(row.acceptedItemContent)
  if (!item || !exact(item, ["clientMessageId", "disposition", "parts", "source"]) || !Array.isArray(item.parts)
    || item.clientMessageId !== payload.clientMessageId || item.source !== payload.source || item.disposition !== payload.disposition) return null
  const source = payload.source as "user" | "automation" | "system"
  return row.acceptedActor === (source === "user" ? "user" : "system") ? source : null
}
function callMatches(row: Row, scope: { userId: string; sessionId: string; turnId: string; rootTaskId: string }, stored: StoredReceipt): boolean {
  const receipt = stored.receipt
  const payload = object(row.payload), content = object(row.itemContent), input = object(content?.input)
  const callId = row.correlationId
  const toolName = receipt.decision === "keep" ? "agent.reconcile" : "agent.plan"
  const inputKeys = receipt.decision === "keep" ? ["decision", "expectedRevision"] : ["expectedRevision", "nodes"]
  const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, receipt.stepId, callId])
  const receiptKey = `agent.plan.reconciliation:sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`
  return id(callId) && row.type === "tool_call.started" && row.actor === "orchestrator" && row.eventTaskId === scope.rootTaskId
    && row.eventItemId === row.callItemId && row.correlationId === callId && row.idempotencyKey === `turn:${scope.turnId}:event:tool-started:${callId}`
    && payload !== null && exact(payload, ["taskId", "toolCallId", "toolName"]) && payload.taskId === scope.rootTaskId && payload.toolCallId === callId && payload.toolName === toolName
    && row.stepId === receipt.stepId && row.itemTaskId === scope.rootTaskId && row.itemType === "tool_call"
    && content !== null && content.toolCallId === callId && content.toolName === toolName && content.toolVersion === "1"
    && input !== null && exact(input, inputKeys) && input.expectedRevision === receipt.observedRevision
    && (receipt.decision === "keep" ? input.decision === "keep" : Array.isArray(input.nodes) && input.nodes.length > 0)
    && stored.idempotencyKey === receiptKey
}

/** Reads the Worker-equivalent unresolved set through the caller's existing Session-locked transaction. */
export async function readUnresolvedSteeringCount(tx: CommandTransaction, scope: { sessionId: string; userId: string; turnId: string }): Promise<number> {
  const turns = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "input", "rootTaskId" FROM "agent_turns" WHERE "id" = ${scope.turnId} AND "sessionId" = ${scope.sessionId} AND "userId" = ${scope.userId}`)
  if (turns.length !== 1) return failClosed()
  const turnInput = turns[0]?.input, rootTaskId = turns[0]?.rootTaskId
  if (rootTaskId !== null && !id(rootTaskId)) return failClosed()
  const rootId = typeof rootTaskId === "string" ? rootTaskId : null
  let rootAttemptCount = 0, graphRevision = 0
  if (rootId) {
    const roots = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "sessionId", "turnId", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ${rootId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId}`)
    if (roots.length !== 1 || roots[0]?.id !== rootId || !Number.isSafeInteger(roots[0]?.attemptCount) || Number(roots[0]?.attemptCount) < 0) return failClosed()
    rootAttemptCount = Number(roots[0]?.attemptCount)
    const graphId = `task-graph-${createHash("sha256").update(rootId).digest("hex")}`
    const graphs = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "revision" FROM "agent_items" WHERE "id" = ${graphId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId} AND "taskId" = ${rootId} AND "type" = 'task_graph'`)
    if (graphs.length > 1) return failClosed()
    if (graphs.length) {
      graphRevision = Number(graphs[0]?.revision)
      if (!Number.isSafeInteger(graphRevision) || graphRevision < 0) return failClosed()
    }
  }
  const inputs = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT input."id", input."clientMessageId", input."delivery", input."status", input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt",
      event."type" AS "acceptedType", event."actor" AS "acceptedActor", event."taskId" AS "acceptedTaskId", event."correlationId" AS "acceptedCorrelationId", event."itemId" AS "acceptedItemId", event."sequence" AS "acceptedEventSequence", event."payload" AS "acceptedPayload",
      accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId", accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
    FROM "agent_inputs" AS input LEFT JOIN "agent_events" AS event ON event."sessionId" = input."sessionId" AND event."turnId" = input."targetTurnId" AND event."sequence" = input."acceptedSequence"
    LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = event."itemId" AND accepted_item."sessionId" = input."sessionId" AND accepted_item."turnId" = input."targetTurnId"
    WHERE input."sessionId" = ${scope.sessionId} AND input."targetTurnId" = ${scope.turnId} AND input."userId" = ${scope.userId} ORDER BY input."acceptedSequence", input."id"`)
  type ParsedInput = Row & { id: string; clientMessageId: string; acceptedSequence: bigint; status: string; delivery: string }
  const parsed: ParsedInput[] = inputs.map(row => {
    const acceptedSequence = sequence(row.acceptedSequence)
    if (!id(row.id) || !id(row.clientMessageId) || acceptedSequence === null || !["steer", "follow_up"].includes(String(row.delivery)) || !INPUT_STATUSES.has(String(row.status))
      || !(row.consumedByStepId === null || id(row.consumedByStepId)) || !(row.consumedAt === null || validDate(row.consumedAt))
      || !(row.cancelledAt === null || validDate(row.cancelledAt))) return failClosed()
    return { ...row, id: row.id, clientMessageId: row.clientMessageId, acceptedSequence, status: String(row.status), delivery: String(row.delivery) }
  })
  const bound = rootClientMessageId(turnInput)
  if (bound === null) return failClosed()
  const rootMatches = bound === undefined ? [] : parsed.filter(row => row.clientMessageId === bound)
  if (bound !== undefined && rootMatches.length !== 1) return failClosed()
  const originalInputId = rootMatches[0]?.id
  const current: Candidate[] = []
  for (const row of parsed) {
    if (row.id === originalInputId || row.delivery !== "steer" || !["accepted", "queued", "consumed"].includes(row.status)) continue
    const source = acceptedSource(row, scope.turnId)
    if (!source || sequence(row.acceptedEventSequence) !== row.acceptedSequence) return failClosed()
    if (row.status === "consumed") {
      if (!row.consumedByStepId || !validDate(row.consumedAt) || row.cancelledAt !== null) return failClosed()
    } else if (row.consumedByStepId !== null || row.consumedAt !== null || row.cancelledAt !== null) return failClosed()
    if (source === "user") current.push({ id: row.id, acceptedSequence: row.acceptedSequence, status: row.status as Candidate["status"], consumedByStepId: row.consumedByStepId as string | null, consumer: null })
  }
  const receiptRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'agent.plan.reconciliation' ORDER BY event."sequence" ASC`)
  if (receiptRows.length > 256) return failClosed()
  const receipts: StoredReceipt[] = receiptRows.map(row => {
    const receipt = rootId ? parseReceipt(row.payload, scope.sessionId, scope.turnId, rootId) : null
    const sequenceValue = sequence(row.sequence)
    if (!receipt || row.itemId !== null || row.taskId !== rootId || row.type !== "agent.plan.reconciliation" || row.actor !== "orchestrator"
      || row.correlationId !== scope.turnId || row.causationId !== receipt.stepId || row.hasOutbox !== false
      || typeof row.idempotencyKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(row.idempotencyKey) || sequenceValue === null) return failClosed()
    return { receipt, sequence: sequenceValue, idempotencyKey: row.idempotencyKey }
  })
  const historyStepIds = [...new Set(receipts.map(entry => entry.receipt.stepId))]
  const callRows = historyStepIds.length ? await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'tool_call.started' AND event."taskId" = ${rootId}
      AND item."taskId" = ${rootId} AND item."type" = 'tool_call' AND item."stepId" = ANY(${historyStepIds}::text[])`) : []
  if (callRows.length > 512) return failClosed()
  const stepIds = [...new Set([...current.map(input => input.consumedByStepId).filter((value): value is string => value !== null), ...historyStepIds])]
  let steps = new Map<string, Step>()
  if (stepIds.length) {
    if (!rootId) return failClosed()
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds" FROM "agent_steps"
      WHERE "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId} AND "taskId" = ${rootId} AND "id" = ANY(${stepIds}::text[])`)
    if (rows.length !== stepIds.length) return failClosed()
    steps = new Map()
    for (const row of rows) {
      const step = stepFrom(row)
      if (!step || step.taskId !== rootId || step.attempt > rootAttemptCount) return failClosed()
      steps.set(step.id, step)
    }
  }
  for (const input of current) {
    if (!input.consumedByStepId) continue
    const consumer = steps.get(input.consumedByStepId)
    if (!consumer || !consumer.ids.includes(input.id) || consumer.cursor < input.acceptedSequence) return failClosed()
    input.consumer = consumer
  }
  const agendas = new Map<string, number>()
  if (historyStepIds.length && rootId) {
    const agendaRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."actor", event."itemId", event."taskId", event."correlationId", event."payload" FROM "agent_events" AS event
      WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'cognitive.agenda' AND event."taskId" = ${rootId}
        AND event."itemId" IS NULL AND event."correlationId" = ANY(${historyStepIds}::text[]) ORDER BY event."sequence" ASC`)
    for (const row of agendaRows) {
      const stepId = String(row.correlationId), agenda = parseCognitiveAgendaReceipt(object(row.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: rootId, stepId })
      if (!agenda || row.itemId !== null || row.taskId !== rootId || !["subagent", "orchestrator"].includes(String(row.actor)) || agendas.has(stepId)) return failClosed()
      agendas.set(stepId, agenda.planRevision ?? -1)
    }
    if (agendas.size !== historyStepIds.length) return failClosed()
  }
  const resolved = new Set<string>()
  let previousSequence = BigInt(-1)
  for (const stored of receipts) {
    const { receipt } = stored, step = steps.get(receipt.stepId)
    if (!step || agendas.get(step.id) !== receipt.observedRevision || step.cursor !== receipt.through || receipt.resultingRevision > graphRevision || stored.sequence <= previousSequence) return failClosed()
    previousSequence = stored.sequence
    if (!rootId) return failClosed()
    const calls = callRows.filter(row => callMatches(row, { ...scope, rootTaskId: rootId }, stored))
    if (calls.length !== 1) return failClosed()
    const expected = current.filter(input => input.acceptedSequence <= receipt.through && !resolved.has(input.id))
    if (expected.some(input => !input.consumer || input.consumer.ordinal > step.ordinal || input.consumer.ordinal === step.ordinal && input.consumer.attempt > step.attempt)
      || expected.map(input => input.id).sort().join("\0") !== receipt.steerInputIds.join("\0")) return failClosed()
    expected.forEach(input => resolved.add(input.id))
  }
  return current.length - resolved.size
}

export async function assertSteeringCapacity(tx: CommandTransaction, scope: { sessionId: string; userId: string; turnId: string }): Promise<void> {
  const unresolvedCount = await readUnresolvedSteeringCount(tx, scope)
  if (unresolvedCount >= MAX_UNRESOLVED_STEERING_INPUTS) {
    throw new AgentCommandError("invalid_command", "This Turn has reached its steering capacity", 409,
      { capacity: MAX_UNRESOLVED_STEERING_INPUTS, unresolvedCount })
  }
}
