import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"
import type { ScoredJob } from "../types"
import { attachAnalyzeSourceChangedClaims, isAnalyzeSourceChangedError, readAnalyzeSourceChangedClaims, validateAnalyzeSourceFingerprints } from "./analyze-model-input"
import type { AnalyzeSourceChangedClaim, AnalyzeSourceFingerprint } from "./analyze-model-input"

const ANALYZABLE_TASK_STATUSES = ["discovered", "analyzing"]
const PROTECTED_APPLICATION_CHECKPOINTS = ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"]
export const ANALYZE_SOURCE_CHANGED_CHECKPOINT = "analyze_source_changed"

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

export interface AnalyzeRecoveryHooks {
  existingScoredJobs?: readonly ScoredJob[]
  sourceFingerprintsByJob?: Readonly<Record<string, AnalyzeSourceFingerprint>>
  initialFailed?: number
  beforeScore?: (jobId: string) => Promise<void>
  onScoredJob?: (scored: ScoredJob, tx: Prisma.TransactionClient, sourceFingerprint: AnalyzeSourceFingerprint) => Promise<void>
  onScoreFailure?: (jobId: string) => Promise<void>
  assertScoreOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
}

export class AnalyzeRecoveryPersistenceError extends AgentExecutionCancelledError {
  constructor() {
    super()
    this.message = "Failed to persist Analyze recovery state"
    this.name = "AnalyzeRecoveryPersistenceError"
  }
}

export async function findAnalyzeSourceChangedJobIds(userId: string, jobIds: readonly string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set()
  const tasks = await db.applicationTask.findMany({
    where: { userId, jobId: { in: [...jobIds] }, status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT },
    select: { jobId: true },
  })
  return new Set(tasks.map(task => task.jobId))
}

export async function validateAnalyzeRecoverySources(input: {
  userId: string; sessionId?: string; executionAttempt?: ExecutionAttempt; signal?: AbortSignal
  resumeId: string; resumeText: string; scoredJobs: readonly ScoredJob[]; sourceFingerprintsByJob: unknown
  assertOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
}): Promise<Readonly<Record<string, AnalyzeSourceFingerprint>>> {
  const claims = input.scoredJobs.flatMap(scored => typeof scored.analysisFenceAt === 'string'
    && Number.isFinite(new Date(scored.analysisFenceAt).getTime())
    ? [{ jobId: scored.job.id, analysisFenceAt: new Date(scored.analysisFenceAt) }] : [])
  const claimTokens: AnalyzeSourceChangedClaim[] = input.scoredJobs.map(scored => ({
    jobId: scored.job.id, analysisFenceAt: scored.analysisFenceAt ?? '',
  }))
  try {
    return await db.$transaction(async tx => {
      const current = await validateAnalyzeSourceFingerprints(tx, {
      userId: input.userId, resumeId: input.resumeId, resumeText: input.resumeText,
      jobIds: input.scoredJobs.map(scored => scored.job.id), sourceFingerprintsByJob: input.sourceFingerprintsByJob, claimTokens,
      })
      if (input.assertOwnerCurrent && !await input.assertOwnerCurrent(tx)) throw new AgentExecutionCancelledError()
      return current
    })
  } catch (error) {
    if (!isAnalyzeSourceChangedError(error)) throw error
    await cleanupAnalyzeSourceChangedClaims({ ...input, claims, maxClaims: input.scoredJobs.length, sourceError: error })
    throw error
  }
}

export async function cleanupAnalyzeSourceChangedClaims(input: {
  claims: readonly { jobId: string; analysisFenceAt: Date }[]; maxClaims: number
  userId: string; sessionId?: string; executionAttempt?: ExecutionAttempt; signal?: AbortSignal
  sourceError: unknown; assertOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
}): Promise<void> {
  if (!attachAnalyzeSourceChangedClaims(input.sourceError, input.claims, input.maxClaims)) throw new Error('Analyze source-change claims are invalid.')
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  try {
    await failAnalyzeClaimsAfterSourceChange({
      claims: input.claims, userId: input.userId, sessionId: input.sessionId,
      executionAttempt: input.executionAttempt, signal: input.signal,
      error: 'Analyze source material changed while scoring.', assertOwnerCurrent: input.assertOwnerCurrent,
    })
  } catch (cleanupError) {
    if (input.signal?.aborted || cleanupError instanceof AgentExecutionCancelledError) throw new AgentExecutionCancelledError()
  }
}

export function createAnalyzeSourceChangedCleanup(input: {
  userId: string; sessionId: string; executionAttempt: ExecutionAttempt; signal?: AbortSignal
}): (error: unknown) => Promise<void> {
  return async error => {
    const tokens = readAnalyzeSourceChangedClaims(error)
    if (!tokens) throw new Error('Analyze source-change cleanup claims are unavailable.')
    const claims = tokens.map(token => {
      const analysisFenceAt = new Date(token.analysisFenceAt)
      if (!Number.isFinite(analysisFenceAt.getTime()) || analysisFenceAt.toISOString() !== token.analysisFenceAt) {
        throw new Error('Analyze source-change cleanup claims are invalid.')
      }
      return { jobId: token.jobId, analysisFenceAt }
    })
    await failAnalyzeClaimsAfterSourceChange({ ...input, claims, error: 'Analyze source material changed while scoring.' })
  }
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
    : { OR: [
        { sessionId: null },
        { sessionId: input.sessionId },
        { status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT },
      ] }
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
        { status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT },
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

export function failAnalyzeTaskAfterSourceChange(
  tx: Prisma.TransactionClient,
  input: AnalyzeTaskIdentity & { analysisFenceAt: Date; error: string },
): Promise<boolean> {
  return transitionAnalyzeTask(tx, {
    ...input,
    data: {
      status: "failed",
      checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT,
      error: input.error,
      completedAt: new Date(),
    },
  })
}

export async function failAnalyzeClaimsAfterSourceChange(input: {
  claims: readonly { jobId: string; analysisFenceAt: Date }[]
  userId: string
  sessionId?: string
  executionAttempt?: ExecutionAttempt
  signal?: AbortSignal
  error: string
  assertOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
}): Promise<void> {
  for (const claim of input.claims) {
    await db.$transaction(async tx => {
      assertAnalyzeSignalActive(input.signal)
      if (input.assertOwnerCurrent && !await input.assertOwnerCurrent(tx)) throw new AgentExecutionCancelledError()
      if (input.executionAttempt && !await refreshExecutionAttempt(tx, { ...input, jobId: claim.jobId })) throw new AgentExecutionCancelledError()
      await failAnalyzeTaskAfterSourceChange(tx, {
        userId: input.userId, sessionId: input.sessionId,
        signal: input.signal, error: input.error, ...claim,
      })
    })
  }
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
