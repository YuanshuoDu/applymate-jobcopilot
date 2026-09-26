/** Stage 2 — Analyst scores jobs and persists results. */
import type { Job }     from '@prisma/client'
import { db }           from '@/lib/db'
import { modelChat, stripFences } from '@/lib/model-router'
import type {
  PipelineCtx, ScoredJob, AnalyzeOutput, StageResult, AcceptResult,
} from '../types'
import { stageOk, stageFail } from '../types'
import { roleAiConfig } from '../role-config'
import { forEachConcurrent } from '../concurrency'
import { assessApplicationPreflight } from '../application-preflight'

const SCORE_COLOR = (s: number) => s >= 80 ? '#3B6D11' : s >= 60 ? '#854F0B' : '#6B7280'
const STICKY_SUBMISSION_CHECKPOINTS = ['submission_request_started', 'submission_uncertain']

export async function runAnalyze(
  jobs: Job[],
  ctx: PipelineCtx,
): Promise<StageResult<AnalyzeOutput>> {
  const t0 = Date.now()
  const { agentCfg, resumeText, aiConfig, roleConfigs, emit, userId } = ctx
  const THROTTLE_MS = agentCfg.throttleMs ?? 300

  // Use analyst role's configured model; fall back to global aiConfig
  const analystCfg = roleConfigs.analyst
  const scoringConfig = roleAiConfig('analyst', analystCfg, aiConfig)
  const safeCheckpoint = { OR: [{ checkpoint: null }, { checkpoint: { notIn: STICKY_SUBMISSION_CHECKPOINTS } }] }
  const sessionFence = ctx.sessionId === undefined
    ? { sessionId: null }
    : { OR: [{ sessionId: null }, { sessionId: ctx.sessionId }] }

  const scoredJobs: ScoredJob[] = []
  let failed = 0
  let fenceSkipped = 0

  // Ask the candidate before scoring jobs without descriptions.
  const noDescCount = jobs.filter(j => !j.description && !!j.role).length
  let skipNoDescription = false
  if (noDescCount > 0) {
    const question = `Discover ${noDescCount} positions have no job description.I would try to rate based on job title and company, But the accuracy may be low.suggestion: exist Jobs The page manually adds descriptions for these positions before running.Do you want to continue??`
    const options = [
      { label: '✓ continue(Rate by job title)', value: 'continue' },
      { label: '↩ Skip jobs without description', value: 'skip_no_desc' },
    ]
    if (ctx.askUser) {
      skipNoDescription = await ctx.askUser('analyst', question, options) === 'skip_no_desc'
    } else {
      emit('agent_question', { role: 'analyst', questionId: 'no_description_jobs', question, options })
    }
  }

  await forEachConcurrent(jobs, 3, async job => {
    const preflight = assessApplicationPreflight(job)
    const hardPreflightIssues = preflight.issues.filter(issue => issue.code !== "missing_description")
    const refreshed = await db.$transaction(async tx => {
      const identity = { userId, jobId: job.id }
      await tx.applicationTask.upsert({
        where: { userId_jobId: identity },
        create: { ...identity, sessionId: ctx.sessionId ?? null, status: "analyzing", checkpoint: "match_analysis" },
        // Ensure a task exists, then refresh it only if a submission has not
        // crossed the durable request-start boundary.
        update: {},
      })
      return tx.applicationTask.updateMany({
        where: {
          ...identity,
          AND: [sessionFence, safeCheckpoint],
        },
        data: { sessionId: ctx.sessionId ?? undefined, status: "analyzing", checkpoint: "match_analysis", error: null, completedAt: null },
      })
    })
    if (refreshed.count !== 1) {
      fenceSkipped++
      return
    }
    emit('job_start', { jobId: job.id, company: job.company, role: job.role })
    emit('agent_action', {
      role:   'analyst',
      action: `score ${job.company} · ${job.role}${job.location ? ` (${job.location})` : ''}`,
    })

    // Reject ineligible records before spending model credits.
    if (hardPreflightIssues.length > 0) {
      const reason = hardPreflightIssues.map(issue => issue.message).join(" ")
      await db.applicationTask?.updateMany({
        where: { userId, jobId: job.id, status: 'analyzing' },
        data: { status: 'skipped', checkpoint: 'job_preflight_failed', error: reason, completedAt: new Date() },
      })
      emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason })
      emit('agent_observation', {
        role: 'analyst',
        observation: `⚠ jump over ${job.company} · ${job.role}: The pre-application verification failed.${reason}`,
      })
      return
    }

    if (!job.description && !job.role) {
      await db.applicationTask?.updateMany({
        where: { userId, jobId: job.id, status: 'analyzing' },
        data: { status: 'skipped', checkpoint: 'job_data_insufficient', error: 'No job title or description available.', completedAt: new Date() },
      })
      emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'No job description available' })
      emit('agent_observation', {
        role:        'analyst',
        observation: `⚠ jump over ${job.company} · ${job.role}: No job description, Unable to rate`,
      })
      return
    }

    if (skipNoDescription && !job.description) {
      await db.applicationTask?.updateMany({
        where: { userId, jobId: job.id, status: 'analyzing' },
        data: { status: 'skipped', checkpoint: 'job_description_required', error: 'Candidate chose not to score this job without a description.', completedAt: new Date() },
      })
      emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'Candidate chose to skip jobs without descriptions' })
      return
    }

    try {
      const prompt = buildScorePrompt(resumeText, job)
      const systemPrompt = ctx.roleConfigs.analyst?.systemPrompt ?? undefined
      const messages = systemPrompt
        ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
        : [{ role: 'user' as const, content: prompt }]
      // Reasoning models need enough completion budget to return the JSON.
      const result = await modelChat(messages, scoringConfig, 1600)
      const parsed = parseScoreResult(result.text)

      const color = SCORE_COLOR(parsed.score)
      // This conditional UPDATE locks the task through both writes; NULL is
      // explicit because PostgreSQL NOT IN does not match NULL values.
      const persisted = await db.$transaction(async tx => {
        const { count } = await tx.applicationTask.updateMany({
          where: { userId, jobId: job.id, status: 'analyzing', sessionId: ctx.sessionId ?? null, ...safeCheckpoint },
          data: { status: 'analyzing' },
        })
        if (count !== 1) return false
        await tx.job.update({ where: { id: job.id }, data: { score: parsed.score, analysisNote: parsed.recommendation || null } })
        await tx.activity.create({ data: { userId, jobId: job.id, type: 'agent_action', text: `Agent scored ${job.company} · ${job.role}: ${parsed.score}% match`, color } })
        return true
      })
      if (!persisted) {
        fenceSkipped++
        return
      }

      scoredJobs.push({ job, ...parsed })

      // Emit per-job observation with AI reasoning
      const matchStr  = parsed.matchedKeywords.length  ? `match: ${parsed.matchedKeywords.slice(0, 4).join(', ')}` : ''
      const missStr   = parsed.missingKeywords.length   ? `Missing: ${parsed.missingKeywords.slice(0, 3).join(', ')}` : ''
      const scoreTag  = parsed.score >= 80 ? '✦ High match' : parsed.score >= 60 ? '◆ medium' : '◇ On the low side'
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
      console.error('[analyze] scoring error:', err)
      const message = err instanceof Error ? err.message : 'Unknown AI scoring error'
      const markedFailed = await db.applicationTask?.updateMany({
        where: { userId, jobId: job.id, status: 'analyzing', sessionId: ctx.sessionId ?? null, ...safeCheckpoint },
        data: { status: 'failed', checkpoint: 'match_analysis_failed', error: message, completedAt: new Date() },
      })
      if (markedFailed && markedFailed.count !== 1) {
        fenceSkipped++
        return
      }
      failed++
      emit('agent_observation', {
        role:        'analyst',
        observation: `✗ ${job.company} · ${job.role} Rating failed: ${message}`,
      })
      emit('job_error', { jobId: job.id, company: job.company, role: job.role, error: message })
    }
  })

  if (scoredJobs.length === 0 && jobs.length > 0 && fenceSkipped === 0) {
    return stageFail('analyze', 'All jobs failed to score')
  }

  return stageOk('analyze', { scoredJobs, failed }, scoredJobs.length, Date.now() - t0)
}

export function acceptAnalyze(result: StageResult<AnalyzeOutput>): AcceptResult {
  if (!result.ok || !result.data) return { ok: false, reason: result.error ?? 'Analyze returned no data' }
  for (const sj of result.data.scoredJobs) {
    if (typeof sj.score !== 'number' || sj.score < 0 || sj.score > 100) return { ok: false, reason: `Job ${sj.job.id} has invalid score: ${sj.score}` }
    if (!Array.isArray(sj.matchedKeywords)) return { ok: false, reason: `Job ${sj.job.id} missing matchedKeywords array` }
  }
  return { ok: true }
}

function buildScorePrompt(resumeText: string, job: Job): string {
  return `You are an expert ATS analyzer. Score this resume-job fit.

IMPORTANT: Output ONLY the JSON object below. No explanation, no preamble, no markdown fences.

RESUME (excerpt):
${resumeText.slice(0, 2000)}

JOB: ${job.role} at ${job.company}${job.location ? ` (${job.location})` : ''}
${job.description ? `DESCRIPTION:\n${job.description.slice(0, 1000)}` : '(no description — score based on role/company only)'}

Output this exact JSON structure:
{"score":75,"matchedKeywords":["skill1","skill2"],"missingKeywords":["skill3"],"recommendation":"One actionable sentence."}

Now output the JSON for this specific job:`
}

function parseScoreResult(raw: string): Omit<ScoredJob, 'job'> {
  const stripped = stripFences(raw)
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI returned no JSON score')

  let result: Record<string, unknown>
  try { result = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown> }
  catch { throw new Error('AI returned malformed score JSON') }

  const score = Number(result.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('AI returned an invalid match score')

  return {
    score: Math.round(score),
    matchedKeywords: Array.isArray(result.matchedKeywords) ? result.matchedKeywords.filter((value): value is string => typeof value === 'string') : [],
    missingKeywords: Array.isArray(result.missingKeywords) ? result.missingKeywords.filter((value): value is string => typeof value === 'string') : [],
    recommendation: typeof result.recommendation === 'string' ? result.recommendation : '',
  }
}
