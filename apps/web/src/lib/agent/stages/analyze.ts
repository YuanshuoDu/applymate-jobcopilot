/** Stage 2 — Analyst scores jobs and persists results. */
import type { Job, Prisma } from '@prisma/client'
import { db }           from '@/lib/db'
import { stripFences } from '@/lib/model-router'
import { completeAnalyzeModelCall } from './analyze-model-call'
import type {
  PipelineCtx, ScoredJob, AnalyzeOutput, StageResult, AcceptResult,
} from '../types'
import { stageOk, stageFail } from '../types'
import { roleAiConfig } from '../role-config'
import { forEachConcurrent } from '../concurrency'
import { assessApplicationPreflight } from '../application-preflight'
import { assertAnalyzeSignalActive, claimAnalyzeTask, transitionAnalyzeTask } from './analyze-ownership'
import { AgentExecutionCancelledError } from '../execution-control'

const SCORE_COLOR = (s: number) => s >= 80 ? '#3B6D11' : s >= 60 ? '#854F0B' : '#6B7280'

export interface AnalyzeRecoveryHooks {
  existingScoredJobs?: readonly ScoredJob[]
  initialFailed?: number
  beforeScore?: (jobId: string) => Promise<void>
  onScoredJob?: (scored: ScoredJob, tx: Prisma.TransactionClient) => Promise<void>
  onScoreFailure?: (jobId: string) => Promise<void>
  assertScoreOwnerCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>
}

export class AnalyzeRecoveryPersistenceError extends AgentExecutionCancelledError {
  constructor() {
    super()
    this.message = 'Failed to persist Analyze recovery state'
    this.name = 'AnalyzeRecoveryPersistenceError'
  }
}

export async function runAnalyze(
  jobs: Job[],
  ctx: PipelineCtx,
  recovery?: AnalyzeRecoveryHooks,
): Promise<StageResult<AnalyzeOutput>> {
  const t0 = Date.now()
  const { agentCfg, resumeText, aiConfig, roleConfigs, emit, userId } = ctx
  const THROTTLE_MS = agentCfg.throttleMs ?? 300

  // Use analyst role's configured model; fall back to global aiConfig
  const analystCfg = roleConfigs.analyst
  const scoringConfig = roleAiConfig('analyst', analystCfg, aiConfig)

  const scoredJobs: ScoredJob[] = [...(recovery?.existingScoredJobs ?? [])]
  const alreadyScored = new Set(scoredJobs.map(item => item.job.id))
  const jobsToScore = jobs.filter(job => !alreadyScored.has(job.id))
  let failed = recovery?.initialFailed ?? 0
  let fenceSkipped = 0
  let hasFatalError = false
  let fatalError: unknown
  const throwIfFatal = () => { if (hasFatalError) throw fatalError }

  // Ask the candidate before scoring jobs without descriptions.
  const noDescCount = jobsToScore.filter(j => !j.description && !!j.role).length
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

  await forEachConcurrent(jobsToScore, 3, async job => {
    if (hasFatalError) return
    try {
      throwIfFatal()
      const preflight = assessApplicationPreflight(job)
      const hardPreflightIssues = preflight.issues.filter(issue => issue.code !== "missing_description")
      const analysisFenceAt = await db.$transaction(tx => claimAnalyzeTask(tx, {
        userId, jobId: job.id, sessionId: ctx.sessionId, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
      }))
      throwIfFatal()
      if (!analysisFenceAt) {
        fenceSkipped++
        return
      }
      let recoveryHookFailed = false
      const assertRecoveryOwnerCurrent = async (tx: Prisma.TransactionClient) => {
        if (!recovery?.assertScoreOwnerCurrent) return
        try {
          if (!await recovery.assertScoreOwnerCurrent(tx)) throw new AgentExecutionCancelledError()
        } catch (error) { recoveryHookFailed = true; throw error }
      }
      const emitJobStart = () => {
        emit('job_start', { jobId: job.id, company: job.company, role: job.role })
        emit('agent_action', {
          role:   'analyst',
          action: `score ${job.company} · ${job.role}${job.location ? ` (${job.location})` : ''}`,
        })
      }
      // Reject ineligible records before spending model credits.
      if (hardPreflightIssues.length > 0) {
        const reason = hardPreflightIssues.map(issue => issue.message).join(" ")
        const skipped = await db.$transaction(async tx => {
          await assertRecoveryOwnerCurrent(tx)
          return transitionAnalyzeTask(tx, {
          userId, jobId: job.id, sessionId: ctx.sessionId, analysisFenceAt, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
          data: { status: 'skipped', checkpoint: 'job_preflight_failed', error: reason, completedAt: new Date() },
          })
        })
        if (!skipped) { fenceSkipped++; return }
        emitJobStart()
        emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason })
        emit('agent_observation', {
          role: 'analyst',
          observation: `⚠ jump over ${job.company} · ${job.role}: The pre-application verification failed.${reason}`,
        })
        return
      }
      if (!job.description && !job.role) {
        const skipped = await db.$transaction(async tx => {
          await assertRecoveryOwnerCurrent(tx)
          return transitionAnalyzeTask(tx, {
          userId, jobId: job.id, sessionId: ctx.sessionId, analysisFenceAt, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
          data: { status: 'skipped', checkpoint: 'job_data_insufficient', error: 'No job title or description available.', completedAt: new Date() },
          })
        })
        if (!skipped) { fenceSkipped++; return }
        emitJobStart()
        emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'No job description available' })
        emit('agent_observation', {
          role:        'analyst',
          observation: `⚠ jump over ${job.company} · ${job.role}: No job description, Unable to rate`,
        })
        return
      }
      if (skipNoDescription && !job.description) {
        const skipped = await db.$transaction(async tx => {
          await assertRecoveryOwnerCurrent(tx)
          return transitionAnalyzeTask(tx, {
          userId, jobId: job.id, sessionId: ctx.sessionId, analysisFenceAt, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
          data: { status: 'skipped', checkpoint: 'job_description_required', error: 'Candidate chose not to score this job without a description.', completedAt: new Date() },
          })
        })
        if (!skipped) { fenceSkipped++; return }
        emitJobStart()
        emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: 'Candidate chose to skip jobs without descriptions' })
        return
      }
      emitJobStart()
      let recoveryScorePersisted = false
      try {
        try { await recovery?.beforeScore?.(job.id) }
        catch (error) { recoveryHookFailed = true; throw error }
        throwIfFatal()
        const prompt = buildScorePrompt(resumeText, job)
        const systemPrompt = ctx.roleConfigs.analyst?.systemPrompt ?? undefined
        const messages = systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
          : [{ role: 'user' as const, content: prompt }]
        const result = await completeAnalyzeModelCall({
          scoringConfig, messages, userId, sessionId: ctx.sessionId, turnId: ctx.turnId,
          executionAttempt: ctx.executionAttempt, jobId: job.id, analysisFenceAt, signal: ctx.signal,
        })
        throwIfFatal()
        const parsed = parseScoreResult(result)
        const color = SCORE_COLOR(parsed.score)
        const scored = { job, ...parsed, analysisFenceAt: analysisFenceAt.toISOString() }
        // This conditional UPDATE locks the task through both writes; NULL is
        // explicit because PostgreSQL NOT IN does not match NULL values.
        const persisted = await db.$transaction(async tx => {
          throwIfFatal()
          await assertRecoveryOwnerCurrent(tx)
          throwIfFatal()
          const owned = await transitionAnalyzeTask(tx, {
            userId, jobId: job.id, sessionId: ctx.sessionId, analysisFenceAt, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
            data: { status: 'analyzing', updatedAt: analysisFenceAt },
          })
          if (!owned) return false
          throwIfFatal()
          await tx.job.update({ where: { id: job.id }, data: { score: parsed.score, analysisNote: parsed.recommendation || null } })
          throwIfFatal()
          assertAnalyzeSignalActive(ctx.signal)
          await tx.activity.create({ data: { userId, jobId: job.id, type: 'agent_action', text: `Agent scored ${job.company} · ${job.role}: ${parsed.score}% match`, color } })
          throwIfFatal()
          assertAnalyzeSignalActive(ctx.signal)
          if (recovery?.onScoredJob) {
            try { await recovery.onScoredJob(scored, tx) }
            catch (error) { recoveryHookFailed = true; throw error }
            recoveryScorePersisted = true
          }
          return true
        })
        if (!persisted) {
          fenceSkipped++
          return
        }
        scoredJobs.push(scored)

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
        if (hasFatalError) throw fatalError
        if (err instanceof AgentExecutionCancelledError || recoveryScorePersisted || recoveryHookFailed) throw err
        assertAnalyzeSignalActive(ctx.signal)
        const message = err instanceof Error ? err.message : 'Unknown AI scoring error'
        const markedFailed = await db.$transaction(async tx => {
          await assertRecoveryOwnerCurrent(tx)
          return transitionAnalyzeTask(tx, {
          userId, jobId: job.id, sessionId: ctx.sessionId, analysisFenceAt, executionAttempt: ctx.executionAttempt, signal: ctx.signal,
          data: { status: 'failed', checkpoint: 'match_analysis_failed', error: message, completedAt: new Date() },
          })
        })
        if (!markedFailed) {
          fenceSkipped++
          return
        }
        await recovery?.onScoreFailure?.(job.id)
        console.error('[analyze] scoring error:', err)
        failed++
        emit('agent_observation', {
          role:        'analyst',
          observation: `✗ ${job.company} · ${job.role} Rating failed: ${message}`,
        })
        emit('job_error', { jobId: job.id, company: job.company, role: job.role, error: message })
      }
    } catch (error) {
      if (!hasFatalError) { fatalError = error; hasFatalError = true }
    }
  })
  if (hasFatalError) throw fatalError

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
