import { createHash } from "node:crypto"
import type pg from "pg"
import type { TenantScope, RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { lockTaskGraphScope } from "../subagents/task-graph-pg-state.js"
import { TurnLeaseError, type TurnLease } from "../turns/lease.js"
import { TurnEngineError, toRepositoryJson } from "../turns/turn-engine-output.js"

export const ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE = "agent.plan.root_task_history_session_authorization"
export const ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE = "agent.plan.root_task_history_memory_snapshot"

const AUTHORIZATION_SCHEMA_VERSION = "agent-harness.v2.root-task-history-session-authorization.v1"
const AUTHORIZATION_KEY = (sessionId: string) => `root-task-history-session-authorization:${sessionId}:v1`
const SAFE_STATE_ERROR = "Root task history authorization could not be verified; start a new Turn."
const OWNER_FENCE_ERRORS = new Set([
  "task_graph_session_fenced", "task_graph_turn_fenced", "task_graph_parent_fenced", "task_graph_step_fenced",
])

type Row = Record<string, unknown>
type EventRow = Row & {
  id: string; sessionId: string; turnId: string; taskId: string; sequence: string | number | bigint
  type: string; actor: string; itemId: string | null; correlationId: string; causationId: string | null
  idempotencyKey: string; payload: unknown
}
export type RootTaskHistorySessionAuthorizationInput = Readonly<{
  scope: Pick<TenantScope, "userId">
  lease: TurnLease
  rootTaskId: string
  rootAttemptCount: number
  stepId: string
  environmentGateEnabled: boolean
}>

export type RootTaskHistorySessionAuthorization = Readonly<{
  eventId: string
  sessionId: string
  userId: string
  consentVersion: number
  consentEnabled: boolean
  gateEnabledAtCapture: boolean
}>

export type RootTaskHistorySessionAuthorizationResult<T> = Readonly<{
  authorization: RootTaskHistorySessionAuthorization
  historyReadAllowed: boolean
  historyResult?: T
}>

/** The callback shares the authorization transaction and is never called with either gate closed. */
export type AuthorizedRootTaskHistoryWork<T> = (
  client: pg.PoolClient,
  authorization: RootTaskHistorySessionAuthorization,
) => Promise<T>

function conflict(): TurnEngineError {
  return new TurnEngineError("persistence_conflict", SAFE_STATE_ERROR)
}

function idempotencyId(key: string): string {
  return `agent-root-task-history-${createHash("sha256").update(key).digest("hex")}`
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function sequence(value: unknown): string | null {
  try {
    const parsed = BigInt(String(value))
    return parsed > 0n ? parsed.toString() : null
  } catch { return null }
}

function validateInput(input: RootTaskHistorySessionAuthorizationInput): void {
  const { lease } = input
  if (!text(lease.userId) || input.scope.userId !== lease.userId || !text(lease.sessionId) || !text(lease.turnId)
    || !text(lease.ownerId) || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1
    || !text(input.rootTaskId) || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1
    || !text(input.stepId) || typeof input.environmentGateEnabled !== "boolean") throw conflict()
}

function authorizationPayload(value: unknown, sessionId: string, userId: string): Omit<RootTaskHistorySessionAuthorization, "eventId"> | null {
  const payload = parseJson(value)
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const row = payload as Row
  const keys = Object.keys(row).sort().join(",")
  if (keys !== "consentEnabled,consentVersion,gateEnabledAtCapture,schemaVersion,sessionId,userId"
    || row.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION || row.sessionId !== sessionId || row.userId !== userId
    || typeof row.consentEnabled !== "boolean" || typeof row.gateEnabledAtCapture !== "boolean"
    || !Number.isSafeInteger(row.consentVersion) || Number(row.consentVersion) < 0) return null
  return {
    sessionId, userId, consentVersion: Number(row.consentVersion), consentEnabled: row.consentEnabled,
    gateEnabledAtCapture: row.gateEnabledAtCapture,
  }
}

async function lockCurrentOwner(client: pg.PoolClient, input: RootTaskHistorySessionAuthorizationInput): Promise<void> {
  const { lease, rootTaskId, rootAttemptCount } = input
  const root = await lockTaskGraphScope(client, {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId,
    parentTaskId: rootTaskId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: rootAttemptCount, stepId: input.stepId,
  })
  if (root.id !== rootTaskId || root.rootTaskId !== rootTaskId || root.parentTaskId !== null
    || root.role !== "orchestrator" || root.taskType !== "root" || root.status !== "running"
    || root.leaseOwner !== lease.ownerId || Number(root.attemptCount) !== rootAttemptCount || root.interruptRequestedAt != null) {
    throw new TurnLeaseError("lease_lost", "Turn root is no longer active")
  }
  const step = await client.query<Row>(`SELECT "id" FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3
    AND "taskId"=$4 AND "attempt"=$5 AND "status"='streaming' FOR UPDATE`,
  [input.stepId, lease.sessionId, lease.turnId, rootTaskId, rootAttemptCount])
  if (step.rows.length !== 1 || step.rows[0]?.id !== input.stepId) {
    throw new TurnLeaseError("lease_lost", "Turn step is no longer active")
  }
}

async function readEvent(client: pg.PoolClient, key: string): Promise<EventRow | null> {
  const id = idempotencyId(key)
  const result = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [key, id])
  if (result.rows.length > 1) throw conflict()
  return result.rows[0] ?? null
}

async function assertRetainedOwner(client: pg.PoolClient, row: EventRow, input: RootTaskHistorySessionAuthorizationInput): Promise<void> {
  const { lease } = input
  if (row.sessionId !== lease.sessionId || !text(row.turnId) || !text(row.taskId)) throw conflict()
  const turn = await client.query<Row>(`SELECT "id" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3
    AND "rootTaskId"=$4`, [row.turnId, lease.sessionId, lease.userId, row.taskId])
  if (turn.rows.length !== 1 || turn.rows[0]?.id !== row.turnId) throw conflict()
  const root = await client.query<Row>(`SELECT task."id" FROM "sub_agent_tasks" task JOIN "agent_sessions" session
    ON session."id"=task."sessionId" AND session."userId"=$4 WHERE task."id"=$1 AND task."sessionId"=$2
      AND task."turnId"=$3 AND task."rootTaskId"=$1 AND task."parentTaskId" IS NULL
      AND task."role"='orchestrator' AND task."taskType"='root'`, [row.taskId, lease.sessionId, row.turnId, lease.userId])
  if (root.rows.length !== 1 || root.rows[0]?.id !== row.taskId) throw conflict()
}

function validEvent(row: EventRow, key: string): boolean {
  return row.id === idempotencyId(key) && row.idempotencyKey === key
    && row.type === ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE && row.actor === "orchestrator"
    && row.itemId === null && row.causationId === null && text(row.taskId) && row.correlationId === row.taskId
    && sequence(row.sequence) !== null
}

function expectedOutbox(row: EventRow, payload: RepositoryJsonValue): AgentOutboxIdentity {
  const eventPayload: AgentOutboxPayload = {
    eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, taskId: row.taskId,
    itemId: null, sequence: sequence(row.sequence)!, type: row.type, actor: "orchestrator",
    correlationId: row.taskId, causationId: null, idempotencyKey: row.idempotencyKey, payload,
  }
  return { id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: row.sessionId,
    idempotencyKey: `agent-event:${row.id}`, payload: eventPayload }
}

async function verifyOutbox(client: pg.PoolClient, expected: AgentOutboxIdentity): Promise<void> {
  const rows = await client.query<Row>(`SELECT "id","topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [expected.idempotencyKey, expected.id])
  if (rows.rows.length !== 1 || !matchesAgentOutboxIdentity(rows.rows[0], expected)) throw conflict()
}

async function assertNoOrphanOutbox(client: pg.PoolClient, key: string): Promise<void> {
  const id = idempotencyId(key)
  const rows = await client.query<Row>(`SELECT "id" FROM "agent_outbox"
    WHERE "idempotencyKey"=$1 OR "id"=$2 FOR UPDATE`, [`agent-event:${id}`, `agent-outbox-${id}`])
  if (rows.rows.length !== 0) throw conflict()
}

async function appendEvent(client: pg.PoolClient, input: RootTaskHistorySessionAuthorizationInput, key: string, value: RepositoryJsonValue): Promise<EventRow> {
  const { lease, rootTaskId } = input, id = idempotencyId(key)
  const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions"
    SET "eventSequence"="eventSequence"+1 WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"`, [lease.sessionId, lease.userId])
  const eventSequence = sequence(next.rows[0]?.eventSequence)
  if (!eventSequence) throw conflict()
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor",
    "correlationId","causationId","idempotencyKey","payload") VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$4,NULL,$7,$8::jsonb)`,
  [id, lease.sessionId, lease.turnId, rootTaskId, eventSequence, ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE, key, JSON.stringify(value)])
  const row: EventRow = { id, sessionId: lease.sessionId, turnId: lease.turnId, taskId: rootTaskId, sequence: eventSequence,
    type: ROOT_TASK_HISTORY_SESSION_AUTHORIZATION_EVENT_TYPE, actor: "orchestrator", itemId: null, correlationId: rootTaskId,
    causationId: null, idempotencyKey: key, payload: value }
  const outbox = expectedOutbox(row, value)
  await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload")
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [outbox.id, outbox.topic, outbox.aggregateId, outbox.idempotencyKey,
    JSON.stringify(toRepositoryJson(outbox.payload))])
  await verifyOutbox(client, outbox)
  return row
}

async function pinnedAuthorization(client: pg.PoolClient, input: RootTaskHistorySessionAuthorizationInput): Promise<RootTaskHistorySessionAuthorization> {
  const key = AUTHORIZATION_KEY(input.lease.sessionId), prior = await readEvent(client, key)
  if (prior) {
    await assertRetainedOwner(client, prior, input)
    const parsed = authorizationPayload(prior.payload, input.lease.sessionId, input.lease.userId)
    if (!validEvent(prior, key) || !parsed) throw conflict()
    await verifyOutbox(client, expectedOutbox(prior, toRepositoryJson({ schemaVersion: AUTHORIZATION_SCHEMA_VERSION, ...parsed })))
    return { ...parsed, eventId: prior.id }
  }
  await assertNoOrphanOutbox(client, key)
  const user = await client.query<Row>(`SELECT "id","agentTaskHistoryMemoryEnabled","agentTaskHistoryMemoryConsentVersion"
    FROM "User" WHERE "id"=$1`, [input.lease.userId])
  const consent = user.rows[0]
  if (user.rows.length !== 1 || consent?.id !== input.lease.userId
    || typeof consent.agentTaskHistoryMemoryEnabled !== "boolean"
    || !Number.isSafeInteger(consent.agentTaskHistoryMemoryConsentVersion)
    || Number(consent.agentTaskHistoryMemoryConsentVersion) < 0) throw conflict()
  const payload = toRepositoryJson({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION, sessionId: input.lease.sessionId, userId: input.lease.userId,
    consentVersion: Number(consent.agentTaskHistoryMemoryConsentVersion), consentEnabled: consent.agentTaskHistoryMemoryEnabled,
    gateEnabledAtCapture: input.environmentGateEnabled,
  })
  const created = await appendEvent(client, input, key, payload)
  const parsed = authorizationPayload(payload, input.lease.sessionId, input.lease.userId)
  if (!parsed || !validEvent(created, key)) throw conflict()
  return { ...parsed, eventId: created.id }
}

/** Pins consent once per Session and keeps authorized history work in the same fenced transaction. */
export async function withRootTaskHistorySessionAuthorization<T>(
  pool: Pick<pg.Pool, "connect">,
  input: RootTaskHistorySessionAuthorizationInput,
  work: AuthorizedRootTaskHistoryWork<T>,
): Promise<RootTaskHistorySessionAuthorizationResult<T>> {
  validateInput(input)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('applymate:agent-task-history-memory:' || $1::text, 0))", [input.lease.userId])
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", input.lease.userId])
    try { await lockCurrentOwner(client, input) } catch (error: unknown) {
      if (error instanceof Error && OWNER_FENCE_ERRORS.has(error.message)) throw new TurnLeaseError("lease_lost", "Turn owner is no longer active")
      throw error
    }
    const authorization = await pinnedAuthorization(client, input)
    const historyReadAllowed = input.environmentGateEnabled && authorization.consentEnabled
    const historyResult = historyReadAllowed ? await work(client, authorization) : undefined
    await client.query("COMMIT")
    committed = true
    return { authorization, historyReadAllowed, ...(historyReadAllowed ? { historyResult: historyResult as T } : {}) }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    if (error instanceof TurnLeaseError || error instanceof TurnEngineError) throw error
    throw conflict()
  } finally { client.release() }
}
