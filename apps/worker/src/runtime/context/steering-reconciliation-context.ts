import type pg from "pg"
import type { InputContentPart } from "@jobcopilot/agent-protocol"
import type { StoredAgentInput } from "./input-claim-store.js"
import type { RootInputContextRow } from "./root-input-context-reader.js"
import type { SteeringReconciliationScope } from "../subagents/steering-reconciliation-contract.js"
import { readSteeringReconciliationState } from "../subagents/steering-reconciliation-read.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type HydrationRow = RootInputContextRow & Readonly<{
  acceptedType: unknown; acceptedActor: unknown; acceptedTaskId: unknown; acceptedCorrelationId: unknown
  acceptedEventSequence: unknown; acceptedPayload: unknown; acceptedItemId: unknown; acceptedItemType: unknown
  acceptedItemTaskId: unknown; acceptedItemStatus: unknown; acceptedItemContent: unknown; cancelledAt: unknown
}>
export type HydrationScope = Omit<SteeringReconciliationScope, "stepId">
type ErrorFactory = (message: string) => Error

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  if (prototype !== Object.prototype && prototype !== null) return null
  return parsed as Row
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") throw new TypeError("Invalid accepted input parts")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError("Invalid accepted input parts")
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) result[key] = canonical((value as Row)[key])
  return result
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function assertAcceptedUserParts(row: HydrationRow, input: StoredAgentInput, turnId: string, fail: ErrorFactory): void {
  const payload = object(row.acceptedPayload)
  const item = object(row.acceptedItemContent)
  const payloadKeys = payload && Object.keys(payload).sort().join(",")
  const itemKeys = item && Object.keys(item).sort().join(",")
  const sequence = typeof row.acceptedEventSequence === "bigint" || typeof row.acceptedEventSequence === "number" || typeof row.acceptedEventSequence === "string"
    ? BigInt(row.acceptedEventSequence) : -1n
  if (row.acceptedType !== "input.accepted" || row.acceptedActor !== "user" || row.acceptedTaskId !== null
    || row.acceptedCorrelationId !== turnId || sequence !== input.acceptedSequence || typeof row.acceptedItemId !== "string"
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStatus !== "completed"
    || payloadKeys !== "clientMessageId,delivery,disposition,inputId,source" || payload?.inputId !== input.id
    || payload.clientMessageId !== input.clientMessageId || payload.delivery !== "steer" || payload.source !== "user"
    || typeof payload.disposition !== "string" || !payload.disposition.trim()
    || itemKeys !== "clientMessageId,disposition,parts,source" || item?.clientMessageId !== input.clientMessageId
    || item.disposition !== payload.disposition || item.source !== "user" || !Array.isArray(item.parts)) throw fail("Accepted user steering provenance is invalid")
  try {
    if (!jsonEqual(input.content, item.parts)) throw fail("Accepted user steering content changed")
  } catch (error: unknown) {
    if (error instanceof TypeError) throw fail("Accepted user steering content is invalid")
    throw error
  }
}

export function createStoredAgentInputMapper(fail: ErrorFactory): (row: RootInputContextRow) => StoredAgentInput {
  function required(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw fail(`Invalid ${field}`)
    return value
  }
  function content(value: unknown): InputContentPart[] {
    if (!Array.isArray(value) || value.length === 0) throw fail("Invalid AgentInput content")
    return value.map(part => {
      if (!part || typeof part !== "object" || Array.isArray(part)) throw fail("Invalid AgentInput content part")
      const row = part as Row
      if (row.type === "text") return { type: "text", text: required(row.text, "text part") }
      if (row.type === "attachment_ref") return { type: "attachment_ref", attachmentId: required(row.attachmentId, "attachmentId"), mediaType: required(row.mediaType, "mediaType"), ...(row.filename === undefined ? {} : { filename: required(row.filename, "filename") }) }
      throw fail("Unknown AgentInput content part")
    })
  }
  function inputDate(value: unknown, field: string, nullable: false): Date
  function inputDate(value: unknown, field: string, nullable: true): Date | null
  function inputDate(value: unknown, field: string, nullable: boolean): Date | null {
    if (value === null && nullable) return null
    const result = value instanceof Date ? new Date(value) : typeof value === "string" ? new Date(value) : null
    if (!result || Number.isNaN(result.getTime())) throw fail(`Invalid ${field}`)
    return result
  }
  return row => {
    const delivery = row.delivery === "steer" || row.delivery === "follow_up" ? row.delivery : null
    const status = ["accepted", "queued", "consumed", "cancelled", "rejected"].includes(row.status) ? row.status as StoredAgentInput["status"] : null
    if (!delivery || !status) throw fail("Invalid AgentInput state")
    const createdAt = inputDate(row.createdAt, "createdAt", false)
    return {
      id: required(row.id, "id"), sessionId: required(row.sessionId, "sessionId"), targetTurnId: row.targetTurnId,
      userId: required(row.userId, "userId"), clientMessageId: required(row.clientMessageId, "clientMessageId"), delivery, status,
      content: content(row.content), acceptedSequence: BigInt(row.acceptedSequence), consumedByStepId: row.consumedByStepId,
      consumedAt: inputDate(row.consumedAt, "consumedAt", true), createdAt,
    }
  }
}

export async function loadUnresolvedSteeringContext(
  client: Client,
  scope: HydrationScope,
  mapInput: (row: RootInputContextRow) => StoredAgentInput,
  fail: ErrorFactory,
): Promise<readonly StoredAgentInput[]> {
  if (Object.hasOwn(scope, "stepId") && (scope as { stepId?: unknown }).stepId !== undefined) throw fail("Historical steering read must omit the current Step")
  const state = await readSteeringReconciliationState(client, scope)
  const expectedIds = state.unresolvedInputs.map(input => input.id)
  if (new Set(expectedIds).size !== expectedIds.length) throw fail("Duplicate unresolved steering identity")
  if (!expectedIds.length) return []
  const result = await client.query<HydrationRow>(
    `SELECT input."id", input."sessionId", input."targetTurnId", input."userId", input."clientMessageId", input."delivery", input."status", input."content", input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."createdAt", input."cancelledAt",
            event."type" AS "acceptedType", event."actor" AS "acceptedActor", event."taskId" AS "acceptedTaskId", event."correlationId" AS "acceptedCorrelationId", event."sequence" AS "acceptedEventSequence", event."payload" AS "acceptedPayload", event."itemId" AS "acceptedItemId",
            accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId", accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
     FROM "agent_inputs" AS input
     JOIN "agent_events" AS event ON event."sessionId" = input."sessionId" AND event."turnId" = input."targetTurnId" AND event."sequence" = input."acceptedSequence"
     JOIN "agent_items" AS accepted_item ON accepted_item."id" = event."itemId" AND accepted_item."sessionId" = input."sessionId" AND accepted_item."turnId" = input."targetTurnId"
     WHERE input."sessionId" = $1 AND input."targetTurnId" = $2 AND input."userId" = $3 AND input."delivery" = 'steer' AND input."id" = ANY($4::text[])
     ORDER BY input."acceptedSequence" ASC, input."id" ASC`,
    [scope.sessionId, scope.turnId, scope.userId, expectedIds],
  )
  if (result.rows.length !== expectedIds.length) throw fail("Unresolved steering input is missing its accepted user item")
  const expected = new Set(expectedIds), seen = new Set<string>()
  const inputs = result.rows.map(row => {
    const input = mapInput(row)
    if (!expected.has(input.id) || seen.has(input.id) || input.sessionId !== scope.sessionId || input.targetTurnId !== scope.turnId
      || input.userId !== scope.userId || input.delivery !== "steer" || !["accepted", "queued", "consumed"].includes(input.status)
      || row.cancelledAt !== null) throw fail("Unresolved steering input is outside its accepted owner scope")
    seen.add(input.id)
    assertAcceptedUserParts(row, input, scope.turnId, fail)
    return input
  })
  if (seen.size !== expected.size) throw fail("Unresolved steering hydration is incomplete")
  return inputs
}
