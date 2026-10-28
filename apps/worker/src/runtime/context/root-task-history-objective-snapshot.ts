import { createHash } from "node:crypto"
import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { TurnEngineError, toRepositoryJson } from "../turns/turn-engine-output.js"
import type { TurnLease } from "../turns/lease.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import {
  ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE,
  type RootTaskHistorySessionAuthorization,
} from "./root-task-history-session-memory.js"
import type { RootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import {
  createRootTaskHistoryObjectiveSnapshotIdentity, createRootTaskHistoryObjectiveSnapshotPayload,
  readRootTaskHistoryObjectiveSnapshotPayload, rootTaskHistoryObjectiveSnapshotKey,
} from "./root-task-history-objective-snapshot-codec.js"

export const ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE = ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE
const SAFE_ERROR = "Root task history snapshot could not be verified; start a new Turn."

type Row = Record<string, unknown>
type EventRow = Row & {
  id: string; sessionId: string; turnId: string; taskId: string; sequence: string | number | bigint
  type: string; actor: string; itemId: string | null; correlationId: string; causationId: string | null
  idempotencyKey: string; payload: unknown
}

export type RootTaskHistoryObjectiveSnapshotInput = Readonly<{
  client: Pick<pg.PoolClient, "query">
  lease: TurnLease
  rootTaskId: string
  authorization: RootTaskHistorySessionAuthorization
  /** Must be the result of readRootTaskHistoryFence in this same transaction. */
  fence: RootTaskHistoryFence
  /** Built from the checkpoint claimed by this Step-context transaction. */
  acceptedInputRevision: bigint
  steerEvidence: RootTaskHistorySteerEvidence
  /** Must use this client and return direct-store validated prior-session outcomes only. */
  loadOutcomes: (client: Pick<pg.PoolClient, "query">) => Promise<readonly ValidatedRootTaskHistoryOutcome[]>
}>

export type RootTaskHistoryObjectiveSnapshotResult = Readonly<{
  /** Safe materialized projection inputs. Empty means an immutable empty snapshot was committed. */
  outcomes: readonly ValidatedRootTaskHistoryOutcome[]
  reused: boolean
}>

function conflict(): TurnEngineError { return new TurnEngineError("persistence_conflict", SAFE_ERROR) }
function idempotencyId(key: string): string { return `agent-root-task-history-${createHash("sha256").update(key).digest("hex")}` }
function sequence(value: unknown): string | null {
  try { const parsed = BigInt(String(value)); return parsed > 0n ? parsed.toString() : null } catch { return null }
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim() === value }

async function readEvent(client: Pick<pg.PoolClient, "query">, key: string): Promise<EventRow | null> {
  const rows = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events" WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`,
  [key, idempotencyId(key)])
  if (rows.rows.length > 1) throw conflict()
  return rows.rows[0] ?? null
}

function validEvent(row: EventRow, key: string): boolean {
  return row.id === idempotencyId(key) && row.idempotencyKey === key
    && row.type === ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE && row.actor === "orchestrator"
    && row.itemId === null && row.causationId === null && text(row.turnId) && text(row.taskId)
    && row.correlationId === row.taskId && sequence(row.sequence) !== null
}

function expectedOutbox(row: EventRow, payload: RepositoryJsonValue): AgentOutboxIdentity {
  const eventPayload: AgentOutboxPayload = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId,
    taskId: row.taskId, itemId: null, sequence: sequence(row.sequence)!, type: row.type, actor: "orchestrator",
    correlationId: row.taskId, causationId: null, idempotencyKey: row.idempotencyKey, payload }
  return { id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: row.sessionId,
    idempotencyKey: `agent-event:${row.id}`, payload: eventPayload }
}

async function verifyOutbox(client: Pick<pg.PoolClient, "query">, expected: AgentOutboxIdentity): Promise<void> {
  const rows = await client.query<Row>(`SELECT "id","topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [expected.idempotencyKey, expected.id])
  if (rows.rows.length !== 1 || !matchesAgentOutboxIdentity(rows.rows[0], expected)) throw conflict()
}

async function assertNoOrphanOutbox(client: Pick<pg.PoolClient, "query">, key: string): Promise<void> {
  const id = idempotencyId(key), rows = await client.query<Row>(`SELECT "id" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [`agent-event:${id}`, `agent-outbox-${id}`])
  if (rows.rows.length) throw conflict()
}

async function assertRetainedOwner(client: Pick<pg.PoolClient, "query">, row: EventRow, input: RootTaskHistoryObjectiveSnapshotInput): Promise<void> {
  const result = await client.query<Row>(`SELECT turn."id", root."id" AS "rootId" FROM "agent_turns" turn
    JOIN "agent_sessions" session ON session."id"=turn."sessionId" AND session."userId"=$3
    JOIN "sub_agent_tasks" root ON root."id"=turn."rootTaskId" AND root."sessionId"=turn."sessionId" AND root."turnId"=turn."id"
      AND root."rootTaskId"=root."id" AND root."parentTaskId" IS NULL AND root."role"='orchestrator' AND root."taskType"='root'
    WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 AND turn."rootTaskId"=$4`,
  [row.turnId, input.lease.sessionId, input.lease.userId, row.taskId])
  if (row.sessionId !== input.lease.sessionId || result.rows.length !== 1 || result.rows[0]?.id !== row.turnId
    || result.rows[0]?.rootId !== row.taskId) throw conflict()
}

async function appendEvent(client: Pick<pg.PoolClient, "query">, input: RootTaskHistoryObjectiveSnapshotInput,
  key: string, payload: RepositoryJsonValue): Promise<EventRow> {
  const id = idempotencyId(key)
  const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions"
    SET "eventSequence"="eventSequence"+1 WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"`,
  [input.lease.sessionId, input.lease.userId])
  const eventSequence = sequence(next.rows[0]?.eventSequence)
  if (!eventSequence) throw conflict()
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
    "correlationId","causationId","idempotencyKey","payload") VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$4,NULL,$7,$8::jsonb)`,
  [id, input.lease.sessionId, input.lease.turnId, input.rootTaskId, eventSequence, ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE,
    key, JSON.stringify(payload)])
  const event: EventRow = { id, sessionId: input.lease.sessionId, turnId: input.lease.turnId, taskId: input.rootTaskId,
    sequence: eventSequence, type: ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE, actor: "orchestrator", itemId: null,
    correlationId: input.rootTaskId, causationId: null, idempotencyKey: key, payload }
  const outbox = expectedOutbox(event, payload)
  await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload") VALUES ($1,$2,$3,$4,$5::jsonb)`,
  [outbox.id, outbox.topic, outbox.aggregateId, outbox.idempotencyKey, JSON.stringify(toRepositoryJson(outbox.payload))])
  await verifyOutbox(client, outbox)
  return event
}

/** Persists or replays a per-objective snapshot on the caller's owner-fenced transaction client. */
export async function withRootTaskHistoryObjectiveSnapshot(
  input: RootTaskHistoryObjectiveSnapshotInput,
): Promise<RootTaskHistoryObjectiveSnapshotResult | undefined> {
  const identity = createRootTaskHistoryObjectiveSnapshotIdentity(input)
  if (!identity) return undefined
  const key = rootTaskHistoryObjectiveSnapshotKey(identity), prior = await readEvent(input.client, key)
  if (prior) {
    await assertRetainedOwner(input.client, prior, input)
    const outcomes = readRootTaskHistoryObjectiveSnapshotPayload(prior.payload, identity, input.fence.currentStartCreatedAt!)
    if (!validEvent(prior, key) || !outcomes) throw conflict()
    await verifyOutbox(input.client, expectedOutbox(prior, toRepositoryJson(prior.payload)))
    return { outcomes, reused: true }
  }
  await assertNoOrphanOutbox(input.client, key)
  const payload = createRootTaskHistoryObjectiveSnapshotPayload(identity, await input.loadOutcomes(input.client), input.fence.currentStartCreatedAt!)
  if (!payload) throw conflict()
  const event = await appendEvent(input.client, input, key, payload)
  const outcomes = readRootTaskHistoryObjectiveSnapshotPayload(payload, identity, input.fence.currentStartCreatedAt!)
  if (!validEvent(event, key) || !outcomes) throw conflict()
  return { outcomes, reused: false }
}
