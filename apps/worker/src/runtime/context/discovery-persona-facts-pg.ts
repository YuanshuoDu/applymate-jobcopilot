import type pg from "pg"
import { createHash } from "node:crypto"
import type { TenantScope, RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { TurnLeaseError, type TurnLease } from "../turns/lease.js"
import { TurnEngineError, toRepositoryJson } from "../turns/turn-engine-output.js"
import { estimateDiscoveryPersonaContextTokens } from "./discovery-persona-context-blocks.js"
import {
  DISCOVERY_PERSONA_FACT_LIMIT, DISCOVERY_PERSONA_BYTE_LIMIT, parseDiscoveryPersonaOverflowPayload,
  parseDiscoveryPersonaSnapshotPayload, projectDiscoveryPersonaFacts, type DiscoveryPersonaFactRow,
  type DiscoveryPersonaProjection,
} from "./discovery-persona-facts.js"

export const DISCOVERY_PERSONA_SNAPSHOT_EVENT = "agent.plan.discovery_persona_snapshot"
export const DISCOVERY_PERSONA_OVERFLOW_EVENT = "agent.plan.discovery_persona_overflow"
const SNAPSHOT_KEY = (sessionId: string) => `discovery-persona-snapshot:${sessionId}:v1`
const OVERFLOW_KEY = (sessionId: string, turnId: string) => `discovery-persona-overflow:${sessionId}:${turnId}:v1`
const SAFE_STATE_ERROR = "Discovery memory could not be verified; start a new Turn."
type Row = Record<string, unknown>
type EventRow = Row & { id: string; sessionId: string; turnId: string; taskId: string; sequence: string | number | bigint; type: string; payload: unknown }
type OwnerInput = Readonly<{ scope: Pick<TenantScope, "userId">; lease: TurnLease; rootTaskId: string; rootAttemptCount: number }>
type Input = OwnerInput & Readonly<{ stepId: string }>
export type DiscoveryPersonaSnapshotResult =
  | { readonly kind: "accepted"; readonly projection: DiscoveryPersonaProjection }
  | { readonly kind: "overflow"; readonly reason: "fact_limit" | "byte_limit"; readonly observedFactCount: number; readonly canonicalUtf8Bytes: number | null }

function conflict(): TurnEngineError { return new TurnEngineError("persistence_conflict", SAFE_STATE_ERROR) }
function idempotencyId(key: string): string { return `agent-discovery-persona-${createHash("sha256").update(key).digest("hex")}` }
function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}
function sequence(value: unknown): string | null {
  try { const number = BigInt(String(value)); return number > 0n ? number.toString() : null } catch { return null }
}

async function assertCurrentOwner(client: pg.PoolClient, input: Input): Promise<void> {
  await assertCurrentRootOwner(client, input)
  const { lease, rootTaskId, rootAttemptCount, stepId } = input
  const step = await client.query<Row>(`SELECT "id" FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3
    AND "taskId"=$4 AND "attempt"=$5 AND "status"='streaming' FOR UPDATE`, [stepId, lease.sessionId, lease.turnId, rootTaskId, rootAttemptCount])
  if (!step.rows[0]) throw new TurnLeaseError("lease_lost", "Turn step is no longer active")
}

async function assertCurrentRootOwner(client: pg.PoolClient, input: OwnerInput): Promise<void> {
  const { lease, rootTaskId, rootAttemptCount } = input
  const session = await client.query<Row>(`SELECT "id" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2
    AND "status" NOT IN ('aborted','archived') FOR UPDATE`, [lease.sessionId, lease.userId])
  if (!session.rows[0]) throw new TurnLeaseError("lease_lost", "Turn session is no longer owned")
  const turn = await client.query<Row>(`SELECT "id" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3
    AND "rootTaskId"=$4 AND "status"='in_progress' AND "leaseOwnerId"=$5 AND "leaseVersion"=$6
    AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion])
  if (!turn.rows[0]) throw new TurnLeaseError("lease_lost", "Turn lease is no longer owned")
  const root = await client.query<Row>(`SELECT task."id" FROM "sub_agent_tasks" task JOIN "agent_sessions" session
    ON session."id"=task."sessionId" AND session."userId"=$4 WHERE task."id"=$1 AND task."sessionId"=$2 AND task."turnId"=$3
    AND task."rootTaskId"=$1 AND task."status"='running' AND task."leaseOwner"=$5
    AND task."attemptCount"=$6 AND task."leaseExpiresAt">clock_timestamp() AND task."interruptRequestedAt" IS NULL FOR UPDATE OF task`,
  [rootTaskId, lease.sessionId, lease.turnId, lease.userId, lease.ownerId, rootAttemptCount])
  if (!root.rows[0]) throw new TurnLeaseError("lease_lost", "Root task is no longer owned")
}

async function readEvent(client: pg.PoolClient, key: string): Promise<EventRow | null> {
  const result = await client.query<EventRow>(`SELECT "id","sessionId","turnId","taskId","sequence","type","actor","itemId",
    "correlationId","causationId","idempotencyKey","payload" FROM "agent_events" WHERE "idempotencyKey"=$1 FOR UPDATE`, [key])
  if (result.rows.length > 1) throw conflict()
  return result.rows[0] ?? null
}
async function assertRetainedEventOwner(client: pg.PoolClient, row: EventRow, input: OwnerInput): Promise<void> {
  const { lease } = input
  if (row.sessionId !== lease.sessionId || typeof row.turnId !== "string" || typeof row.taskId !== "string") throw conflict()
  const turn = await client.query<Row>(`SELECT "id" FROM "agent_turns"
    WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3`, [row.turnId, lease.sessionId, lease.userId])
  if (!turn.rows[0]) throw conflict()
  const task = await client.query<Row>(`SELECT task."id" FROM "sub_agent_tasks" task JOIN "agent_sessions" session
    ON session."id"=task."sessionId" AND session."userId"=$4 WHERE task."id"=$1 AND task."sessionId"=$2
      AND task."turnId"=$3 AND task."rootTaskId"=$1`, [row.taskId, lease.sessionId, row.turnId, lease.userId])
  if (!task.rows[0]) throw conflict()
}

function envelope(row: EventRow, type: string, key: string): boolean {
  return row.id === idempotencyId(key) && row.type === type && row.idempotencyKey === key && row.actor === "orchestrator"
    && row.itemId === null && row.causationId === null && typeof row.taskId === "string" && row.taskId.trim().length > 0
    && row.correlationId === row.taskId && sequence(row.sequence) !== null
}
function expectedOutbox(row: EventRow, payload: RepositoryJsonValue): AgentOutboxIdentity {
  const eventPayload: AgentOutboxPayload = { eventId: row.id, sessionId: String(row.sessionId), turnId: row.turnId, taskId: row.taskId,
    itemId: null, sequence: sequence(row.sequence)!, type: row.type, actor: "orchestrator", correlationId: row.taskId,
    causationId: null, idempotencyKey: row.idempotencyKey as string, payload }
  return { id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: String(row.sessionId),
    idempotencyKey: `agent-event:${row.id}`, payload: eventPayload }
}
async function verifyOutbox(client: pg.PoolClient, expected: AgentOutboxIdentity): Promise<void> {
  const row = await client.query<Row>(`SELECT "id","topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox" WHERE "idempotencyKey"=$1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(row.rows[0], expected)) throw conflict()
}
async function appendEvent(client: pg.PoolClient, input: Input, type: string, key: string, payload: RepositoryJsonValue): Promise<void> {
  const { lease, rootTaskId } = input, id = idempotencyId(key)
  const next = await client.query<{ eventSequence: string | number | bigint }>(`UPDATE "agent_sessions" SET "eventSequence"="eventSequence"+1
    WHERE "id"=$1 AND "userId"=$2 RETURNING "eventSequence"`, [lease.sessionId, lease.userId])
  const eventSequence = next.rows[0]?.eventSequence
  if (eventSequence === undefined) throw conflict()
  const sequenceValue = String(eventSequence), correlationId = rootTaskId
  await client.query(`INSERT INTO "agent_events" ("id","sessionId","turnId","itemId","taskId","sequence","type","actor","correlationId","causationId","idempotencyKey","payload")
    VALUES ($1,$2,$3,NULL,$4,$5,$6,'orchestrator',$4,NULL,$7,$8::jsonb)`,
  [id, lease.sessionId, lease.turnId, rootTaskId, sequenceValue, type, key, JSON.stringify(payload)])
  const row: EventRow = { id, sessionId: lease.sessionId, turnId: lease.turnId, taskId: rootTaskId, sequence: sequenceValue,
    type, actor: "orchestrator", itemId: null, correlationId, causationId: null, idempotencyKey: key, payload }
  const expected = expectedOutbox(row, payload)
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id","topic","aggregateId","idempotencyKey","payload")
    VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
  [expected.id, expected.topic, expected.aggregateId, expected.idempotencyKey, JSON.stringify(toRepositoryJson(expected.payload))])
  if ((inserted.rowCount ?? 0) !== 1) await verifyOutbox(client, expected)
}
function resultFromPayload(payload: ReturnType<typeof parseDiscoveryPersonaSnapshotPayload> | ReturnType<typeof parseDiscoveryPersonaOverflowPayload>): DiscoveryPersonaSnapshotResult {
  if (!payload) throw conflict()
  return payload.status === "accepted" ? { kind: "accepted", projection: payload.projection }
    : { kind: "overflow", reason: payload.reason, observedFactCount: payload.observedFactCount, canonicalUtf8Bytes: payload.canonicalUtf8Bytes }
}

export async function loadOrCreateDiscoveryPersonaSnapshot(pool: Pick<pg.Pool, "connect">, input: Input): Promise<DiscoveryPersonaSnapshotResult> {
  const { lease, rootTaskId } = input
  if (input.scope.userId !== lease.userId) throw conflict()
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", lease.userId])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('applymate:persona-facts:' || $1::text, 0))", [lease.userId])
    await assertCurrentOwner(client, input)
    const overflowKey = OVERFLOW_KEY(lease.sessionId, lease.turnId)
    const priorOverflow = await readEvent(client, overflowKey)
    if (priorOverflow) {
      await assertRetainedEventOwner(client, priorOverflow, input)
      const payload = parseDiscoveryPersonaOverflowPayload(parsedJson(priorOverflow.payload))
      if (!envelope(priorOverflow, DISCOVERY_PERSONA_OVERFLOW_EVENT, overflowKey) || priorOverflow.turnId !== lease.turnId
        || priorOverflow.taskId !== rootTaskId || !payload) throw conflict()
      await verifyOutbox(client, expectedOutbox(priorOverflow, toRepositoryJson(payload)))
      await client.query("COMMIT"); committed = true
      return resultFromPayload(payload)
    }
    const snapshotKey = SNAPSHOT_KEY(lease.sessionId)
    const priorSnapshot = await readEvent(client, snapshotKey)
    if (priorSnapshot) {
      await assertRetainedEventOwner(client, priorSnapshot, input)
      const payload = parseDiscoveryPersonaSnapshotPayload(parsedJson(priorSnapshot.payload))
      if (!envelope(priorSnapshot, DISCOVERY_PERSONA_SNAPSHOT_EVENT, snapshotKey) || !payload) throw conflict()
      await verifyOutbox(client, expectedOutbox(priorSnapshot, toRepositoryJson(payload)))
      await client.query("COMMIT"); committed = true
      return resultFromPayload(payload)
    }
    const facts = await client.query<DiscoveryPersonaFactRow>(`SELECT "id","key","category","value","normalized_value" AS "normalizedValue","source","evidence","updated_at" AS "updatedAt"
      FROM "persona_facts" WHERE "userId"=$1 AND "status"='confirmed' AND "revoked_at" IS NULL
        AND ("expires_at" IS NULL OR "expires_at">clock_timestamp()) AND "allowedUses" @> ARRAY['discovery']::text[]
      ORDER BY "key","normalized_value","id" LIMIT $2`, [lease.userId, DISCOVERY_PERSONA_FACT_LIMIT + 1])
    const projection = projectDiscoveryPersonaFacts(facts.rows)
    const type = projection.kind === "accepted" ? DISCOVERY_PERSONA_SNAPSHOT_EVENT : DISCOVERY_PERSONA_OVERFLOW_EVENT
    const key = projection.kind === "accepted" ? snapshotKey : overflowKey
    const payload = toRepositoryJson(projection.payload)
    await appendEvent(client, input, type, key, payload)
    await client.query("COMMIT"); committed = true
    return projection.kind === "accepted" ? { kind: "accepted", projection: projection.payload.projection }
      : { kind: "overflow", reason: projection.payload.reason, observedFactCount: projection.payload.observedFactCount, canonicalUtf8Bytes: projection.payload.canonicalUtf8Bytes }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    if (error instanceof TurnLeaseError || error instanceof TurnEngineError) throw error
    throw conflict()
  } finally { client.release() }
}

export type DiscoveryPersonaSnapshotEstimate =
  | { readonly kind: "accepted"; readonly estimatedTokens: number }
  | { readonly kind: "absent" }
  | { readonly kind: "overflow" }

/** Read only an already-persisted, verified same-Session snapshot before the first Step. */
export async function readDiscoveryPersonaSnapshotForCompaction(
  pool: Pick<pg.Pool, "connect">, input: OwnerInput,
): Promise<DiscoveryPersonaSnapshotEstimate> {
  const { lease, rootTaskId } = input
  if (input.scope.userId !== lease.userId) throw conflict()
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", lease.userId])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('applymate:persona-facts:' || $1::text, 0))", [lease.userId])
    await assertCurrentRootOwner(client, input)
    const overflowKey = OVERFLOW_KEY(lease.sessionId, lease.turnId)
    const priorOverflow = await readEvent(client, overflowKey)
    if (priorOverflow) {
      await assertRetainedEventOwner(client, priorOverflow, input)
      const payload = parseDiscoveryPersonaOverflowPayload(parsedJson(priorOverflow.payload))
      if (!envelope(priorOverflow, DISCOVERY_PERSONA_OVERFLOW_EVENT, overflowKey) || priorOverflow.turnId !== lease.turnId
        || priorOverflow.taskId !== rootTaskId || !payload) throw conflict()
      await verifyOutbox(client, expectedOutbox(priorOverflow, toRepositoryJson(payload)))
      await client.query("COMMIT"); committed = true
      return { kind: "overflow" }
    }
    const snapshotKey = SNAPSHOT_KEY(lease.sessionId)
    const priorSnapshot = await readEvent(client, snapshotKey)
    if (!priorSnapshot) {
      await client.query("COMMIT"); committed = true
      return { kind: "absent" }
    }
    await assertRetainedEventOwner(client, priorSnapshot, input)
    const payload = parseDiscoveryPersonaSnapshotPayload(parsedJson(priorSnapshot.payload))
    if (!envelope(priorSnapshot, DISCOVERY_PERSONA_SNAPSHOT_EVENT, snapshotKey) || !payload) throw conflict()
    await verifyOutbox(client, expectedOutbox(priorSnapshot, toRepositoryJson(payload)))
    const estimatedTokens = estimateDiscoveryPersonaContextTokens(payload.projection)
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) throw conflict()
    await client.query("COMMIT"); committed = true
    return { kind: "accepted", estimatedTokens }
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    if (error instanceof TurnLeaseError || error instanceof TurnEngineError) throw error
    throw conflict()
  } finally { client.release() }
}
