import { Prisma, type PrismaClient } from "@prisma/client"
import { createDualWriteSession, type DualWriteSession } from "./dual-write"
import type { AgentSessionDb } from "./repository"
import type { RunRecorderWriteOwner } from "./run-recorder-ownership"
import { ensureV2TurnInTransaction, LegacyResumeTurnMismatchError, lockOpenSession, type EnsureV2TurnInput, type V2TurnHandle, type V2TurnSource } from "./v2-turn"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"

const CLOSED_SESSION_STATUSES = ["aborted", "archived"] as const
const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const

type SessionLifecycleDb = AgentSessionDb & {
  agentSession: AgentSessionDb["agentSession"] & {
    findFirst(args: { where: { id: string; userId: string }; select: { id: true; status: true } }): Promise<{ id: string; status: string } | null>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
  }
}

type ActivationTransactionDb = AgentSessionDb & { $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> }

type ActivationOwnership = {
  executionAttempt: { id: string; attemptCount: number }
  signal?: AbortSignal
  assertCurrent: () => Promise<boolean>
}

export interface RunSessionActivationInput {
  userId: string
  sessionId: string
  goal: string
  source?: V2TurnSource
  turnId?: string
  legacyResumeQuestionId?: string
  dualWrite: boolean
  ensureTurn?: boolean
  deferActivation: boolean
  reopenSession: boolean
}

export async function assertExistingSessionAvailable(
  db: AgentSessionDb,
  input: { sessionId: string; userId: string },
): Promise<void> {
  const sessionDb = db as SessionLifecycleDb
  const session = await sessionDb.agentSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, status: true },
  })
  if (!session || CLOSED_SESSION_STATUSES.includes(session.status as (typeof CLOSED_SESSION_STATUSES)[number])) {
    throw new Error(`Agent session ${input.sessionId} does not exist for this user`)
  }
}

async function reopenExistingSession(
  db: AgentSessionDb,
  input: { sessionId: string; userId: string },
  ownership?: ActivationOwnership,
  turnId?: string,
): Promise<boolean> {
  const sessionDb = db as SessionLifecycleDb
  if (!ownership) {
    await assertExistingSessionAvailable(db, input)
    const updated = await sessionDb.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, status: { notIn: [...CLOSED_SESSION_STATUSES] } },
      data: { status: "running", completedAt: null },
    })
    if (updated.count !== 1) throw new Error(`Agent session ${input.sessionId} does not exist for this user`)
    return true
  }

  if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
  return (db as ActivationTransactionDb).$transaction(async (rawTx: Prisma.TransactionClient) => {
    if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
    await lockOpenSession(rawTx, input)
    if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
    if (turnId) {
      const turns = await rawTx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
        SELECT "id", "status" FROM "agent_turns"
        WHERE "id" = ${turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
        FOR UPDATE
      `)
      if (!turns[0] || !ACTIVE_TURN_STATUSES.includes(turns[0].status as (typeof ACTIVE_TURN_STATUSES)[number])) return false
    }
    const owned = await refreshAgentExecutionAttempt(rawTx, {
      id: ownership.executionAttempt.id,
      userId: input.userId,
      attemptCount: ownership.executionAttempt.attemptCount,
    })
    if (!owned) return false
    if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()

    // Refreshing the execution row acquires its lock. The conditional session
    // update shares that transaction, so Stop/reclaim cannot slip between the
    // ownership fence and reopening the legacy session.
    const updated = await rawTx.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, status: { notIn: [...CLOSED_SESSION_STATUSES] } },
      data: { status: "running", completedAt: null },
    })
    if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
    return updated.count === 1
  })
}

export function createRunSessionActivation(db: AgentSessionDb, input: RunSessionActivationInput) {
  let dualWrite: DualWriteSession | null = null
  let activated = false
  let writeOwner: RunRecorderWriteOwner | null = null
  let activation: Promise<boolean> | null = null

  const activate = (ownership?: ActivationOwnership): Promise<boolean> => {
    if (activated) return Promise.resolve(true)
    if (activation) return activation
    const run = async (): Promise<boolean> => {
      if (ownership && (ownership.signal?.aborted || !await ownership.assertCurrent() || ownership.signal?.aborted)) return false
      const needsProjection = input.dualWrite || input.ensureTurn
      const turnInput: EnsureV2TurnInput = {
        sessionId: input.sessionId,
        userId: input.userId,
        goal: input.goal,
        source: input.source ?? "system",
        turnId: input.turnId,
        legacyResumeQuestionId: input.legacyResumeQuestionId,
      }
      if (ownership && needsProjection) {
        let result: { writer: DualWriteSession | null } | null
        try {
          result = await (db as ActivationTransactionDb).$transaction(async rawTx => {
            if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
            let turn: V2TurnHandle
            try {
              turn = await ensureV2TurnInTransaction(rawTx, turnInput, ownership)
            } catch (error) {
              if (!(error instanceof LegacyResumeTurnMismatchError)) throw error
              if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
              const failed = await rawTx.agentExecution.updateMany({
                where: {
                  id: ownership.executionAttempt.id,
                  userId: input.userId,
                  sessionId: input.sessionId,
                  attemptCount: ownership.executionAttempt.attemptCount,
                  status: "running",
                },
                data: { status: "failed", checkpoint: "failed", error: error.message, completedAt: new Date() },
              })
              return failed.count === 1 ? { writer: null } : null
            }
            if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
            const writer = await createDualWriteSession(
              db as unknown as PrismaClient,
              turnInput,
              { executionAttempt: ownership.executionAttempt, signal: ownership.signal },
              turn,
            )
            if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
            if (input.reopenSession || input.deferActivation) {
              const sessionDb = rawTx as unknown as SessionLifecycleDb
              const reopened = await sessionDb.agentSession.updateMany({
                where: { id: input.sessionId, userId: input.userId, status: { notIn: [...CLOSED_SESSION_STATUSES] } },
                data: { status: "running", completedAt: null },
              })
              if (ownership.signal?.aborted) throw new AgentExecutionCancelledError()
              if (reopened.count !== 1) return null
            }
            return { writer }
          })
        } catch (error) {
          if (error instanceof AgentExecutionCancelledError) return false
          throw error
        }
        if (!result?.writer) return false
        dualWrite = result.writer
        return true
      }
      const createProjection = async () => {
        dualWrite = await createDualWriteSession(db as unknown as PrismaClient, turnInput,
          ownership ? { executionAttempt: ownership.executionAttempt, signal: ownership.signal } : undefined)
      }
      // A failed V2 setup must not leave the legacy session reopened. New
      // deferred manual sessions are created paused until this succeeds.
      if (input.deferActivation && (input.dualWrite || input.ensureTurn)) {
        await createProjection()
        if (ownership && (ownership.signal?.aborted || !await ownership.assertCurrent() || ownership.signal?.aborted)) return false
      }
      if (input.reopenSession || input.deferActivation) {
        const reopened = await reopenExistingSession(
          db,
          { sessionId: input.sessionId, userId: input.userId },
          ownership,
          input.turnId ?? dualWrite?.turnId,
        )
        if (!reopened) return false
      }
      if (!input.deferActivation && (input.dualWrite || input.ensureTurn)) await createProjection()
      return true
    }
    activation = run().then(current => {
      activated = current
      writeOwner = current && ownership ? {
        executionAttempt: ownership.executionAttempt,
        signal: ownership.signal,
        turnId: input.turnId ?? dualWrite?.turnId,
      } : null
      return current
    }).finally(() => { activation = null })
    return activation
  }

  return {
    activate,
    isActivated: () => activated,
    getDualWrite: () => dualWrite,
    getWriteOwner: () => writeOwner,
  }
}
