import { Prisma } from "@prisma/client"
import { db } from "../db"
import type { PipelineCheckpointState } from "./types"
import { appendAgentEventWithOutboxInTransaction } from "./session/fact-store"

export const EXECUTION_STATUSES = ["queued", "running", "waiting_for_user", "paused", "completed", "failed", "cancelled"] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]
const EXECUTION_STALE_MS = Number(process.env.AGENT_EXECUTION_STALE_MS ?? 15_000)

export type { PipelineCheckpointState } from "./types"

export type AgentExecutionAttempt = { id: string; attemptCount: number }

/** Raised in the runner when the control plane revoked an in-flight run. */
export class AgentExecutionCancelledError extends Error {
  constructor() {
    super("Agent execution was cancelled")
    this.name = "AgentExecutionCancelledError"
  }
}

/** Mirrors the exact stale-running branch in the claim CAS and route precheck. */
export function isStaleExactWorkerAttempt(input: {
  status: string
  attemptCount: number
  workerTaskId: string | null
  updatedAt: Date | string
}, expectedAttemptCount: number, workerTaskId: string, now = Date.now()): boolean {
  if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0 || expectedAttemptCount >= Number.MAX_SAFE_INTEGER) return false
  if (!Number.isFinite(EXECUTION_STALE_MS) || EXECUTION_STALE_MS <= 0) return false
  const updatedAt = input.updatedAt instanceof Date ? input.updatedAt.getTime() : new Date(input.updatedAt).getTime()
  return input.status === "running"
    && input.workerTaskId === workerTaskId
    && Number.isSafeInteger(input.attemptCount)
    && input.attemptCount >= expectedAttemptCount + 1
    && input.attemptCount < Number.MAX_SAFE_INTEGER
    && Number.isFinite(updatedAt)
    && updatedAt < now - EXECUTION_STALE_MS
}

export async function ensureAgentExecution(input: { userId: string; sessionId: string; autonomous?: boolean; restartForRun?: boolean }) {
  if (input.restartForRun) {
    const reset = await db.agentExecution.updateMany({
      where: {
        userId: input.userId,
        sessionId: input.sessionId,
        status: { in: ["completed", "failed", "cancelled"] },
      },
      data: {
        status: "queued",
        checkpoint: "scout",
        state: { nextStage: "scout", startedAt: new Date().toISOString(), autonomous: input.autonomous ?? false },
        error: null,
        workerTaskId: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
    })
    if (reset.count > 0) {
      return db.agentExecution.findFirst({ where: { userId: input.userId, sessionId: input.sessionId } })
    }
  }

  return db.agentExecution.upsert({
    where: { sessionId: input.sessionId },
    create: { userId: input.userId, sessionId: input.sessionId, status: "queued", checkpoint: "scout", state: { nextStage: "scout", startedAt: new Date().toISOString(), autonomous: input.autonomous ?? false } },
    update: {},
  })
}

/** Atomically claims an execution. A duplicate worker or cancelled job cannot run. */
export async function claimAgentExecution(input: {
  id: string
  userId: string
  sessionId?: string
  workerTaskId?: string
  expectedAttemptCount?: number
}): Promise<number | null> {
  // BullMQ reclaims a worker's stalled lock after a short delay. A checkpoint
  // heartbeat may be older than that while an LLM call is active, but a second
  // delivery is only possible after the original worker lost its lock.
  const staleBefore = new Date(Date.now() - EXECUTION_STALE_MS)
  return db.$transaction(async tx => {
    const exactDispatch = input.workerTaskId !== undefined || input.expectedAttemptCount !== undefined
    const exactInput = input.sessionId && input.workerTaskId && input.expectedAttemptCount !== undefined
      ? { sessionId: input.sessionId, workerTaskId: input.workerTaskId, expectedAttemptCount: input.expectedAttemptCount }
      : null
    if (exactDispatch && (!exactInput || !Number.isSafeInteger(exactInput.expectedAttemptCount)
      || exactInput.expectedAttemptCount < 0)) return null
    const result = await tx.agentExecution.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        ...(exactInput
          ? {
              sessionId: exactInput.sessionId,
              workerTaskId: exactInput.workerTaskId,
              OR: [
                { status: "queued", attemptCount: exactInput.expectedAttemptCount },
                ...(Number.isFinite(EXECUTION_STALE_MS) && EXECUTION_STALE_MS > 0
                  && exactInput.expectedAttemptCount < Number.MAX_SAFE_INTEGER ? [{
                  status: "running",
                  attemptCount: {
                    gte: exactInput.expectedAttemptCount + 1,
                    lt: Number.MAX_SAFE_INTEGER,
                  },
                  updatedAt: { lt: staleBefore },
                }] : []),
              ],
            }
          : { OR: [
              { status: { in: ["queued", "paused"] } },
              { status: "running", updatedAt: { lt: staleBefore } },
            ] }),
      },
      data: { status: "running", error: null, startedAt: new Date(), attemptCount: { increment: 1 } },
    })
    if (result.count !== 1) return null
    const claimed = await tx.agentExecution.findUnique({ where: { id: input.id }, select: { attemptCount: true } })
    return claimed?.attemptCount ?? null
  })
}

/** Closes only the exact answered legacy Turn when a terminal route preflight rejects its dispatch. */
export async function failLegacyTurnBeforeRun(input: {
  userId: string
  sessionId: string
  executionId: string
  workerTaskId: string
  expectedAttemptCount: number
  turnId: string
  questionId: string
  message: string
}): Promise<boolean> {
  if (!input.questionId.startsWith(`agent-question:${input.turnId}:legacy:`)
    || !Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 0
    || input.expectedAttemptCount >= Number.MAX_SAFE_INTEGER) return false
  const staleDate = Number.isFinite(EXECUTION_STALE_MS) && EXECUTION_STALE_MS > 0
    ? new Date(Date.now() - EXECUTION_STALE_MS)
    : null
  const staleBefore = staleDate && Number.isFinite(staleDate.getTime()) ? staleDate : null
  return db.$transaction(async tx => {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_sessions"
      WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
        AND "status" NOT IN ('aborted', 'archived')
      FOR UPDATE
    `)
    if (!sessions[0]) return false
    const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT "id", "status" FROM "agent_turns"
      WHERE "id" = ${input.turnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
      FOR UPDATE
    `)
    const turn = turns[0]
    if (!turn || turn.status !== "waiting_for_user") return false
    const question = await tx.agentRunQuestion.findFirst({
      where: { id: input.questionId, userId: input.userId, runId: input.sessionId },
      select: { id: true, answer: true },
    })
    if (!question?.answer) return false

    const failedExecution = await tx.agentExecution.updateMany({
      where: {
        id: input.executionId, userId: input.userId, sessionId: input.sessionId,
        workerTaskId: input.workerTaskId,
        OR: [
          { status: "queued", attemptCount: input.expectedAttemptCount },
          ...(staleBefore ? [{
            status: "running",
            attemptCount: { gte: input.expectedAttemptCount + 1, lt: Number.MAX_SAFE_INTEGER },
            updatedAt: { lt: staleBefore },
          }] : []),
        ],
      },
      data: { status: "failed", checkpoint: "failed", error: input.message, completedAt: new Date() },
    })
    if (failedExecution.count !== 1) return false
    const now = new Date()
    const failedTurn = await tx.agentTurn.updateMany({
      where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId, status: "waiting_for_user" },
      data: { status: "failed", error: input.message, completedAt: now, revision: { increment: 1 } },
    })
    if (failedTurn.count !== 1) throw new AgentExecutionCancelledError()
    await appendAgentEventWithOutboxInTransaction(tx, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "turn.failed",
      actor: "orchestrator",
      correlationId: input.turnId,
      idempotencyKey: `legacy-turn-preflight-failed:${input.workerTaskId}`,
      payload: { turnId: input.turnId, reason: "dispatch_preflight_rejected", message: input.message },
      outboxTopic: "agent.session.event",
    })
    return true
  })
}

/** Refreshes and locks the current runner lease in the same transaction as its side effect. */
export async function refreshAgentExecutionAttempt(
  tx: Prisma.TransactionClient,
  input: { id: string; userId: string; attemptCount: number },
): Promise<boolean> {
  const result = await tx.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: "running", attemptCount: input.attemptCount },
    data: { updatedAt: new Date() },
  })
  return result.count === 1
}

export async function saveExecutionCheckpoint(input: {
  id: string
  userId: string
  attemptCount: number
  state: PipelineCheckpointState
}) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: "running", attemptCount: input.attemptCount },
    data: { checkpoint: input.state.nextStage, state: input.state as unknown as Prisma.InputJsonValue },
  })
  return result.count === 1
}

export async function finishAgentExecution(input: { id: string; userId: string; attemptCount: number; status: "completed" | "failed" | "waiting_for_user" | "cancelled"; error?: string | null }) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: "running", attemptCount: input.attemptCount },
    data: {
      status: input.status,
      error: input.error ?? null,
      completedAt: input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? new Date() : null,
    },
  })
  return result.count === 1
}

export async function cancelAgentExecution(input: { id: string; userId: string }) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: { notIn: ["completed", "failed", "cancelled"] } },
    data: { status: "cancelled", checkpoint: "cancelled", cancelledAt: new Date(), completedAt: new Date() },
  })
  return result.count === 1
}
