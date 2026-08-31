import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import type { Actor, AgentMessagePhase, ItemStatus } from "@jobcopilot/agent-protocol"

export interface AppendAgentEventInput {
  sessionId: string
  turnId: string
  itemId?: string | null
  taskId?: string | null
  type: string
  actor: Actor
  correlationId: string
  causationId?: string | null
  idempotencyKey?: string | null
  payload: Prisma.InputJsonValue
  outboxTopic: string
}

export interface UpdateAgentItemRevisionInput {
  itemId: string
  expectedRevision: number
  content: Prisma.InputJsonValue
  status: ItemStatus
  phase?: AgentMessagePhase | null
  startedAt?: Date | null
  completedAt?: Date | null
}

export class AgentSessionNotFoundError extends Error {
  readonly code = "agent_session_not_found"

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} does not exist`)
    this.name = "AgentSessionNotFoundError"
  }
}

export class AgentItemRevisionConflictError extends Error {
  readonly code = "agent_item_revision_conflict"

  constructor(itemId: string, expectedRevision: number) {
    super(`Agent item ${itemId} revision ${expectedRevision} is stale`)
    this.name = "AgentItemRevisionConflictError"
  }
}

type AgentEventRecord = Prisma.AgentEventGetPayload<{}>

interface EventReader {
  agentEvent: {
    findFirst(args: Prisma.AgentEventFindFirstArgs): Promise<AgentEventRecord | null>
  }
}

async function findExistingEvent(
  db: EventReader,
  input: AppendAgentEventInput,
): Promise<AgentEventRecord | null> {
  if (!input.idempotencyKey) return null

  return db.agentEvent.findFirst({
    where: {
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
    },
  })
}

async function allocateSessionSequence(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ eventSequence: bigint }>>(Prisma.sql`
    UPDATE "agent_sessions"
    SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = ${sessionId}
    RETURNING "eventSequence" AS "eventSequence"
  `)

  const sequence = rows[0]?.eventSequence
  if (typeof sequence !== "bigint") throw new AgentSessionNotFoundError(sessionId)
  return sequence
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return (error as { code?: unknown }).code === "P2002"
}

function buildOutboxPayload(
  input: AppendAgentEventInput,
  eventId: string,
  sequence: bigint,
): Prisma.InputJsonObject {
  return {
    eventId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId: input.itemId ?? null,
    taskId: input.taskId ?? null,
    sequence: sequence.toString(),
    type: input.type,
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: input.payload,
  }
}

export async function appendAgentEventWithOutbox(
  db: PrismaClient,
  input: AppendAgentEventInput,
): Promise<{ event: AgentEventRecord; duplicate: boolean }> {
  const existing = await findExistingEvent(db, input)
  if (existing) return { event: existing, duplicate: true }

  try {
    return await db.$transaction(async (tx) => {
      const transactionExisting = await findExistingEvent(tx, input)
      if (transactionExisting) return { event: transactionExisting, duplicate: true }

      const sequence = await allocateSessionSequence(tx, input.sessionId)
      const eventId = randomUUID()
      const event = await tx.agentEvent.create({
        data: {
          id: eventId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId: input.itemId ?? null,
          taskId: input.taskId ?? null,
          sequence,
          type: input.type,
          actor: input.actor,
          correlationId: input.correlationId,
          causationId: input.causationId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          payload: input.payload,
        },
      })

      await tx.agentOutbox.create({
        data: {
          id: randomUUID(),
          topic: input.outboxTopic,
          aggregateId: input.sessionId,
          idempotencyKey: `agent-event:${eventId}`,
          payload: buildOutboxPayload(input, eventId, sequence),
        },
      })

      return { event, duplicate: false }
    })
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error

    const duplicate = await findExistingEvent(db, input)
    if (duplicate) return { event: duplicate, duplicate: true }
    throw error
  }
}

export async function updateAgentItemRevision(
  db: PrismaClient,
  input: UpdateAgentItemRevisionInput,
): Promise<{ updated: true; revision: number }> {
  const nextRevision = input.expectedRevision + 1

  return db.$transaction(async (tx) => {
    const result = await tx.agentItem.updateMany({
      where: {
        id: input.itemId,
        revision: input.expectedRevision,
      },
      data: {
        content: input.content,
        status: input.status,
        revision: nextRevision,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      },
    })

    if (result.count !== 1) {
      throw new AgentItemRevisionConflictError(input.itemId, input.expectedRevision)
    }

    return { updated: true as const, revision: nextRevision }
  })
}
