import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from '../execution-control'
import type { PipelineCtx, ScoredJob } from '../types'

export const PREPARE_CHECKPOINT = 'tailoring_and_cover_letter'

export class PrepareOwnershipLostError extends Error {
  constructor() {
    super('Prepare no longer owns this application task')
    this.name = 'PrepareOwnershipLostError'
  }
}

export function isPrepareOwnershipLost(error: unknown): boolean {
  return error instanceof PrepareOwnershipLostError || error instanceof AgentExecutionCancelledError
}

function assertPrepareNotAborted(ctx: PipelineCtx): void {
  if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()
}

export function analysisFenceDate(sj: ScoredJob): Date | null {
  if (typeof sj.analysisFenceAt !== 'string' || !sj.analysisFenceAt.trim()) return null
  const value = new Date(sj.analysisFenceAt)
  return Number.isFinite(value.getTime()) ? value : null
}

async function refreshExecutionAttempt(tx: Prisma.TransactionClient, ctx: PipelineCtx): Promise<boolean> {
  if (!ctx.executionAttempt) return true
  return refreshAgentExecutionAttempt(tx, { ...ctx.executionAttempt, userId: ctx.userId })
}

function canReenterTokenlessPrepare(sj: ScoredJob, ctx: PipelineCtx): boolean {
  return sj.analysisFenceAt === undefined
    && Boolean(ctx.executionAttempt)
    && typeof ctx.sessionId === 'string'
    && ctx.sessionId.trim().length > 0
}

/** Claim the Analyze result before any Writer model call or durable material write. */
export async function claimPrepareTask(sj: ScoredJob, ctx: PipelineCtx): Promise<boolean> {
  assertPrepareNotAborted(ctx)
  const analysisFenceAt = analysisFenceDate(sj)
  const tokenlessReentry = !analysisFenceAt && canReenterTokenlessPrepare(sj, ctx)
  if (!analysisFenceAt && !tokenlessReentry) return false

  const claimed = await db.$transaction(async tx => {
    assertPrepareNotAborted(ctx)
    const attemptCurrent = await refreshExecutionAttempt(tx, ctx)
    assertPrepareNotAborted(ctx)
    if (!attemptCurrent) return false
    const identity = { userId: ctx.userId, jobId: sj.job.id, sessionId: ctx.sessionId ?? null }

    if (tokenlessReentry) {
      assertPrepareNotAborted(ctx)
      const transition = await tx.applicationTask.updateMany({
        where: { ...identity, status: 'analyzing', checkpoint: 'match_analysis' },
        data: { status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
      })
      assertPrepareNotAborted(ctx)
      if (transition.count === 1) return true

      assertPrepareNotAborted(ctx)
      const retry = await tx.applicationTask.updateMany({
        where: { ...identity, status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
        data: { status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
      })
      assertPrepareNotAborted(ctx)
      return retry.count === 1
    }

    assertPrepareNotAborted(ctx)
    const transition = await tx.applicationTask.updateMany({
      where: {
        ...identity,
        status: 'analyzing',
        checkpoint: 'match_analysis',
        updatedAt: analysisFenceAt!,
      },
      data: { status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
    })
    assertPrepareNotAborted(ctx)
    if (transition.count === 1) return true

    // A retry or resumed Prepare stage can re-enter only while this exact
    // durable execution attempt still owns the same session task.
    if (!ctx.executionAttempt) return false
    assertPrepareNotAborted(ctx)
    const retry = await tx.applicationTask.updateMany({
      where: {
        ...identity,
        status: 'generating_materials',
        checkpoint: PREPARE_CHECKPOINT,
      },
      data: { status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
    })
    assertPrepareNotAborted(ctx)
    return retry.count === 1
  })
  assertPrepareNotAborted(ctx)
  return claimed
}

/** Recheck the durable execution immediately before a paid Writer request. */
export async function assertPrepareExecutionCurrent(ctx: PipelineCtx): Promise<void> {
  assertPrepareNotAborted(ctx)
  if (!ctx.executionAttempt) return
  const current = await db.$transaction(async tx => {
    assertPrepareNotAborted(ctx)
    const owned = await refreshExecutionAttempt(tx, ctx)
    assertPrepareNotAborted(ctx)
    return owned
  })
  assertPrepareNotAborted(ctx)
  if (!current) throw new AgentExecutionCancelledError()
}

export async function markBelowThresholdSkipped(
  sj: ScoredJob,
  ctx: PipelineCtx,
  scoreFloor: number,
): Promise<boolean> {
  assertPrepareNotAborted(ctx)
  const analysisFenceAt = analysisFenceDate(sj)
  const tokenlessReentry = !analysisFenceAt && canReenterTokenlessPrepare(sj, ctx)
  if (!analysisFenceAt && !tokenlessReentry) return false
  const skipped = await db.$transaction(async tx => {
    assertPrepareNotAborted(ctx)
    const attemptCurrent = await refreshExecutionAttempt(tx, ctx)
    assertPrepareNotAborted(ctx)
    if (!attemptCurrent) return false
    assertPrepareNotAborted(ctx)
    const updated = await tx.applicationTask.updateMany({
      where: {
        userId: ctx.userId,
        jobId: sj.job.id,
        sessionId: ctx.sessionId ?? null,
        status: 'analyzing',
        checkpoint: 'match_analysis',
        ...(analysisFenceAt ? { updatedAt: analysisFenceAt } : {}),
      },
      data: {
        status: 'skipped',
        checkpoint: 'below_match_threshold',
        error: `Match score ${sj.score}% is below the preparation threshold of ${scoreFloor}%.`,
        completedAt: new Date(),
      },
    })
    assertPrepareNotAborted(ctx)
    return updated.count === 1
  })
  assertPrepareNotAborted(ctx)
  return skipped
}

/** Lock and validate the current execution and Prepare state for one DB write. */
export async function withPrepareOwnership<T>(
  sj: ScoredJob,
  ctx: PipelineCtx,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertPrepareNotAborted(ctx)
  if (!analysisFenceDate(sj) && !canReenterTokenlessPrepare(sj, ctx)) throw new PrepareOwnershipLostError()
  const result = await db.$transaction(async tx => {
    assertPrepareNotAborted(ctx)
    const attemptCurrent = await refreshExecutionAttempt(tx, ctx)
    assertPrepareNotAborted(ctx)
    if (!attemptCurrent) throw new PrepareOwnershipLostError()
    assertPrepareNotAborted(ctx)
    const checked = await tx.applicationTask.updateMany({
      where: {
        userId: ctx.userId,
        jobId: sj.job.id,
        sessionId: ctx.sessionId ?? null,
        status: 'generating_materials',
        checkpoint: PREPARE_CHECKPOINT,
      },
      // updateMany acquires the row lock for this transaction; retaining the
      // state in data keeps the check atomic with the material write.
      data: { status: 'generating_materials', checkpoint: PREPARE_CHECKPOINT },
    })
    assertPrepareNotAborted(ctx)
    if (checked.count !== 1) throw new PrepareOwnershipLostError()
    assertPrepareNotAborted(ctx)
    const value = await write(tx)
    assertPrepareNotAborted(ctx)
    return value
  })
  assertPrepareNotAborted(ctx)
  return result
}

export async function saveAgentCoverLetter(tx: Prisma.TransactionClient, input: {
  userId: string
  jobId: string
  resumeId: string
  content: string
  tone: string
}) {
  const existing = await tx.coverLetter.findFirst({
    where: { userId: input.userId, jobId: input.jobId, resumeId: input.resumeId, origin: 'agent' },
    select: { id: true },
  })
  if (existing) {
    return tx.coverLetter.update({
      where: { id: existing.id },
      data: { content: input.content, tone: input.tone, isFinal: false },
      select: { id: true },
    })
  }
  return tx.coverLetter.create({
    data: {
      userId: input.userId,
      jobId: input.jobId,
      resumeId: input.resumeId,
      content: input.content,
      tone: input.tone,
      origin: 'agent',
      isFinal: false,
    },
    select: { id: true },
  })
}
