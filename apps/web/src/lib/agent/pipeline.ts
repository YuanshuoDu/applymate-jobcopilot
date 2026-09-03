/**
 * Agent Pipeline — Orchestrated by OrchestratorAgent
 *
 * The OrchestratorAgent is the master harness that:
 *   1. Plans the run strategy before starting
 *   2. Dispatches each SubAgent stage
 *   3. Evaluates output quality after each stage
 *   4. Diagnoses failures and applies fixes
 *   5. Retries failed stages with patched context
 *   6. Decides skip / abort when retries are exhausted
 *
 *   Scout → Analyze → Prepare → Gate → Execute → Audit
 */
import { runScout,   acceptScout   } from './stages/scout'
import { runAnalyze, acceptAnalyze } from './stages/analyze'
import { runPrepare, acceptPrepare } from './stages/prepare'
import { runGate                   } from './stages/gate'
import { runExecute, acceptExecute } from './stages/execute'
import { runAudit                  } from './stages/audit'
import { recordRoleRun, ROLE_META  } from './role-config'
import { runCustomAgents, summarizeCustomAgentResults } from './stages/custom'
import { OrchestratorAgent         } from './orchestrator'
import type { ApplicationPackage, CustomAgentRunResult, ExecuteOutput, GateOutput, PipelineCheckpointState, PipelineCtx, RunReport, ScoredJob, PipelineRunToolInput, PipelineRunToolOutput } from './types'
import { emptyReport } from './types'

export type { PipelineCtx }

/** Stable Agent-column coarse tool contract. userId is always runtime-owned. */
export const PIPELINE_RUN_TOOL = Object.freeze({
  name: 'pipeline.run',
  version: '1',
  description: 'Run or resume the job application preparation pipeline.',
  input: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['resume', 'start'] } } },
})

export type { PipelineRunToolInput, PipelineRunToolOutput }

export class PipelineInterruptedError extends Error {
  readonly code = 'pipeline_interrupted'

  constructor() {
    super('Pipeline interrupted before the next stage could start')
    this.name = 'PipelineInterruptedError'
  }
}

function emitRole(ctx: PipelineCtx, role: string, event: 'start' | 'done', extra: Record<string, unknown> = {}) {
  const meta  = ROLE_META[role as keyof typeof ROLE_META]
  const model = ctx.roleConfigs[role as keyof typeof ctx.roleConfigs]?.model ?? ctx.aiConfig.model
  if (event === 'start') {
    ctx.emit('role_start', { role, label: meta?.label ?? role, model, icon: meta?.icon ?? '' })
  } else {
    ctx.emit('role_done', { role, icon: meta?.icon ?? '', ...extra })
  }
}

const STAGE_ORDER = { scout: 0, analyze: 1, prepare: 2, gate: 3, execute: 4, audit: 5, completed: 6 } as const

function needsStage(state: PipelineCheckpointState, stage: keyof typeof STAGE_ORDER) {
  return STAGE_ORDER[state.nextStage] <= STAGE_ORDER[stage]
}

export async function runPipeline(ctx: PipelineCtx): Promise<RunReport> {
  const t0   = Date.now()
  let state: PipelineCheckpointState = ctx.resumeState ?? { nextStage: 'scout', startedAt: new Date().toISOString() }
  let eventIndex = state.eventIndex ?? 0
  const canonicalWrites: Promise<unknown>[] = []
  const emit = (event: string, data: unknown) => {
    ctx.emit(event, data)
    const index = eventIndex++
    if (ctx.onCanonicalEvent) {
      canonicalWrites.push(Promise.resolve(ctx.onCanonicalEvent({
        event, data, index,
        idempotencyKey: `pipeline:${ctx.sessionId ?? ctx.userId}:${index}`,
      })))
    }
  }
  const flushCanonical = async () => { await Promise.all(canonicalWrites.splice(0)) }
  const assertAlive = () => {
    if (ctx.signal?.aborted) throw new PipelineInterruptedError()
  }
  const pipelineCtx: PipelineCtx = { ...ctx, emit }
  const orch = new OrchestratorAgent(pipelineCtx, ctx.autonomous ?? false)
  const controlledCtx: PipelineCtx = {
    ...pipelineCtx,
    askUser: async (stage, question, options) => {
      const answer = await orch.ask(stage, question, options)
      await orch.applyOptionAction(answer, options)
      return answer
    },
  }
  let customAgentResults: CustomAgentRunResult[] = state.customAgentResults ?? []
  const persist = async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    assertAlive()
    emit('pipeline_checkpoint', { nextStage, eventIndex })
    await flushCanonical()
    state = { ...state, ...patch, customAgentResults, eventIndex, nextStage }
    await ctx.checkpoint?.(state)
  }
  const collectCustomResults = async (jobs: Parameters<typeof runCustomAgents>[1], afterStage: string) => {
    const results = await runCustomAgents(controlledCtx, jobs, afterStage)
    if (Array.isArray(results)) customAgentResults = [...customAgentResults, ...results]
  }

  // ── Orchestrator: plan ─────────────────────────────────────────────────────
  assertAlive()
  await orch.plan()

  // ── Stage 1: Scout ─────────────────────────────────────────────────────────
  const hasTargets = ctx.agentCfg.targetRoles.length > 0
  let scoutedJobs = state.scoutedJobs ?? []
  let scoutDiscovered = 0
  if (needsStage(state, 'scout')) {
  orch.beginStage('scout', 3)
  emitRole(pipelineCtx, 'scout', 'start')
  emit('agent_plan', {
    role: 'scout',
    plan: hasTargets
      ? `plan: Match found [${ctx.agentCfg.targetRoles.slice(0, 3).join(', ')}] new positions, Then load the saved job, Apply filters(exclude ${ctx.agentCfg.excludeCompanies.length} companies, daily cap ${ctx.agentCfg.dailyLimit} strip)`
      : `plan: Load all saved jobs, Apply exclusions/Remove duplicates/Daily cap filter`,
  })
  await persist('scout')

  scoutLoop: while (true) {
    const attempt = orch.nextAttempt('scout')
    if (attempt > 1) orch.emitRetry('scout', attempt, 3, 'Rescan jobs…')

    const s1 = await runScout(pipelineCtx)
    assertAlive()
    const a1 = acceptScout(s1)

    if (!a1.ok) {
      orch.recordFailure('scout', a1.reason ?? 'Scout failed')
      if (orch.isExhausted('scout')) {
        const decision = await orch.decideOnExhaustion('scout', a1.reason ?? '', { jobsProcessed: 0 })
        if (decision === 'abort') { const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report }
        break scoutLoop
      }
      orch.applyFix('scout', 'scout_failed')
      continue
    }

    // True LLM evaluation of scout output
    const dec1 = await orch.evaluate('scout',
      `Found ${s1.data!.jobs.length} jobs (${scoutDiscovered} new discovered)`,
      { jobCount: s1.data!.jobs.length, discovered: scoutDiscovered, targetRoles: ctx.agentCfg.targetRoles.length },
    )
    if (dec1.decision === 'abort') {
      const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report
    }
    if (dec1.decision === 'ask_user' && dec1.ask_question) {
      const answer = await orch.ask('scout', dec1.ask_question, dec1.ask_options ?? [
        { label: 'continue', value: 'continue' },
        { label: 'abort', value: 'abort' },
      ])
      if (answer === 'abort') { const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report }
      // Apply option action if any
      await orch.applyOptionAction(answer, dec1.ask_options ?? [])
    }
    if (dec1.decision === 'retry' && dec1.retry_fix && attempt < 3) {
      orch.applyFix(dec1.retry_fix, 'scout')
      continue
    }

    scoutedJobs     = s1.data!.jobs
    scoutDiscovered = s1.data!.discovered
    const scoutSummary = scoutDiscovered > 0
      ? `Discovered ${scoutDiscovered} new jobs, ${scoutedJobs.length} total queued`
      : `${scoutedJobs.length} saved jobs queued`

    emit('agent_reflect', {
      role: 'scout',
      reflect: `Reconnaissance completed: ${scoutDiscovered > 0 ? `Discover ${scoutDiscovered} new positions, ` : ''}common ${scoutedJobs.length} positions enter the analysis queue(time consuming ${(s1.metrics.durationMs / 1000).toFixed(1)}s)`,
    })
    emitRole(pipelineCtx, 'scout', 'done', { count: scoutedJobs.length, discovered: scoutDiscovered, durationMs: s1.metrics.durationMs, summary: scoutSummary })
    emit('stage_done', { stage: 'scout', count: scoutedJobs.length, durationMs: s1.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'scout', { count: scoutedJobs.length, durationMs: s1.metrics.durationMs, summary: scoutSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'scout')
    await persist('analyze', { scoutedJobs })
    break scoutLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; Scout result restored (${scoutedJobs.length} jobs).` })
  }

  if (scoutedJobs.length === 0) {
    const msg = hasTargets
      ? 'No jobs found. Try broadening your target roles or locations in Settings.'
      : 'No saved jobs to process. Configure target roles in Settings so the agent can discover jobs automatically.'
    emit('info', { message: msg })
    const report = emptyReport(Date.now() - t0)
    emit('done', report)
    await flushCanonical()
    return report
  }

  emit('start', { total: scoutedJobs.length })

  // ── Stage 2: Analyze ───────────────────────────────────────────────────────
  let scoredJobs: ScoredJob[] = state.scoredJobs ?? []
  let analysisFailed = state.analysisFailed ?? 0
  if (needsStage(state, 'analyze')) {
  orch.beginStage('analyst', 2)
  emitRole(pipelineCtx, 'analyst', 'start')
  emit('agent_plan', {
    role: 'analyst',
    plan: `plan: right ${scoutedJobs.length} positions one by one AI match score, Extract matches/Missing keywords(minimum score threshold: ${ctx.agentCfg.minMatchScore}%)`,
  })
  await persist('analyze', { scoutedJobs })

  analyzeLoop: while (true) {
    const attempt = orch.nextAttempt('analyst')
    if (attempt > 1) orch.emitRetry('analyst', attempt, 2, 'Switch alternate model to rescore…')

    const s2 = await runAnalyze(scoutedJobs, controlledCtx)
    assertAlive()
    const a2 = acceptAnalyze(s2)

    if (!a2.ok || !s2.data) {
      orch.recordFailure('analyst', a2.ok ? 'No data' : a2.reason)
      if (orch.isExhausted('analyst')) {
        const decision = await orch.decideOnExhaustion('analyst', 'All scoring failed', { jobsProcessed: 0 })
        if (decision === 'abort') { const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report }
        break analyzeLoop
      }
      orch.applyFix('analyst', 'all_scoring_failed')
      continue
    }

    // True LLM evaluation of analyst output
    const avgScoreEval = s2.data.scoredJobs.length
      ? Math.round(s2.data.scoredJobs.reduce((s, j) => s + j.score, 0) / s2.data.scoredJobs.length)
      : 0
    const aboveEval = s2.data.scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
    const dec2 = await orch.evaluate('analyst',
      `Scored ${s2.data.scoredJobs.length}/${scoutedJobs.length} jobs, avg ${avgScoreEval}%, ${aboveEval} above threshold, ${s2.data.failed ?? 0} failed`,
      { scored: s2.data.scoredJobs.length, avgScore: avgScoreEval, aboveThreshold: aboveEval, failed: s2.data.failed ?? 0, threshold: ctx.agentCfg.minMatchScore },
    )
    if (dec2.decision === 'abort') {
      const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report
    }
    if (dec2.decision === 'ask_user' && dec2.ask_question) {
      const answer = await orch.ask('analyst', dec2.ask_question, dec2.ask_options ?? [
        { label: 'continue', value: 'continue' },
        { label: 'lower threshold 5%', value: 'lower', action: { field: 'minMatchScore', value: Math.max(40, ctx.agentCfg.minMatchScore - 5) } },
      ])
      await orch.applyOptionAction(answer, dec2.ask_options ?? [])
      if (answer === 'abort') { const report = emptyReport(Date.now() - t0); emit('done', report); await flushCanonical(); return report }
    }
    if (dec2.decision === 'retry' && dec2.retry_fix && attempt < 2) {
      orch.applyFix(dec2.retry_fix, 'analyst')
      continue
    }

    scoredJobs    = s2.data.scoredJobs
    analysisFailed = s2.data.failed ?? 0
    const avgScore = scoredJobs.length
      ? Math.round(scoredJobs.reduce((sum, j) => sum + j.score, 0) / scoredJobs.length)
      : 0
    const aboveThreshold = scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
    const analystSummary = `${scoredJobs.length} scored, avg ${avgScore}%`

    emit('agent_reflect', {
      role: 'analyst',
      reflect: `Analysis completed: ${scoredJobs.length} rated, average score ${avgScore}%, ${aboveThreshold} reaches the threshold(≥${ctx.agentCfg.minMatchScore}%), ${analysisFailed} a failure(time consuming ${(s2.metrics.durationMs / 1000).toFixed(1)}s)`,
    })
    emitRole(pipelineCtx, 'analyst', 'done', { count: scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary, avgScore })
    emit('stage_done', { stage: 'analyze', count: scoredJobs.length, durationMs: s2.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'analyst', { count: scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'analyst')

    await persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })
    break analyzeLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; match analysis restored (${scoredJobs.length} jobs).` })
  }

  if (scoredJobs.length === 0) {
    emit('info', { message: 'No jobs scored successfully. Check AI API keys.' })
    orch.complete({ processed: scoutedJobs.length, applied: 0, queued: 0, pending: 0, skipped: scoutedJobs.length })
    const report = emptyReport(Date.now() - t0)
    emit('done', report)
    await flushCanonical()
    return report
  }

  // ── Stage 3: Prepare (Writer) ──────────────────────────────────────────────
  let preparedPackages: ApplicationPackage[] = state.preparedPackages ?? []
  if (needsStage(state, 'prepare')) {
  orch.beginStage('writer', 2)
  emitRole(pipelineCtx, 'writer', 'start')
  const qualifiedCount = scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
  emit('agent_plan', {
    role: 'writer',
    plan: ctx.agentCfg.autoCoverLetter
      ? `plan: for ${qualifiedCount} Generate a customized cover letter for every qualified position(intonation: ${ctx.agentCfg.coverTone || 'professional'})`
      : `plan: for ${qualifiedCount} Prepare application materials for qualified positions`,
  })
  await persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })

  let allowResumeTailoring = true

  // Resume tailoring creates a new candidate artifact. Keep that mutation behind
  // an explicit user gate; the Reviewer remains a separate final approval gate.
  if (ctx.agentCfg.requireApproval) {
    const decision = await orch.ask('writer',
      `Writer Prepare for ${qualifiedCount} Applications for qualified positions AI Revise, Generate custom resumes and keep job connections with templates.Do you want to continue??`,
      [
        { label: 'application AI Modify and generate customized resumes', value: 'apply_ai_changes' },
        { label: 'Generate cover letter only, Resume remains the same', value: 'keep_resume' },
      ],
    )
    allowResumeTailoring = decision === 'apply_ai_changes'
    if (!allowResumeTailoring) {
      emit('agent_observation', {
        role: 'writer',
        observation: 'Original resume has been retained; Writer We will only prepare application materials without modifying your resume.',
      })
    }
  }

  prepareLoop: while (true) {
    const attempt = orch.nextAttempt('writer')
    if (attempt > 1) orch.emitRetry('writer', attempt, 2, 'Regenerate your cover letter using a simplified template…')

    const s3 = await runPrepare(scoredJobs, controlledCtx, { allowResumeTailoring })
    assertAlive()
    // Prepare is non-fatal; acceptPrepare returns ok=true even with partial failures
    const lettersCount = s3.data!.packages.filter(p => p.coverLetter).length
    const writerSummary = ctx.agentCfg.autoCoverLetter
      ? `${lettersCount} cover letters generated`
      : `${s3.data!.packages.length} packages prepared`

    if (ctx.agentCfg.autoCoverLetter && lettersCount === 0 && qualifiedCount > 0 && attempt < 2) {
      orch.applyFix('writer', 'cover_letter_generation_failed')
      emit('orchestrator_fix', {
        stage: 'writer', fix: 'retry_cover_letters',
        message: 'All cover letter generation failed, Retrying(may be API temporary exception)…',
      })
      continue
    }

    preparedPackages = s3.data!.packages
    emit('agent_reflect', {
      role: 'writer',
      reflect: ctx.agentCfg.autoCoverLetter
        ? `Completed: generate ${lettersCount} cover letter, ${preparedPackages.length - lettersCount} no need to generate(time consuming ${(s3.metrics.durationMs / 1000).toFixed(1)}s)`
        : `Material preparation completed: ${preparedPackages.length} Application packages are ready(time consuming ${(s3.metrics.durationMs / 1000).toFixed(1)}s)`,
    })
    emitRole(pipelineCtx, 'writer', 'done', { count: preparedPackages.length, durationMs: s3.metrics.durationMs, summary: writerSummary, letters: lettersCount })
    emit('stage_done', { stage: 'prepare', count: preparedPackages.length, durationMs: s3.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'writer', { count: preparedPackages.length, durationMs: s3.metrics.durationMs, summary: writerSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'writer')
    await persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })
    break prepareLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; application materials restored (${preparedPackages.length} packages).` })
  }

  // ── Stage 4: Gate (Reviewer) ───────────────────────────────────────────────
  let gateOutput: GateOutput = state.gateOutput ?? { approved: [], pending: [], skipped: [] }
  if (needsStage(state, 'gate')) {
  orch.beginStage('reviewer', 1)
  emitRole(pipelineCtx, 'reviewer', 'start')
  const gateRule = ctx.agentCfg.autoApply && !ctx.agentCfg.requireApproval
    ? `automatic preparation mode: point ≥ ${ctx.agentCfg.minMatchScore}% → Automatically complete material and form preparation; Each application must still be reviewed by the user and submitted with separate authorization`
    : 'Audit mode: All positions are queued for review; Position-by-position authorization is required before submission'
  emit('agent_plan', {
    role: 'reviewer',
    plan: `plan: right ${preparedPackages.length} Application package execution AI quality review + Diversion decision.rule: ${gateRule}`,
  })
  await persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })

    const s4 = await runGate(preparedPackages, controlledCtx)
    assertAlive()
  gateOutput = s4.data ?? gateOutput

  const reviewerSummary = `${gateOutput.approved.length} approved, ${gateOutput.pending.length} pending, ${gateOutput.skipped.length} skipped`
  emit('agent_reflect', {
    role: 'reviewer',
    reflect: `Review completed: ${gateOutput.approved.length} Approved to enter the application queue, ${gateOutput.pending.length} pending review, ${gateOutput.skipped.length} below the threshold to skip(time consuming ${(s4.metrics.durationMs / 1000).toFixed(1)}s)`,
  })
  emitRole(pipelineCtx, 'reviewer', 'done', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary, approved: gateOutput.approved.length, pending: gateOutput.pending.length })
  emit('stage_done', { stage: 'gate', approved: gateOutput.approved.length, pending: gateOutput.pending.length, skipped: gateOutput.skipped.length, durationMs: s4.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'reviewer', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary }).catch(() => {})
  await collectCustomResults(scoutedJobs, 'reviewer')

  // Persist the internal readiness signal without inventing an employer-facing
  // "in review" application status.
  if (gateOutput.pending.length > 0) {
    emit('info', { message: `${gateOutput.pending.length} job(s) are ready for your review in Saved jobs` })
    const { db } = await import('@/lib/db')
    for (const pkg of gateOutput.pending) {
      await db.job.update({ where: { id: pkg.job.id }, data: { status: 'saved', workflowState: 'ready_to_apply' } }).catch(() => {})
    }
  }

  // Orchestrator: if nothing approved AND nothing pending, flag it
  if (gateOutput.approved.length === 0 && gateOutput.pending.length === 0) {
    emit('orchestrator_decision', {
      stage: 'reviewer', decision: 'all_skipped',
      reason: `all ${gateOutput.skipped.length} positions are below the threshold ${ctx.agentCfg.minMatchScore}%.It is recommended to lower the threshold or improve the resume.`,
    })
  }
  await persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; review routing restored.` })
  }

  // ── Stage 5: Execute ───────────────────────────────────────────────────────
  let executeOutput: ExecuteOutput = state.executeOutput ?? { queued: [], failed: [] }
  let executorQueued: string[] = executeOutput.queued
  let executorFailed: string[] = executeOutput.failed
  if (needsStage(state, 'execute')) {
  orch.beginStage('executor', 3)
  emitRole(pipelineCtx, 'executor', 'start')
  emit('agent_plan', {
    role: 'executor',
    plan: gateOutput.approved.length > 0
      ? `plan: for ${gateOutput.approved.length} Prepare for an approved position"Apply now"queue, Waiting for you to manually confirm delivery`
      : `plan: No approved position, ${gateOutput.pending.length} are in the review queue waiting for manual operation`,
  })
  await persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })

  executeLoop: while (true) {
    const attempt = orch.nextAttempt('executor')
    if (attempt > 1) {
      const backoffMs = attempt * 1000
      await new Promise(r => setTimeout(r, backoffMs))
      orch.emitRetry('executor', attempt, 3, `DB write retry(wait ${backoffMs}ms)…`)
    }

    const s5 = await runExecute(gateOutput.approved, pipelineCtx)
    assertAlive()

    // If the queue was temporarily unavailable, retry only the failed packages.
    if (s5.data!.failed.length > 0 && attempt < 3) {
      orch.recordFailure('executor', `${s5.data!.failed.length} queue operations failed`)
      // Re-run with only the failed jobs
      const failedPkgs = gateOutput.approved.filter(p => s5.data!.failed.includes(p.job.id))
      if (failedPkgs.length > 0) {
        emit('orchestrator_fix', {
          stage: 'executor', fix: 'retry_failed_db_writes',
          message: `${s5.data!.failed.length} Delivery tasks failed to join the queue, Retrying…`,
        })
        // Merge results
        executorQueued = [...executorQueued, ...s5.data!.queued]
        // Override approved list to only retry failed ones
        gateOutput.approved = failedPkgs
        continue
      }
    }

    executorQueued = [...executorQueued, ...s5.data!.queued]
    executorFailed  = [...executorFailed,  ...s5.data!.failed]

    emit('agent_reflect', {
      role: 'executor',
      reflect: executorQueued.length > 0
        ? `Distributed: ${executorQueued.length} Applications that have received final authorization on a position-by-position basis are executed in the background..Submission confirmation will be provided by Worker write back${executorFailed.length > 0 ? `(${executorFailed.length} Failed to join the team)` : ''}(time consuming ${(s5.metrics.durationMs / 1000).toFixed(1)}s)`
        : `Ready to complete: No applications have been distributed in this round; All qualified positions are still pending review, Awaiting your explicit authorization`,
    })
    const executorSummary = `${executorQueued.length} explicitly authorized application(s) queued, ${executorFailed.length} failed`
    emitRole(pipelineCtx, 'executor', 'done', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary, queued: executorQueued.length, failed: executorFailed.length })
    emit('stage_done', { stage: 'execute', queued: executorQueued.length, durationMs: s5.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'executor', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'executor')
    executeOutput = { queued: executorQueued, failed: executorFailed }
    await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })
    break executeLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; executor outcome restored.` })
  }

  // ── Stage 6: Audit ─────────────────────────────────────────────────────────
  if (!needsStage(state, 'audit')) {
    const restored = state.report ?? emptyReport(Date.now() - t0)
    emit('info', { message: 'Agent run was already audited; returning the persisted final report.' })
    return restored
  }
  orch.beginStage('auditor', 2)
  emitRole(pipelineCtx, 'auditor', 'start')
  emit('agent_plan', {
    role: 'auditor',
    plan: `plan: Verify DB state, Statistical results(${executorQueued.length} Dispatched to unattended Worker / ${gateOutput.pending.length} Pending review / ${gateOutput.skipped.length} jump over), scanning Gmail mail`,
  })
  await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })

  let auditWarnings: string[] = []

  auditLoop: while (true) {
    const attempt = orch.nextAttempt('auditor')
    if (attempt > 1) {
      orch.emitRetry('auditor', attempt, 2, 'jump over Gmail scanning, only do DB Verify…')
    }

    const fakeExecuteOutput = { queued: executorQueued, failed: executorFailed }
    const s6 = await runAudit(fakeExecuteOutput, scoutedJobs, pipelineCtx)
    assertAlive()
    auditWarnings = s6.data!.warnings ?? []

    if (auditWarnings.length > 0) {
      emit('info', { message: `Audit: ${auditWarnings.join('; ')}` })
    }

    const report: RunReport = {
      processed:  scoutedJobs.length,
      applied:    0,
      queued:     executorQueued.length,
      pending:    gateOutput.pending.length,
      skipped:    gateOutput.skipped.length + analysisFailed,
      failed:     executorFailed.length,
      durationMs: Date.now() - t0,
    }

    const auditorSummary = `${report.queued} dispatched, ${report.pending} pending, ${auditWarnings.length} warnings`
    emit('agent_reflect', {
      role: 'auditor',
      reflect: `✅ This operation report: deal with ${report.processed} positions · 🚀 Distributed ${report.queued} indivual · ✅ Submission confirmed ${report.applied} indivual · ⏳ Pending review ${report.pending} indivual · ⏭ jump over ${report.skipped} indivual · ❌ fail ${report.failed} indivual${auditWarnings.length > 0 ? ` · ⚠ ${auditWarnings.length} warning` : ''} · Total time spent ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    })
    emitRole(pipelineCtx, 'auditor', 'done', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary, warnings: auditWarnings.length })
    emit('stage_done', { stage: 'audit', durationMs: s6.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'auditor', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'auditor')
    const customSummary = summarizeCustomAgentResults(customAgentResults)
    if (customSummary.length > 0) {
      emit('custom_agent_summary', { findings: customSummary })
    }

    // ── Post-run LLM evaluation (true Orchestrator decision, not hardcoded) ──
    const postRunAvg = scoredJobs.length
      ? Math.round(scoredJobs.reduce((s, j) => s + j.score, 0) / scoredJobs.length)
      : 0
    const decPost = await orch.evaluate('post-run',
      `Complete: ${report.processed} processed, ${report.queued} dispatched, ${report.applied} confirmed submitted, ${report.pending} pending review, ${report.skipped} skipped, avg score ${postRunAvg}%`,
      { processed: report.processed, queued: report.queued, applied: report.applied, pending: report.pending, skipped: report.skipped, avgScore: postRunAvg, threshold: ctx.agentCfg.minMatchScore, autoApply: ctx.agentCfg.autoApply },
    )
    if (decPost.decision === 'ask_user' && decPost.ask_question) {
      const options = decPost.ask_options ?? [{ label: '✓ learn', value: 'ok' }]
      const answer  = await orch.ask('post-run', decPost.ask_question, options)
      await orch.applyOptionAction(answer, options)
    }
    if (decPost.decision === 'retry' && decPost.retry_fix) {
      orch.applyFix(decPost.retry_fix, 'post-run')
    }

    // ── Orchestrator complete ─────────────────────────────────────────────────
    orch.complete({
      processed: report.processed,
      applied:   report.applied,
      queued:    report.queued,
      pending:   report.pending,
      skipped:   report.skipped,
    })

    emit('done', report)
    await persist('completed', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput, report })
    return report
  }

  // Should never reach here, but TS needs it
  await flushCanonical()
  return emptyReport(Date.now() - t0)
}
