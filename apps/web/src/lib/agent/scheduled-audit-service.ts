import { db } from '@/lib/db'
import { AgentExecutionCancelledError } from '@/lib/agent/execution-control'
import { createRunSessionRecorder } from '@/lib/agent/session/run-recorder'
import { createDurableEventWriter, createRunAttemptOwnership, isActiveAccount, saveHistory } from '@/lib/agent/run-service-helpers'
import { recordRoleRun } from '@/lib/agent/role-config'
import { buildScheduledTaskGraphGateResumeState, serializeScheduledTaskGraphCheckpoint } from '@/lib/agent/scheduled-taskgraph-run-service'
import { scheduledTaskGraphRunCheckpointIsCurrent, scheduledTaskGraphRunOwnerFence, type ScheduledTaskGraphRunInput } from '@/lib/agent/scheduled-taskgraph-audit-action'
import { scheduledTaskGraphContinuationKey } from '@/lib/agent/scheduled-taskgraph-pipeline-checkpoint'
import { finishScheduledTaskGraphExecution, saveScheduledTaskGraphCheckpoint, scheduledTaskGraphClaimMatches } from '@/lib/agent/scheduled-taskgraph-pipeline-fence'
import { scheduledTaskGraphExecuteGateCompletionProof } from '@/lib/agent/scheduled-taskgraph-gate-rpc'
import { parseScheduledAutomationSnapshot } from '@/lib/agent/scheduled-automation-snapshot'
import { runScheduledAudit } from '@/lib/agent/stages/audit'
import { summarizeCustomAgentResults } from '@/lib/agent/stages/custom'
import type { ExecuteOutput, GateOutput, PipelineCheckpointState, RunReport } from '@/lib/agent/types'

type HistoryEvent = { event: string; at: string; data: unknown }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function validExecute(value: unknown, allowedIds: ReadonlySet<string>): value is ExecuteOutput {
  const row = record(value)
  if (!row || !Array.isArray(row.queued) || !Array.isArray(row.failed)) return false
  const queued: unknown[] = row.queued, failed: unknown[] = row.failed
  const validIds = (ids: unknown[]) => ids.every(id => typeof id === 'string' && allowedIds.has(id))
  return validIds(queued) && validIds(failed) && new Set(queued).size === queued.length
    && new Set(failed).size === failed.length && !queued.some(id => failed.includes(id))
}
function validGate(value: unknown): value is GateOutput {
  const row = record(value)
  return Boolean(row && ['approved', 'pending', 'skipped'].every(key => Array.isArray(row[key])))
}

export async function runScheduledAuditService(input: {
  scheduled: ScheduledTaskGraphRunInput
  signal?: AbortSignal
}): Promise<RunReport | null> {
  const scheduled = input.scheduled
  if (scheduled.action !== 'scheduled_audit_execute' || scheduled.prepareProof === undefined
    || scheduled.gateCompletionProof === undefined || !scheduled.auditActor) return null
  const { owner, continuationKey: key, claimToken } = scheduled
  if (typeof owner.userId !== 'string' || owner.userId.trim().length === 0) return null
  if (scheduledTaskGraphContinuationKey(owner, scheduled.attestation) !== key) return null
  const execution = await db.agentExecution.findFirst({ where: { id: owner.executionId, userId: owner.userId,
    sessionId: owner.sessionId, status: 'running', attemptCount: owner.executionAttemptCount },
    select: { id: true, status: true, attemptCount: true, state: true } })
  if (!execution || execution.attemptCount !== owner.executionAttemptCount
    || !scheduledTaskGraphClaimMatches(execution.state, key, owner, claimToken)) return null

  const startedAt = Date.now(), fence = scheduledTaskGraphRunOwnerFence(scheduled)
  let persistedState: unknown = execution.state
  const recorder = await createRunSessionRecorder(db, { userId: owner.userId, goal: 'Agent Pipeline Run', sessionId: owner.sessionId,
    dualWrite: true, source: 'automation', turnId: owner.turnId, manageV2Lifecycle: false,
    manageSessionLifecycle: false, deferActivation: true, ensureTurn: true })
  const attempt = createRunAttemptOwnership({ id: execution.id, userId: owner.userId, sessionId: owner.sessionId,
    attemptCount: execution.attemptCount, turnId: recorder.getTurnId, signal: input.signal })
  const isOwnerCurrent = async () => !input.signal?.aborted && await attempt.isCurrentAttempt()
    && await fence.isCurrent()
  const assertAlive = async () => { if (!await isOwnerCurrent()) throw new AgentExecutionCancelledError() }
  const finish = (status: 'completed' | 'failed', error?: string) => finishScheduledTaskGraphExecution({
    state: persistedState, owner, key, claimToken, status, error, assertOwnerCurrent: fence.assertCurrent,
  })
  const recordOwner = (terminalStatus: 'completed' | 'failed') => ({ turnId: owner.turnId,
    executionAttempt: { id: owner.executionId, userId: owner.userId, attemptCount: owner.executionAttemptCount }, terminalStatus })
  const events: HistoryEvent[] = []
  const storedIndex = record(execution.state)?.eventIndex
  let eventIndex = Number.isSafeInteger(storedIndex) && Number(storedIndex) >= 0 ? Number(storedIndex) : 0
  const writer = createDurableEventWriter({ record: async (event, data) => {
    if (event !== 'error' && !await isOwnerCurrent()) throw new AgentExecutionCancelledError()
    return recorder.record(event, data)
  },
    publish: (event, data) => events.push({ event, data, at: new Date().toISOString() }),
    onError: error => console.warn('Failed to record scheduled audit event', error) })
  const emit = (event: string, data: unknown) => { eventIndex += 1; writer.emit(event, data) }
  const finalize = (status: 'completed' | 'failed', report: RunReport | null) => recorder.finalize({
    status, report, owner: recordOwner(status),
  })
  const fail = async (message: string): Promise<null> => {
    if (!await attempt.isCurrentAttempt()) { await writer.drain(); return null }
    if (!await finish('failed', message) || !await attempt.canPublishAttemptResult('failed')) { await writer.drain(); return null }
    emit('error', { message }); await writer.drain()
    if (!await finalize('failed', null)) return null
    await saveHistory(owner.userId, events, startedAt, null, true)
    return null
  }
  try {
    if (!await attempt.isCurrentAttempt() || !await recorder.activate({ executionAttempt: { id: execution.id,
      attemptCount: execution.attemptCount }, signal: input.signal, assertCurrent: isOwnerCurrent })) return null
    await assertAlive()
    if (!await isActiveAccount(owner.userId)) return await fail('Account is not active')
    if (!await db.agentConfig.findUnique({ where: { userId: owner.userId }, select: { userId: true } })) {
      return await fail('Agent not configured')
    }
    const resume = await db.resume.findFirst({ where: { userId: owner.userId, isDefault: true }, select: { id: true } })
      ?? await db.resume.findFirst({ where: { userId: owner.userId }, orderBy: { createdAt: 'desc' }, select: { id: true } })
    if (!resume) return await fail('No resume found')
    await assertAlive()

    const gateProof = scheduledTaskGraphExecuteGateCompletionProof(scheduled.gateCompletionProof)
    const gate = gateProof?.gate as { taskId: string; attemptCount: number } | undefined
    const proofInput = { owner, snapshot: scheduled.snapshot, analyzeCheckpoint: persistedState,
      analyzeAttestation: scheduled.attestation, prepareProof: scheduled.prepareProof,
      ...(gate ? { gate: { ...gate, phase: 'completed' as const, completionProof: scheduled.gateCompletionProof } } : {}) }
    const gateState = await buildScheduledTaskGraphGateResumeState({ ...scheduled, persistedCheckpoint: persistedState,
      prepareProof: scheduled.prepareProof })
    const safeGateState = serializeScheduledTaskGraphCheckpoint(gateState)
    if (!safeGateState) throw new AgentExecutionCancelledError()
    const automation = parseScheduledAutomationSnapshot(scheduled.snapshot)
    if (!automation) throw new AgentExecutionCancelledError()
    eventIndex = Number.isSafeInteger(gateState.eventIndex) && Number(gateState.eventIndex) >= 0 ? Number(gateState.eventIndex) : eventIndex
    const pipelineState = { ...gateState }
    const scoutedJobs = pipelineState.scoutedJobs, scoredJobs = pipelineState.scoredJobs
    const preparedPackages = pipelineState.preparedPackages, gateOutput = pipelineState.gateOutput
    const analysisFailed = pipelineState.analysisFailed
    if (!scoutedJobs || !scoredJobs || !preparedPackages || !validGate(gateOutput)
      || typeof analysisFailed !== 'number' || !Number.isSafeInteger(analysisFailed) || analysisFailed < 0) throw new AgentExecutionCancelledError()
    let executeOutput = pipelineState.executeOutput ?? { queued: [], failed: [] }
    const allowedJobIds = new Set(scheduled.ownedJobs.map(job => job.id))
    if (allowedJobIds.size !== scheduled.ownedJobs.length || !validExecute(executeOutput, allowedJobIds)) throw new AgentExecutionCancelledError()
    if (!await saveScheduledTaskGraphCheckpoint({ expectedState: persistedState, state: safeGateState,
      owner, key, claimToken, assertOwnerCurrent: tx => scheduledTaskGraphRunCheckpointIsCurrent({ scheduled,
        proofInput, tx, assertOwnerCurrent: fence.assertCurrent }) })) throw new AgentExecutionCancelledError()
    persistedState = safeGateState
    const pipelineStartedAt = Date.now()
    let currentState: PipelineCheckpointState = pipelineState
    const persist = async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState>) => {
      await assertAlive()
      if (!await isActiveAccount(owner.userId)) throw new AgentExecutionCancelledError()
      emit('pipeline_checkpoint', { nextStage, eventIndex })
      await writer.drain(); await assertAlive()
      const next = { ...currentState, ...patch, eventIndex, nextStage }
      const safe = serializeScheduledTaskGraphCheckpoint(next)
      if (!safe || !await saveScheduledTaskGraphCheckpoint({ expectedState: persistedState, state: safe,
        owner, key, claimToken, assertOwnerCurrent: fence.assertCurrent })) throw new AgentExecutionCancelledError()
      currentState = next; persistedState = safe
    }
    let executorQueued = executeOutput.queued, executorFailed = executeOutput.failed
    if (currentState.nextStage === 'execute') {
      const stageStartedAt = Date.now()
      emit('agent_plan', { role: 'executor', plan: gateOutput.approved.length
        ? `plan: for ${gateOutput.approved.length} Prepare for an approved position"Apply now"queue, Waiting for you to manually confirm delivery`
        : `plan: No approved position, ${gateOutput.pending.length} are in the review queue waiting for manual operation` })
      await persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })
      for (const pkg of gateOutput.approved) emit('agent_action', { role: 'executor',
        action: `Holding ${pkg.job.company} · ${pkg.job.role} for explicit final authorization` })
      emit('agent_observation', { role: 'executor', observation: gateOutput.approved.length
        ? `${gateOutput.approved.length} application(s) are held. Review and final submit authorization are required before any browser task can start.`
        : 'No application was dispatched. Review-ready jobs remain safely paused.' })
      await assertAlive()
      const durationMs = Date.now() - stageStartedAt
      emit('agent_reflect', { role: 'executor', reflect: executorQueued.length
        ? `Distributed: ${executorQueued.length} Applications that have received final authorization on a position-by-position basis are executed in the background..Submission confirmation will be provided by Worker write back${executorFailed.length ? `(${executorFailed.length} Failed to join the team)` : ''}(time consuming ${(durationMs / 1000).toFixed(1)}s)`
        : 'Ready to complete: No applications have been distributed in this round; All qualified positions are still pending review, Awaiting your explicit authorization' })
      const summary = `${executorQueued.length} explicitly authorized application(s) queued, ${executorFailed.length} failed`
      emit('stage_done', { stage: 'execute', queued: executorQueued.length, durationMs })
      await recordRoleRun(owner.userId, 'executor', { count: executorQueued.length, durationMs, summary }).catch(() => {})
      executeOutput = { queued: executorQueued, failed: executorFailed }
      await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })
    } else emit('info', { message: `Resuming from ${currentState.nextStage}; executor outcome restored.` })

    if (currentState.nextStage !== 'audit') throw new AgentExecutionCancelledError()
    const reportStartedAt = pipelineStartedAt
    emit('agent_plan', { role: 'auditor', plan: `plan: Verify DB state, Statistical results(${executorQueued.length} Dispatched to unattended Worker / ${gateOutput.pending.length} Pending review / ${gateOutput.skipped.length} jump over), scanning Gmail mail` })
    await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })
    const audit = await runScheduledAudit({ userId: owner.userId, executeOutput, assertCurrent: isOwnerCurrent })
    if (!audit) return null
    await assertAlive()
    for (const observation of audit.observations) emit('agent_observation', { role: 'auditor', observation })
    if (audit.warnings.length) emit('info', { message: `Audit: ${audit.warnings.join('; ')}` })
    const report: RunReport = { processed: scoutedJobs.length, applied: 0, queued: executorQueued.length,
      pending: gateOutput.pending.length, skipped: gateOutput.skipped.length + analysisFailed,
      failed: executorFailed.length, durationMs: Date.now() - reportStartedAt }
    const summary = `${report.queued} dispatched, ${report.pending} pending, ${audit.warnings.length} warnings`
    emit('agent_reflect', { role: 'auditor', reflect: `✅ This operation report: deal with ${report.processed} positions · 🚀 Distributed ${report.queued} indivual · ✅ Submission confirmed ${report.applied} indivual · ⏳ Pending review ${report.pending} indivual · ⏭ jump over ${report.skipped} indivual · ❌ fail ${report.failed} indivual${audit.warnings.length ? ` · ⚠ ${audit.warnings.length} warning` : ''} · Total time spent ${(report.durationMs / 1000).toFixed(1)}s` })
    emit('stage_done', { stage: 'audit', durationMs: audit.durationMs })
    await recordRoleRun(owner.userId, 'auditor', { count: report.processed, durationMs: audit.durationMs, summary }).catch(() => {})
    const customSummary = summarizeCustomAgentResults(currentState.customAgentResults ?? [])
    if (customSummary.length) emit('custom_agent_summary', { findings: customSummary })
    await assertAlive()
    emit('orchestrator_complete', { thinking: '', totalRetries: 0, autonomous: automation.autoApply,
      report: { processed: report.processed, applied: report.applied, queued: report.queued,
        pending: report.pending, skipped: report.skipped }, message: '✅ Orchestrator Finish, Passed all stages successfully' })
    emit('done', report)
    await persist('completed', { scoutedJobs, scoredJobs, analysisFailed,
      preparedPackages, gateOutput, executeOutput, report })
    await assertAlive()
    if (!await finish('completed') || !await attempt.canPublishAttemptResult('completed')) return null
    if (!await finalize('completed', report)) return null
    await saveHistory(owner.userId, events, startedAt, report)
    return report
  } catch (error) {
    if (error instanceof AgentExecutionCancelledError || input.signal?.aborted) { await writer.drain(); return null }
    return await fail(error instanceof Error ? error.message : 'Agent run failed')
  }
}
