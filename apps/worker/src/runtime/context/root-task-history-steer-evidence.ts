import {
  AgentEventEnvelopeSchema, AgentInputSchema, AgentItemSchema, schemaVersion, validate,
  type TenantScope,
} from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { assertInputClaimOwnerFence, type InputClaimQueryClient, type TurnExecutionFence } from "./input-claim-store.js"

export type RootTaskHistorySteerEvidence = Readonly<{ kind: "no_accepted_steer" | "accepted_steer" | "unsafe" }>
export type RootTaskHistorySteerEvidenceRequest = Readonly<{ sessionId: string; turnId: string; stepId: string; lease: TurnExecutionFence }>
type Row = Record<string, unknown>
type InputEvidence = Readonly<{ id: string; clientMessageId: string; delivery: string; sequence: bigint; content: unknown }>
const MAX_INPUT_EVIDENCE = 64
const UNSAFE: RootTaskHistorySteerEvidence = Object.freeze({ kind: "unsafe" })
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function timestamp(value: unknown): string | null {
  const date = value instanceof Date ? new Date(value) : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function sequence(value: unknown): bigint | null {
  try {
    const parsed = typeof value === "bigint" ? value : typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? BigInt(value) : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null
    return parsed !== null && parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null
  } catch { return null }
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  const object = record(value)
  if (!object || Object.getOwnPropertySymbols(value as object).length) throw new TypeError("Invalid accepted input parts")
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]))
}
function equalJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}
function inputIdMatches(value: unknown, id: string): boolean {
  return value === id || UUID.test(id) && value === redactSensitiveText(id)
}
function parseInput(row: Row, scope: TenantScope, request: RootTaskHistorySteerEvidenceRequest): InputEvidence | null {
  const createdAt = timestamp(row.createdAt), consumedAt = row.consumedAt === null ? null : timestamp(row.consumedAt)
  const cancelledAt = row.cancelledAt === null ? null : timestamp(row.cancelledAt)
  const acceptedSequence = sequence(row.acceptedSequence)
  const status = row.status, consumedByStepId = row.consumedByStepId
  const hasConsumer = typeof consumedByStepId === "string" && consumedByStepId.length > 0
  const hasConsumedAt = consumedAt !== null
  if (acceptedSequence === null || createdAt === null || row.sessionId !== request.sessionId || row.targetTurnId !== request.turnId
    || row.userId !== scope.userId || !(consumedByStepId === null || hasConsumer) || hasConsumer !== hasConsumedAt
    || status === "consumed" && (!hasConsumer || cancelledAt !== null)
    || status === "cancelled" && cancelledAt === null
    || status !== "cancelled" && cancelledAt !== null
    || status !== "consumed" && status !== "cancelled" && hasConsumer) return null
  const input = { schemaVersion, id: row.id, clientMessageId: row.clientMessageId, sessionId: row.sessionId,
    turnId: row.targetTurnId, delivery: row.delivery, state: status, content: row.content, createdAt, consumedAt }
  if (!validate(AgentInputSchema, input) || typeof row.id !== "string" || typeof row.clientMessageId !== "string") return null
  return { id: row.id, clientMessageId: row.clientMessageId, delivery: String(row.delivery), sequence: acceptedSequence, content: row.content }
}
function parseEvent(row: Row, input: InputEvidence, sessionId: string, turnId: string): { id: string; inputId: string; clientMessageId: string; delivery: string; sequence: bigint; parts: unknown } | null {
  const payload = record(row.acceptedPayload), item = record(row.acceptedItemContent)
  const payloadKeys = payload && Object.keys(payload).sort().join(",")
  const itemKeys = item && Object.keys(item).sort().join(",")
  const acceptedSequence = sequence(row.acceptedEventSequence), createdAt = timestamp(row.acceptedEventCreatedAt)
  if (!payload || !item || acceptedSequence === null || createdAt === null
    || payloadKeys !== "clientMessageId,delivery,disposition,inputId,source"
    || !inputIdMatches(payload.inputId, input.id) || payload.clientMessageId !== redactSensitiveText(input.clientMessageId)
    || (payload.delivery !== "steer" && payload.delivery !== "follow_up")
    || typeof payload.disposition !== "string" || !payload.disposition.trim()
    || (payload.source !== "user" && payload.source !== "automation" && payload.source !== "system")
    || row.acceptedType !== "input.accepted" || row.acceptedActor !== (payload.source === "user" ? "user" : "system")
    || row.acceptedTaskId !== null || row.acceptedCorrelationId !== turnId
    || row.acceptedEventCausationId !== null
    || row.acceptedEventSessionId !== sessionId || row.acceptedEventTurnId !== turnId
    || row.acceptedItemId !== row.acceptedEventItemId || typeof row.acceptedItemId !== "string"
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStatus !== "completed"
    || itemKeys !== "clientMessageId,disposition,parts,source" || !Array.isArray(item.parts)
    || row.acceptedItemStepId !== null || item.clientMessageId !== input.clientMessageId
    || item.disposition !== payload.disposition || item.source !== payload.source || !equalJson(item.parts, input.content)) return null
  const envelope = { schemaVersion, id: row.acceptedEventId, sessionId: row.acceptedEventSessionId, turnId: row.acceptedEventTurnId,
    itemId: row.acceptedEventItemId, taskId: row.acceptedTaskId, sequence: Number(acceptedSequence), type: row.acceptedType,
    actor: row.acceptedActor, correlationId: row.acceptedCorrelationId, causationId: row.acceptedEventCausationId,
    idempotencyKey: row.acceptedEventIdempotencyKey, payload: row.acceptedPayload, createdAt }
  const itemEnvelope = { schemaVersion, id: row.acceptedItemId, sessionId: row.acceptedItemSessionId, turnId: row.acceptedItemTurnId,
    stepId: row.acceptedItemStepId, status: row.acceptedItemStatus, createdAt: timestamp(row.acceptedItemCreatedAt),
    updatedAt: timestamp(row.acceptedItemUpdatedAt), type: row.acceptedItemType, data: row.acceptedItemContent }
  if (!validate(AgentEventEnvelopeSchema, envelope) || !validate(AgentItemSchema, itemEnvelope)
    || row.acceptedEventSessionId !== row.acceptedItemSessionId || row.acceptedEventTurnId !== row.acceptedItemTurnId
    || typeof row.acceptedEventId !== "string") return null
  return { id: String(row.acceptedEventId), inputId: input.id, clientMessageId: input.clientMessageId,
    delivery: payload.delivery, sequence: acceptedSequence, parts: item.parts }
}

/**
 * Classify steer provenance on the same transaction client used to claim inputs and persist the Step checkpoint.
 * This acquires the owner locks on that client; the caller must retain the transaction through context commit.
 */
export async function readRootTaskHistorySteerEvidence(
  client: InputClaimQueryClient, scope: TenantScope, request: RootTaskHistorySteerEvidenceRequest,
): Promise<RootTaskHistorySteerEvidence> {
  await assertInputClaimOwnerFence(client, scope, request, request.lease)
  const root = await client.query<Row>(`SELECT root."id" FROM "agent_turns" AS turn
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
      AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."taskType" = 'root'
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" IS NOT NULL
    FOR UPDATE OF root`, [request.turnId, request.sessionId, scope.userId])
  if (root.rows.length !== 1 || typeof root.rows[0]?.id !== "string") return UNSAFE
  const rootTaskId = root.rows[0].id
  const step = await client.query<Row>(`SELECT "id" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR UPDATE`,
  [request.stepId, request.sessionId, request.turnId, rootTaskId])
  if (step.rows.length !== 1) return UNSAFE
  const inputs = await client.query<Row>(`SELECT "id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt", "cancelledAt", "createdAt"
    FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2
    ORDER BY "acceptedSequence" ASC, "id" ASC LIMIT ${MAX_INPUT_EVIDENCE + 1} FOR SHARE`, [request.sessionId, request.turnId])
  if (inputs.rows.length > MAX_INPUT_EVIDENCE) return UNSAFE
  const events = await client.query<Row>(`SELECT event."id" AS "acceptedEventId", event."sessionId" AS "acceptedEventSessionId", event."turnId" AS "acceptedEventTurnId",
      event."itemId" AS "acceptedEventItemId", event."taskId" AS "acceptedTaskId", event."sequence" AS "acceptedEventSequence", event."type" AS "acceptedType",
      event."actor" AS "acceptedActor", event."correlationId" AS "acceptedCorrelationId", event."causationId" AS "acceptedEventCausationId",
      event."idempotencyKey" AS "acceptedEventIdempotencyKey", event."payload" AS "acceptedPayload", event."createdAt" AS "acceptedEventCreatedAt",
      item."id" AS "acceptedItemId", item."sessionId" AS "acceptedItemSessionId", item."turnId" AS "acceptedItemTurnId", item."stepId" AS "acceptedItemStepId",
      item."taskId" AS "acceptedItemTaskId", item."type" AS "acceptedItemType", item."status" AS "acceptedItemStatus", item."content" AS "acceptedItemContent",
      item."createdAt" AS "acceptedItemCreatedAt", item."updatedAt" AS "acceptedItemUpdatedAt"
    FROM "agent_events" AS event LEFT JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" IS NULL AND event."type" = 'input.accepted'
    ORDER BY event."sequence" ASC, event."id" ASC LIMIT ${MAX_INPUT_EVIDENCE + 1} FOR SHARE OF event`, [request.sessionId, request.turnId])
  if (events.rows.length > MAX_INPUT_EVIDENCE || inputs.rows.length !== events.rows.length) return UNSAFE
  const bySequence = new Map<bigint, InputEvidence>(), inputIds = new Set<string>(), inputSequences = new Set<bigint>(), clientMessages = new Set<string>()
  for (const row of inputs.rows) {
    const input = parseInput(row, scope, request)
    if (!input || inputIds.has(input.id) || inputSequences.has(input.sequence) || clientMessages.has(input.clientMessageId)) return UNSAFE
    inputIds.add(input.id)
    bySequence.set(input.sequence, input); inputSequences.add(input.sequence); clientMessages.add(input.clientMessageId)
  }
  const seenInputs = new Set<string>(), eventIds = new Set<string>(), eventSequences = new Set<bigint>()
  for (const row of events.rows) {
    const eventSequence = sequence(row.acceptedEventSequence), input = eventSequence === null ? undefined : bySequence.get(eventSequence)
    const event = input ? parseEvent(row, input, request.sessionId, request.turnId) : null
    if (!event || !input || seenInputs.has(event.inputId) || eventIds.has(event.id) || eventSequences.has(event.sequence)
      || event.clientMessageId !== input.clientMessageId || event.delivery !== input.delivery || event.sequence !== input.sequence
      || !equalJson(input.content, event.parts)) return UNSAFE
    seenInputs.add(event.inputId); eventIds.add(event.id); eventSequences.add(event.sequence)
  }
  if (seenInputs.size !== inputIds.size) return UNSAFE
  return [...bySequence.values()].some(input => input.delivery === "steer") ? { kind: "accepted_steer" } : { kind: "no_accepted_steer" }
}
