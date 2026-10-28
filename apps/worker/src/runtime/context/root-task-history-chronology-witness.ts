import { createHash } from "node:crypto"
import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { TurnEngineError, toRepositoryJson } from "../turns/turn-engine-output.js"

export const ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE = "agent.plan.root_task_history_chronology_witness"
const WITNESS_SCHEMA = "agent-harness.v2.root-task-history-chronology-witness.v1"
const LOCK_NAMESPACE = "applymate:root-task-history-chronology:"
const SAFE_ERROR = "Root task history chronology could not be verified; start a new Turn."
const MAX_XID8 = (1n << 64n) - 1n
const TRANSACTION_LOCK = Symbol("root-task-history-chronology-lock")

export type RootTaskHistoryChronologyBoundary = "turn_start" | "root_terminal"
export type RootTaskHistoryChronologyOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
export type RootTaskHistoryChronologyWitness = Readonly<{ eventId: string; xid8: string }>
export type RootTaskHistoryChronologyLock = Readonly<{ userId: string; xid8: string; [TRANSACTION_LOCK]: true }>
export type RootTaskHistoryChronologyWitnessInput = RootTaskHistoryChronologyOwner & Readonly<{
  boundary: RootTaskHistoryChronologyBoundary
  boundaryEventId: string
}>

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
type EventRow = Row & {
  id: string; sessionId: string; turnId: string; taskId: string; sequence: string | number | bigint
  type: string; actor: string; itemId: string | null; correlationId: string; causationId: string | null
  idempotencyKey: string; payload: unknown
}

function conflict(): TurnEngineError { return new TurnEngineError("persistence_conflict", SAFE_ERROR) }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value }
function sequence(value: unknown): string | null {
  try { const parsed = BigInt(String(value)); return parsed > 0n ? parsed.toString() : null } catch { return null }
}
function object(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null }
  catch { return null }
}
export function parseRootTaskHistoryChronologyXid8(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined
  try { const parsed = BigInt(value); return parsed <= MAX_XID8 ? parsed : undefined } catch { return undefined }
}
function key(input: RootTaskHistoryChronologyWitnessInput): string {
  return `root-task-history-chronology-witness:${input.boundary}:${input.boundaryEventId}:v1`
}
function idempotencyId(value: string): string {
  return `agent-root-task-history-chronology-${createHash("sha256").update(value).digest("hex")}`
}
function validOwner(input: RootTaskHistoryChronologyWitnessInput): boolean {
  return [input.userId, input.sessionId, input.turnId, input.rootTaskId, input.boundaryEventId].every(text)
    && (input.boundary === "turn_start" || input.boundary === "root_terminal")
}
function validBoundary(row: EventRow, input: RootTaskHistoryChronologyWitnessInput): boolean {
  const payload = object(row.payload)
  if (row.id !== input.boundaryEventId || row.sessionId !== input.sessionId || row.turnId !== input.turnId
    || row.taskId !== input.rootTaskId || row.actor !== "orchestrator") return false
  if (input.boundary === "turn_start") return row.itemId === null && row.type === "turn.started" && row.correlationId === input.turnId
    && row.idempotencyKey === `turn:${input.turnId}:event:turn-started`
    && payload?.taskId === input.rootTaskId && payload.rootTaskId === input.rootTaskId
  const completed = row.type === "turn.completed"
  const terminalKey = completed ? `turn:${input.turnId}:event:turn-completed`
    : row.type === "turn.interrupted" ? `turn:${input.turnId}:event:turn-interrupted`
      : row.type === "turn.failed" ? `turn:${input.turnId}:event:turn-failed:` : null
  const validTerminalKey = terminalKey !== null && (row.type === "turn.failed"
    ? text(payload?.errorCode) && row.idempotencyKey === `${terminalKey}${payload.errorCode}`
    : row.idempotencyKey === terminalKey)
  if (!payload || !validTerminalKey) return false
  if (completed) return text(row.correlationId) && text(row.itemId) && row.itemId === payload.finalItemId
    && Object.keys(payload).sort().join(",") === "finalItemId,taskId,turnId,usage"
    && payload.turnId === input.turnId && payload.taskId === input.rootTaskId
  return row.correlationId === input.turnId && payload.turnId === input.turnId && payload.taskId === input.rootTaskId
}
async function verifyCompletedTerminalReceipt(client: Queryable, input: RootTaskHistoryChronologyWitnessInput, parent: EventRow): Promise<void> {
  if (parent.type !== "turn.completed") return
  const finalItemId = parent.itemId, stepId = parent.correlationId
  if (!text(finalItemId) || !text(stepId) || !text(parent.causationId)) throw conflict()
  const result = await client.query<EventRow>(`SELECT completed."id",completed."sessionId",completed."turnId",completed."taskId",
    completed."sequence",completed."type",completed."actor",completed."itemId",completed."correlationId",completed."causationId",
    completed."idempotencyKey",completed."payload" FROM "agent_steps" AS step
    JOIN "agent_items" AS item ON item."id"=$5 AND item."sessionId"=step."sessionId" AND item."turnId"=step."turnId"
      AND item."taskId"=step."taskId" AND item."stepId"=step."id" AND item."type"='agent_message'
      AND item."status"='completed' AND item."phase"='final_answer' AND item."revision"=1
    JOIN "agent_events" AS completed ON completed."id"=$6 AND completed."sessionId"=step."sessionId"
      AND completed."turnId"=step."turnId" AND completed."taskId"=step."taskId" AND completed."type"='item.completed'
      AND completed."actor"='orchestrator' AND completed."itemId"=item."id" AND completed."correlationId"=item."id"
      AND completed."idempotencyKey"='turn:' || step."turnId" || ':event:final-completed:' || item."id" || ':1'
      AND completed."payload"=jsonb_build_object('itemId',item."id",'status','completed','content',item."content")
    WHERE step."id"=$4 AND step."sessionId"=$1 AND step."turnId"=$2 AND step."taskId"=$3
      AND step."attempt"=1 AND step."status"='completed' AND completed."sequence"<$7
    FOR SHARE OF step,item,completed`,
  [input.sessionId, input.turnId, input.rootTaskId, stepId, finalItemId, parent.causationId, parent.sequence])
  if (result.rows.length !== 1 || !result.rows[0]) throw conflict()
  await verifyOutbox(client, expectedOutbox(result.rows[0], toRepositoryJson(result.rows[0].payload)))
}
function expectedOutbox(row: EventRow, payload: RepositoryJsonValue): AgentOutboxIdentity {
  const eventPayload: AgentOutboxPayload = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId,
    taskId: row.taskId, itemId: row.itemId, sequence: sequence(row.sequence)!, type: row.type, actor: "orchestrator",
    correlationId: row.correlationId, causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload }
  return { id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: row.sessionId,
    idempotencyKey: `agent-event:${row.id}`, payload: eventPayload }
}
async function verifyOutbox(client: Queryable, expected: AgentOutboxIdentity): Promise<void> {
  const rows = await client.query<Row>(`SELECT "id","topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [expected.idempotencyKey, expected.id])
  if (rows.rows.length !== 1 || !matchesAgentOutboxIdentity(rows.rows[0], expected)) throw conflict()
}
async function assertNoOrphanOutbox(client: Queryable, witnessId: string): Promise<void> {
  const rows = await client.query<Row>(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`,
    [`agent-event:${witnessId}`, `agent-outbox-${witnessId}`])
  if (rows.rows.length) throw conflict()
}
async function readParent(client: Queryable, input: RootTaskHistoryChronologyWitnessInput): Promise<EventRow> {
  const result = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events"
    WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "taskId"=$4 FOR SHARE`,
  [input.boundaryEventId, input.sessionId, input.turnId, input.rootTaskId])
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || !validBoundary(row, input) || !sequence(row.sequence)) throw conflict()
  await verifyOutbox(client, expectedOutbox(row, toRepositoryJson(row.payload)))
  await verifyCompletedTerminalReceipt(client, input, row)
  return row
}
function validWitness(row: EventRow, parent: EventRow, input: RootTaskHistoryChronologyWitnessInput): string | undefined {
  const value = object(row.payload), xid8 = value?.xid8
  if (row.id !== idempotencyId(key(input)) || row.sessionId !== input.sessionId || row.turnId !== input.turnId
    || row.taskId !== input.rootTaskId || row.type !== ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE
    || row.actor !== "orchestrator" || row.itemId !== null || row.correlationId !== input.rootTaskId
    || row.causationId !== parent.id || row.idempotencyKey !== key(input) || !sequence(row.sequence)
    || !value || Object.keys(value).sort().join(",") !== "boundary,boundaryEventId,schemaVersion,xid8"
    || value.schemaVersion !== WITNESS_SCHEMA || value.boundary !== input.boundary
    || value.boundaryEventId !== parent.id || parseRootTaskHistoryChronologyXid8(xid8) === undefined) return undefined
  return xid8 as string
}

/** Acquires the lock and captures this transaction's full xid8 before any row lock or write. */
export async function acquireRootTaskHistoryChronologyLock(client: Queryable, userId: string): Promise<RootTaskHistoryChronologyLock> {
  if (!text(userId)) throw conflict()
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || $2::text, 0))`, [LOCK_NAMESPACE, userId])
  const result = await client.query<{ xid8: string }>(`SELECT pg_current_xact_id()::text AS "xid8"`)
  const xid8 = result.rows[0]?.xid8
  if (result.rows.length !== 1 || parseRootTaskHistoryChronologyXid8(xid8) === undefined) throw conflict()
  return Object.freeze({ userId, xid8, [TRANSACTION_LOCK]: true as const })
}

/** Appends a private witness after a new parent boundary was written in this same transaction. */
export async function appendRootTaskHistoryChronologyWitness(
  client: Queryable, input: RootTaskHistoryChronologyWitnessInput, lock: RootTaskHistoryChronologyLock,
): Promise<RootTaskHistoryChronologyWitness> {
  if (!validOwner(input) || !lock || lock[TRANSACTION_LOCK] !== true || lock.userId !== input.userId
    || parseRootTaskHistoryChronologyXid8(lock.xid8) === undefined) throw conflict()
  const parent = await readParent(client, input)
  const current = await client.query<{ xid8: string }>(`SELECT pg_current_xact_id()::text AS "xid8"`)
  if (current.rows.length !== 1 || current.rows[0]?.xid8 !== lock.xid8) throw conflict()
  const xid8 = lock.xid8
  const witnessKey = key(input), eventId = idempotencyId(witnessKey)
  const prior = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events" WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`,
  [witnessKey, eventId])
  if (prior.rows.length) throw conflict()
  await assertNoOrphanOutbox(client, eventId)
  const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions"
    SET "eventSequence"="eventSequence"+1 WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"`,
  [input.sessionId, input.userId])
  const eventSequence = sequence(next.rows[0]?.eventSequence)
  if (!eventSequence) throw conflict()
  const payload: RepositoryJsonValue = { schemaVersion: WITNESS_SCHEMA, boundary: input.boundary,
    boundaryEventId: parent.id, xid8 }
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
    "correlationId","causationId","idempotencyKey","payload") VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$4,$7,$8,$9::jsonb)`,
  [eventId, input.sessionId, input.turnId, input.rootTaskId, eventSequence, ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE,
    parent.id, witnessKey, JSON.stringify(payload)])
  const event: EventRow = { id: eventId, sessionId: input.sessionId, turnId: input.turnId, taskId: input.rootTaskId,
    sequence: eventSequence, type: ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE, actor: "orchestrator", itemId: null,
    correlationId: input.rootTaskId, causationId: parent.id, idempotencyKey: witnessKey, payload }
  await verifyOutbox(client, await appendOutbox(client, event, payload))
  return { eventId, xid8 }
}
async function appendOutbox(client: Queryable, row: EventRow, payload: RepositoryJsonValue): Promise<AgentOutboxIdentity> {
  const expected = expectedOutbox(row, payload)
  await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload") VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [expected.id, expected.topic, expected.aggregateId, expected.idempotencyKey, JSON.stringify(toRepositoryJson(expected.payload))])
  return expected
}

/** Reads only a fully owner-bound witness; a missing legacy witness stays missing. */
export async function readRootTaskHistoryChronologyWitness(
  client: Queryable, input: RootTaskHistoryChronologyWitnessInput,
): Promise<RootTaskHistoryChronologyWitness | undefined> {
  if (!validOwner(input)) throw conflict()
  const parent = await readParent(client, input), witnessId = idempotencyId(key(input))
  const result = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR SHARE`, [key(input), witnessId])
  if (result.rows.length > 1) throw conflict()
  const row = result.rows[0]
  if (!row) { await assertNoOrphanOutbox(client, witnessId); return undefined }
  const xid8 = validWitness(row, parent, input)
  if (!xid8) throw conflict()
  await verifyOutbox(client, expectedOutbox(row, toRepositoryJson(row.payload)))
  return { eventId: row.id, xid8 }
}
