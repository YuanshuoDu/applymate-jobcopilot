import { Prisma } from "@prisma/client"
import {
  OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE,
  OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  ObjectiveLocationSteerReceiptSchema,
  formatObjectiveLocationSteerMessage,
  validate,
} from "@jobcopilot/agent-protocol"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import {
  acceptedSource, exact, id, object, sequence, validDate,
  MAX_UNRESOLVED_STEERING_INPUTS,
} from "../control-plane/commands/steering-capacity-history-validation"
import type { CommandTransaction } from "../control-plane/commands/transaction"

export type ActiveTurnLocationScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}>

export type ActiveTurnLocationAcceptance = Readonly<{
  inputId: string
  acceptedInputSequence: bigint
  receiptSequence: bigint
  locations: readonly string[]
  consumed: boolean
  consumedByStepId: string | null
}>

type Row = Record<string, unknown>
const PAGE_SIZE = MAX_UNRESOLVED_STEERING_INPUTS + 1

function exactObject(value: unknown, keys: readonly string[]): Row | null {
  const row = object(value)
  return row && exact(row, keys) ? row : null
}

function canonicalMessage(partsValue: unknown, locations: readonly string[]): boolean {
  if (!Array.isArray(partsValue) || partsValue.length !== 1) return false
  const part = exactObject(partsValue[0], ["type", "text"])
  return part?.type === "text" && part.text === formatObjectiveLocationSteerMessage(locations)
}

function validInputState(row: Row): boolean {
  if (!id(row.id) || !["accepted", "queued", "consumed"].includes(String(row.status)) || row.cancelledAt !== null) return false
  if (row.status === "consumed") return id(row.consumedByStepId) && validDate(row.consumedAt)
  return row.consumedByStepId === null && row.consumedAt === null
}

/** Returns only owner-bound, canonical typed location confirmations from this Root Turn. */
export async function readActiveTurnLocationAcceptances(
  tx: CommandTransaction,
  scope: ActiveTurnLocationScope,
): Promise<ActiveTurnLocationAcceptance[]> {
  const eventRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."sessionId", event."turnId", event."taskId",
      event."type", event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."sequence", event."payload"
    FROM "agent_events" AS event
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = turn."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId}
      AND event."type" = ${OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE}
      AND event."taskId" = ${scope.rootTaskId} AND turn."userId" = ${scope.userId} AND session."userId" = ${scope.userId}
      AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph' AND turn."rootTaskId" = ${scope.rootTaskId}
      AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."depth" = 0 AND root."role" = 'orchestrator' AND root."taskType" = 'root'
    ORDER BY event."sequence" DESC, event."id" DESC LIMIT ${PAGE_SIZE}`)
  if (!eventRows.length) return []
  if (eventRows.length === PAGE_SIZE) return []
  const causationIds = [...new Set(eventRows.map(row => row.causationId).filter(id))]
  if (!causationIds.length) return []
  const facts = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT input."id", input."sessionId" AS "inputSessionId", input."targetTurnId" AS "inputTargetTurnId",
      input."userId" AS "inputUserId", input."clientMessageId", input."delivery", input."status", input."content" AS "inputContent",
      input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt",
      accepted_event."id" AS "acceptedEventId", accepted_event."sessionId" AS "acceptedEventSessionId", accepted_event."turnId" AS "acceptedEventTurnId",
      accepted_event."sequence" AS "acceptedEventSequence", accepted_event."type" AS "acceptedType", accepted_event."actor" AS "acceptedActor",
      accepted_event."taskId" AS "acceptedEventTaskId", accepted_event."correlationId" AS "acceptedEventCorrelationId",
      accepted_event."causationId" AS "acceptedEventCausationId", accepted_event."itemId" AS "acceptedItemId", accepted_event."payload" AS "acceptedPayload",
      accepted_item."id" AS "acceptedItemRowId", accepted_item."sessionId" AS "acceptedItemSessionId", accepted_item."turnId" AS "acceptedItemTurnId",
      accepted_item."stepId" AS "acceptedItemStepId", accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId",
      accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
    FROM "agent_events" AS accepted_event
    JOIN "agent_inputs" AS input ON input."sessionId" = accepted_event."sessionId" AND input."targetTurnId" = accepted_event."turnId"
      AND input."userId" = ${scope.userId} AND input."acceptedSequence" = accepted_event."sequence"
    LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = accepted_event."itemId"
      AND accepted_item."sessionId" = accepted_event."sessionId" AND accepted_item."turnId" = accepted_event."turnId"
    WHERE accepted_event."id" = ANY(${causationIds}::text[]) AND accepted_event."sessionId" = ${scope.sessionId}
      AND accepted_event."turnId" = ${scope.turnId}`)
  const duplicateRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."causationId", COUNT(*)::int AS "count"
    FROM "agent_events" AS event WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId}
      AND event."type" = ${OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE} AND event."causationId" = ANY(${causationIds}::text[])
    GROUP BY event."causationId"`)
  const factRows = new Map<string, Row[]>(), duplicateCounts = new Map<string, number>()
  for (const fact of facts) {
    const eventId = fact.acceptedEventId
    if (!id(eventId)) continue
    factRows.set(eventId, [...(factRows.get(eventId) ?? []), fact])
  }
  for (const row of duplicateRows) if (id(row.causationId) && Number.isSafeInteger(row.count)) duplicateCounts.set(row.causationId, Number(row.count))

  const parsed: ActiveTurnLocationAcceptance[] = []
  for (const event of eventRows) {
    const causationId = event.causationId
    if (!id(causationId) || duplicateCounts.get(causationId) !== 1) continue
    const matches = factRows.get(causationId)
    if (!matches || matches.length !== 1) continue
    const acceptance = parseActiveTurnLocationAcceptance(event, matches[0]!, scope)
    if (!acceptance) return []
    parsed.push(acceptance)
  }
  parsed.sort((left, right) => left.acceptedInputSequence < right.acceptedInputSequence ? -1 : 1)
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1]!.acceptedInputSequence >= parsed[index]!.acceptedInputSequence
      || parsed[index - 1]!.receiptSequence >= parsed[index]!.receiptSequence) return []
  }
  return parsed
}

export function parseActiveTurnLocationAcceptance(
  eventValue: unknown,
  acceptedFactsValue: unknown,
  scope: ActiveTurnLocationScope,
): ActiveTurnLocationAcceptance | null {
  const event = object(eventValue), facts = object(acceptedFactsValue)
  const payload = exactObject(event?.payload, ["acceptedInputSequence", "locations", "schemaVersion"])
  const rawLocations = payload?.locations
  const locations = Array.isArray(rawLocations) && rawLocations.every(value => typeof value === "string")
    ? normalizeAgentLocationAllowlist(rawLocations as string[]) : null
  const acceptedSequence = sequence(facts?.acceptedSequence), receiptSequence = sequence(event?.sequence)
  const receipt = payload && locations ? { schemaVersion: payload.schemaVersion,
    acceptedInputSequence: payload.acceptedInputSequence, locations: rawLocations } : null
  if (!event || !facts || !payload || !receipt || !validate(ObjectiveLocationSteerReceiptSchema, receipt)
    || payload.schemaVersion !== OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION || !locations
    || !Array.isArray(rawLocations) || locations.length !== rawLocations.length
    || locations.some((location, index) => location !== rawLocations[index])
    || !id(event.id) || event.sessionId !== scope.sessionId || event.turnId !== scope.turnId || event.taskId !== scope.rootTaskId
    || event.type !== OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE || event.actor !== "user" || event.itemId !== null
    || event.correlationId !== scope.turnId || event.causationId !== facts.acceptedEventId
    || receiptSequence === null || acceptedSequence === null || acceptedSequence < BigInt(1) || receiptSequence <= acceptedSequence
    || receipt.acceptedInputSequence !== Number(acceptedSequence) || acceptedSource(facts, scope) !== "user"
    || !validInputState(facts) || !canonicalMessage(facts.inputContent, locations)
    || !canonicalMessage(object(facts.acceptedItemContent)?.parts, locations)) return null
  const clientMessageId = facts.clientMessageId
  const prefix = typeof clientMessageId === "string" ? `agent-objective-locations:${clientMessageId}:` : ""
  const key = event.idempotencyKey
  const revision = typeof key === "string" && key.startsWith(prefix) ? key.slice(prefix.length) : ""
  if (!prefix || !/^(0|[1-9][0-9]{0,15})$/.test(revision) || !Number.isSafeInteger(Number(revision))) return null
  return { inputId: facts.id as string, acceptedInputSequence: acceptedSequence, receiptSequence, locations,
    consumed: facts.status === "consumed", consumedByStepId: facts.consumedByStepId as string | null }
}
