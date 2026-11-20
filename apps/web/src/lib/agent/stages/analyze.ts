/** Stage 2 — Analyst scores jobs and persists results. */
import type { Job, Prisma } from '@prisma/client'
import { db }           from '@/lib/db'
import { completeAnalyzeModelCall } from './analyze-model-call'
import { acceptAnalyze, isAnalyzeSourceChangedError, analyzeScoreColor, assertAnalyzeModelInputsCurrent, buildAnalyzeMessages, parseScoreResult } from './analyze-model-input'
import type {
  PipelineCtx, ScoredJob, AnalyzeOutput, StageResult,
} from '../types'
import { stageOk, stageFail } from '../types'
import { roleAiConfig } from '../role-config'
import { forEachConcurrent } from '../concurrency'
import { assessApplicationPreflight } from '../application-preflight'
import { AnalyzeRecoveryPersistenceError, assertAnalyzeSignalActive, claimAnalyzeTask, cleanupAnalyzeSourceChangedClaims, transitionAnalyzeTask, validateAnalyzeRecoverySources } from './analyze-ownership'
import type { AnalyzeRecoveryHooks } from './analyze-ownership'
import { AgentExecutionCancelledError } from '../execution-control'
export { acceptAnalyze }
export { AnalyzeRecoveryPersistenceError }
export type { AnalyzeRecoveryHooks }

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

  const existingScoredJobs = recovery?.existingScoredJobs ?? []
  if (existingScoredJobs.length > 0) await validateAnalyzeRecoverySources({ userId, sessionId: ctx.sessionId,
    executionAttempt: ctx.executionAttempt, signal: ctx.signal, resumeId: ctx.defaultResume.id, resumeText,
    scoredJobs: existingScoredJobs, sourceFingerprintsByJob: recovery?.sourceFingerprintsByJob,
    assertOwnerCurrent: recovery?.assertScoreOwnerCurrent })
  const scoredJobs: ScoredJob[] = [...existingScoredJobs]
  const alreadyScored = new Set(scoredJobs.map(item => item.job.id))
  const jobsToScore = jobs.filter(job => !alreadyScored.has(job.id))
  const analysisClaims = new Map<string, Date>()
  for (const scored of existingScoredJobs) {
    if (typeof scored.analysisFenceAt !== 'string') continue
    const fenceAt = new Date(scored.analysisFenceAt)
    if (Number.isFinite(fenceAt.getTime())) analysisClaims.set(scored.job.id, fenceAt)
  }
  let failed = recovery?.initialFailed ?? 0
  let fenceSkipped = 0
  let hasFatalError = false
  let fatalError: unknown
  const throwIfFatal = () => { if (hasFatalError) throw fatalError }
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
      analysisClaims.set(job.id, analysisFenceAt)
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
        const messages = buildAnalyzeMessages(resumeText, job, ctx.roleConfigs.analyst?.systemPrompt ?? undefined)
        const result = await completeAnalyzeModelCall({
          scoringConfig, messages, userId, sessionId: ctx.sessionId, turnId: ctx.turnId,
          executionAttempt: ctx.executionAttempt, jobId: job.id, analysisFenceAt, signal: ctx.signal,
        })
        throwIfFatal()
        const parsed = parseScoreResult(result)
        const color = analyzeScoreColor(parsed.score)
        const scored = { job, ...parsed, analysisFenceAt: analysisFenceAt.toISOString() }
        // This conditional UPDATE locks the task through both writes; NULL is
        // explicit because PostgreSQL NOT IN does not match NULL values.
        const persisted = await db.$transaction(async tx => {
          throwIfFatal()
          const sourceFingerprint = await assertAnalyzeModelInputsCurrent(tx, { userId, job, resumeId: ctx.defaultResume.id, resumeText })
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
            try { await recovery.onScoredJob(scored, tx, sourceFingerprint) }
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
        if (err instanceof AgentExecutionCancelledError || isAnalyzeSourceChangedError(err) || recoveryScorePersisted || recoveryHookFailed) throw err
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
  if (hasFatalError) {
    if (isAnalyzeSourceChangedError(fatalError)) {
      await cleanupAnalyzeSourceChangedClaims({ claims: [...analysisClaims].map(([jobId, analysisFenceAt]) => ({ jobId, analysisFenceAt })),
        maxClaims: analysisClaims.size, sourceError: fatalError, userId, sessionId: ctx.sessionId,
        executionAttempt: ctx.executionAttempt, signal: ctx.signal, assertOwnerCurrent: recovery?.assertScoreOwnerCurrent })
    }
    throw fatalError
  }

  if (scoredJobs.length === 0 && jobs.length > 0 && fenceSkipped === 0) {
    return stageFail('analyze', 'All jobs failed to score')
  }

  return stageOk('analyze', { scoredJobs, failed }, scoredJobs.length, Date.now() - t0)
}
