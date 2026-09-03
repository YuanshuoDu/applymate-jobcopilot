import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import {
  assertSnapshotIntegrity,
  canonicalJson,
  parseSnapshotContent,
  snapshotCanonicalJson,
} from "./context-snapshot-canonical.js"
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ContextSnapshotError,
  type AgentContextSnapshot,
  type ContextSnapshotStorePort,
} from "./context-snapshot-types.js"

type SnapshotRow = {
  id: string
  sessionId: string
  throughSequence: bigint | string
  version: number | string
  schemaVersion: string
  content: unknown
  summary: string
  checksum: string
  inputTokens: number | string
  outputTokens: number | string
  estimatedCostUsd: number | string
  tokenAccounting: unknown
  createdAt: Date | string
}

const SNAPSHOT_COLUMNS = `"id", "sessionId", "throughSequence", "version", "schemaVersion", "content", "summary", "checksum", "inputTokens", "outputTokens", "estimatedCostUsd", "tokenAccounting", "createdAt"`

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return value
}

function scopeUser(scope: TenantScope): string {
  return nonEmpty(scope.userId, "scope.userId")
}

function integer(value: number | string | bigint, field: string): number {
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return result
}

function decimal(value: number | string, field: string): number {
  const result = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(result) || result < 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return Number(result.toFixed(8))
}

function date(value: Date | string, field: string): Date {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return result
}

function mapRow(row: SnapshotRow): AgentContextSnapshot {
  const sessionId = nonEmpty(row.sessionId, "sessionId")
  const throughSequence = BigInt(row.throughSequence)
  if (throughSequence < 0n) throw new ContextSnapshotError("store_conflict", "Invalid throughSequence")
  if (row.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) throw new ContextSnapshotError("store_conflict", "Unsupported context snapshot schema version")
  const content = parseSnapshotContent(row.content)
  const base = { sessionId, throughSequence, version: integer(row.version, "version"), content }
  const snapshot: AgentContextSnapshot = {
    id: nonEmpty(row.id, "id"),
    ...base,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    summary: nonEmpty(row.summary, "summary"),
    memorySummary: row.summary,
    checksum: nonEmpty(row.checksum, "checksum"),
    inputTokens: integer(row.inputTokens, "inputTokens"),
    outputTokens: integer(row.outputTokens, "outputTokens"),
    estimatedCostUsd: decimal(row.estimatedCostUsd, "estimatedCostUsd"),
    tokenAccounting: row.tokenAccounting as AgentContextSnapshot["tokenAccounting"],
    canonicalJson: snapshotCanonicalJson(base),
    createdAt: date(row.createdAt, "createdAt"),
  }
  assertSnapshotIntegrity(snapshot)
  return snapshot
}

function sameSnapshot(left: AgentContextSnapshot, right: AgentContextSnapshot): boolean {
  return left.checksum === right.checksum
    && left.version === right.version
    && left.schemaVersion === right.schemaVersion
    && left.summary === right.summary
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.estimatedCostUsd === right.estimatedCostUsd
    && canonicalJson(left.tokenAccounting) === canonicalJson(right.tokenAccounting)
}

async function withTransaction<T>(pool: Pick<pg.Pool, "connect">, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function sessionOwner(client: pg.PoolClient, snapshot: AgentContextSnapshot, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
    [snapshot.sessionId, userId],
  )
  if (!result.rows[0]) throw new ContextSnapshotError("session_not_found", `Session ${snapshot.sessionId} is not owned by the tenant`)
}

async function persistProjection(client: pg.PoolClient, snapshot: AgentContextSnapshot, userId: string): Promise<void> {
  await client.query(
    `UPDATE "agent_sessions" AS session
     SET "memorySummary" = $1
     WHERE session."id" = $2 AND session."userId" = $3
       AND NOT EXISTS (
         SELECT 1 FROM "agent_context_snapshots" AS newer
         WHERE newer."sessionId" = session."id"
           AND newer."throughSequence" > $4
       )`,
    [snapshot.memorySummary, snapshot.sessionId, userId, snapshot.throughSequence.toString()],
  )
}

export function createPgContextSnapshotStore(pool: Pick<pg.Pool, "connect">): ContextSnapshotStorePort {
  return {
    async save(snapshot, scope): Promise<AgentContextSnapshot> {
      const userId = scopeUser(scope)
      assertSnapshotIntegrity(snapshot)
      const id = snapshot.id ?? randomUUID()
      return withTransaction(pool, userId, async (client) => {
        await sessionOwner(client, snapshot, userId)
        const inserted = await client.query<SnapshotRow>(
          `INSERT INTO "agent_context_snapshots" (${SNAPSHOT_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING
           RETURNING ${SNAPSHOT_COLUMNS}`,
          [
            id,
            snapshot.sessionId,
            snapshot.throughSequence.toString(),
            snapshot.version,
            snapshot.schemaVersion,
            JSON.stringify(snapshot.content),
            snapshot.summary,
            snapshot.checksum,
            snapshot.inputTokens,
            snapshot.outputTokens,
            snapshot.estimatedCostUsd.toFixed(8),
            JSON.stringify(snapshot.tokenAccounting),
          ],
        )
        const existing = inserted.rows[0] ?? (await client.query<SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM "agent_context_snapshots"
           WHERE "sessionId" = $1 AND "throughSequence" = $2 FOR UPDATE`,
          [snapshot.sessionId, snapshot.throughSequence.toString()],
        )).rows[0]
        if (!existing) throw new ContextSnapshotError("snapshot_conflict", "Snapshot could not be inserted or loaded")
        const persisted = mapRow(existing)
        if (!sameSnapshot(persisted, snapshot)) throw new ContextSnapshotError("snapshot_conflict", "Snapshot identity already has different content")
        await persistProjection(client, persisted, userId)
        return persisted
      })
    },

    async load(input): Promise<AgentContextSnapshot | null> {
      const userId = scopeUser(input.scope)
      nonEmpty(input.sessionId, "sessionId")
      if (input.throughSequence < 0n) throw new ContextSnapshotError("invalid_input", "throughSequence must not be negative")
      return withTransaction(pool, userId, async (client) => {
        const result = await client.query<SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS}
           FROM "agent_context_snapshots" AS snapshot
           JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
           WHERE snapshot."sessionId" = $1 AND snapshot."throughSequence" = $2
             AND session."userId" = $3`,
          [input.sessionId, input.throughSequence.toString(), userId],
        )
        return result.rows[0] ? mapRow(result.rows[0]) : null
      })
    },
  }
}
