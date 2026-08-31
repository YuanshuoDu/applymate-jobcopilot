import { Prisma, PrismaClient } from "@prisma/client"
import type {
  AgentRepositoryUnitOfWork,
  AgentStore,
  AppendEventInput,
  ClaimTurnInput,
  StartStepInput,
  TenantScope,
  UpdateItemInput,
} from "@jobcopilot/agent-protocol"

import { AgentRepositoryConflictError } from "./errors"
import { mapEvent, mapItem, mapStep, mapTurn } from "./mapping"

type Transaction = Prisma.TransactionClient

function conflict(resource: string): AgentRepositoryConflictError {
  return new AgentRepositoryConflictError(`Agent repository state conflict: ${resource}`)
}

function outboxPayload(input: AppendEventInput, sequence: bigint): Prisma.InputJsonObject {
  return {
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
  } as Prisma.InputJsonObject
}

async function ownsSession(tx: Transaction, sessionId: string, scope: TenantScope): Promise<boolean> {
  const session = await tx.agentSession.findFirst({
    where: { id: sessionId, userId: scope.userId },
    select: { id: true },
  })
  return Boolean(session)
}

function createUnitOfWork(tx: Transaction, scope: TenantScope): AgentRepositoryUnitOfWork {
  return {
    async claimTurn(input: ClaimTurnInput) {
      if (!(await ownsSession(tx, input.sessionId, scope))) return null
      const result = await tx.agentTurn.updateMany({
        where: {
          id: input.turnId,
          sessionId: input.sessionId,
          userId: scope.userId,
          revision: input.expectedRevision,
          status: input.expectedStatus,
        },
        data: { status: "in_progress", revision: { increment: 1 } },
      })
      if (result.count !== 1) return null

      const turn = await tx.agentTurn.findFirst({
        where: { id: input.turnId, sessionId: input.sessionId, userId: scope.userId },
      })
      return turn ? mapTurn(turn) : null
    },

    async startStep(input: StartStepInput) {
      if (!(await ownsSession(tx, input.sessionId, scope))) throw conflict(`session ${input.sessionId}`)
      const turn = await tx.agentTurn.findFirst({
        where: {
          id: input.turnId,
          sessionId: input.sessionId,
          userId: scope.userId,
          revision: input.expectedTurnRevision,
        },
      })
      if (!turn) throw conflict(`turn ${input.turnId}`)

      const step = await tx.agentStep.create({
        data: {
          id: input.stepId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          ordinal: input.ordinal,
          attempt: input.attempt,
          status: input.status,
          inputThroughSequence: input.inputThroughSequence,
          consumedInputIds: input.consumedInputIds as Prisma.InputJsonValue,
          modelProfileSnapshot: input.modelProfileSnapshot as Prisma.InputJsonValue,
        },
      })
      return mapStep(step)
    },

    async updateItem(input: UpdateItemInput) {
      const rows = await tx.$queryRaw<Parameters<typeof mapItem>[0][]>(Prisma.sql`
        UPDATE "agent_items" AS item
        SET "status" = ${input.status},
            "phase" = ${input.phase},
            "content" = CAST(${JSON.stringify(input.content)} AS JSONB),
            "revision" = item."revision" + 1,
            "startedAt" = ${input.startedAt ? new Date(input.startedAt) : null},
            "completedAt" = ${input.completedAt ? new Date(input.completedAt) : null},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE item."id" = ${input.itemId}
          AND item."sessionId" = ${input.sessionId}
          AND item."revision" = ${input.expectedRevision}
          AND EXISTS (
            SELECT 1 FROM "agent_sessions" AS session
            WHERE session."id" = item."sessionId" AND session."userId" = ${scope.userId}
          )
        RETURNING item.*
      `)
      const item = rows[0]
      if (!item) throw conflict(`item ${input.itemId} revision ${input.expectedRevision}`)
      return mapItem(item)
    },

    async appendEvent(input: AppendEventInput) {
      const ownedSession = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "agent_sessions"
        WHERE "id" = ${input.sessionId} AND "userId" = ${scope.userId}
        FOR UPDATE
      `)
      if (!ownedSession[0]) throw conflict(`session ${input.sessionId}`)

      const turn = await tx.agentTurn.findFirst({
        where: { id: input.turnId, sessionId: input.sessionId, userId: scope.userId },
      })
      if (!turn) throw conflict(`turn ${input.turnId}`)
      if (input.itemId) {
        const item = await tx.agentItem.findFirst({
          where: { id: input.itemId, sessionId: input.sessionId, turnId: input.turnId },
        })
        if (!item) throw conflict(`item ${input.itemId}`)
      }

      if (input.idempotencyKey) {
        const existing = await tx.agentEvent.findFirst({
          where: { sessionId: input.sessionId, idempotencyKey: input.idempotencyKey },
        })
        if (existing) return mapEvent(existing)
      }

      const sequenceRows = await tx.$queryRaw<Array<{ eventSequence: bigint }>>(Prisma.sql`
        UPDATE "agent_sessions"
        SET "eventSequence" = "eventSequence" + 1
        WHERE "id" = ${input.sessionId} AND "userId" = ${scope.userId}
        RETURNING "eventSequence"
      `)
      const sequence = sequenceRows[0]?.eventSequence
      if (typeof sequence !== "bigint") throw conflict(`session ${input.sessionId}`)

      const event = await tx.agentEvent.create({
        data: {
          id: input.id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId: input.itemId,
          taskId: input.taskId,
          sequence,
          type: input.type,
          actor: input.actor,
          correlationId: input.correlationId,
          causationId: input.causationId,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload as Prisma.InputJsonValue,
        },
      })

      await tx.agentOutbox.create({
        data: {
          id: `agent-outbox-${input.id}`,
          topic: input.outboxTopic,
          aggregateId: input.sessionId,
          idempotencyKey: `agent-event:${input.id}`,
          payload: outboxPayload(input, sequence),
        },
      })
      return mapEvent(event)
    },
  }
}

export function createPrismaAgentStore(db: PrismaClient, scope: TenantScope): AgentStore {
  return {
    withUnitOfWork<T>(work: (uow: AgentRepositoryUnitOfWork) => Promise<T>): Promise<T> {
      return db.$transaction((tx) => work(createUnitOfWork(tx, scope)))
    },

    async getProjection(input) {
      return db.$transaction(async (tx) => {
        if (!(await ownsSession(tx, input.sessionId, scope))) return null
        const turn = await tx.agentTurn.findFirst({
          where: { id: input.turnId, sessionId: input.sessionId, userId: scope.userId },
        })
        if (!turn) return null

        const [steps, items, events] = await Promise.all([
          tx.agentStep.findMany({ where: { sessionId: input.sessionId, turnId: input.turnId }, orderBy: [{ ordinal: "asc" }, { attempt: "asc" }] }),
          tx.agentItem.findMany({ where: { sessionId: input.sessionId, turnId: input.turnId }, orderBy: { createdAt: "asc" } }),
          tx.agentEvent.findMany({ where: { sessionId: input.sessionId, turnId: input.turnId }, orderBy: { sequence: "asc" } }),
        ])
        return {
          turn: mapTurn(turn),
          steps: steps.map(mapStep),
          items: items.map(mapItem),
          events: events.map(mapEvent),
        }
      })
    },
  }
}
