import { Prisma } from "@prisma/client"
import type { AgentSessionDb } from "./repository"
import { lockOpenSession } from "./v2-turn"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

export type RecorderFinalizationOwner = {
  turnId: string
  executionAttempt: { id: string; userId: string; attemptCount: number }
  terminalStatus: "running" | "completed" | "failed" | "waiting_for_user"
  executionTransitionTo?: "waiting_for_user"
}

type OwnershipDb = AgentSessionDb & {
  $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>
}

export async function withOpenSession<T>(
  db: AgentSessionDb,
  input: { sessionId: string; userId: string },
  work: (tx: AgentSessionDb) => Promise<T>,
): Promise<T> {
  return (db as OwnershipDb).$transaction(async tx => {
    await lockOpenSession(tx, input)
    return work(tx as unknown as AgentSessionDb)
  })
}

export async function withRunRecorderTerminalOwnership(
  db: AgentSessionDb,
  input: {
    sessionId: string
    userId: string
    owner: RecorderFinalizationOwner
    v2Finalize?: { status: "completed" | "failed" | "interrupted" | "waiting_for_user"; finalResponse: string | null; error: string | null }
  },
  write: (tx: AgentSessionDb) => Promise<void>,
): Promise<boolean> {
  return (db as OwnershipDb).$transaction(async tx => {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_sessions"
      WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
        AND "status" NOT IN ('aborted', 'archived')
      FOR UPDATE
    `)
    if (!sessions[0]) return false
    const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT "id", "status" FROM "agent_turns"
      WHERE "id" = ${input.owner.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
      FOR UPDATE
    `)
    if (!turns[0] || !ACTIVE_TURN_STATUSES.includes(turns[0].status as (typeof ACTIVE_TURN_STATUSES)[number])) return false
    const execution = await tx.agentExecution.updateMany({
      where: {
        id: input.owner.executionAttempt.id,
        userId: input.userId,
        sessionId: input.sessionId,
        attemptCount: input.owner.executionAttempt.attemptCount,
        status: input.owner.terminalStatus,
      },
      data: input.owner.executionTransitionTo
        ? { status: input.owner.executionTransitionTo, error: null, completedAt: null, updatedAt: new Date() }
        : { updatedAt: new Date() },
    })
    if (execution.count !== 1) return false
    if (input.v2Finalize) {
      const turn = await tx.agentTurn.updateMany({
        where: {
          id: input.owner.turnId,
          sessionId: input.sessionId,
          userId: input.userId,
          status: { in: [...ACTIVE_TURN_STATUSES] },
        },
        data: {
          status: input.v2Finalize.status,
          completedAt: input.v2Finalize.status === "waiting_for_user" ? null : new Date(),
          finalResponse: input.v2Finalize.finalResponse,
          error: input.v2Finalize.error,
        },
      })
      if (turn.count !== 1) return false
    }
    await write(tx as unknown as AgentSessionDb)
    return true
  })
}

export type RunRecorderWriteOwner = {
  executionAttempt: { id: string; attemptCount: number }
  signal?: AbortSignal
  turnId?: string
  requireRunning?: boolean
}

export function createRunRecorderWriteContext(input: {
  db: AgentSessionDb
  sessionId: string
  userId: string
  isActivated: () => boolean
  getWriteOwner: () => RunRecorderWriteOwner | null
}) {
  const assertActivated = () => {
    if (!input.isActivated()) throw new Error("Agent session recorder must be activated after claiming its execution")
  }
  const writeOwned = async <T>(work: (tx: AgentSessionDb) => Promise<T>): Promise<T> => {
    const owner = input.getWriteOwner()
    if (!owner) return withOpenSession(input.db, { sessionId: input.sessionId, userId: input.userId }, work)
    const result = await withRunRecorderWriteOwnership(input.db, {
      sessionId: input.sessionId, userId: input.userId, owner,
    }, work)
    if (!result.owned) throw new AgentExecutionCancelledError()
    return result.value
  }
  return { assertActivated, writeOwned }
}

type ExecutionOwnershipDb = OwnershipDb & { agentExecution: Prisma.TransactionClient["agentExecution"] }

export async function withRunRecorderWriteOwnership<T>(
  db: AgentSessionDb,
  input: { sessionId: string; userId: string; owner: RunRecorderWriteOwner },
  write: (tx: AgentSessionDb) => Promise<T>,
): Promise<{ owned: false } | { owned: true; value: T }> {
  return (db as ExecutionOwnershipDb).$transaction(async tx => {
    await lockOpenSession(tx, input)
    if (input.owner.turnId) {
      const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
        SELECT "id", "status" FROM "agent_turns"
        WHERE "id" = ${input.owner.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
        FOR UPDATE
      `)
      if (!turns[0] || !ACTIVE_TURN_STATUSES.includes(turns[0].status as (typeof ACTIVE_TURN_STATUSES)[number])) return { owned: false }
    }
    const allowedStatuses = input.owner.requireRunning
      ? ["running"]
      : input.owner.signal?.aborted
      ? ["completed", "failed", "waiting_for_user"]
      : ["running", "completed", "failed", "waiting_for_user"]
    const claimed = await tx.agentExecution.updateMany({
      where: {
        id: input.owner.executionAttempt.id,
        userId: input.userId,
        sessionId: input.sessionId,
        attemptCount: input.owner.executionAttempt.attemptCount,
        status: { in: allowedStatuses },
      },
      data: { updatedAt: new Date() },
    })
    if (claimed.count !== 1) return { owned: false }
    const current = await tx.agentExecution.findFirst({
      where: { id: input.owner.executionAttempt.id, userId: input.userId, sessionId: input.sessionId, attemptCount: input.owner.executionAttempt.attemptCount },
      select: { status: true },
    })
    if (!current || (input.owner.signal?.aborted && current.status === "running")) throw new AgentExecutionCancelledError()
    return { owned: true, value: await write(tx as unknown as AgentSessionDb) }
  })
}
