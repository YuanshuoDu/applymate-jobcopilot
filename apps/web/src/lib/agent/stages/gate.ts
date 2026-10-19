/**
 * Stage 4 — Gate (Reviewer)
 * Role: auditor
 *
 * Two-phase operation:
 *
 *   Phase A — AI Quality Review (NEW):
 *     Reviews cover letter relevance and resume-JD fit quality.
 *     Emits quality observations; flags poor materials via agent_question.
 *
 *   Phase B — Routing Decision:
 *     approved — auto-apply immediately (autoApply=true, requireApproval=false, score≥threshold)
 *     pending  — queued for human review
 *     skipped  — below minMatchScore
 */
import type {
  PipelineCtx, ApplicationPackage, GateOutput, StageResult,
} from '../types'
import { stageOk } from '../types'
import { skipApplicationForGate } from '../application-control'
import { AgentExecutionCancelledError } from '../execution-control'
import { requireLegacyPolicy } from '../policy/legacy'
import { hashArtifactConstraints } from '../artifacts/hash'
import { preflightArtifact, reviewArtifact } from '../artifacts/review'
import { artifactItemData } from '../artifacts/item'
import { tailoringConstraints } from './prepare'
import { createGateReviewReceipt } from './gate-review-receipt'
import { reviewApplicationQuality } from './gate-quality-review'

function gateWriteOwner(ctx: PipelineCtx) {
  if (!ctx.sessionId) return undefined
  if (!ctx.turnId || !ctx.executionAttempt) throw new AgentExecutionCancelledError()
  return { turnId: ctx.turnId, executionAttempt: ctx.executionAttempt, signal: ctx.signal }
}

export async function runGate(
  packages: ApplicationPackage[],
  ctx: PipelineCtx,
): Promise<StageResult<GateOutput>> {
  const t0 = Date.now()
  let minMatchScore = ctx.agentCfg.minMatchScore

  const approved: ApplicationPackage[] = []
  const pending:  ApplicationPackage[] = []
  const skipped:  ApplicationPackage[] = []

  const { emit } = ctx
  let projectedWaitIssued = false

  // Proactive question: borderline jobs (within 5% of threshold). In a
  // controlled run this is a durable pause, not a best-effort UI suggestion.
  let includeBorderline = false
  const borderline = packages.filter(p => p.score >= minMatchScore - 5 && p.score < minMatchScore)
  if (borderline.length > 0) {
    const question = `${borderline.length} job ratings are just below the threshold ${minMatchScore}%(gap 1-5 point): ${borderline.slice(0, 3).map(p => `${p.job.company}(${p.score}%)`).join(', ')}${borderline.length > 3 ? '…' : ''}.whether to include them for review?`
    const options = [
      { label: '⏳ Included for review(recommend)', value: 'add_to_pending' },
      { label: '✕ jump over(Keep existing thresholds)', value: 'skip' },
      { label: '⬇ lower threshold 5%', value: 'lower_threshold', action: { field: 'minMatchScore', value: Math.max(40, minMatchScore - 5) } },
    ]
    if (ctx.askUser) {
      includeBorderline = await ctx.askUser('reviewer', question, options) === 'add_to_pending'
      minMatchScore = ctx.agentCfg.minMatchScore
    } else {
      emit('agent_question', { role: 'reviewer', questionId: 'borderline_threshold', question, options })
    }
  }

  for (const pkg of packages) {
    emit('agent_action', {
      role:   'reviewer',
      action: `Review ${pkg.job.company} · ${pkg.job.role} (${pkg.score}%)`,
    })

    // ── Phase A: AI quality review ──────────────────────────────────────────
    const qualityReview = await reviewApplicationQuality(pkg, ctx)
    if (qualityReview.kind === 'unavailable') {
      emit('agent_observation', {
        role: 'reviewer',
        observation: 'AI quality review did not complete; no quality result was produced. Normal match-threshold and material checks still apply; only eligible packages continue to human review.',
      })
    } else if (qualityReview.kind === 'valid') {
      const quality = qualityReview.result
      const clTag  = quality.clScore >= 8 ? '✦ excellent' : quality.clScore >= 6 ? '◆ qualified' : '◇ Weak'
      const readyTag = quality.readyToApply ? '' : ' ⚠ Suggest improvements before submitting'
      emit('agent_observation', {
        role:        'reviewer',
        observation: `Cover letter quality ${clTag}(${quality.clScore}/10)${readyTag}${quality.fitGap ? ` · gap: ${quality.fitGap}` : ''} → ${quality.recommendation}`,
      })

      // Weak materials are not silently allowed through a queued review. Ask
      // the candidate to decide whether this job remains eligible for review.
      if (quality.clScore < 6 && pkg.coverLetter) {
        const question = `${pkg.job.company} · ${pkg.job.role} cover letter quality is low(${quality.clScore}/10): ${quality.recommendation}.Whether to continue delivery or skip?`
        const options = [
          { label: '📤 Continue delivery(Existing materials)', value: 'continue' },
          { label: '⏳ Place for review', value: 'review' },
          { label: '✕ Skip this post', value: 'skip' },
        ]
        const decision = ctx.askUser
          ? await ctx.askUser('reviewer', question, options)
          : (emit('agent_question', { role: 'reviewer', questionId: `poor_cl_${pkg.job.id}`, question, options }), 'review')
        if (decision === 'skip') {
          skipped.push(pkg)
          await skipApplicationForGate({
            userId: ctx.userId,
            jobId: pkg.job.id,
            sessionId: ctx.sessionId,
            checkpoint: 'review_quality_declined',
            owner: gateWriteOwner(ctx),
          })
          continue
        }
      }
    }

    if (pkg.score < minMatchScore && !includeBorderline) {
      skipped.push(pkg)
      await skipApplicationForGate({
        userId: ctx.userId,
        jobId: pkg.job.id,
        sessionId: ctx.sessionId,
        checkpoint: 'below_match_threshold',
        owner: gateWriteOwner(ctx),
      })
      emit('agent_observation', {
        role:        'reviewer',
        observation: `✕ jump over: ${pkg.score}% < threshold ${minMatchScore}%`,
      })
      continue
    }

    const artifactSummaries = [pkg.tailoredResumeArtifact, pkg.coverLetterArtifact].filter((item): item is NonNullable<typeof item> => Boolean(item))
    let reviewedPackage = pkg
    if (artifactSummaries.length > 0) {
      const constraintHash = hashArtifactConstraints(tailoringConstraints(pkg, ctx.agentCfg))
      const preflightIssues = artifactSummaries.flatMap(artifact => {
        const result = preflightArtifact(artifact, constraintHash)
        return result.ok ? [] : result.issues.map(issue => `${artifact.kind}:${issue}`)
      })
      if (preflightIssues.length > 0) {
        skipped.push(pkg)
        emit('artifact_reviewed', { role: 'reviewer', status: 'stale', issues: preflightIssues, artifacts: artifactSummaries.map(artifact => artifactItemData(artifact)) })
        emit('agent_observation', { role: 'reviewer', observation: `✕ Material preflight blocked ${pkg.job.company}: ${preflightIssues.join(', ')}` })
        continue
      }
      const reviews = artifactSummaries.map(artifact => reviewArtifact({
        artifact,
        expectedHash: artifact.hash,
        reviewerId: ctx.userId,
        decision: 'passed',
        evidence: [],
        constraintHash,
      }))
      reviewedPackage = { ...pkg, artifactReview: reviews[0], artifactReviews: reviews }
      emit('artifact_reviewed', { role: 'reviewer', status: 'passed', reviews: reviews.map((review, index) => ({ review: { ...review, evidence: undefined }, artifact: artifactItemData(artifactSummaries[index], review) })) })
    }

    pending.push(reviewedPackage)
    if (ctx.sessionId) {
      requireLegacyPolicy({
        userId: ctx.userId, sessionId: ctx.sessionId, turnId: `gate:${ctx.sessionId}`, stepId: `review:${pkg.job.id}`,
        toolCallId: `review:${pkg.job.id}`, toolName: 'application.review', domain: 'application', risk: 'internal_write',
        capabilities: ['read', 'write'], input: { requiresReceipt: false, unknownSensitiveFacts: false, jobId: pkg.job.id },
      })
    }
    const approval = ctx.sessionId
      ? await createGateReviewReceipt(ctx, reviewedPackage, projectedWaitIssued)
      : null
    if (approval?.projectedWait) projectedWaitIssued = true
    emit('agent_observation', {
      role:        'reviewer',
      observation: `⏳ Enter to be reviewed: Material saved, They must be reviewed individually by you and explicitly authorized before submission..`,
    })
    emit('agent_question', {
      role: 'reviewer', questionId: `application_review_${pkg.job.id}`,
      question: `${pkg.job.company} · ${pkg.job.role} The application materials are ready.Please check whether the materials correspond to the position, Are all answers true?; Submit can only be authorized after confirmation..`,
      options: [
        { label: 'Reserved for review', value: 'review' },
      ],
    })
    if (approval) {
      emit("application_review_ready", {
        approval: {
          ...approval.receipt,
        },
      })
    }
  }

  const total = Date.now() - t0
  return stageOk(
    'gate',
    { approved, pending, skipped },
    approved.length + pending.length + skipped.length,
    total,
  )
}
