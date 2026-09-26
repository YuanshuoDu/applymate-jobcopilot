import type { Prisma } from '@prisma/client'
import type { GateOutput } from './types'
import { runPrepare } from './stages/prepare'
import { runGate } from './stages/gate'
import { withRunRecorderWriteOwnership } from './session/run-recorder-ownership'
import type { PipelinePrepareGateResult, PipelineScoutAnalyzeResult, PipelineStageRuntimeContext } from './pipeline-context'

export async function runPrepareGateStages(
  runtime: PipelineStageRuntimeContext,
  input: PipelineScoutAnalyzeResult,
): Promise<PipelinePrepareGateResult> {
  const { ctx, pipelineCtx, controlledCtx, orchestrator: orch, emit, emitRole } = runtime
  const { scoutedJobs, scoredJobs, analysisFailed } = input
  let preparedPackages = runtime.getState().preparedPackages ?? []

  if (runtime.needsStage('prepare')) {
    orch.beginStage('writer', 2)
    emitRole(pipelineCtx, 'writer', 'start')
    const qualifiedCount = scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
    emit('agent_plan', {
      role: 'writer',
      plan: ctx.agentCfg.autoCoverLetter
        ? `plan: for ${qualifiedCount} Generate a customized cover letter for every qualified position(intonation: ${ctx.agentCfg.coverTone || 'professional'})`
        : `plan: for ${qualifiedCount} Prepare application materials for qualified positions`,
    })
    await runtime.persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })

    let allowResumeTailoring = true
    if (ctx.agentCfg.requireApproval) {
      const decision = await orch.ask('writer',
        `Writer Prepare for ${qualifiedCount} Applications for qualified positions AI Revise, Generate custom resumes and keep job connections with templates.Do you want to continue??`,
        [
          { label: 'application AI Modify and generate customized resumes', value: 'apply_ai_changes' },
          { label: 'Generate cover letter only, Resume remains the same', value: 'keep_resume' },
        ],
      )
      await runtime.assertAlive()
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
      await runtime.assertAlive()
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
      await runtime.recordRoleRun('writer', { count: preparedPackages.length, durationMs: s3.metrics.durationMs, summary: writerSummary }).catch(() => {})
      await runtime.collectCustomResults(scoutedJobs, 'writer')
      await runtime.persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })
      break prepareLoop
    }
  } else {
    emit('info', { message: `Resuming from ${runtime.getState().nextStage}; application materials restored (${preparedPackages.length} packages).` })
  }

  let gateOutput: GateOutput = runtime.getState().gateOutput ?? { approved: [], pending: [], skipped: [] }
  if (runtime.needsStage('gate')) {
    orch.beginStage('reviewer', 1)
    emitRole(pipelineCtx, 'reviewer', 'start')
    const gateRule = ctx.agentCfg.autoApply && !ctx.agentCfg.requireApproval
      ? `automatic preparation mode: point ≥ ${ctx.agentCfg.minMatchScore}% → Automatically complete material and form preparation; Each application must still be reviewed by the user and submitted with separate authorization`
      : 'Audit mode: All positions are queued for review; Position-by-position authorization is required before submission'
    emit('agent_plan', {
      role: 'reviewer',
      plan: `plan: right ${preparedPackages.length} Application package execution AI quality review + Diversion decision.rule: ${gateRule}`,
    })
    await runtime.persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })

    const s4 = await runGate(preparedPackages, controlledCtx)
    await runtime.assertAlive()
    gateOutput = s4.data ?? gateOutput

    const reviewerSummary = `${gateOutput.approved.length} approved, ${gateOutput.pending.length} pending, ${gateOutput.skipped.length} skipped`
    emit('agent_reflect', {
      role: 'reviewer',
      reflect: `Review completed: ${gateOutput.approved.length} Approved to enter the application queue, ${gateOutput.pending.length} pending review, ${gateOutput.skipped.length} below the threshold to skip(time consuming ${(s4.metrics.durationMs / 1000).toFixed(1)}s)`,
    })
    emitRole(pipelineCtx, 'reviewer', 'done', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary, approved: gateOutput.approved.length, pending: gateOutput.pending.length })
    emit('stage_done', { stage: 'gate', approved: gateOutput.approved.length, pending: gateOutput.pending.length, skipped: gateOutput.skipped.length, durationMs: s4.metrics.durationMs })
    await runtime.recordRoleRun('reviewer', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary }).catch(() => {})
    await runtime.collectCustomResults(scoutedJobs, 'reviewer')

    if (gateOutput.pending.length > 0) {
      emit('info', { message: `${gateOutput.pending.length} job(s) are ready for your review in Saved jobs` })
      const { db } = await import('@/lib/db')
      for (const pkg of gateOutput.pending) {
        const data = { status: 'saved' as const, workflowState: 'ready_to_apply' as const }
        if (!ctx.executionAttempt || !ctx.sessionId || !ctx.turnId) runtime.throwInterrupted()
        const result = await withRunRecorderWriteOwnership(db as never, {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          owner: {
            executionAttempt: ctx.executionAttempt,
            turnId: ctx.turnId,
            signal: ctx.signal,
            requireRunning: true,
          },
        }, async tx => {
          try {
            return await (tx as unknown as Prisma.TransactionClient).job.update({ where: { id: pkg.job.id }, data })
          } catch {
            return null
          }
        })
        if (!result.owned) runtime.throwInterrupted()
      }
    }

    if (gateOutput.approved.length === 0 && gateOutput.pending.length === 0) {
      emit('orchestrator_decision', {
        stage: 'reviewer', decision: 'all_skipped',
        reason: `all ${gateOutput.skipped.length} positions are below the threshold ${ctx.agentCfg.minMatchScore}%.It is recommended to lower the threshold or improve the resume.`,
      })
    }
    await runtime.persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })
  } else {
    emit('info', { message: `Resuming from ${runtime.getState().nextStage}; review routing restored.` })
  }

  return { preparedPackages, gateOutput }
}
