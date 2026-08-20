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
import { modelChat } from '@/lib/model-router'
import { db } from '@/lib/db'
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ApplicationPackage, GateOutput, StageResult,
} from '../types'
import { stageOk } from '../types'
import { roleAiConfig } from '../role-config'
import { holdForApplicationReview } from '../application-control'

// ── AI Quality Review ─────────────────────────────────────────────────────────

interface QualityResult {
  clScore:       number   // 0-10, how specific/relevant the cover letter is
  fitGap:        string   // key missing skills / gaps
  recommendation: string  // one-line suggestion
  readyToApply:  boolean  // overall assessment
}

async function reviewApplicationQuality(
  pkg: ApplicationPackage,
  ctx: PipelineCtx,
): Promise<QualityResult | null> {
  // Only review if there's a cover letter to assess
  if (!pkg.coverLetter && !pkg.job.description) return null

  const reviewerCfg = ctx.roleConfigs.reviewer
  const aiConfig: AiConfig = roleAiConfig('reviewer', reviewerCfg, ctx.aiConfig)

  const prompt = `You are a hiring quality reviewer. Assess this application package.

JOB: ${pkg.job.role} at ${pkg.job.company}${pkg.job.location ? ` (${pkg.job.location})` : ''}
${pkg.job.description ? `JD: ${pkg.job.description.slice(0, 600)}` : ''}

MATCH SCORE: ${pkg.score}%
MATCHED KEYWORDS: ${pkg.matchedKeywords.slice(0, 5).join(', ')}
MISSING KEYWORDS: ${pkg.missingKeywords.slice(0, 4).join(', ')}

${pkg.coverLetter ? `COVER LETTER:\n${pkg.coverLetter.slice(0, 800)}` : 'NO COVER LETTER'}

Return ONLY valid JSON:
{
  "clScore": <0-10, how specific/personalized the cover letter is to THIS job. 0=generic, 10=highly tailored>,
  "fitGap": "<key missing skill or concern in one sentence>",
  "recommendation": "<one actionable improvement for this specific application>",
  "readyToApply": <true if score≥7 and materials look solid, false otherwise>
}`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], aiConfig, 300)
    const text = result.text.replace(/```json|```/g, '').trim()
    return JSON.parse(text) as QualityResult
  } catch {
    return null
  }
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
    const quality = await reviewApplicationQuality(pkg, ctx)
    if (quality) {
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
          await db.applicationTask?.updateMany({
            where: { userId: ctx.userId, jobId: pkg.job.id, status: { in: ['analyzing', 'generating_materials'] } },
            data: { status: 'skipped', checkpoint: 'review_quality_declined', completedAt: new Date() },
          })
          continue
        }
      }
    }

    if (pkg.score < minMatchScore && !includeBorderline) {
      skipped.push(pkg)
      await db.applicationTask?.updateMany({
        where: { userId: ctx.userId, jobId: pkg.job.id, status: { in: ["analyzing", "generating_materials"] } },
        data: { status: "skipped", checkpoint: "below_match_threshold", completedAt: new Date() },
      })
      emit('agent_observation', {
        role:        'reviewer',
        observation: `✕ jump over: ${pkg.score}% < threshold ${minMatchScore}%`,
      })
      continue
    }

    pending.push(pkg)
    const task = await holdForApplicationReview({
      userId: ctx.userId,
      jobId: pkg.job.id,
      sessionId: ctx.sessionId,
      resumeId: pkg.tailoredResumeId ?? ctx.defaultResume.id,
      coverLetterId: pkg.coverLetterId,
    })
    const approval = ctx.sessionId
      ? await db.agentApproval.create({
          data: {
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            type: "review_application",
            status: "pending",
            title: `Review application: ${pkg.job.company} · ${pkg.job.role}`,
            body: "Review the job, tailored materials, and every proposed answer. Approval here only unlocks the final submit authorization; it never submits by itself.",
            impact: { externalSubmission: false, jobId: pkg.job.id },
            payload: { applicationTaskId: task.id, jobId: pkg.job.id },
          },
        })
      : null
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
          id: approval.id,
          type: approval.type,
          title: approval.title,
          body: approval.body,
          impact: approval.impact,
          payload: approval.payload,
          status: approval.status,
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
