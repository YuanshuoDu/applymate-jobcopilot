import type pg from "pg"
import { OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, ObjectiveLocationSteerReceiptSchema, validate,
  formatObjectiveLocationSteerMessage, type ObjectiveLocationSteerReceipt } from "@jobcopilot/agent-protocol"
import { canonicalJson, normalizeAgentLocationAllowlist, redactSensitiveText } from "@jobcopilot/shared"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type TaskGraphConfirmedLocationSteerScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
export type TaskGraphConfirmedLocationSteerResult = Readonly<{ kind: "absent" | "pending" | "unavailable" }>
  | Readonly<{ kind: "confirmed"; locations: readonly string[]; acceptedInputSequence: bigint; acceptedInputId: string }>
const UNAVAILABLE: TaskGraphConfirmedLocationSteerResult = Object.freeze({ kind: "unavailable" })
const PENDING: TaskGraphConfirmedLocationSteerResult = Object.freeze({ kind: "pending" })
const INPUT_STATUSES = new Set(["accepted", "queued", "consumed"])
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed), descriptors = Object.getOwnPropertyDescriptors(parsed)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0
      && Object.values(descriptors).every(item => item.enumerable && "value" in item) ? parsed as Row : null
  } catch { return null }
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
function inputIdMatches(value: unknown, inputId: string): boolean {
  return value === inputId || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(inputId) && value === redactSensitiveText(inputId)
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
function stringArray(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Array.prototype || parsed.length > 256) return null
  const keys = Reflect.ownKeys(parsed), descriptors = Object.getOwnPropertyDescriptors(parsed)
  if (keys.length !== parsed.length + 1 || keys.some(key => key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parsed.length))) return null
  const result: string[] = []
  for (let index = 0; index < parsed.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !id(descriptor.value)) return null
    result.push(descriptor.value)
  }
  return result
}
function canonicalLocations(value: unknown): readonly string[] | null {
  if (!object(value) || !validate(ObjectiveLocationSteerReceiptSchema, value)) return null
  const receipt = value as ObjectiveLocationSteerReceipt
  const locations = normalizeAgentLocationAllowlist(receipt.locations)
  return locations && sameJson(locations, receipt.locations) ? locations : null
}
function validScope(scope: TaskGraphConfirmedLocationSteerScope): boolean {
  const value = object(scope)
  return Boolean(value && Object.keys(value).sort().join(",") === "rootTaskId,sessionId,turnId,userId"
    && [value.userId, value.sessionId, value.turnId, value.rootTaskId].every(id))
}
function acceptedInputValid(row: Row, scope: TaskGraphConfirmedLocationSteerScope, causationId: string, acceptedSequence: bigint, locations: readonly string[]): boolean {
  const payload = object(row.acceptedPayload), item = object(row.acceptedItemContent), inputSequence = sequence(row.acceptedSequence)
  const expectedContent = [{ type: "text", text: formatObjectiveLocationSteerMessage(locations) }]
  if (!id(row.inputId) || !id(row.clientMessageId) || inputSequence !== acceptedSequence
    || row.inputSessionId !== scope.sessionId || row.inputTurnId !== scope.turnId || row.inputUserId !== scope.userId
    || row.delivery !== "steer" || typeof row.status !== "string" || !INPUT_STATUSES.has(row.status) || row.cancelledAt !== null
    || row.acceptedEventId !== causationId || row.acceptedSessionId !== scope.sessionId || row.acceptedTurnId !== scope.turnId
    || row.acceptedType !== "input.accepted" || row.acceptedActor !== "user" || row.acceptedTaskId !== null
    || row.acceptedCorrelationId !== scope.turnId || row.acceptedCausationId !== null
    || sequence(row.acceptedEventSequence) !== acceptedSequence || !id(row.acceptedItemId)
    || row.acceptedItemId !== row.acceptedItemJoinedId || row.acceptedItemSessionId !== scope.sessionId || row.acceptedItemTurnId !== scope.turnId
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStepId !== null || row.acceptedItemStatus !== "completed"
    || row.acceptedItemPhase !== "commentary" || row.acceptedItemRevision !== 0
    || !payload || Object.keys(payload).sort().join(",") !== "clientMessageId,delivery,disposition,inputId,source"
    || !inputIdMatches(payload.inputId, row.inputId as string) || payload.clientMessageId !== redactSensitiveText(row.clientMessageId as string)
    || payload.delivery !== "steer" || payload.source !== "user" || payload.disposition !== "steered"
    || !item || Object.keys(item).sort().join(",") !== "clientMessageId,disposition,parts,source" || !Array.isArray(item.parts)
    || item.clientMessageId !== row.clientMessageId || item.disposition !== "steered" || item.source !== "user"
    || !sameJson(item.parts, row.inputContent) || !sameJson(row.inputContent, expectedContent)) return false
  return row.status === "consumed"
    ? id(row.consumedByStepId) && row.consumedAt instanceof Date && Number.isFinite(row.consumedAt.getTime())
    : row.consumedByStepId === null && row.consumedAt === null
}
function consumedByOwnedRootStep(row: Row, scope: TaskGraphConfirmedLocationSteerScope, inputId: string, stepId: string, acceptedSequence: bigint): boolean {
  const cursor = sequence(row.inputThroughSequence), consumedIds = stringArray(row.consumedInputIds)
  return row.stepId === stepId && id(row.stepId) && id(row.taskId) && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.taskId === scope.rootTaskId && row.turnRootTaskId === scope.rootTaskId && row.turnUserId === scope.userId && row.sessionUserId === scope.userId
    && Number.isSafeInteger(row.ordinal) && Number(row.ordinal) >= 0 && Number.isSafeInteger(row.attempt) && Number(row.attempt) >= 1
    && typeof row.status === "string" && STEP_STATUSES.has(row.status) && cursor !== null && cursor >= acceptedSequence
    && Array.isArray(consumedIds) && consumedIds.length <= 256 && consumedIds.every(id)
    && new Set(consumedIds).size === consumedIds.length && consumedIds.includes(inputId)
}

/** Reads only the latest owner-bound E2 location acceptance; callers supply their trusted Step cutoff. */
export async function readTaskGraphConfirmedLocationSteer(
  client: Client,
  scope: TaskGraphConfirmedLocationSteerScope,
  consumedThroughSequence: bigint,
): Promise<TaskGraphConfirmedLocationSteerResult> {
  return readConfirmedLocationSteer(client, scope, consumedThroughSequence)
}

/** Revalidates one historical accepted location receipt by its exact input sequence. */
export async function readTaskGraphConfirmedLocationSteerAtSequence(
  client: Client, scope: TaskGraphConfirmedLocationSteerScope, consumedThroughSequence: bigint, acceptedInputSequence: bigint,
): Promise<TaskGraphConfirmedLocationSteerResult> {
  return readConfirmedLocationSteer(client, scope, consumedThroughSequence, acceptedInputSequence)
}

async function readConfirmedLocationSteer(client: Client, scope: TaskGraphConfirmedLocationSteerScope,
  consumedThroughSequence: bigint, exactAcceptedSequence?: bigint): Promise<TaskGraphConfirmedLocationSteerResult> {
  try {
    if (!client || typeof client.query !== "function" || !validScope(scope) || typeof consumedThroughSequence !== "bigint"
      || consumedThroughSequence < 0n || consumedThroughSequence > MAX_SEQUENCE
      || exactAcceptedSequence !== undefined && (typeof exactAcceptedSequence !== "bigint" || exactAcceptedSequence < 1n || exactAcceptedSequence > MAX_SEQUENCE)) return UNAVAILABLE
    const exact = exactAcceptedSequence !== undefined
    const latest = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."taskId", event."sequence", event."type", event."actor",
        event."correlationId", event."causationId", event."itemId", event."payload", turn."rootTaskId" AS "turnRootTaskId",
        turn."userId" AS "turnUserId", session."userId" AS "sessionUserId", turn."source" AS "turnSource", turn."executionMode" AS "turnExecutionMode"
      FROM "agent_events" AS event JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = turn."userId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
        AND turn."userId" = $4 AND session."userId" = $4 ${exact ? `AND event."payload"->>'acceptedInputSequence' = $5` : ""}
      ORDER BY event."sequence" ${exact ? "ASC LIMIT 2" : "DESC LIMIT 1"}`,
    exact ? [scope.sessionId, scope.turnId, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, scope.userId, exactAcceptedSequence!.toString()]
      : [scope.sessionId, scope.turnId, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, scope.userId])
    if (!latest.rows.length) return exact ? UNAVAILABLE : Object.freeze({ kind: "absent" })
    if (latest.rows.length !== 1) return UNAVAILABLE
    const event = latest.rows[0]!, eventSequence = sequence(event.sequence), causationId = event.causationId
    const locations = canonicalLocations(event.payload)
    if (!id(event.id) || eventSequence === null || eventSequence < 1n || event.sessionId !== scope.sessionId || event.turnId !== scope.turnId
      || event.taskId !== scope.rootTaskId || event.turnRootTaskId !== scope.rootTaskId || event.turnUserId !== scope.userId || event.sessionUserId !== scope.userId
      || event.type !== OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE || event.actor !== "user" || event.correlationId !== scope.turnId
      || event.turnSource !== "user" || event.turnExecutionMode !== "canonical_task_graph"
      || event.itemId !== null || !id(causationId) || !locations) return UNAVAILABLE
    const duplicates = await client.query<Row>(`SELECT 1 FROM "agent_events" AS event
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = turn."userId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3 AND event."causationId" = $4 AND event."id" <> $5
        AND turn."rootTaskId" = $6 AND turn."userId" = $7 AND session."userId" = $7 LIMIT 1`,
    [scope.sessionId, scope.turnId, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, causationId, event.id, scope.rootTaskId, scope.userId])
    if (duplicates.rows.length) return UNAVAILABLE
    const accepted = await client.query<Row>(`SELECT input."id" AS "inputId", input."sessionId" AS "inputSessionId", input."targetTurnId" AS "inputTurnId",
        input."userId" AS "inputUserId", input."clientMessageId", input."delivery", input."status", input."content" AS "inputContent",
        input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt", accepted_event."id" AS "acceptedEventId",
        accepted_event."sessionId" AS "acceptedSessionId", accepted_event."turnId" AS "acceptedTurnId", accepted_event."sequence" AS "acceptedEventSequence",
        accepted_event."type" AS "acceptedType", accepted_event."actor" AS "acceptedActor", accepted_event."taskId" AS "acceptedTaskId",
        accepted_event."correlationId" AS "acceptedCorrelationId", accepted_event."causationId" AS "acceptedCausationId", accepted_event."itemId" AS "acceptedItemId",
        accepted_event."payload" AS "acceptedPayload", accepted_item."id" AS "acceptedItemJoinedId", accepted_item."sessionId" AS "acceptedItemSessionId",
        accepted_item."turnId" AS "acceptedItemTurnId", accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId",
        accepted_item."stepId" AS "acceptedItemStepId", accepted_item."status" AS "acceptedItemStatus", accepted_item."phase" AS "acceptedItemPhase",
        accepted_item."revision" AS "acceptedItemRevision", accepted_item."content" AS "acceptedItemContent"
      FROM "agent_events" AS accepted_event JOIN "agent_inputs" AS input ON input."sessionId" = accepted_event."sessionId"
        AND input."targetTurnId" = accepted_event."turnId" AND input."userId" = $2 AND input."acceptedSequence" = accepted_event."sequence"
      LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = accepted_event."itemId"
        AND accepted_item."sessionId" = accepted_event."sessionId" AND accepted_item."turnId" = accepted_event."turnId"
      WHERE accepted_event."id" = $1 AND accepted_event."sessionId" = $3 AND accepted_event."turnId" = $4 LIMIT 2`,
    [causationId, scope.userId, scope.sessionId, scope.turnId])
    const receipt = object(event.payload), acceptedSequence = receipt && validate(ObjectiveLocationSteerReceiptSchema, receipt)
      ? BigInt((receipt as ObjectiveLocationSteerReceipt).acceptedInputSequence) : null
    if (accepted.rows.length !== 1 || acceptedSequence === null || exact && acceptedSequence !== exactAcceptedSequence || eventSequence <= acceptedSequence
      || !acceptedInputValid(accepted.rows[0]!, scope, causationId, acceptedSequence, locations)) return UNAVAILABLE
    const input = accepted.rows[0]!
    if (input.status === "consumed") {
      const step = await client.query<Row>(`SELECT step."id" AS "stepId", step."sessionId", step."turnId", step."taskId", step."ordinal", step."attempt",
          step."status", step."inputThroughSequence", step."consumedInputIds", turn."rootTaskId" AS "turnRootTaskId",
          turn."userId" AS "turnUserId", session."userId" AS "sessionUserId"
        FROM "agent_steps" AS step JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
        JOIN "agent_sessions" AS session ON session."id" = step."sessionId" AND session."userId" = turn."userId"
        WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
          AND turn."rootTaskId" = $4 AND turn."userId" = $5 AND session."userId" = $5 LIMIT 2`,
      [input.consumedByStepId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
      if (step.rows.length !== 1 || !consumedByOwnedRootStep(step.rows[0]!, scope, String(input.inputId), String(input.consumedByStepId), acceptedSequence)) return UNAVAILABLE
    }
    if (acceptedSequence > consumedThroughSequence) return PENDING
    if (input.status !== "consumed") return UNAVAILABLE
    return { kind: "confirmed", locations, acceptedInputSequence: acceptedSequence, acceptedInputId: String(input.inputId) }
  } catch { return UNAVAILABLE }
}
