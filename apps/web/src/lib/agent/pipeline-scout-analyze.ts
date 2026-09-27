import { runScout, acceptScout } from './stages/scout'
import { runAnalyze, acceptAnalyze } from './stages/analyze'
import { emptyReport } from './types'
import type { PipelineScoutAnalyzeResult, PipelineStageRuntimeContext } from './pipeline-context'

export async function runScoutAnalyzeStages(
  runtime: PipelineStageRuntimeContext,
): Promise<PipelineScoutAnalyzeResult> {
  const { ctx, pipelineCtx, controlledCtx, orchestrator: orch, emit, emitRole } = runtime
  const finish = async (
    scoutedJobs: PipelineScoutAnalyzeResult['scoutedJobs'],
    scoredJobs: PipelineScoutAnalyzeResult['scoredJobs'],
    analysisFailed: number,
  ): Promise<PipelineScoutAnalyzeResult> => {
    const report = emptyReport(Date.now() - runtime.startedAt)
    emit('done', report)
    await runtime.flushCanonical()
    return { terminalReport: report, scoutedJobs, scoredJobs, analysisFailed }
  }

  const hasTargets = ctx.agentCfg.targetRoles.length > 0
  let scoutedJobs = runtime.getState().scoutedJobs ?? []
  let scoutDiscovered = 0
  if (runtime.needsStage('scout')) {
    orch.beginStage('scout', 3)
    emitRole(pipelineCtx, 'scout', 'start')
    emit('agent_plan', {
      role: 'scout',
      plan: hasTargets
        ? `plan: Match found [${ctx.agentCfg.targetRoles.slice(0, 3).join(', ')}] new positions, Then load the saved job, Apply filters(exclude ${ctx.agentCfg.excludeCompanies.length} companies, daily cap ${ctx.agentCfg.dailyLimit} strip)`
        : `plan: Load all saved jobs, Apply exclusions/Remove duplicates/Daily cap filter`,
    })
    await runtime.persist('scout')

    scoutLoop: while (true) {
      const attempt = orch.nextAttempt('scout')
      if (attempt > 1) orch.emitRetry('scout', attempt, 3, 'Rescan jobs…')

      const s1 = await runScout(pipelineCtx)
      await runtime.assertAlive()
      const a1 = acceptScout(s1)

      if (!a1.ok) {
        orch.recordFailure('scout', a1.reason ?? 'Scout failed')
        if (orch.isExhausted('scout')) {
          const decision = await orch.decideOnExhaustion('scout', a1.reason ?? '', { jobsProcessed: 0 })
          await runtime.assertAlive()
          if (decision === 'abort') return finish(scoutedJobs, [], 0)
          break scoutLoop
        }
        orch.applyFix('scout', 'scout_failed')
        continue
      }

      const dec1 = await orch.evaluate('scout',
        `Found ${s1.data!.jobs.length} jobs (${scoutDiscovered} new discovered)`,
        { jobCount: s1.data!.jobs.length, discovered: scoutDiscovered, targetRoles: ctx.agentCfg.targetRoles.length },
      )
      await runtime.assertAlive()
      if (dec1.decision === 'abort') return finish(scoutedJobs, [], 0)
      if (dec1.decision === 'ask_user' && dec1.ask_question) {
        const answer = await orch.ask('scout', dec1.ask_question, dec1.ask_options ?? [
          { label: 'continue', value: 'continue' },
          { label: 'abort', value: 'abort' },
        ])
        await runtime.assertAlive()
        if (answer === 'abort') return finish(scoutedJobs, [], 0)
        await orch.applyOptionAction(answer, dec1.ask_options ?? [])
        await runtime.assertAlive()
      }
      if (dec1.decision === 'retry' && dec1.retry_fix && attempt < 3) {
        orch.applyFix(dec1.retry_fix, 'scout')
        continue
      }

      scoutedJobs = s1.data!.jobs
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
      await runtime.recordRoleRun('scout', { count: scoutedJobs.length, durationMs: s1.metrics.durationMs, summary: scoutSummary }).catch(() => {})
      await runtime.collectCustomResults(scoutedJobs, 'scout')
      await runtime.persist('analyze', { scoutedJobs })
      break scoutLoop
    }
  } else {
    emit('info', { message: `Resuming from ${runtime.getState().nextStage}; Scout result restored (${scoutedJobs.length} jobs).` })
  }

  if (scoutedJobs.length === 0) {
    const msg = hasTargets
      ? 'No jobs found. Try broadening your target roles or locations in Settings.'
      : 'No saved jobs to process. Configure target roles in Settings so the agent can discover jobs automatically.'
    emit('info', { message: msg })
    return finish(scoutedJobs, [], 0)
  }

  emit('start', { total: scoutedJobs.length })

  let scoredJobs = runtime.getState().scoredJobs ?? []
  let analysisFailed = runtime.getState().analysisFailed ?? 0
  if (runtime.needsStage('analyze')) {
    orch.beginStage('analyst', 2)
    emitRole(pipelineCtx, 'analyst', 'start')
    emit('agent_plan', {
      role: 'analyst',
      plan: `plan: right ${scoutedJobs.length} positions one by one AI match score, Extract matches/Missing keywords(minimum score threshold: ${ctx.agentCfg.minMatchScore}%)`,
    })
    await runtime.persist('analyze', { scoutedJobs })

    analyzeLoop: while (true) {
      const attempt = orch.nextAttempt('analyst')
      if (attempt > 1) orch.emitRetry('analyst', attempt, 2, 'Switch alternate model to rescore…')

      const s2 = await runAnalyze(scoutedJobs, controlledCtx)
      await runtime.assertAlive()
      const a2 = acceptAnalyze(s2)

      if (!a2.ok || !s2.data) {
        orch.recordFailure('analyst', a2.ok ? 'No data' : a2.reason)
        if (orch.isExhausted('analyst')) {
          const decision = await orch.decideOnExhaustion('analyst', 'All scoring failed', { jobsProcessed: 0 })
          await runtime.assertAlive()
          if (decision === 'abort') return finish(scoutedJobs, scoredJobs, analysisFailed)
          break analyzeLoop
        }
        orch.applyFix('analyst', 'all_scoring_failed')
        continue
      }

      const ownershipSkippedJobIds = new Set(s2.data.ownershipSkippedJobIds)
      const currentRunJobs = scoutedJobs.filter(job => !ownershipSkippedJobIds.has(job.id))
      if (
        scoutedJobs.length > 0
        && currentRunJobs.length === 0
        && s2.data.scoredJobs.length === 0
        && s2.data.failed === 0
      ) {
        emit('info', {
          message: 'Analysis was not run because every job is fenced by existing task ownership. These jobs were left untouched and are not counted as completed, skipped, or failed.',
        })
        return finish([], [], 0)
      }

      const avgScoreEval = s2.data.scoredJobs.length
        ? Math.round(s2.data.scoredJobs.reduce((s, j) => s + j.score, 0) / s2.data.scoredJobs.length)
        : 0
      const aboveEval = s2.data.scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
      const dec2 = await orch.evaluate('analyst',
        `Scored ${s2.data.scoredJobs.length}/${currentRunJobs.length} jobs, avg ${avgScoreEval}%, ${aboveEval} above threshold, ${s2.data.failed ?? 0} failed`,
        { scored: s2.data.scoredJobs.length, avgScore: avgScoreEval, aboveThreshold: aboveEval, failed: s2.data.failed ?? 0, threshold: ctx.agentCfg.minMatchScore },
      )
      await runtime.assertAlive()
      if (dec2.decision === 'abort') return finish(scoutedJobs, scoredJobs, analysisFailed)
      if (dec2.decision === 'ask_user' && dec2.ask_question) {
        const answer = await orch.ask('analyst', dec2.ask_question, dec2.ask_options ?? [
          { label: 'continue', value: 'continue' },
          { label: 'lower threshold 5%', value: 'lower', action: { field: 'minMatchScore', value: Math.max(40, ctx.agentCfg.minMatchScore - 5) } },
        ])
        await runtime.assertAlive()
        await orch.applyOptionAction(answer, dec2.ask_options ?? [])
        await runtime.assertAlive()
        if (answer === 'abort') return finish(scoutedJobs, scoredJobs, analysisFailed)
      }
      if (dec2.decision === 'retry' && dec2.retry_fix && attempt < 2) {
        orch.applyFix(dec2.retry_fix, 'analyst')
        continue
      }

      scoutedJobs = currentRunJobs
      scoredJobs = s2.data.scoredJobs
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
      await runtime.recordRoleRun('analyst', { count: scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary }).catch(() => {})
      await runtime.collectCustomResults(currentRunJobs, 'analyst')
      await runtime.persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })
      break analyzeLoop
    }
  } else {
    emit('info', { message: `Resuming from ${runtime.getState().nextStage}; match analysis restored (${scoredJobs.length} jobs).` })
  }

  if (scoredJobs.length === 0) {
    emit('info', { message: 'No jobs scored successfully. Check AI API keys.' })
    orch.complete({ processed: scoutedJobs.length, applied: 0, queued: 0, pending: 0, skipped: scoutedJobs.length })
    return finish(scoutedJobs, scoredJobs, analysisFailed)
  }

  return { scoutedJobs, scoredJobs, analysisFailed }
}
