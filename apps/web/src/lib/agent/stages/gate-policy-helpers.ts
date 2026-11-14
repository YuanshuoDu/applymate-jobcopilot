import type { PipelineCtx, ApplicationPackage } from '../types'
import { AgentExecutionCancelledError } from '../execution-control'
import { hashArtifactConstraints } from '../artifacts/hash'
import { preflightArtifact, reviewArtifact } from '../artifacts/review'
import { artifactItemData } from '../artifacts/item'
import { tailoringConstraints } from './prepare'
import { createScheduledTaskGraphGateQuestion, type ScheduledTaskGraphGateQuestion } from '../scheduled-taskgraph-gate-service'

export function gateWriteOwner(ctx: PipelineCtx) {
  if (!ctx.sessionId) return undefined
  if (!ctx.turnId || !ctx.executionAttempt) throw new AgentExecutionCancelledError()
  return { turnId: ctx.turnId, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
    ...(ctx.scheduledTaskGraphOwnerFence ? { assertScheduledGateCurrent: ctx.scheduledTaskGraphOwnerFence.assertCurrent } : {}) }
}

export async function assertScheduledGateCurrent(ctx: PipelineCtx, scheduled: boolean) {
  if (!scheduled || !ctx.scheduledTaskGraphOwnerFence) return
  if (ctx.signal?.aborted || ctx.assertExecutionCurrent && !await ctx.assertExecutionCurrent()) throw new AgentExecutionCancelledError()
}

export function prepareReviewedPackage(pkg: ApplicationPackage, ctx: PipelineCtx, scheduled = false) {
  const artifacts = [pkg.tailoredResumeArtifact, pkg.coverLetterArtifact].filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (!artifacts.length) return { reviewedPackage: pkg, artifacts, issues: [] as string[], reviews: [] as ReturnType<typeof reviewArtifact>[] }
  const constraintHash = hashArtifactConstraints(tailoringConstraints(pkg, ctx.agentCfg))
  const issues = artifacts.flatMap(artifact => {
    // Scheduled Gate input already verified the Worker artifact against its Prepare proof and source digest.
    const expectedHash = scheduled && ctx.scheduledTaskGraphOwnerFence ? artifact.constraintHash : constraintHash
    const result = preflightArtifact(artifact, expectedHash)
    return result.ok ? [] : result.issues.map(issue => `${artifact.kind}:${issue}`)
  })
  const reviews = issues.length ? [] : artifacts.map(artifact => reviewArtifact({ artifact, expectedHash: artifact.hash,
    reviewerId: ctx.userId, decision: 'passed', evidence: [],
    constraintHash: scheduled && ctx.scheduledTaskGraphOwnerFence ? artifact.constraintHash : constraintHash }))
  return { reviewedPackage: reviews.length ? { ...pkg, artifactReview: reviews[0], artifactReviews: reviews } : pkg, artifacts, issues, reviews }
}

export function emitArtifactResult(ctx: PipelineCtx, check: ReturnType<typeof prepareReviewedPackage>) {
  if (check.issues.length) {
    ctx.emit('artifact_reviewed', { role: 'reviewer', status: 'stale', issues: check.issues, artifacts: check.artifacts.map(item => artifactItemData(item)) })
  } else if (check.reviews.length) {
    ctx.emit('artifact_reviewed', { role: 'reviewer', status: 'passed', reviews: check.reviews.map((review, index) => ({
      review: { ...review, evidence: undefined }, artifact: artifactItemData(check.artifacts[index], review),
    })) })
  }
}

export function scheduledGateQuestion(kind: 'borderline_match' | 'weak_cover_letter', jobIds: readonly string[]): ScheduledTaskGraphGateQuestion {
  const question = createScheduledTaskGraphGateQuestion(kind, jobIds)
  if (!question) throw new AgentExecutionCancelledError()
  return question
}
