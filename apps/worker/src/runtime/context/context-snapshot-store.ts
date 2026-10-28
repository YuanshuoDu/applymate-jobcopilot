import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { assertSnapshotIntegrity, canonicalJson } from "./context-snapshot-canonical.js"
import {
  ContextSnapshotError,
  type AgentContextSnapshot,
  type ContextSnapshotStorePort,
} from "./context-snapshot-types.js"
import {
  CONTEXT_SNAPSHOT_COLUMNS,
  CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED,
  mapContextSnapshotRow,
  type ContextSnapshotRow,
} from "./context-snapshot-row.js"

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return value
}

function scopeUser(scope: TenantScope): string {
  return nonEmpty(scope.userId, "scope.userId")
}

function assertSnapshotOwner(snapshot: AgentContextSnapshot, userId: string): void {
  if (snapshot.content.ownerId !== userId) {
    throw new ContextSnapshotError("reference_cross_tenant", "Context snapshot content is outside the tenant scope")
  }
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
      assertSnapshotOwner(snapshot, userId)
      const id = snapshot.id ?? randomUUID()
      return withTransaction(pool, userId, async (client) => {
        await sessionOwner(client, snapshot, userId)
        const inserted = await client.query<ContextSnapshotRow>(
          `INSERT INTO "agent_context_snapshots" (${CONTEXT_SNAPSHOT_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT DO NOTHING
           RETURNING ${CONTEXT_SNAPSHOT_COLUMNS}`,
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
        const existing = inserted.rows[0] ?? (await client.query<ContextSnapshotRow>(
          `SELECT ${CONTEXT_SNAPSHOT_COLUMNS} FROM "agent_context_snapshots"
           WHERE "sessionId" = $1 AND "throughSequence" = $2 FOR UPDATE`,
          [snapshot.sessionId, snapshot.throughSequence.toString()],
        )).rows[0]
        if (!existing) throw new ContextSnapshotError("snapshot_conflict", "Snapshot could not be inserted or loaded")
        const persisted = mapContextSnapshotRow(existing)
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
        const result = await client.query<ContextSnapshotRow>(
          `SELECT ${CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED}
           FROM "agent_context_snapshots" AS snapshot
           JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
           WHERE snapshot."sessionId" = $1 AND snapshot."throughSequence" = $2
             AND session."userId" = $3`,
          [input.sessionId, input.throughSequence.toString(), userId],
        )
        if (!result.rows[0]) return null
        const snapshot = mapContextSnapshotRow(result.rows[0])
        assertSnapshotOwner(snapshot, userId)
        return snapshot
      })
    },
  }
}
