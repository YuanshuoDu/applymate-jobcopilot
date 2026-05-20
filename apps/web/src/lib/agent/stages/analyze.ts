/**
 * Stage 2 — Analyze
 * Role: 分析员
 * Scores each job against the user's resume using AI.
 * Persists score to DB immediately after each call.
 * Emits per-job SSE events: job_start / job_done / job_skip / job_error
 */
import type { Job }     from '@prisma/client'
import { db }           from '@/lib/db'
import { modelChat, stripFences } from '@/lib/model-router'
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ScoredJob, AnalyzeOutput, StageResult, AcceptResult,
} from '../types'
import { stageOk, stageFail } from '../types'

const SCORE_COLOR = (s: number) => s >= 80 ? '#3B6D11' : s >= 60 ? '#854F0B' : '#6B7280'

export async function runAnalyze(
  jobs: Job[],
  ctx: PipelineCtx,
): Promise<StageResult<AnalyzeOutput>> {
  const t0 = Date.now()
  const { agentCfg, resumeText, aiConfig, roleConfigs, emit, userId } = ctx
  const THROTTLE_MS = agentCfg.throttleMs ?? 300

  // Use analyst role's configured model; fall back to global aiConfig
  const analystCfg = roleConfigs.analyst
  const scoringConfig = analystCfg
    ? { provider: analystCfg.provider as AiConfig['provider'], model: analystCfg.model, apiKey: analystCfg.apiKey }
    : aiConfig

  const scoredJobs: ScoredJob[] = []
  let failed = 0
  const pendingUpdates: Array<{ jobId: string; score: number; recommendation?: string }> = []
  const pendingActivities: Array<{ jobId: string; text: string; color: string }> = []

  // Proactive question: jobs without descriptions
  const noDescCount = jobs.filter(j => !j.description && !!j.role).length
  if (noDescCount > 0) {
    emit('agent_question', {
      role:       'analyst',
      questionId: 'no_description_jobs',
      question:   `发现 ${noDescCount} 个职位没有职位描述。我会尝试根据职位名称和公司评分，但准确度可能偏低。建议：在 Jobs 页面为这些职位手动添加描述后再运行。是否继续？`,
      options: [
        { label: '✓ 继续（用职位名称评分）',   value: 'continue' },
        { label: '↩ 跳过无描述职位',            value: 'skip_no_desc',  action: { field: 'skipNoDescription', value: true } },
      ],
    })
  }

  for (const job of jobs) {
    emit('job_start', { jobId: job.id, company: job.company, role: job.role })
    emit('agent_action', {
      role:   'analyst',
      action: `评分 ${job.company} · ${job.role}${job.location ? ` (${job.location})` : ''}`,
    })

    if (!job.description && !job.role) {
      emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'No job description available' })
      emit('agent_observation', {
        role:        'analyst',
        observation: `⚠ 跳过 ${job.company} · ${job.role}：无职位描述，无法评分`,
      })
      continue
    }

    try {
      const prompt = buildScorePrompt(resumeText, job)
      const systemPrompt = ctx.roleConfigs.analyst?.systemPrompt ?? undefined
      const messages = systemPrompt
        ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
        : [{ role: 'user' as const, content: prompt }]
      const result = await modelChat(messages, scoringConfig, 512)
      const parsed = parseScoreResult(result.text)

      const color = SCORE_COLOR(parsed.score)
      pendingUpdates.push({ jobId: job.id, score: parsed.score, recommendation: parsed.recommendation })
      pendingActivities.push({ jobId: job.id, text: `Agent scored ${job.company} · ${job.role}: ${parsed.score}% match`, color })

      scoredJobs.push({ job, ...parsed })

      // Emit per-job observation with AI reasoning
      const matchStr  = parsed.matchedKeywords.length  ? `匹配：${parsed.matchedKeywords.slice(0, 4).join(', ')}` : ''
      const missStr   = parsed.missingKeywords.length   ? `缺失：${parsed.missingKeywords.slice(0, 3).join(', ')}` : ''
      const scoreTag  = parsed.score >= 80 ? '✦ 高匹配' : parsed.score >= 60 ? '◆ 中等' : '◇ 偏低'
      emit('agent_observation', {
        role:        'analyst',
        observation: `${scoreTag} ${parsed.score}%${matchStr ? ' · ' + matchStr : ''}${missStr ? ' · ' + missStr : ''}${parsed.recommendation ? ' → ' + parsed.recommendation : ''}`,
      })

      emit('job_done', {
        jobId: job.id, company: job.company, role: job.role,
        score: parsed.score, autoApplied: false,
        recommendation: parsed.recommendation,
        matchedKeywords: parsed.matchedKeywords, missingKeywords: parsed.missingKeywords,
      })

      await new Promise(r => setTimeout(r, THROTTLE_MS))
    } catch (err) {
      failed++
      console.error('[analyze] scoring error:', err)
      emit('agent_observation', {
        role:        'analyst',
        observation: `✗ ${job.company} · ${job.role} 评分失败：AI 调用异常`,
      })
      emit('job_error', { jobId: job.id, company: job.company, role: job.role, error: 'AI scoring failed' })
    }
  }

  // Batch persist scores and activities
  if (pendingUpdates.length > 0) {
    await Promise.all([
      ...pendingUpdates.map(u =>
        db.job.update({ where: { id: u.jobId }, data: { score: u.score, analysisNote: u.recommendation || null } as any })
      ),
      ...pendingActivities.map(a =>
        db.activity.create({ data: { userId, jobId: a.jobId, type: 'agent_action' as const, text: a.text, color: a.color } })
      ),
    ])
  }

  if (scoredJobs.length === 0 && jobs.length > 0) {
    return stageFail('analyze', 'All jobs failed to score')
  }

  return stageOk('analyze', { scoredJobs, failed }, scoredJobs.length, Date.now() - t0)
}

export function acceptAnalyze(result: StageResult<AnalyzeOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? 'Analyze returned no data' }
  }
  for (const sj of result.data.scoredJobs) {
    if (typeof sj.score !== 'number' || sj.score < 0 || sj.score > 100) {
      return { ok: false, reason: `Job ${sj.job.id} has invalid score: ${sj.score}` }
    }
    if (!Array.isArray(sj.matchedKeywords)) {
      return { ok: false, reason: `Job ${sj.job.id} missing matchedKeywords array` }
    }
  }
  return { ok: true }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildScorePrompt(resumeText: string, job: Job): string {
  return `You are an expert ATS analyzer. Score this resume against this job posting.
Return ONLY valid JSON — no markdown, no preamble.

RESUME:
${resumeText.slice(0, 2500)}

JOB: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `DESCRIPTION:\n${job.description.slice(0, 1200)}` : ''}

JSON format:
{
  "score": <integer 0-100>,
  "matchedKeywords": [<up to 6 strings>],
  "missingKeywords": [<up to 4 strings>],
  "recommendation": "<one actionable sentence to improve this application>"
}`
}

function parseScoreResult(raw: string): Omit<ScoredJob, 'job'> {
  try {
    const json   = stripFences(raw)
    const result = JSON.parse(json)
    return {
      score:           Math.min(100, Math.max(0, Number(result.score) || 0)),
      matchedKeywords: Array.isArray(result.matchedKeywords) ? result.matchedKeywords : [],
      missingKeywords: Array.isArray(result.missingKeywords) ? result.missingKeywords : [],
      recommendation:  typeof result.recommendation === 'string' ? result.recommendation : '',
    }
  } catch {
    return { score: 0, matchedKeywords: [], missingKeywords: [], recommendation: '' }
  }
}
