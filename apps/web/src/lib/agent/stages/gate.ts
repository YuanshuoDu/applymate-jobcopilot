/**
 * Stage 4 — Gate (Reviewer)
 * Role: 审核员
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
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ApplicationPackage, GateOutput, StageResult,
} from '../types'
import { stageOk } from '../types'

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
  const aiConfig: AiConfig = reviewerCfg
    ? { provider: reviewerCfg.provider as AiConfig['provider'], model: reviewerCfg.model, apiKey: reviewerCfg.apiKey }
    : ctx.aiConfig

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
  const { autoApply, requireApproval, minMatchScore } = ctx.agentCfg

  const approved: ApplicationPackage[] = []
  const pending:  ApplicationPackage[] = []
  const skipped:  ApplicationPackage[] = []

  const { emit } = ctx

  // Proactive question: borderline jobs (within 5% of threshold)
  const borderline = packages.filter(p => p.score >= minMatchScore - 5 && p.score < minMatchScore)
  if (borderline.length > 0) {
    emit('agent_question', {
      role:       'reviewer',
      questionId: 'borderline_threshold',
      question:   `${borderline.length} 个职位评分刚好低于阈值 ${minMatchScore}%（差距 1-5 分）：${borderline.slice(0, 3).map(p => `${p.job.company}(${p.score}%)`).join('、')}${borderline.length > 3 ? '…' : ''}。是否将它们纳入待审核？`,
      options: [
        { label: '⏳ 纳入待审核（推荐）', value: 'add_to_pending' },
        { label: '✕ 跳过（保持现有阈值）', value: 'skip'          },
        { label: '⬇ 降低阈值 5%',         value: 'lower_threshold', action: { field: 'minMatchScore', value: Math.max(40, minMatchScore - 5) } },
      ],
    })
  }

  for (const pkg of packages) {
    emit('agent_action', {
      role:   'reviewer',
      action: `审核 ${pkg.job.company} · ${pkg.job.role} (${pkg.score}%)`,
    })

    // ── Phase A: AI quality review ──────────────────────────────────────────
    const quality = await reviewApplicationQuality(pkg, ctx)
    if (quality) {
      const clTag  = quality.clScore >= 8 ? '✦ 优秀' : quality.clScore >= 6 ? '◆ 合格' : '◇ 偏弱'
      const readyTag = quality.readyToApply ? '' : ' ⚠ 建议改进后再投递'
      emit('agent_observation', {
        role:        'reviewer',
        observation: `求职信质量 ${clTag}（${quality.clScore}/10）${readyTag}${quality.fitGap ? ` · 缺口：${quality.fitGap}` : ''} → ${quality.recommendation}`,
      })

      // If CL quality is poor, ask user
      if (quality.clScore < 6 && pkg.coverLetter) {
        emit('agent_question', {
          role:       'reviewer',
          questionId: `poor_cl_${pkg.job.id}`,
          question:   `${pkg.job.company} · ${pkg.job.role} 的求职信质量偏低（${quality.clScore}/10）：${quality.recommendation}。是否继续投递还是跳过？`,
          options: [
            { label: '📤 继续投递（现有材料）', value: 'continue' },
            { label: '⏳ 放入待审核',           value: 'review'   },
            { label: '✕ 跳过此职位',            value: 'skip'     },
          ],
        })
      }
    }

    // A Writer-produced tailored resume is a reviewable application artifact.
    // Keep 65–(threshold-1) matches in the human-review path instead of
    // discarding them before the user can inspect the generated resume.
    if (pkg.score < minMatchScore && !pkg.tailoredResumeId) {
      skipped.push(pkg)
      emit('agent_observation', {
        role:        'reviewer',
        observation: `✕ 跳过：${pkg.score}% < 阈值 ${minMatchScore}%`,
      })
      continue
    }

    if (pkg.tailoredResumeId) {
      pending.push(pkg)
      emit('agent_question', {
        role: 'reviewer', questionId: `resume_review_${pkg.job.id}`,
        question: `${pkg.job.company} · ${pkg.job.role} 的定制简历已生成并通过材料审核。请查看简历后确认是否进入申请。`,
        options: [
          { label: '查看定制简历', value: 'view_resume', action: { field: '_navigate', value: `resume&resumeId=${pkg.tailoredResumeId}` } },
          { label: '保留待审核', value: 'review' },
        ],
      })
      continue
    }

    if (autoApply && !requireApproval) {
      approved.push(pkg)
      emit('agent_observation', {
        role:        'reviewer',
        observation: `✓ 批准自动投递：分 ${pkg.score}% ≥ ${minMatchScore}%，autoApply=true`,
      })
    } else {
      pending.push(pkg)
      const reason = !autoApply ? 'autoApply=false' : 'requireApproval=true'
      emit('agent_observation', {
        role:        'reviewer',
        observation: `⏳ 进入待审核：${reason}，需人工确认`,
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
