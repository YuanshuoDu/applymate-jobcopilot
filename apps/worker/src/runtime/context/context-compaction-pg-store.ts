import type pg from "pg"
import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { ownerFenceSql } from "../turns/turn-engine-owner-sql.js"
import { OPEN_SESSION } from "../session-gate.js"

export type CompactionPgPool = Pick<pg.Pool, "connect">
export type CompactionPgClient = Pick<pg.PoolClient, "query" | "release">
export type CompactionPgRow = Record<string, unknown>
export type CompactionSnapshotRow = { id: string; sessionId: string; throughSequence: bigint | string; version: number | string; content: unknown; checksum: string }
export type CompactionEventInput = {
  readonly owner: TurnExecutionOwnerFence; readonly id: string; readonly itemId: string; readonly type: string
  readonly idempotencyKey: string; readonly causationId: string | null; readonly payload: RepositoryJsonValue
}

export function compactionConflict(resource: string): Error {
  const error = new Error(`Context compaction persistence conflict: ${resource}`)
  error.name = "ContextCompactionPersistenceConflict"
  return error
}

export function assertCompactionScope(scope: TenantScope, owner: TurnExecutionOwnerFence, sessionId: string, turnId: string): void {
  if (!scope.userId || scope.userId !== owner.userId || sessionId !== owner.sessionId || turnId !== owner.turnId) throw compactionConflict("tenant or owner scope")
}

export async function withCompactionOwner<T>(pool: CompactionPgPool, scope: TenantScope, owner: TurnExecutionOwnerFence, work: (client: CompactionPgClient, turn: CompactionPgRow) => Promise<T>): Promise<T> {
  assertCompactionScope(scope, owner, owner.sessionId, owner.turnId)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", owner.userId])
    const session = await client.query(`SELECT "id" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND session."userId" = $2 AND ${OPEN_SESSION} FOR UPDATE`, [owner.sessionId, owner.userId])
    if (!session.rows[0]) throw compactionConflict(`open session ${owner.sessionId}`)
    const fence = ownerFenceSql(owner, 1)
    const turn = await client.query<CompactionPgRow>(`SELECT turn."id", turn."contextSnapshotId", turn."input", turn."rootTaskId" FROM "agent_turns" AS turn
      WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, owner.turnId, owner.sessionId])
    if (!turn.rows[0]) throw compactionConflict(`owned turn ${owner.turnId}`)
    const result = await work(client, turn.rows[0])
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function latestCompactionSnapshot(client: CompactionPgClient, sessionId: string, lock = false): Promise<CompactionSnapshotRow | null> {
  const result = await client.query<CompactionSnapshotRow>(`SELECT "id", "sessionId", "throughSequence", "version", "content", "checksum"
    FROM "agent_context_snapshots" WHERE "sessionId" = $1 ORDER BY "version" DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`, [sessionId])
  return result.rows[0] ?? null
}

function eventPayload(input: CompactionEventInput, sequence: string): AgentOutboxPayload {
  return { eventId: input.id, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId, itemId: input.itemId, sequence,
    type: input.type, actor: "orchestrator", correlationId: input.itemId, causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload }
}

export async function appendCompactionEvent(client: CompactionPgClient, input: CompactionEventInput): Promise<{ id: string; sequence: string }> {
  const expectedId = { id: input.id, topic: "agent.events", aggregateId: input.owner.sessionId, idempotencyKey: `agent-event:${input.id}`, payload: eventPayload(input, "") }
  const existing = await client.query<CompactionPgRow>(`SELECT "id", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [input.owner.sessionId, input.idempotencyKey])
  if (existing.rows[0]) {
    const row = existing.rows[0]
    const sequence = String(row.sequence)
    const exact = String(row.id) === input.id && row.turnId === input.owner.turnId && row.itemId === input.itemId && row.taskId === input.owner.taskId
      && row.type === input.type && row.actor === "orchestrator" && row.correlationId === input.itemId && row.causationId === input.causationId
      && row.idempotencyKey === input.idempotencyKey && jsonEqual(row.payload, input.payload)
    if (!exact) throw compactionConflict(`event ${input.idempotencyKey} identity`)
    await ensureEventOutbox(client, { ...expectedId, payload: eventPayload(input, sequence) })
    return { id: input.id, sequence }
  }
  const sequenceResult = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" AS session SET "eventSequence" = session."eventSequence" + 1
    WHERE session."id" = $1 AND session."userId" = $2 AND ${OPEN_SESSION}
    RETURNING session."eventSequence"`, [input.owner.sessionId, input.owner.userId])
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw compactionConflict(`event session ${input.owner.sessionId}`)
  const sequenceText = String(sequence)
  const payload = eventPayload(input, sequenceText)
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'orchestrator', $8, $9, $10, $11::jsonb)`, [input.id, input.owner.sessionId, input.owner.turnId, input.itemId, input.owner.taskId, sequenceText, input.type, input.itemId, input.causationId, input.idempotencyKey, JSON.stringify(input.payload)])
  await ensureEventOutbox(client, { ...expectedId, payload })
  return { id: input.id, sequence: sequenceText }
}

async function ensureEventOutbox(client: CompactionPgClient, expected: AgentOutboxIdentity): Promise<void> {
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.events', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [expected.id, expected.aggregateId, expected.idempotencyKey, JSON.stringify(expected.payload)])
  if (inserted.rowCount === 1) return
  const result = await client.query<CompactionPgRow>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(result.rows[0], expected)) throw compactionConflict(`event outbox ${expected.idempotencyKey} identity`)
}

export function jsonText(value: unknown): string { return JSON.stringify(value) }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return jsonText(value)
}
export function jsonEqual(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right) }
export function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
