/** Stage 4 — shared manual and scheduled Gate policy. */
import type { PipelineCtx, ApplicationPackage, GateOutput, StageResult } from '../types'
import { stageOk } from '../types'
import { skipApplicationForGate } from '../application-control'
import { AgentExecutionCancelledError } from '../execution-control'
import { requireLegacyPolicy } from '../policy/legacy'
import { hashArtifactConstraints } from '../artifacts/hash'
import { preflightArtifact, reviewArtifact } from '../artifacts/review'
import { artifactItemData } from '../artifacts/item'
import { tailoringConstraints } from './prepare'
import { createGateReviewReceipt, findGateReviewReceiptReplay } from './gate-review-receipt'
import { reviewApplicationQuality } from './gate-quality-review'
import { createScheduledTaskGraphGateQuestion, parseScheduledTaskGraphGateChoiceHistory, scheduledTaskGraphGateChoiceKey,
  type ScheduledTaskGraphGateCompletion, type ScheduledTaskGraphGateQuestion } from '../scheduled-taskgraph-gate-service'

type GatePolicyResult = ScheduledTaskGraphGateQuestion | { status: 'stage_completed'; result: StageResult<GateOutput> }
export type ScheduledGateRunResult = ScheduledTaskGraphGateQuestion | ScheduledTaskGraphGateCompletion

function gateWriteOwner(ctx: PipelineCtx) {
  if (!ctx.sessionId) return undefined
  if (!ctx.turnId || !ctx.executionAttempt) throw new AgentExecutionCancelledError()
  return { turnId: ctx.turnId, executionAttempt: ctx.executionAttempt, signal: ctx.signal, ...(ctx.scheduledTaskGraphOwnerFence ? { assertScheduledGateCurrent: ctx.scheduledTaskGraphOwnerFence.assertCurrent } : {}) }
}

export async function runGate(packages: ApplicationPackage[], ctx: PipelineCtx): Promise<StageResult<GateOutput>> {
  const result = await runGatePolicy(packages, ctx, false)
  if (result.status !== 'stage_completed') throw new AgentExecutionCancelledError()
  return result.result
}

/** Runs the shared Gate policy without legacy Orchestrator questions. */
export async function runScheduledGate(packages: readonly ApplicationPackage[], ctx: PipelineCtx, validatedChoice?: unknown, priorChoices?: readonly unknown[]): Promise<ScheduledGateRunResult> {
  const result = await runGatePolicy(packages, ctx, true, validatedChoice, priorChoices)
  if (result.status !== 'stage_completed') return result
  const output = result.result.data
  if (!output) throw new AgentExecutionCancelledError()
  return { status: 'completed', nextStage: 'execute', approvedJobIds: output.approved.map(pkg => pkg.job.id),
    pendingJobIds: output.pending.map(pkg => pkg.job.id), skippedJobIds: output.skipped.map(pkg => pkg.job.id),
    counts: { approved: output.approved.length, pending: output.pending.length, skipped: output.skipped.length } }
}
async function runGatePolicy(packages: readonly ApplicationPackage[], ctx: PipelineCtx, scheduled: boolean,
  validatedChoice?: unknown, priorChoiceValues: readonly unknown[] = []): Promise<GatePolicyResult> {
  await assertScheduledGateCurrent(ctx, scheduled)
  const t0 = Date.now()
  let minMatchScore = ctx.agentCfg.minMatchScore
  const approved: ApplicationPackage[] = []
  const pending:  ApplicationPackage[] = []
  const skipped:  ApplicationPackage[] = []
  const { emit } = ctx
  let projectedWaitIssued = false
  let choiceMatched = false
  let deferredQuestion: ScheduledTaskGraphGateQuestion | null = null
  let includeBorderline = false
  const borderline = packages.filter(p => p.score >= minMatchScore - 5 && p.score < minMatchScore)
  const borderlineIdentity = scheduled && borderline.length
    ? scheduledGateQuestion('borderline_match', borderline.map(pkg => pkg.job.id)) : null
  const history = scheduled ? parseScheduledTaskGraphGateChoiceHistory(priorChoiceValues, validatedChoice, packages.map(pkg => pkg.job.id), borderlineIdentity) : { priorChoices: [], currentChoice: null }
  if (!history) throw new AgentExecutionCancelledError()
  const { priorChoices, currentChoice: scheduledChoice } = history
  const priorBorderline = priorChoices.find(choice => choice.kind === 'borderline_match')
  const priorWeakChoices = new Map(priorChoices.filter(choice => choice.kind === 'weak_cover_letter')
    .map(choice => [choice.jobIds[0]!, choice]))
  const appliedPrior = new Set<string>()
  const decisions = [...priorChoices, ...(scheduledChoice ? [scheduledChoice] : [])]
  if (borderlineIdentity && !priorBorderline && decisions.some(choice => choice.kind === 'weak_cover_letter'
    && borderlineIdentity.jobIds.includes(choice.jobIds[0]!))) throw new AgentExecutionCancelledError()
  if (priorBorderline?.choiceId === 'skip' && decisions.some(choice => choice.kind === 'weak_cover_letter'
    && borderlineIdentity?.jobIds.includes(choice.jobIds[0]!))) throw new AgentExecutionCancelledError()
  if (borderline.length > 0) {
    const questionIdentity = borderlineIdentity
    const question = `${borderline.length} job ratings are just below the threshold ${minMatchScore}%(gap 1-5 point): ${borderline.slice(0, 3).map(p => `${p.job.company}(${p.score}%)`).join(', ')}${borderline.length > 3 ? '…' : ''}.whether to include them for review?`
    const options = [
      { label: '⏳ Included for review(recommend)', value: 'add_to_pending' },
      { label: '✕ jump over(Keep existing thresholds)', value: 'skip' },
      { label: '⬇ lower threshold 5%', value: 'lower_threshold', action: { field: 'minMatchScore', value: Math.max(40, minMatchScore - 5) } },
    ]
    if (scheduled) {
      if (!questionIdentity) throw new AgentExecutionCancelledError()
      const priorDecision = priorBorderline
      const currentDecision = scheduledChoice?.kind === 'borderline_match' ? scheduledChoice : null
      if (priorDecision || currentDecision) {
        const decision = priorDecision ?? currentDecision!
        includeBorderline = decision.choiceId === 'add_to_pending'
        if (priorDecision) appliedPrior.add(scheduledTaskGraphGateChoiceKey(priorDecision))
        else choiceMatched = true
        if (decision.choiceId === 'lower_threshold') minMatchScore = Math.max(40, minMatchScore - 5)
      } else if (scheduledChoice) deferredQuestion = questionIdentity
      else return questionIdentity
    } else if (ctx.askUser) {
      includeBorderline = await ctx.askUser('reviewer', question, options) === 'add_to_pending'
      minMatchScore = ctx.agentCfg.minMatchScore
    } else {
      emit('agent_question', { role: 'reviewer', questionId: 'borderline_threshold', question, options })
    }
  }

  for (const pkg of packages) {
    await assertScheduledGateCurrent(ctx, scheduled)
    if (deferredQuestion?.kind === 'borderline_match' && deferredQuestion.jobIds.includes(pkg.job.id)) continue
    const priorChoice = priorWeakChoices.get(pkg.job.id)
    let reviewedPackage = pkg
    let artifactCheck: ReturnType<typeof prepareReviewedPackage> | undefined
    if (scheduled) {
      artifactCheck = prepareReviewedPackage(pkg, ctx)
      if (artifactCheck.issues.length) {
        if (priorChoice || scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id) throw new AgentExecutionCancelledError()
        skipped.push(pkg)
        emitArtifactResult(ctx, artifactCheck)
        emit('agent_observation', { role: 'reviewer', observation: `✕ Material preflight blocked ${pkg.job.company}: ${artifactCheck.issues.join(', ')}` })
        continue
      }
      reviewedPackage = artifactCheck.reviewedPackage
      const replay = ctx.sessionId ? await findGateReviewReceiptReplay(ctx, reviewedPackage) : null
      if (replay) {
        if (scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id
          || priorChoice?.choiceId === 'skip') throw new AgentExecutionCancelledError()
        if (priorChoice) appliedPrior.add(scheduledTaskGraphGateChoiceKey(priorChoice))
        pending.push(reviewedPackage)
        continue
      }
      emitArtifactResult(ctx, artifactCheck)
      if (priorChoice) {
        appliedPrior.add(scheduledTaskGraphGateChoiceKey(priorChoice))
        if (priorChoice.choiceId === 'skip') {
          skipped.push(pkg)
          await skipApplicationForGate({ userId: ctx.userId, jobId: pkg.job.id, sessionId: ctx.sessionId, checkpoint: 'review_quality_declined', owner: gateWriteOwner(ctx) })
          continue
        }
      }
    }
    emit('agent_action', {
      role:   'reviewer',
      action: `Review ${pkg.job.company} · ${pkg.job.role} (${pkg.score}%)`,
    })

    await assertScheduledGateCurrent(ctx, scheduled)
    const qualityReview = priorChoice ? null : await reviewApplicationQuality(pkg, ctx)
    if (qualityReview?.kind === 'unavailable') {
      emit('agent_observation', {
        role: 'reviewer',
        observation: 'AI quality review did not complete; no quality result was produced. Normal match-threshold and material checks still apply; only eligible packages continue to human review.',
      })
    } else if (qualityReview?.kind === 'valid') {
      const quality = qualityReview.result
      const clTag  = quality.clScore >= 8 ? '✦ excellent' : quality.clScore >= 6 ? '◆ qualified' : '◇ Weak'
      const readyTag = quality.readyToApply ? '' : ' ⚠ Suggest improvements before submitting'
      emit('agent_observation', { role: 'reviewer', observation: scheduled
        ? `Cover letter quality ${clTag}(${quality.clScore}/10)${readyTag}`
        : `Cover letter quality ${clTag}(${quality.clScore}/10)${readyTag}${quality.fitGap ? ` · gap: ${quality.fitGap}` : ''} → ${quality.recommendation}` })

      if (quality.clScore < 6 && pkg.coverLetter) {
        const question = `${pkg.job.company} · ${pkg.job.role} cover letter quality is low(${quality.clScore}/10): ${quality.recommendation}.Whether to continue delivery or skip?`
        const options = [
          { label: '📤 Continue delivery(Existing materials)', value: 'continue' },
          { label: '⏳ Place for review', value: 'review' },
          { label: '✕ Skip this post', value: 'skip' },
        ]
        let decision: string
        if (scheduled) {
          const questionIdentity = scheduledGateQuestion('weak_cover_letter', [pkg.job.id])
          if (scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id) {
            decision = scheduledChoice.choiceId
            choiceMatched = true
          } else if (appliedPrior.size < priorChoices.length || scheduledChoice?.kind === 'weak_cover_letter' && !choiceMatched) {
            deferredQuestion ??= questionIdentity
            continue
          } else return questionIdentity
        } else {
          decision = ctx.askUser
            ? await ctx.askUser('reviewer', question, options)
            : (emit('agent_question', { role: 'reviewer', questionId: `poor_cl_${pkg.job.id}`, question, options }), 'review')
        }
        if (decision === 'skip') {
          skipped.push(pkg)
          await skipApplicationForGate({
            userId: ctx.userId,
            jobId: pkg.job.id,
            sessionId: ctx.sessionId,
            checkpoint: 'review_quality_declined',
            owner: gateWriteOwner(ctx),
          })
          if (deferredQuestion && appliedPrior.size === priorChoices.length) break
          continue
        }
      }
    }

    if (scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id) {
      choiceMatched = true
      if (scheduledChoice.choiceId === 'skip') {
        skipped.push(pkg)
        await skipApplicationForGate({ userId: ctx.userId, jobId: pkg.job.id, sessionId: ctx.sessionId, checkpoint: 'review_quality_declined', owner: gateWriteOwner(ctx) })
        if (deferredQuestion && appliedPrior.size === priorChoices.length) break
        continue
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
      if (deferredQuestion && scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id
        && appliedPrior.size === priorChoices.length) break
      continue
    }

    if (!scheduled) {
      artifactCheck = prepareReviewedPackage(pkg, ctx)
      if (artifactCheck.issues.length > 0) {
        skipped.push(pkg)
        emitArtifactResult(ctx, artifactCheck)
        emit('agent_observation', { role: 'reviewer', observation: `✕ Material preflight blocked ${pkg.job.company}: ${artifactCheck.issues.join(', ')}` })
        continue
      }
      reviewedPackage = artifactCheck.reviewedPackage
      emitArtifactResult(ctx, artifactCheck)
    }

    pending.push(reviewedPackage)
    if (ctx.sessionId) {
      requireLegacyPolicy({
        userId: ctx.userId, sessionId: ctx.sessionId, turnId: `gate:${ctx.sessionId}`, stepId: `review:${pkg.job.id}`,
        toolCallId: `review:${pkg.job.id}`, toolName: 'application.review', domain: 'application', risk: 'internal_write',
        capabilities: ['read', 'write'], input: { requiresReceipt: false, unknownSensitiveFacts: false, jobId: pkg.job.id },
      })
    }
    const approval = ctx.sessionId ? scheduled
      ? await createGateReviewReceipt(ctx, reviewedPackage, projectedWaitIssued, true)
      : await createGateReviewReceipt(ctx, reviewedPackage, projectedWaitIssued) : null
    if (approval?.projectedWait) projectedWaitIssued = true
    emit('agent_observation', {
      role:        'reviewer',
      observation: `⏳ Enter to be reviewed: Material saved, They must be reviewed individually by you and explicitly authorized before submission..`,
    })
    if (!scheduled) emit('agent_question', {
      role: 'reviewer', questionId: `application_review_${pkg.job.id}`,
      question: `${pkg.job.company} · ${pkg.job.role}: The job and prepared materials are ready for review. Approval here unlocks form-fill only and does not submit the application.`,
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
    if (scheduledChoice?.kind === 'weak_cover_letter' && scheduledChoice.jobIds[0] === pkg.job.id && deferredQuestion
      && appliedPrior.size === priorChoices.length) break
  }
  if (validatedChoice !== undefined && !choiceMatched) throw new AgentExecutionCancelledError()
  if (appliedPrior.size !== priorChoices.length) throw new AgentExecutionCancelledError()
  if (deferredQuestion) return deferredQuestion
  const total = Date.now() - t0
  return { status: 'stage_completed', result: stageOk('gate', { approved, pending, skipped }, approved.length + pending.length + skipped.length, total) }
}

async function assertScheduledGateCurrent(ctx: PipelineCtx, scheduled: boolean) {
  if (!scheduled || !ctx.scheduledTaskGraphOwnerFence) return
  if (ctx.signal?.aborted || ctx.assertExecutionCurrent && !await ctx.assertExecutionCurrent()) throw new AgentExecutionCancelledError()
}

function prepareReviewedPackage(pkg: ApplicationPackage, ctx: PipelineCtx) {
  const artifacts = [pkg.tailoredResumeArtifact, pkg.coverLetterArtifact].filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (!artifacts.length) return { reviewedPackage: pkg, artifacts, issues: [] as string[], reviews: [] as ReturnType<typeof reviewArtifact>[] }
  const constraintHash = hashArtifactConstraints(tailoringConstraints(pkg, ctx.agentCfg))
  const issues = artifacts.flatMap(artifact => {
    const result = preflightArtifact(artifact, constraintHash)
    return result.ok ? [] : result.issues.map(issue => `${artifact.kind}:${issue}`)
  })
  const reviews = issues.length ? [] : artifacts.map(artifact => reviewArtifact({ artifact, expectedHash: artifact.hash,
    reviewerId: ctx.userId, decision: 'passed', evidence: [], constraintHash }))
  return { reviewedPackage: reviews.length ? { ...pkg, artifactReview: reviews[0], artifactReviews: reviews } : pkg, artifacts, issues, reviews }
}

function emitArtifactResult(ctx: PipelineCtx, check: ReturnType<typeof prepareReviewedPackage>) {
  if (check.issues.length) {
    ctx.emit('artifact_reviewed', { role: 'reviewer', status: 'stale', issues: check.issues, artifacts: check.artifacts.map(item => artifactItemData(item)) })
  } else if (check.reviews.length) {
    ctx.emit('artifact_reviewed', { role: 'reviewer', status: 'passed', reviews: check.reviews.map((review, index) => ({
      review: { ...review, evidence: undefined }, artifact: artifactItemData(check.artifacts[index], review),
    })) })
  }
}

function scheduledGateQuestion(kind: 'borderline_match' | 'weak_cover_letter', jobIds: readonly string[]): ScheduledTaskGraphGateQuestion {
  const question = createScheduledTaskGraphGateQuestion(kind, jobIds)
  if (!question) throw new AgentExecutionCancelledError()
  return question
}
