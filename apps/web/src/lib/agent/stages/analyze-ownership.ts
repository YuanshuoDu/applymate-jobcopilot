import type { Prisma } from "@prisma/client"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"

const ANALYZABLE_TASK_STATUSES = ["discovered", "analyzing"]
const PROTECTED_APPLICATION_CHECKPOINTS = ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"]

type ExecutionAttempt = { id: string; attemptCount: number }
type AnalyzeTaskIdentity = {
  userId: string
  jobId: string
  sessionId?: string
  executionAttempt?: ExecutionAttempt
  signal?: AbortSignal
}

type AnalyzeTaskTransition = {
  status: "analyzing" | "skipped" | "failed"
  checkpoint?: string
  error?: string | null
  completedAt?: Date | null
  updatedAt?: Date
}

export async function claimAnalyzeTask(
  tx: Prisma.TransactionClient,
  input: AnalyzeTaskIdentity,
): Promise<Date | null> {
  if (!await refreshExecutionAttempt(tx, input)) return null

  const identity = { userId: input.userId, jobId: input.jobId }
  await tx.applicationTask.upsert({
    where: { userId_jobId: identity },
    create: { ...identity, sessionId: input.sessionId ?? null, status: "analyzing", checkpoint: "match_analysis" },
    // Ensure a task exists before the optimistic-version claim below.
    update: {},
  })
  assertAnalyzeSignalActive(input.signal)
  const current = await tx.applicationTask.findUnique({ where: { userId_jobId: identity }, select: { updatedAt: true } })
  assertAnalyzeSignalActive(input.signal)
  if (!current) return null

  // Bump past the stored version so same-millisecond claims remain distinct.
  const nextFenceAt = new Date(Math.max(Date.now(), current.updatedAt.getTime()) + 1)
  const sessionFence = input.sessionId === undefined
    ? { sessionId: null }
    : { OR: [{ sessionId: null }, { sessionId: input.sessionId }] }
  const safeCheckpoint = { OR: [
    { checkpoint: null },
    { checkpoint: { notIn: PROTECTED_APPLICATION_CHECKPOINTS } },
  ] }
  const claimed = await tx.applicationTask.updateMany({
    where: {
      ...identity,
      updatedAt: current.updatedAt,
      OR: [
        { status: { in: ANALYZABLE_TASK_STATUSES } },
        { status: "failed", checkpoint: "match_analysis_failed" },
      ],
      AND: [sessionFence, safeCheckpoint],
    },
    data: {
      sessionId: input.sessionId ?? undefined,
      status: "analyzing",
      checkpoint: "match_analysis",
      error: null,
      completedAt: null,
      updatedAt: nextFenceAt,
    },
  })
  assertAnalyzeSignalActive(input.signal)
  return claimed.count === 1 ? nextFenceAt : null
}

export async function transitionAnalyzeTask(
  tx: Prisma.TransactionClient,
  input: AnalyzeTaskIdentity & { analysisFenceAt: Date; data: AnalyzeTaskTransition },
): Promise<boolean> {
  if (!await refreshExecutionAttempt(tx, input)) return false

  const result = await tx.applicationTask.updateMany({
    where: {
      userId: input.userId,
      jobId: input.jobId,
      status: "analyzing",
      sessionId: input.sessionId ?? null,
      checkpoint: "match_analysis",
      updatedAt: input.analysisFenceAt,
      OR: [
        { checkpoint: null },
        { checkpoint: { notIn: PROTECTED_APPLICATION_CHECKPOINTS } },
      ],
    },
    data: input.data,
  })
  assertAnalyzeSignalActive(input.signal)
  return result.count === 1
}

async function refreshExecutionAttempt(tx: Prisma.TransactionClient, input: AnalyzeTaskIdentity): Promise<boolean> {
  assertAnalyzeSignalActive(input.signal)
  if (!input.executionAttempt) return true
  const refreshed = await refreshAgentExecutionAttempt(tx, {
    id: input.executionAttempt.id,
    userId: input.userId,
    attemptCount: input.executionAttempt.attemptCount,
  })
  assertAnalyzeSignalActive(input.signal)
  return refreshed
}

export function assertAnalyzeSignalActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentExecutionCancelledError()
}
