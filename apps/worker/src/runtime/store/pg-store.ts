import type pg from "pg"
import type {
  AgentRepositoryUnitOfWork,
  AgentStore,
  AppendEventInput,
  ClaimTurnInput,
  StartStepInput,
  TenantScope,
  UpdateItemInput,
} from "@jobcopilot/agent-protocol"

import { AgentRepositoryConflictError } from "./errors.js"
import { mapEvent, mapItem, mapStep, mapTurn } from "./mapping.js"
import { readPgProjection } from "./pg-projection.js"

type Client = pg.PoolClient

function conflict(resource: string): AgentRepositoryConflictError {
  return new AgentRepositoryConflictError(`Agent repository state conflict: ${resource}`)
}

function eventOutboxPayload(input: AppendEventInput, sequence: bigint): string {
  return JSON.stringify({
    eventId: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId: input.itemId,
    taskId: input.taskId,
    sequence: sequence.toString(),
    type: input.type,
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  })
}

function createUnitOfWork(client: Client, scope: TenantScope): AgentRepositoryUnitOfWork {
  return {
    async claimTurn(input: ClaimTurnInput) {
      const result = await client.query(
        `UPDATE "agent_turns"
         SET "status" = $1, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4
           AND "revision" = $5 AND "status" = $6
         RETURNING "id", "sessionId", "userId", "source", "status", "revision", "createdAt", "updatedAt"`,
        ["in_progress", input.turnId, input.sessionId, scope.userId, input.expectedRevision, input.expectedStatus],
      )
      return result.rows[0] ? mapTurn(result.rows[0]) : null
    },

    async startStep(input: StartStepInput) {
      const result = await client.query(
        `INSERT INTO "agent_steps"
          ("id", "sessionId", "turnId", "ordinal", "attempt", "status",
           "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb
         FROM "agent_turns" AS turn
         WHERE turn."id" = $3 AND turn."sessionId" = $2 AND turn."userId" = $10
           AND turn."revision" = $11
           AND EXISTS (
             SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = turn."sessionId" AND session."userId" = $10
           )
         RETURNING "id", "sessionId", "turnId", "ordinal", "attempt", "status",
                   "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "createdAt"`,
        [
          input.stepId,
          input.sessionId,
          input.turnId,
          input.ordinal,
          input.attempt,
          input.status,
          input.inputThroughSequence.toString(),
          JSON.stringify(input.consumedInputIds),
          JSON.stringify(input.modelProfileSnapshot),
          scope.userId,
          input.expectedTurnRevision,
        ],
      )
      const step = result.rows[0]
      if (!step) throw conflict(`turn ${input.turnId}`)
      return mapStep(step)
    },

    async updateItem(input: UpdateItemInput) {
      const result = await client.query(
        `UPDATE "agent_items" AS item
         SET "status" = $1, "phase" = $2, "content" = $3::jsonb,
             "revision" = item."revision" + 1, "startedAt" = $4,
             "completedAt" = $5, "updatedAt" = CURRENT_TIMESTAMP
         WHERE item."id" = $6 AND item."sessionId" = $7
           AND item."revision" = $8
           AND EXISTS (
             SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = item."sessionId" AND session."userId" = $9
           )
         RETURNING item."id", item."sessionId", item."turnId", item."stepId", item."taskId",
                   item."type", item."status", item."phase", item."revision", item."content",
                   item."startedAt", item."completedAt", item."createdAt", item."updatedAt"`,
        [
          input.status,
          input.phase,
          JSON.stringify(input.content),
          input.startedAt,
          input.completedAt,
          input.itemId,
          input.sessionId,
          input.expectedRevision,
          scope.userId,
        ],
      )
      const item = result.rows[0]
      if (!item) throw conflict(`item ${input.itemId} revision ${input.expectedRevision}`)
      return mapItem(item)
    },

    async appendEvent(input: AppendEventInput) {
      const session = await client.query<{ id: string }>(
        `SELECT "id" FROM "agent_sessions"
         WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
        [input.sessionId, scope.userId],
      )
      if (!session.rows[0]) throw conflict(`session ${input.sessionId}`)

      const turn = await client.query<{ id: string }>(
        `SELECT "id" FROM "agent_turns"
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [input.turnId, input.sessionId, scope.userId],
      )
      if (!turn.rows[0]) throw conflict(`turn ${input.turnId}`)
      if (input.itemId) {
        const item = await client.query<{ id: string }>(
          `SELECT "id" FROM "agent_items"
           WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
          [input.itemId, input.sessionId, input.turnId],
        )
        if (!item.rows[0]) throw conflict(`item ${input.itemId}`)
      }

      if (input.idempotencyKey) {
        const existing = await client.query(
          `SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type",
                  "actor", "correlationId", "causationId", "idempotencyKey", "payload", "createdAt"
           FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
          [input.sessionId, input.idempotencyKey],
        )
        if (existing.rows[0]) return mapEvent(existing.rows[0])
      }

      const sequence = await client.query<{ eventSequence: bigint | string }>(
        `UPDATE "agent_sessions"
         SET "eventSequence" = "eventSequence" + 1
         WHERE "id" = $1 AND "userId" = $2
         RETURNING "eventSequence"`,
        [input.sessionId, scope.userId],
      )
      const nextSequence = sequence.rows[0]?.eventSequence
      if (nextSequence === undefined) throw conflict(`session ${input.sessionId}`)
      const eventSequence = BigInt(nextSequence)

      const event = await client.query(
        `INSERT INTO "agent_events"
          ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
           "correlationId", "causationId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING "id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type",
                   "actor", "correlationId", "causationId", "idempotencyKey", "payload", "createdAt"`,
        [
          input.id,
          input.sessionId,
          input.turnId,
          input.itemId,
          input.taskId,
          eventSequence.toString(),
          input.type,
          input.actor,
          input.correlationId,
          input.causationId,
          input.idempotencyKey,
          JSON.stringify(input.payload),
        ],
      )

      await client.query(
        `INSERT INTO "agent_outbox"
          ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          `agent-outbox-${input.id}`,
          input.outboxTopic,
          input.sessionId,
          `agent-event:${input.id}`,
          eventOutboxPayload(input, eventSequence),
        ],
      )
      return mapEvent(event.rows[0])
    },
  }
}

export function createPgAgentStore(pool: pg.Pool, scope: TenantScope): AgentStore {
  return {
    async withUnitOfWork<T>(work: (uow: AgentRepositoryUnitOfWork) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
        const result = await work(createUnitOfWork(client, scope))
        await client.query("COMMIT")
        return result
      } catch (error: unknown) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    },

    async getProjection(input) {
      const client = await pool.connect()
      try {
        return await readPgProjection(client, scope, input)
      } finally {
        client.release()
      }
    },
  }
}
