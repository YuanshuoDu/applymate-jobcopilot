import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"

export type V2TurnSource = "user" | "automation" | "system"

export interface EnsureV2TurnInput {
  sessionId: string
  userId: string
  goal: string
  source: V2TurnSource
  /** Bind a compatibility recorder to a Turn already created by the queue adapter. */
  turnId?: string
}

export interface V2TurnHandle {
  sessionId: string
  turnId: string
  userId: string
}

const ACTIVE_TURN_STATUSES = [
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
] as const

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"
}

async function findActiveTurn(tx: Prisma.TransactionClient, input: EnsureV2TurnInput) {
  return tx.agentTurn.findFirst({
    where: { sessionId: input.sessionId, userId: input.userId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })
}

/** Reuses the active root and creates a fresh root after terminal history. */
export async function ensureV2Turn(db: PrismaClient, input: EnsureV2TurnInput): Promise<V2TurnHandle> {
  try {
    return await db.$transaction(async (tx) => {
      const session = await tx.agentSession.findFirst({
        where: { id: input.sessionId, userId: input.userId },
        select: { id: true },
      })
      if (!session) throw new Error(`Agent session ${input.sessionId} does not exist for this user`)

      if (input.turnId) {
        const owned = await tx.agentTurn.findFirst({
          where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
          select: { id: true },
        })
        if (!owned) throw new Error(`Agent turn ${input.turnId} does not belong to this user session`)
        return { sessionId: input.sessionId, turnId: owned.id, userId: input.userId }
      }

      const active = await findActiveTurn(tx, input)
      if (active) return { sessionId: input.sessionId, turnId: active.id, userId: input.userId }

      const startedAt = new Date()
      const turn = await tx.agentTurn.create({
        data: {
          id: randomUUID(),
          sessionId: input.sessionId,
          userId: input.userId,
          status: "in_progress",
          source: input.source,
          input: { goal: input.goal },
          startedAt,
          modelProfileSnapshot: {},
          toolPolicySnapshot: {},
          budgetSnapshot: {},
        },
        select: { id: true },
      })
      return { sessionId: input.sessionId, turnId: turn.id, userId: input.userId }
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const active = await db.agentTurn.findFirst({
      where: { sessionId: input.sessionId, userId: input.userId, status: { in: [...ACTIVE_TURN_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    })
    if (!active) throw error
    return { sessionId: input.sessionId, turnId: active.id, userId: input.userId }
  }
}
