import { runExecute } from './stages/execute'
import { runAudit } from './stages/audit'
import { summarizeCustomAgentResults } from './stages/custom'
import { emptyReport } from './types'
import type { PipelineExecuteAuditInput, PipelineExecuteAuditResult, PipelineStageRuntimeContext } from './pipeline-context'
import type { ExecuteOutput, RunReport } from './types'

export async function runExecuteAuditStages(
  runtime: PipelineStageRuntimeContext,
  input: PipelineExecuteAuditInput,
): Promise<PipelineExecuteAuditResult> {
  const { ctx, pipelineCtx, orchestrator: orch, emit, emitRole } = runtime
  const { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput } = input
  let executeOutput: ExecuteOutput = runtime.getState().executeOutput ?? { queued: [], failed: [] }
  let executorQueued: string[] = executeOutput.queued
  let executorFailed: string[] = executeOutput.failed

  if (runtime.needsStage('execute')) {
    orch.beginStage('executor', 3)
    emitRole(pipelineCtx, 'executor', 'start')
    emit('agent_plan', {
      role: 'executor',
      plan: gateOutput.approved.length > 0
        ? `plan: for ${gateOutput.approved.length} Prepare for an approved position"Apply now"queue, Waiting for you to manually confirm delivery`
        : `plan: No approved position, ${gateOutput.pending.length} are in the review queue waiting for manual operation`,
    })
    await runtime.persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })

    executeLoop: while (true) {
      const attempt = orch.nextAttempt('executor')
      if (attempt > 1) {
        const backoffMs = attempt * 1000
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        await runtime.assertAlive()
        orch.emitRetry('executor', attempt, 3, `DB write retry(wait ${backoffMs}ms)…`)
      }

      const s5 = await runExecute(gateOutput.approved, pipelineCtx)
      await runtime.assertAlive()

      if (s5.data!.failed.length > 0 && attempt < 3) {
        orch.recordFailure('executor', `${s5.data!.failed.length} queue operations failed`)
        const failedPkgs = gateOutput.approved.filter(pkg => s5.data!.failed.includes(pkg.job.id))
        if (failedPkgs.length > 0) {
          emit('orchestrator_fix', {
            stage: 'executor', fix: 'retry_failed_db_writes',
            message: `${s5.data!.failed.length} Delivery tasks failed to join the queue, Retrying…`,
          })
          executorQueued = [...executorQueued, ...s5.data!.queued]
          gateOutput.approved = failedPkgs
          continue
        }
      }

      executorQueued = [...executorQueued, ...s5.data!.queued]
      executorFailed = [...executorFailed, ...s5.data!.failed]
      emit('agent_reflect', {
        role: 'executor',
        reflect: executorQueued.length > 0
          ? `Distributed: ${executorQueued.length} Applications that have received final authorization on a position-by-position basis are executed in the background..Submission confirmation will be provided by Worker write back${executorFailed.length > 0 ? `(${executorFailed.length} Failed to join the team)` : ''}(time consuming ${(s5.metrics.durationMs / 1000).toFixed(1)}s)`
          : `Ready to complete: No applications have been distributed in this round; All qualified positions are still pending review, Awaiting your explicit authorization`,
      })
      const executorSummary = `${executorQueued.length} explicitly authorized application(s) queued, ${executorFailed.length} failed`
      emitRole(pipelineCtx, 'executor', 'done', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary, queued: executorQueued.length, failed: executorFailed.length })
      emit('stage_done', { stage: 'execute', queued: executorQueued.length, durationMs: s5.metrics.durationMs })
      await runtime.recordRoleRun('executor', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary }).catch(() => {})
      await runtime.collectCustomResults(scoutedJobs, 'executor')
      executeOutput = { queued: executorQueued, failed: executorFailed }
      await runtime.persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })
      break executeLoop
    }
  } else {
    emit('info', { message: `Resuming from ${runtime.getState().nextStage}; executor outcome restored.` })
  }

  if (!runtime.needsStage('audit')) {
    const restored = runtime.getState().report ?? emptyReport(Date.now() - runtime.startedAt)
    emit('info', { message: 'Agent run was already audited; returning the persisted final report.' })
    return { report: restored }
  }

  orch.beginStage('auditor', 2)
  emitRole(pipelineCtx, 'auditor', 'start')
  emit('agent_plan', {
    role: 'auditor',
    plan: `plan: Verify DB state, Statistical results(${executorQueued.length} Dispatched to unattended Worker / ${gateOutput.pending.length} Pending review / ${gateOutput.skipped.length} jump over), scanning Gmail mail`,
  })
  await runtime.persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })

  let auditWarnings: string[] = []
  auditLoop: while (true) {
    const attempt = orch.nextAttempt('auditor')
    if (attempt > 1) orch.emitRetry('auditor', attempt, 2, 'jump over Gmail scanning, only do DB Verify…')

    const fakeExecuteOutput = { queued: executorQueued, failed: executorFailed }
    const s6 = await runAudit(fakeExecuteOutput, scoutedJobs, pipelineCtx)
    await runtime.assertAlive()
    auditWarnings = s6.data!.warnings ?? []
    if (auditWarnings.length > 0) emit('info', { message: `Audit: ${auditWarnings.join('; ')}` })

    const report: RunReport = {
      processed: scoutedJobs.length,
      applied: 0,
      queued: executorQueued.length,
      pending: gateOutput.pending.length,
      skipped: gateOutput.skipped.length + analysisFailed,
      failed: executorFailed.length,
      durationMs: Date.now() - runtime.startedAt,
    }

    const auditorSummary = `${report.queued} dispatched, ${report.pending} pending, ${auditWarnings.length} warnings`
    emit('agent_reflect', {
      role: 'auditor',
      reflect: `✅ This operation report: deal with ${report.processed} positions · 🚀 Distributed ${report.queued} indivual · ✅ Submission confirmed ${report.applied} indivual · ⏳ Pending review ${report.pending} indivual · ⏭ jump over ${report.skipped} indivual · ❌ fail ${report.failed} indivual${auditWarnings.length > 0 ? ` · ⚠ ${auditWarnings.length} warning` : ''} · Total time spent ${((Date.now() - runtime.startedAt) / 1000).toFixed(1)}s`,
    })
    emitRole(pipelineCtx, 'auditor', 'done', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary, warnings: auditWarnings.length })
    emit('stage_done', { stage: 'audit', durationMs: s6.metrics.durationMs })
    await runtime.recordRoleRun('auditor', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary }).catch(() => {})
    await runtime.collectCustomResults(scoutedJobs, 'auditor')
    const customSummary = summarizeCustomAgentResults(runtime.getCustomAgentResults())
    if (customSummary.length > 0) emit('custom_agent_summary', { findings: customSummary })

    const postRunAvg = scoredJobs.length
      ? Math.round(scoredJobs.reduce((sum, job) => sum + job.score, 0) / scoredJobs.length)
      : 0
    const decPost = await orch.evaluate('post-run',
      `Complete: ${report.processed} processed, ${report.queued} dispatched, ${report.applied} confirmed submitted, ${report.pending} pending review, ${report.skipped} skipped, avg score ${postRunAvg}%`,
      { processed: report.processed, queued: report.queued, applied: report.applied, pending: report.pending, skipped: report.skipped, avgScore: postRunAvg, threshold: ctx.agentCfg.minMatchScore, autoApply: ctx.agentCfg.autoApply },
    )
    await runtime.assertAlive()
    if (decPost.decision === 'ask_user' && decPost.ask_question) {
      const options = decPost.ask_options ?? [{ label: '✓ learn', value: 'ok' }]
      const answer = await orch.ask('post-run', decPost.ask_question, options)
      await runtime.assertAlive()
      await orch.applyOptionAction(answer, options)
      await runtime.assertAlive()
    }
    if (decPost.decision === 'retry' && decPost.retry_fix) orch.applyFix(decPost.retry_fix, 'post-run')

    await runtime.assertAlive()
    orch.complete({
      processed: report.processed,
      applied: report.applied,
      queued: report.queued,
      pending: report.pending,
      skipped: report.skipped,
    })
    emit('done', report)
    await runtime.persist('completed', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput, report })
    await runtime.assertAlive()
    return { report }
  }

  await runtime.flushCanonical()
  return { report: emptyReport(Date.now() - runtime.startedAt) }
}
