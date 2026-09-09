import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import { ownerFenceSql } from "./turn-engine-owner-sql.js"
import { toRepositoryJson, type TurnEngineItem, type TurnEngineStore, type TurnEngineStep } from "./turn-engine-types.js"

type TurnEnginePool = Pick<pg.Pool, "connect">
type QueryClient = Pick<pg.PoolClient, "query" | "release">
type Row = Record<string, unknown>

function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function conflict(resource: string): Error {
  const error = new Error(`TurnEngine persistence conflict: ${resource}`)
  error.name = "TurnEnginePersistenceConflict"
  return error
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right)) }

async function tenantTransaction<T>(pool: TurnEnginePool, userId: string, work: (client: QueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const result = await work(client)
    await client.query("COMMIT"); committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function ownedTurn(owner: ExecutionOwnerFence, base: number, turnIdParameter: number, sessionParameter: number, allowWaiting = false): { sql: string; values: unknown[] } {
  const fence = ownerFenceSql(owner, base, allowWaiting)
  return {
    sql: `FROM "agent_turns" AS turn ${fence.joins}
      WHERE turn."id" = $${turnIdParameter} AND turn."sessionId" = $${sessionParameter} AND ${fence.where}`,
    values: [...fence.values],
  }
}

async function lockOwnedTurn(client: QueryClient, owner: ExecutionOwnerFence, allowWaiting = false): Promise<boolean> {
  const fence = ownerFenceSql(owner, 1, allowWaiting)
  const result = owner.kind === "turn"
    ? await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, owner.turnId, owner.sessionId])
    : await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $3 AND turn."sessionId" = $2 AND ${fence.where} FOR UPDATE`, fence.values as unknown[])
  return Boolean(result.rows[0])
}

async function assertCurrentStepLineage(client: QueryClient, owner: ExecutionOwnerFence, stepId: string | null): Promise<void> {
  if (!stepId) return
  const attempt = owner.kind === "task" ? owner.attemptCount : 1
  const result = await client.query<Row>(`SELECT "id" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
  [stepId, owner.sessionId, owner.turnId, owner.taskId, attempt])
  if (!result.rows[0]) throw conflict(`step ${stepId} lineage`)
}

async function assertCurrentItemLineage(client: QueryClient, owner: ExecutionOwnerFence, itemId: string): Promise<void> {
  const attempt = owner.kind === "task" ? owner.attemptCount : 1
  const result = await client.query<Row>(`SELECT item."id" FROM "agent_items" AS item
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND (item."stepId" IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
        WHERE owner_step."id" = item."stepId" AND owner_step."sessionId" = item."sessionId"
          AND owner_step."turnId" = item."turnId" AND owner_step."taskId" = item."taskId" AND owner_step."attempt" = $5))`,
  [itemId, owner.sessionId, owner.turnId, owner.taskId, attempt])
  if (!result.rows[0]) throw conflict(`item ${itemId} lineage`)
}

export function createPgTurnEngineStore(pool: TurnEnginePool): TurnEngineStore {
  return {
    async startStep(input): Promise<TurnEngineStep> {
      const actualAttempt = input.owner.kind === "task" ? input.owner.attemptCount : 1
      if (input.attempt !== actualAttempt) throw conflict(`step ${input.stepId} attempt`)
      const client = await pool.connect(); let committed = false
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.owner.userId])
        const fence = ownerFenceSql(input.owner, 1)
        const owned = input.owner.kind === "turn"
          ? await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, input.owner.turnId, input.owner.sessionId])
          : await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $3 AND turn."sessionId" = $2 AND ${fence.where} FOR UPDATE`, fence.values as unknown[])
        if (!owned.rows[0]) throw conflict(`step ${input.stepId}`)
        const existing = await client.query<Row>(`SELECT "id", "ordinal", "taskId", "attempt", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot"
          FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [input.stepId, input.owner.sessionId, input.owner.turnId])
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (row.taskId !== input.owner.taskId || Number(row.attempt) !== input.attempt || String(row.inputThroughSequence) !== input.inputThroughSequence.toString()
            || !sameJson(row.consumedInputIds, input.consumedInputIds) || !sameJson(row.modelProfileSnapshot, input.modelProfileSnapshot)) throw conflict(`step ${input.stepId} identity`)
          await client.query("COMMIT"); committed = true
          return { id: String(row.id), ordinal: Number(row.ordinal) }
        }
        const ordinalResult = await client.query<{ ordinal: number | string }>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal" FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2`, [input.owner.turnId, input.owner.sessionId])
        const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 0)
        const result = await client.query<{ id: string }>(`INSERT INTO "agent_steps"
          ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'streaming', $7, $8::jsonb, $9::jsonb, $10) RETURNING "id"`, [input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, ordinal, input.attempt, input.inputThroughSequence.toString(), json([...input.consumedInputIds]), json(input.modelProfileSnapshot), input.now])
        if (!result.rows[0]) throw conflict(`step ${input.stepId}`)
        await client.query("COMMIT"); committed = true
        return { id: result.rows[0].id, ordinal }
      } catch (error: unknown) { if (!committed) await client.query("ROLLBACK").catch(() => undefined); throw error }
      finally { client.release() }
    },
    async updateStep(input): Promise<void> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`step ${input.stepId}`)
        const attempt = input.owner.kind === "task" ? input.owner.attemptCount : 1
        const guard = ownedTurn(input.owner, 13, 10, 9, true)
        const result = await client.query(`UPDATE "agent_steps" AS step SET "status" = $1, "finishReason" = $2, "errorCode" = $3,
          "inputTokens" = $4, "outputTokens" = $5, "estimatedCostUsd" = $6,
          "completedAt" = CASE WHEN $1 IN ('completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user') THEN $7 ELSE NULL END
          ${guard.sql} AND step."id" = $8 AND step."sessionId" = $9 AND step."turnId" = $10 AND step."taskId" = $11 AND step."attempt" = $12
          AND turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"`, [input.status, input.finishReason, input.errorCode, input.inputTokens, input.outputTokens, input.estimatedCostUsd, input.now, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, attempt, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`step ${input.stepId}`)
      })
    },
    async waitForUser(input): Promise<void> {
      if (input.owner.kind !== "turn") throw conflict(`child wait ${input.owner.taskId}`)
      return tenantTransaction(pool, input.owner.userId, async client => {
        const guard = ownerFenceSql(input.owner, 4)
        const result = await client.query(`UPDATE "agent_turns" AS turn SET "status" = 'waiting_for_user', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1 ${guard.joins} WHERE turn."id" = $2 AND turn."sessionId" = $3 AND ${guard.where}`, [input.now, input.owner.turnId, input.owner.sessionId, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`turn ${input.owner.turnId} wait state`)
      })
    },
    async createItem(input): Promise<TurnEngineItem> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        const guard = ownedTurn(input.owner, 11, 3, 2, true)
        const stepAttempt = input.owner.kind === "task" ? 'owner_task."attemptCount"' : "1"
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`item ${input.itemId}`)
        await assertCurrentStepLineage(client, input.owner, input.stepId)
        const result = await client.query<{ id: string; revision: number }>(`INSERT INTO "agent_items"
          ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
          SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10 ${guard.sql}
          AND ($4 IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
            WHERE owner_step."id" = $4 AND owner_step."turnId" = $3 AND owner_step."sessionId" = $2
              AND owner_step."taskId" = $5 AND owner_step."attempt" = ${stepAttempt}))
          ON CONFLICT ("id") DO NOTHING RETURNING "id", "revision"`, [input.itemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, input.type, input.status, input.phase, json(input.content), input.now, ...guard.values])
        if (result.rows[0]) return result.rows[0]
        const existing = await client.query<Row>(`SELECT item."id", item."revision", item."taskId", item."stepId", item."type", item."status", item."phase", item."content"
          FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId"
          WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND turn."userId" = $4`, [input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.userId])
        if (!existing.rows[0]) throw conflict(`item ${input.itemId}`)
        const row = existing.rows[0]
        if (row.taskId !== input.owner.taskId || row.stepId !== input.stepId || row.type !== input.type || row.status !== input.status
          || row.phase !== input.phase || !sameJson(row.content, input.content)) throw conflict(`item ${input.itemId} identity`)
        return { id: String(row.id), revision: Number(row.revision) }
      })
    },
    async updateItem(input): Promise<TurnEngineItem> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`item ${input.itemId}`)
        await assertCurrentItemLineage(client, input.owner, input.itemId)
        const guard = ownedTurn(input.owner, 12, 9, 8, true)
        const stepAttempt = input.owner.kind === "task" ? 'owner_task."attemptCount"' : "1"
        const result = await client.query<{ id: string; revision: number }>(`UPDATE "agent_items" AS item SET "status" = $1, "phase" = $2, "content" = $3::jsonb,
          "revision" = item."revision" + 1, "startedAt" = $4, "completedAt" = $5, "updatedAt" = $6 ${guard.sql}
          AND item."id" = $7 AND item."sessionId" = $8 AND item."turnId" = $9 AND item."taskId" = $10
          AND item."revision" = $11 AND turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
          AND (item."stepId" IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
            WHERE owner_step."id" = item."stepId" AND owner_step."turnId" = item."turnId" AND owner_step."sessionId" = item."sessionId"
              AND owner_step."taskId" = item."taskId" AND owner_step."attempt" = ${stepAttempt}))
          RETURNING item."id", item."revision"`, [input.status, input.phase, json(input.content), input.startedAt, input.completedAt, input.now, input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, input.expectedRevision, ...guard.values])
        if (!result.rows[0]) throw conflict(`item ${input.itemId} revision ${input.expectedRevision}`)
        return result.rows[0]
      })
    },
    async appendEvent(input): Promise<{ id: string }> {
      if (input.owner.kind === "task" && ["turn.completed", "turn.failed", "turn.interrupted"].includes(input.type)) throw conflict(`child root lifecycle ${input.type}`)
      const client = await pool.connect(); let committed = false
      try {
        await client.query("BEGIN"); await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.owner.userId])
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`turn ${input.owner.turnId}`)
        if (input.itemId) await assertCurrentItemLineage(client, input.owner, input.itemId)
        const existing = await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "correlationId", "causationId", "payload"
          FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [input.owner.sessionId, input.idempotencyKey])
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (row.taskId !== input.owner.taskId || row.turnId !== input.owner.turnId || row.itemId !== input.itemId || row.type !== input.type
            || row.correlationId !== input.correlationId || row.causationId !== input.causationId || !sameJson(row.payload, input.payload)) throw conflict(`event ${input.idempotencyKey} identity`)
          await client.query("COMMIT"); committed = true; return { id: String(row.id) }
        }
        if (input.itemId) {
          const item = await client.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`, [input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
          if (!item.rows[0]) throw conflict(`item ${input.itemId}`)
        }
        const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [input.owner.sessionId, input.owner.userId])
        const next = sequence.rows[0]?.eventSequence
        if (next === undefined) throw conflict(`session ${input.owner.sessionId}`)
        const actor = input.owner.kind === "task" ? "subagent" : "orchestrator"
        await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`, [input.id, input.owner.sessionId, input.owner.turnId, input.itemId, input.owner.taskId, BigInt(next).toString(), input.type, actor, input.correlationId, input.causationId, input.idempotencyKey, json(input.payload)])
        await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`, [`agent-outbox-${input.id}`, input.owner.sessionId, `agent-event:${input.id}`, json({ eventId: input.id, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId, itemId: input.itemId, sequence: BigInt(next).toString(), type: input.type, actor, correlationId: input.correlationId, causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload })])
        await client.query("COMMIT"); committed = true; return { id: input.id }
      } catch (error: unknown) { if (!committed) await client.query("ROLLBACK").catch(() => undefined); throw error }
      finally { client.release() }
    },
    async recordFinalResponse(input): Promise<void> {
      if (input.owner.kind !== "turn") throw conflict(`child final response ${input.owner.taskId}`)
      return tenantTransaction(pool, input.owner.userId, async (client: QueryClient) => {
        const guard = ownerFenceSql(input.owner, 5, true)
        const result = await client.query(`UPDATE "agent_turns" AS turn SET "finalResponse" = $1, "updatedAt" = $2 ${guard.joins} WHERE turn."id" = $3 AND turn."sessionId" = $4 AND ${guard.where}`, [input.response, input.now, input.owner.turnId, input.owner.sessionId, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`final response for turn ${input.owner.turnId}`)
      })
    },
  }
}
