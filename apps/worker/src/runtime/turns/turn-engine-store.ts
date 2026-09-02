import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import type { TurnLease } from "./lease.js"
import type { TurnEngineItem, TurnEngineStore, TurnEngineStep } from "./turn-engine-types.js"

type TurnEnginePool = Pick<pg.Pool, "connect">
type QueryClient = Pick<pg.PoolClient, "query" | "release">

function json(value: RepositoryJsonValue): string {
  return JSON.stringify(value)
}

function conflict(resource: string): Error {
  const error = new Error(`TurnEngine persistence conflict: ${resource}`)
  error.name = "TurnEnginePersistenceConflict"
  return error
}

function leasePredicate(lease: TurnLease, startParameter: number, now: Date, turnAlias = "turn"): { sql: string; values: unknown[] } {
  return {
    sql: `"${turnAlias}"."userId" = $${startParameter} AND "${turnAlias}"."leaseOwnerId" = $${startParameter + 1}
          AND "${turnAlias}"."leaseVersion" = $${startParameter + 2} AND "${turnAlias}"."leaseExpiresAt" > $${startParameter + 3}
          AND "${turnAlias}"."status" = 'in_progress'`,
    values: [lease.userId, lease.ownerId, lease.leaseVersion, now],
  }
}

export function createPgTurnEngineStore(pool: TurnEnginePool): TurnEngineStore {
  return {
    async startStep(input): Promise<TurnEngineStep> {
      const client = await pool.connect()
      try {
        const guard = leasePredicate(input.lease, 10, input.now)
        const result = await client.query<{ id: string }>(
          `INSERT INTO "agent_steps"
             ("id", "sessionId", "turnId", "ordinal", "attempt", "status",
              "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
           SELECT $1, $2, $3, $4, $5, 'streaming', $6, $7::jsonb, $8::jsonb, $9
           FROM "agent_turns" AS turn
           WHERE turn."id" = $3 AND turn."sessionId" = $2
             AND ${guard.sql}
           RETURNING "id"`,
          [input.stepId, input.lease.sessionId, input.lease.turnId, input.ordinal, input.attempt,
            input.inputThroughSequence.toString(), json([...input.consumedInputIds]), json(input.modelProfileSnapshot), input.now,
            ...guard.values],
        )
        if (!result.rows[0]) throw conflict(`step ${input.stepId}`)
        return { id: result.rows[0].id }
      } finally { client.release() }
    },

    async updateStep(input): Promise<void> {
      const client = await pool.connect()
      try {
        const result = await client.query(
          `UPDATE "agent_steps" AS step
           SET "status" = $1, "finishReason" = $2, "errorCode" = $3,
               "inputTokens" = $4, "outputTokens" = $5, "estimatedCostUsd" = $6,
               "completedAt" = CASE WHEN $1 IN ('completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user') THEN $7 ELSE NULL END
           FROM "agent_turns" AS turn
           WHERE step."id" = $8 AND step."sessionId" = $9 AND step."turnId" = $10
             AND turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
             AND turn."userId" = $11 AND turn."leaseOwnerId" = $12
             AND turn."leaseVersion" = $13 AND turn."leaseExpiresAt" > $7
             AND turn."status" = 'in_progress'`,
          [input.status, input.finishReason, input.errorCode, input.inputTokens, input.outputTokens, input.estimatedCostUsd,
            input.now, input.stepId, input.lease.sessionId, input.lease.turnId, input.lease.userId,
            input.lease.ownerId, input.lease.leaseVersion],
        )
        if (result.rowCount !== 1) throw conflict(`step ${input.stepId}`)
      } finally { client.release() }
    },

    async createItem(input): Promise<TurnEngineItem> {
      const client = await pool.connect()
      try {
        const guard = leasePredicate(input.lease, 10, input.now)
        const result = await client.query<{ id: string; revision: number }>(
          `INSERT INTO "agent_items"
             ("id", "sessionId", "turnId", "stepId", "type", "status", "phase", "content", "startedAt", "updatedAt")
           SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9
           FROM "agent_turns" AS turn
           WHERE turn."id" = $3 AND turn."sessionId" = $2 AND ${guard.sql}
           ON CONFLICT ("id") DO NOTHING
           RETURNING "id", "revision"`,
          [input.itemId, input.lease.sessionId, input.lease.turnId, input.stepId, input.type, input.status, input.phase, json(input.content), input.now, ...guard.values],
        )
        if (result.rows[0]) return result.rows[0]
        const existing = await client.query<{ id: string; revision: number }>(
          `SELECT item."id", item."revision"
           FROM "agent_items" AS item
           JOIN "agent_turns" AS turn ON turn."id" = item."turnId"
           WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3
             AND turn."userId" = $4 AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6`,
          [input.itemId, input.lease.sessionId, input.lease.turnId, input.lease.userId, input.lease.ownerId, input.lease.leaseVersion],
        )
        if (!existing.rows[0]) throw conflict(`item ${input.itemId}`)
        return existing.rows[0]
      } finally { client.release() }
    },

    async updateItem(input): Promise<TurnEngineItem> {
      const client = await pool.connect()
      try {
        const result = await client.query<{ id: string; revision: number }>(
          `UPDATE "agent_items" AS item
           SET "status" = $1, "phase" = $2, "content" = $3::jsonb,
               "revision" = item."revision" + 1, "startedAt" = $4,
               "completedAt" = $5, "updatedAt" = $6
           FROM "agent_turns" AS turn
           WHERE item."id" = $7 AND item."sessionId" = $8 AND item."turnId" = $9
             AND item."revision" = $10 AND turn."id" = item."turnId"
             AND turn."userId" = $11 AND turn."leaseOwnerId" = $12
             AND turn."leaseVersion" = $13 AND turn."leaseExpiresAt" > $6
             AND turn."status" = 'in_progress'
           RETURNING item."id", item."revision"`,
          [input.status, input.phase, json(input.content), input.startedAt, input.completedAt, input.now,
            input.itemId, input.lease.sessionId, input.lease.turnId, input.expectedRevision, input.lease.userId,
            input.lease.ownerId, input.lease.leaseVersion],
        )
        if (!result.rows[0]) throw conflict(`item ${input.itemId} revision ${input.expectedRevision}`)
        return result.rows[0]
      } finally { client.release() }
    },

    async appendEvent(input): Promise<{ id: string }> {
      const client = await pool.connect()
      let committed = false
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.lease.userId])
        const existing = await client.query<{ id: string }>(
          `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
          [input.lease.sessionId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
          await client.query("COMMIT")
          committed = true
          return existing.rows[0]
        }
        const guard = await client.query<{ id: string }>(
          `SELECT "id" FROM "agent_turns"
           WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
             AND "leaseOwnerId" = $4 AND "leaseVersion" = $5
             AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND "status" = 'in_progress' FOR UPDATE`,
          [input.lease.turnId, input.lease.sessionId, input.lease.userId, input.lease.ownerId, input.lease.leaseVersion],
        )
        if (!guard.rows[0]) throw conflict(`turn ${input.lease.turnId}`)
        if (input.itemId) {
          const item = await client.query<{ id: string }>(
            `SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
            [input.itemId, input.lease.sessionId, input.lease.turnId],
          )
          if (!item.rows[0]) throw conflict(`item ${input.itemId}`)
        }
        const sequence = await client.query<{ eventSequence: bigint | string }>(
          `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
           WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`,
          [input.lease.sessionId, input.lease.userId],
        )
        const next = sequence.rows[0]?.eventSequence
        if (next === undefined) throw conflict(`session ${input.lease.sessionId}`)
        await client.query(
          `INSERT INTO "agent_events"
             ("id", "sessionId", "turnId", "itemId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
           VALUES ($1, $2, $3, $4, $5, $6, 'orchestrator', $7, $8, $9, $10::jsonb)`,
          [input.id, input.lease.sessionId, input.lease.turnId, input.itemId, BigInt(next).toString(), input.type,
            input.correlationId, input.causationId, input.idempotencyKey, json(input.payload)],
        )
        await client.query(
          `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
           VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`,
          [`agent-outbox-${input.id}`, input.lease.sessionId, `agent-event:${input.id}`, json({
            eventId: input.id, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
            itemId: input.itemId, sequence: BigInt(next).toString(), type: input.type,
            actor: "orchestrator", correlationId: input.correlationId, causationId: input.causationId,
            idempotencyKey: input.idempotencyKey, payload: input.payload,
          })],
        )
        await client.query("COMMIT")
        committed = true
        return { id: input.id }
      } catch (error: unknown) {
        if (!committed) await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { client.release() }
    },

    async recordFinalResponse(input): Promise<void> {
      const client: QueryClient = await pool.connect()
      try {
        const result = await client.query(
          `UPDATE "agent_turns"
           SET "finalResponse" = $1, "updatedAt" = $2
           WHERE "id" = $3 AND "sessionId" = $4 AND "userId" = $5
             AND "leaseOwnerId" = $6 AND "leaseVersion" = $7
             AND "leaseExpiresAt" > $2 AND "status" = 'in_progress'`,
          [input.response, input.now, input.lease.turnId, input.lease.sessionId, input.lease.userId, input.lease.ownerId, input.lease.leaseVersion],
        )
        if (result.rowCount !== 1) throw conflict(`final response for turn ${input.lease.turnId}`)
      } finally { client.release() }
    },
  }
}
